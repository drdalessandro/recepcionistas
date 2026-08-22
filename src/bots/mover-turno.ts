/**
 * Bot · Mover un turno desde el portal del paciente.
 *
 * **Es UNA sola operación.** Se toma el lugar nuevo ANTES de soltar el viejo:
 * si fueran dos llamadas, entre una y otra el paciente se queda sin turno y el
 * contador de sesiones parpadea. El sitio publica que no parpadea.
 *
 * Contrato con el portal (`docs/handoff-portal-turnos.md`): la misma forma que
 * `bw-solicitar-turno`. Si el horario elegido ya no está, devuelve
 * `motivo: 'horario-ocupado'` con `alternativas` frescas para repintar la
 * grilla — no un error técnico.
 *
 * ## Mover REVALIDA la ventana de anticipación (R-13)
 *
 * Era la pregunta abierta del handoff. Se revalida, por dos razones:
 *
 *  1. Sin eso queda un agujero: reservás a 48 h con perfil público y vas
 *     corriendo el turno hacia adelante hasta un lugar que tu perfil no
 *     habilitaba. El tope de 3 movimientos lo acota, no lo cierra.
 *  2. La asimetría del error es clara: si revalidar molesta, el paciente no
 *     puede mover a un horario que igual no podría haber reservado de cero —
 *     molesto pero coherente. Si NO revalidamos, se cuela en la ventana de otro.
 *
 * Sale gratis: la grilla de terapias ya calcula con su perfil (R-13), la
 * capacidad (R-07), el horario del centro y las solicitudes de otros.
 *
 * **Salvo las consultas médicas**, que no pasan por esa grilla: su
 * disponibilidad es la agenda publicada del profesional, que se publica con
 * semanas de anticipación. Aplicarles R-13 las rechazaría todas — y sería al
 * revés de lo que se quiere, porque la consulta es la puerta de entrada y el
 * paciente nuevo es el que tiene la ventana más corta. De eso se ocupa
 * `chequearHorarioDisponible`.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, Slot } from '@medplum/fhirtypes';
import { getServicio } from '../config/catalogo.js';
import { MOVIMIENTOS } from '../config/reglas.js';
import { EXT } from '../fhir/identifiers.js';
import type { DiaDisponible } from '../lib/disponibilidad.js';
import {
  chequearHorarioDisponible,
  esTurnoDelPaciente,
  motivoNoAccionable,
  scheduleIdDeRecurso,
} from './_shared.js';

const fmtFechaHora = new Intl.DateTimeFormat('es-AR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});

export interface EntradaMoverTurno {
  pacienteRef: string;
  appointmentId: string;
  /** Inicio nuevo, tal como lo devuelve `bw-disponibilidad` (ISO con -03:00). */
  inicio: string;
  /** Fin nuevo. Si no viene, se calcula con la duración del servicio. */
  fin?: string;
  /** Slot elegido en la grilla (informativo: el bot crea el suyo). */
  slotId?: string;
}

