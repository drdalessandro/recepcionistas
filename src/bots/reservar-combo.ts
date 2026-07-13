/**
 * Bot · Reservar combo.
 *
 * Reserva un combo en un clic: agenda cada componente en orden (HBOT primero,
 * R-01), consecutivos, auto-asignando una sala disponible para cada uno y
 * validando capacidad/desfasaje (R-07), contraindicaciones (R-02) y ventana (R-13).
 * Si todo entra, crea un Appointment + Slot ocupado por componente (vinculados por
 * un identifier de combo). Si algún componente no entra, no crea nada y explica.
 */
import { randomUUID } from 'node:crypto';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, Slot } from '@medplum/fhirtypes';
import type { Combo } from '../domain/types.js';
import { getCombo } from '../config/combos.js';
import { getServicio } from '../config/catalogo.js';
import { RECURSOS_POR_CODIGO, compartenEquipo, recursosParaCategoria } from '../config/recursos.js';
import type { PerfilReserva } from '../config/reglas.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import {
  DESFASAJE_RECOVERY_MIN,
  combinar,
  validarContraindicaciones,
  validarBloqueoAdministrativo,
  validarOrdenHBOT,
  validarVentanaReserva,
  type Issue,
  type ReservaRecurso,
  type ResultadoValidacion,
} from '../lib/reglas-turno.js';
import { cargarReservasDelDia, consumirSesionDePlan, enviarWhatsApp, extraerCodigos, scheduleIdDeRecurso, tieneBloqueoPago, type ConsumoPlan } from './_shared.js';

export interface EntradaCombo {
  pacienteRef: string;
  comboCodigo: string;
  /** Inicio del primer componente, ISO con offset de Argentina. */
  inicio: string;
  perfil?: PerfilReserva;
  autorizacionMedica?: boolean;
  /** Coverage (membresía) con el que se paga el combo: consume una sesión y confirma sin seña. */
  coverageId?: string;
  /** Si es false, solo valida/planifica (no crea). Default true. */
  confirmar?: boolean;
  /** Si es false, no envía el WhatsApp por sesión (la pre-agenda manda uno solo de resumen). Default true. */
  notificar?: boolean;
}

export interface ItemPlanDTO {
  servicio: string;
  recurso: string;
  desde: string;
  hasta: string;
}

export interface ResultadoCombo extends ResultadoValidacion {
  creado: boolean;
  plan: ItemPlanDTO[];
  appointmentIds?: string[];
  /** Si se usó una membresía: sesiones restantes tras consumir esta. */
  planRestantes?: number;
}

interface ItemPlan {
  servicioCodigo: string;
  servicioNombre: string;
  recursoCodigo: string;
  recursoNombre: string;
  inicio: Date;
  fin: Date;
  ocupantes: number;
}

