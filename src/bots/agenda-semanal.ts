/**
 * Bot · Agenda semanal de membresías (R-21) — cron horario.
 *
 * Recorre las membresías activas con la agenda semanal encendida
 * (`agenda-semanal-activa` + preferencia de días/hora en el Coverage) y reserva
 * cada sesión de la semana APENAS su ventana R-13 se abre. Correrlo cada hora es
 * seguro e idempotente: `candidatosSemana` saltea lo que ya está asignado, lo
 * que no entró en la ventana queda para la corrida siguiente, y como la ventana
 * de cada perfil es distinta (FM 7 días > Intensivo 96 h > Standard 72 h) la
 * prioridad de acceso a la semana se da sola, sin ordenar nada acá.
 *
 * Si la hora preferida está ocupada (R-07) prueba los horarios del MISMO día
 * más cercanos y le avisa al socio que puede moverlo; si el día está lleno,
 * alerta a Recepción y al socio. Las decisiones puras viven en
 * `src/lib/semana-membresia.ts`; acá solo se orquesta.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Coverage } from '@medplum/fhirtypes';
import { getCombo } from '../config/combos.js';
import { HORARIO_SEMANAL, SLOT_GRANULARIDAD_MIN, TZ } from '../config/horario.js';
import { MEMBRESIAS_POR_CODIGO } from '../config/membresias.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { esPlanBW, estadoDeCoverage, planCodigoDeCoverage } from '../fhir/coverage.js';
import { perfilDeReserva } from '../lib/disponibilidad.js';
import { saldoPlan } from '../lib/planes.js';
import {
  candidatosSemana,
  horariosAlternativos,
  inicioTurnoISO,
  parsePreferencia,
  type PreferenciaSemanal,
} from '../lib/semana-membresia.js';
import { crearAlertaRecepcion, fechaCivilAR, fechasConSesionDelPlan, notificarPortal } from './_shared.js';
import { handler as reservarCombo, type EntradaCombo, type ResultadoCombo } from './reservar-combo.js';

export interface EntradaAgendaSemanal {
  /** Sobrescribe "ahora" (ISO) para probar el bot a mano. */
  ahora?: string;
}

export interface ResultadoAgendaSemanal {
  ok: true;
  /** Membresías con agenda semanal activa que se procesaron. */
  planes: number;
  /** Sesiones creadas a la hora preferida. */
  asignados: number;
  /** Sesiones creadas en un horario alternativo del mismo día. */
  conAlternativa: number;
  /** Fechas sin lugar en todo el día (alertadas). */
  sinLugar: number;
  /** Planes salteados (sin saldo disponible este ciclo). */
  omitidos: number;
  detalle: string[];
}

const fmtDiaNotif = new Intl.DateTimeFormat('es-AR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  timeZone: TZ,
});

function diaLegible(fecha: string, hora: string): string {
  return fmtDiaNotif.format(new Date(inicioTurnoISO(fecha, hora))).replace(',', '');
}

function esDiaAbierto(dia: number): boolean {
  return HORARIO_SEMANAL.find((h) => h.dia === dia)?.abierto ?? false;
}

function franjasDelDia(fecha: string): { desde: string; hasta: string }[] {
  const [y, m, d] = fecha.split('-').map(Number);
  const dia = new Date(y!, m! - 1, d!).getDay();
  return HORARIO_SEMANAL.find((h) => h.dia === dia)?.franjas ?? [];
}

function reglasDe(r: ResultadoCombo): Set<string> {
  return new Set(r.bloqueos.map((b) => b.regla));
}