export interface ResultadoMoverTurno {
  ok: boolean;
  mensaje?: string;
  motivo?: 'horario-ocupado';
  alternativas?: DiaDisponible[];
  /** Movimientos que le quedan al turno después de este. */
  movimientosRestantes?: number;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaMoverTurno>,
): Promise<ResultadoMoverTurno> {
  const e = event.input;
  if (!e.pacienteRef || !e.appointmentId || !e.inicio) {
    return { ok: false, mensaje: 'Faltan datos para mover el turno.' };
  }

  const appt = await medplum.readResource('Appointment', e.appointmentId).catch(() => undefined);
  if (!appt || !esTurnoDelPaciente(appt, e.pacienteRef)) {
    return { ok: false, mensaje: 'No encontramos ese turno en tu cuenta.' };
  }

  const noAccionable = motivoNoAccionable(appt);
  if (noAccionable) {
    return { ok: false, mensaje: noAccionable };
  }

  // Tope de movimientos. El portal lo muestra pero NO bloquea: decide el bot.
  const usados = appt.extension?.find((x) => x.url === EXT.movimientos)?.valueInteger ?? 0;
  if (usados >= MOVIMIENTOS.max) {
    return {
      ok: false,
      mensaje: `Ya moviste este turno ${MOVIMIENTOS.max} veces, que es el máximo. Escribinos y lo reprogramamos juntos.`,
      movimientosRestantes: 0,
    };
  }

  // El servicio sale del turno, no del input: mover no puede cambiar QUÉ se hace.
  const servicioCodigo = appt.extension?.find((x) => x.url === EXT.itemCodigo)?.valueString;
  let servicio;
  try {
    servicio = servicioCodigo ? getServicio(servicioCodigo) : undefined;
  } catch {
    servicio = undefined;
  }
  if (!servicio) {
    return { ok: false, mensaje: 'Ese turno no se puede mover desde la app. Escribinos y lo vemos.' };
  }

  const inicio = new Date(e.inicio);
  const fin = e.fin ? new Date(e.fin) : new Date(inicio.getTime() + servicio.duracionMin * 60_000);
  if (Number.isNaN(inicio.getTime()) || inicio.getTime() <= Date.now()) {
    return { ok: false, mensaje: 'Elegí un horario futuro.' };
  }

  // Revalidación (ver el encabezado). `chequearHorarioDisponible` pregunta a la
  // fuente que corresponde: la grilla de salas para las terapias —que ya aplica
  // la ventana R-13— y la agenda publicada del médico para las consultas. Una
  // consulta NO se valida contra la grilla de terapias: el médico publica su
  // agenda con semanas de anticipación y R-13 la rechazaría entera.
  const chequeo = await chequearHorarioDisponible(medplum, e.pacienteRef, servicio, inicio);
  if (!chequeo.ok) {
    return {
      ok: false,
      motivo: 'horario-ocupado',
      mensaje: 'Ese horario ya no está disponible. Elegí otro de los que quedan libres.',
      ...(chequeo.alternativas ? { alternativas: chequeo.alternativas } : {}),
    };
  }

  const recursoCodigo = appt.extension?.find((x) => x.url === EXT.recursoFisico)?.valueString;
  const scheduleId = recursoCodigo ? await scheduleIdDeRecurso(medplum, recursoCodigo) : undefined;
  if (!recursoCodigo || !scheduleId) {
    return { ok: false, mensaje: 'Ese turno no se puede mover desde la app. Escribinos y lo vemos.' };
  }

  // 1) TOMAR el lugar nuevo. Primero esto: si falla, el turno viejo sigue en pie
  //    y el paciente no se queda sin nada.
  const slotNuevo = await medplum.createResource<Slot>({
    resourceType: 'Slot',
    status: 'busy',
    schedule: { reference: `Schedule/${scheduleId}` },
    start: inicio.toISOString(),
    end: fin.toISOString(),
    extension: [
      { url: EXT.recursoFisico, valueString: recursoCodigo },
      { url: EXT.ocupantes, valueInteger: appt.extension?.find((x) => x.url === EXT.ocupantes)?.valueInteger ?? 1 },
    ],
  });

  // 2) MOVER el turno al lugar nuevo (y recién ahí el paciente "está" en el
  //    horario nuevo). El contador sube en el mismo update.
  const slotsViejos = appt.slot ?? [];
  const actualizado = await medplum.updateResource<Appointment>({
    ...appt,
    start: inicio.toISOString(),
    end: fin.toISOString(),
    slot: [{ reference: `Slot/${slotNuevo.id}` }],
    extension: [
      ...(appt.extension ?? []).filter((x) => x.url !== EXT.movimientos),
      { url: EXT.movimientos, valueInteger: usados + 1 },
    ],
  });

  // 3) SOLTAR el lugar viejo. Último: si algo falla acá queda un Slot ocupado de
  //    más (molesto, recuperable), no un paciente sin turno.
  for (const s of slotsViejos) {
    const id = s.reference?.split('/')[1];
    if (!id || id === slotNuevo.id) {
      continue;
    }
    const viejo = await medplum.readResource('Slot', id).catch(() => undefined);
    if (viejo) {
      await medplum.updateResource<Slot>({ ...viejo, status: 'free' }).catch(() => undefined);
    }
  }

  const restantes = MOVIMIENTOS.max - (usados + 1);
  return {
    ok: true,
    mensaje:
      `Listo, tu turno quedó para el ${fmtFechaHora.format(new Date(actualizado.start as string))}.` +
      (restantes > 0
        ? ` Podés moverlo ${restantes} ${restantes === 1 ? 'vez' : 'veces'} más.`
        : ' Es el último cambio que podés hacer desde la app.'),
    movimientosRestantes: restantes,
  };
}