const fmtH = new Intl.DateTimeFormat('es-AR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});
function fmtHora(d: Date): string {
  return fmtH.format(d);
}

function seSolapan(aIni: Date, aFin: Date, bIni: Date, bFin: Date): boolean {
  return aIni < bFin && bIni < aFin;
}

/**
 * ¿Cabe un turno nuevo en `recursoCodigo` [inicio,fin) dado lo ya ocupado?
 * Chequea capacidad del propio recurso (por PERSONAS; los recursos de reserva
 * exclusiva se llenan con una sola reserva) y desfasaje (R-07) contra recursos
 * que comparten equipo. Sólo evalúa el turno nuevo (ignora conflictos preexistentes).
 */
function cabe(recursoCodigo: string, inicio: Date, fin: Date, ocupantes: number, ocupadas: ReservaRecurso[]): boolean {
  const recurso = RECURSOS_POR_CODIGO.get(recursoCodigo);
  const capacidad = recurso?.capacidad ?? 1;
  const solapadas = ocupadas.filter(
    (o) => o.recursoCodigo === recursoCodigo && seSolapan(inicio, fin, o.inicio, o.fin),
  );
  if (recurso?.reservaExclusiva) {
    if (solapadas.length > 0) {
      return false;
    }
  } else {
    const personas = solapadas.reduce((acc, o) => acc + Math.min(o.ocupantes ?? 1, capacidad), 0);
    if (personas + Math.min(ocupantes, capacidad) > capacidad) {
      return false;
    }
  }
  const offsetMs = DESFASAJE_RECOVERY_MIN * 60_000;
  for (const o of ocupadas) {
    if (o.recursoCodigo !== recursoCodigo && compartenEquipo(recursoCodigo, o.recursoCodigo)) {
      if (Math.abs(inicio.getTime() - o.inicio.getTime()) < offsetMs) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Planifica la secuencia del combo: ubica cada componente consecutivo y le asigna
 * la primera sala disponible de su tipo. Pura (sin FHIR), testeable.
 */
export function planificarCombo(combo: Combo, inicio: Date, reservasExistentes: ReservaRecurso[]): {
  ok: boolean;
  bloqueos: Issue[];
  plan: ItemPlan[];
} {
  const plan: ItemPlan[] = [];
  const asignadas: ReservaRecurso[] = [];
  const bloqueos: Issue[] = [];
  let t = inicio;

  for (const comp of combo.componentes) {
    const servicio = getServicio(comp.servicioCodigo);
    const fin = new Date(t.getTime() + comp.duracionMin * 60_000);
    const candidatos = recursosParaCategoria(servicio.categoria);

    const elegido = candidatos.find((cand) => cabe(cand.codigo, t, fin, comp.ocupantes, [...reservasExistentes, ...asignadas]));

    if (!elegido) {
      bloqueos.push({
        regla: 'R-07',
        nivel: 'bloqueo',
        mensaje: `No hay sala disponible para ${servicio.nombre} a las ${fmtHora(t)} (${combo.nombre}).`,
      });
      break;
    }

    asignadas.push({ recursoCodigo: elegido.codigo, inicio: t, fin, ocupantes: comp.ocupantes });
    plan.push({
      servicioCodigo: servicio.codigo,
      servicioNombre: servicio.nombre,
      recursoCodigo: elegido.codigo,
      recursoNombre: elegido.nombre,
      inicio: t,
      fin,
      ocupantes: comp.ocupantes,
    });
    t = fin;
  }

  return { ok: bloqueos.length === 0, bloqueos, plan };
}

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaCombo>): Promise<ResultadoCombo> {
  const e = event.input;
  const combo = getCombo(e.comboCodigo);
  const inicio = new Date(e.inicio);
  const ahora = new Date();

  const categorias = combo.componentes.map((c) => getServicio(c.servicioCodigo).categoria);

  const flags = await medplum.searchResources('Flag', `subject=${e.pacienteRef}&status=active`);
  const contraindicaciones = flags.flatMap(extraerCodigos);

  const reservasExistentes = await cargarReservasDelDia(medplum, inicio);
  const planRes = planificarCombo(combo, inicio, reservasExistentes);

  const partes: ResultadoValidacion[] = [];
  if (inicio.getTime() <= ahora.getTime()) {
    partes.push({ ok: false, bloqueos: [{ regla: 'R-13', nivel: 'bloqueo', mensaje: 'El turno está en el pasado.' }], advertencias: [] });
  }
  partes.push(validarOrdenHBOT(categorias));
  partes.push(validarBloqueoAdministrativo(tieneBloqueoPago(flags)));
  partes.push(validarContraindicaciones([...new Set(categorias)], contraindicaciones, { autorizacionMedica: e.autorizacionMedica ?? false }));
  if (e.perfil) {
    partes.push(validarVentanaReserva(e.perfil, ahora, inicio));
  }
  partes.push({ ok: planRes.ok, bloqueos: planRes.bloqueos, advertencias: [] });

  const resultado = combinar(...partes);
  const planDTO: ItemPlanDTO[] = planRes.plan.map((p) => ({
    servicio: p.servicioNombre,
    recurso: p.recursoNombre,
    desde: fmtHora(p.inicio),
    hasta: fmtHora(p.fin),
  }));

  if (!resultado.ok || e.confirmar === false) {
    return { ...resultado, creado: false, plan: planDTO };
  }

  // Si se paga con una membresía: consumir una sesión antes de crear (R-10).
  let consumo: ConsumoPlan | undefined;
  if (e.coverageId) {
    try {
      consumo = await consumirSesionDePlan(medplum, e.coverageId, { tipo: 'combo', codigo: e.comboCodigo }, ahora);
    } catch (err) {
      return {
        ok: false,
        bloqueos: [{ regla: 'R-10', nivel: 'bloqueo', mensaje: (err as Error).message }],
        advertencias: resultado.advertencias,
        creado: false,
        plan: planDTO,
      };
    }
  }

  // Crear todos los componentes (vinculados por un identifier de combo).
  const comboInstanceId = randomUUID();
  const appointmentIds: string[] = [];
  let orden = 1;
  for (const item of planRes.plan) {
    const scheduleId = await scheduleIdDeRecurso(medplum, item.recursoCodigo);
    if (!scheduleId) {
      continue;
    }
    const slot = await medplum.createResource<Slot>({
      resourceType: 'Slot',
      status: 'busy',
      schedule: { reference: `Schedule/${scheduleId}` },
      start: item.inicio.toISOString(),
      end: item.fin.toISOString(),
      extension: [
        { url: EXT.recursoFisico, valueString: item.recursoCodigo },
        { url: EXT.ocupantes, valueInteger: item.ocupantes },
      ],
    });
    const appt = await medplum.createResource<Appointment>({
      resourceType: 'Appointment',
      // Con membresía: confirmado (sesión paga). Sin plan: tentativo hasta la seña.
      status: consumo ? 'booked' : 'pending',
      description: `${combo.nombre} · ${item.servicioNombre}`,
      start: item.inicio.toISOString(),
      end: item.fin.toISOString(),
      slot: [{ reference: `Slot/${slot.id}` }],
      participant: [{ actor: { reference: e.pacienteRef }, status: 'accepted' }],
      identifier: [{ system: SYSTEM.comboCodigo, value: comboInstanceId }],
      extension: [
        { url: EXT.recursoFisico, valueString: item.recursoCodigo },
        { url: EXT.ordenProtocolo, valueInteger: orden },
        { url: EXT.ocupantes, valueInteger: item.ocupantes },
        { url: EXT.itemTipo, valueCode: 'combo' },
        { url: EXT.itemCodigo, valueString: e.comboCodigo },
        ...(consumo ? [{ url: EXT.coberturaUsada, valueString: `Coverage/${e.coverageId}` }] : []),
      ],
    });
    if (appt.id) {
      appointmentIds.push(appt.id);
    }
    orden++;
  }

  if (e.notificar !== false) {
    await enviarWhatsApp(medplum, event.secrets, {
      template: consumo ? 'reserva-plan' : 'reserva-tentativa',
      pacienteRef: e.pacienteRef,
      body: consumo
        ? `BioWellness: ¡tu ${combo.nombre} quedó confirmado con tu membresía para las ${fmtHora(inicio)}! Te quedan ${consumo.restantes} sesiones este mes. ¡Te esperamos! 💚`
        : `BioWellness: reservamos tu ${combo.nombre} para las ${fmtHora(inicio)} (tentativo). Aboná la seña del 50% para confirmarlo. 💚`,
    });
  }

  return {
    ...resultado,
    creado: true,
    plan: planDTO,
    appointmentIds,
    ...(consumo ? { planRestantes: consumo.restantes } : {}),
  };
}