/** Preferencia guardada en el Coverage, solo si la agenda semanal está activa. */
export function preferenciaDeCoverage(c: Coverage): PreferenciaSemanal | undefined {
  const activa = c.extension?.find((x) => x.url === EXT.agendaSemanalActiva)?.valueBoolean === true;
  if (!activa) {
    return undefined;
  }
  return parsePreferencia(
    c.extension?.find((x) => x.url === EXT.preferenciaDias)?.valueString,
    c.extension?.find((x) => x.url === EXT.preferenciaHora)?.valueString,
  );
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaAgendaSemanal>,
): Promise<ResultadoAgendaSemanal> {
  const e = typeof event.input === 'object' && event.input !== null ? event.input : {};
  const ahora = e.ahora ? new Date(e.ahora) : new Date();

  const res: ResultadoAgendaSemanal = {
    ok: true,
    planes: 0,
    asignados: 0,
    conAlternativa: 0,
    sinLugar: 0,
    omitidos: 0,
    detalle: [],
  };

  const coverages = await medplum.searchResources('Coverage', { status: 'active', _count: 500 });
  for (const cov of coverages) {
    const pref = preferenciaDeCoverage(cov);
    const pacienteRef = cov.beneficiary?.reference;
    if (!pref || !cov.id || !pacienteRef?.startsWith('Patient/') || !esPlanBW(cov)) {
      continue;
    }
    const estado = estadoDeCoverage(cov);
    const planCodigo = planCodigoDeCoverage(cov);
    if (estado.tipo !== 'membresia' || !planCodigo) {
      continue;
    }
    const membresia = MEMBRESIAS_POR_CODIGO.get(planCodigo);
    if (!membresia) {
      continue; // código de plan desconocido: no es de este flujo
    }
    res.planes++;

    const saldo = saldoPlan(estado, ahora);
    if (!saldo.disponible) {
      res.omitidos++;
      continue; // sin sesiones este ciclo: la renovación (R-09) lo vuelve a habilitar
    }

    // Perfil real del socio: FM > intensidad del plan. Ficha ilegible → sin FM.
    let tagFm = false;
    try {
      const paciente = await medplum.readResource('Patient', pacienteRef.split('/')[1]!);
      tagFm = paciente.extension?.some((x) => x.url === EXT.tagFm && x.valueBoolean === true) ?? false;
    } catch {
      // sin ficha se degrada a la ventana del plan
    }
    const perfil = perfilDeReserva(tagFm, [membresia.intensidad]);

    const fechasAsignadas = await fechasConSesionDelPlan(medplum, pacienteRef, cov.id, ahora);
    const candidatos = candidatosSemana({
      preferencia: pref,
      perfil,
      ahora,
      hoyISO: fechaCivilAR(ahora),
      fechasAsignadas,
      saldoRestante: saldo.restantes,
      frecuenciaSemanal: membresia.frecuenciaSemanal,
      esDiaAbierto,
    });

    const combo = getCombo(membresia.comboBaseCodigo);
    const reservar = (inicio: string): Promise<ResultadoCombo> =>
      reservarCombo(medplum, {
        ...event,
        input: {
          pacienteRef,
          comboCodigo: membresia.comboBaseCodigo,
          inicio,
          perfil,
          coverageId: cov.id,
          // El WhatsApp por sesión acá sería ruido semanal: avisa la campanita
          // del portal y los recordatorios 48 h / 2 h siguen saliendo igual.
          notificar: false,
        } satisfies EntradaCombo,
      });

    planLoop: for (const cand of candidatos) {
      const r = await reservar(cand.inicioISO);
      if (r.creado) {
        res.asignados++;
        res.detalle.push(`${pacienteRef} ${cand.fecha} ${pref.hora}: asignado`);
        await notificarPortal(medplum, {
          tipo: 'reserva-confirmada',
          pacienteRef,
          texto: `Agenda semanal: tu ${combo.nombre} quedó reservado para el ${diaLegible(cand.fecha, pref.hora)} a las ${pref.hora}.`,
          about: r.appointmentIds?.[0] ? `Appointment/${r.appointmentIds[0]}` : undefined,
          identifier: { system: SYSTEM.communication, value: `agenda-semanal-${cov.id}-${cand.fecha}` },
        });
        continue;
      }

      const reglas = reglasDe(r);
      if (reglas.has('R-13')) {
        continue; // entre el cálculo y la reserva cambió la ventana: corrida futura
      }
      if (![...reglas].every((x) => x === 'R-07')) {
        // Bloqueo estructural (R-02/R-11/R-20/R-10/R-21…): no depende del horario,
        // así que no se insiste con el resto de la semana. Recepción resuelve.
        await crearAlertaRecepcion(medplum, {
          titulo: 'Agenda semanal: membresía bloqueada',
          detalle: `No se pudo reservar el ${combo.nombre} del ${diaLegible(cand.fecha, pref.hora)} (${planCodigo}): ${r.bloqueos.map((b) => `${b.regla} — ${b.mensaje}`).join(' · ')}`,
          pacienteRef,
          focusRef: `Coverage/${cov.id}`,
          clave: `agenda-semanal-bloqueo-${cov.id}-${cand.fecha}`,
        });
        res.detalle.push(`${pacienteRef} ${cand.fecha}: bloqueado (${[...reglas].join(', ')})`);
        break planLoop;
      }

      // R-07 a la hora preferida: probar los horarios más cercanos del mismo día.
      for (const alt of horariosAlternativos(pref.hora, franjasDelDia(cand.fecha), combo.duracionTotalMin, SLOT_GRANULARIDAD_MIN)) {
        const rAlt = await reservar(inicioTurnoISO(cand.fecha, alt));
        if (rAlt.creado) {
          res.conAlternativa++;
          res.detalle.push(`${pacienteRef} ${cand.fecha}: alternativa ${alt}`);
          await notificarPortal(medplum, {
            tipo: 'reserva-confirmada',
            pacienteRef,
            texto: `Tu horario de las ${pref.hora} del ${diaLegible(cand.fecha, pref.hora)} estaba ocupado: te reservamos el ${combo.nombre} a las ${alt} ese mismo día. Si no te queda cómodo, podés moverlo desde "Mis turnos".`,
            about: rAlt.appointmentIds?.[0] ? `Appointment/${rAlt.appointmentIds[0]}` : undefined,
            identifier: { system: SYSTEM.communication, value: `agenda-semanal-${cov.id}-${cand.fecha}` },
          });
          continue planLoop;
        }
        const reglasAlt = reglasDe(rAlt);
        // R-07 acá (u R-13: la alternativa quedó fuera de la ventana o en el
        // pasado) → sigue probando; cualquier otra cosa es estructural.
        if (![...reglasAlt].every((x) => x === 'R-07' || x === 'R-13')) {
          await crearAlertaRecepcion(medplum, {
            titulo: 'Agenda semanal: membresía bloqueada',
            detalle: `No se pudo reservar el ${combo.nombre} del ${diaLegible(cand.fecha, pref.hora)} (${planCodigo}): ${rAlt.bloqueos.map((b) => `${b.regla} — ${b.mensaje}`).join(' · ')}`,
            pacienteRef,
            focusRef: `Coverage/${cov.id}`,
            clave: `agenda-semanal-bloqueo-${cov.id}-${cand.fecha}`,
          });
          res.detalle.push(`${pacienteRef} ${cand.fecha}: bloqueado en alternativa (${[...reglasAlt].join(', ')})`);
          break planLoop;
        }
      }

      // Día lleno: sin lugar ni en la hora preferida ni en las alternativas.
      res.sinLugar++;
      res.detalle.push(`${pacienteRef} ${cand.fecha}: sin lugar`);
      await crearAlertaRecepcion(medplum, {
        titulo: 'Agenda semanal: día sin lugar',
        detalle: `No hay lugar el ${diaLegible(cand.fecha, pref.hora)} para el ${combo.nombre} de la membresía ${planCodigo} (hora preferida ${pref.hora}). Coordinar otro día con el socio.`,
        pacienteRef,
        focusRef: `Coverage/${cov.id}`,
        clave: `agenda-semanal-sin-lugar-${cov.id}-${cand.fecha}`,
      });
      await notificarPortal(medplum, {
        tipo: 'general',
        pacienteRef,
        texto: `No pudimos reservar tu ${combo.nombre} del ${diaLegible(cand.fecha, pref.hora)}: ese día está completo. Recepción te va a contactar para buscar una alternativa — o elegí otro horario desde "Reservar".`,
        identifier: { system: SYSTEM.communication, value: `agenda-semanal-sin-lugar-${cov.id}-${cand.fecha}` },
      });
      // El resto de la semana se sigue intentando: un día lleno no frena al otro.
    }
  }

  return res;
}
