import type { Appointment, Patient, Slot } from '@medplum/fhirtypes';
import { getDisplayString } from '@medplum/core';
import { medplum } from '../medplum';
import { RECURSOS } from '@bw/config/recursos';
import { HORARIO_SEMANAL } from '@bw/config/horario';
import { EXT } from '@bw/fhir/identifiers';

export interface TurnoTimeline {
  appointmentId: string;
  recursoCodigo: string;
  /** Minutos desde medianoche (hora local). */
  inicioMin: number;
  finMin: number;
  servicio: string;
  paciente: string;
  /** Estado del turno (Appointment.status): booked / arrived / checked-in / fulfilled / noshow. */
  estado: string;
  /** Personas de esta reserva (biplaza pareja = 2, multiplaza 1-6). */
  ocupantes: number;
}

export interface SalaFila {
  codigo: string;
  nombre: string;
  comparteEquipo: boolean;
  /** Capacidad en personas (multiplaza 6, biplaza 2, resto 1). */
  capacidad: number;
  /** Una reserva toma el recurso completo (biplaza, gabinetes Recovery). */
  reservaExclusiva: boolean;
}

export interface TimelineData {
  abierto: boolean;
  aperturaMin: number;
  cierreMin: number;
  salas: SalaFila[];
  turnos: TurnoTimeline[];
  ahoraMin: number;
}

// 'waitlist' es una espera, no un turno: no tiene horario y no ocupa nada.
// Las búsquedas por `date=ge…` ya la dejan afuera (no tiene `start`); esto
// es el segundo cerrojo, para que un cambio de índice no la meta en la agenda.
const ESTADOS_OCULTOS = new Set(['cancelled', 'entered-in-error', 'waitlist']);

function hhmmAMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minDelDia(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function rango(fecha: Date): { desde: string; hasta: string } {
  const ini = new Date(fecha);
  ini.setHours(0, 0, 0, 0);
  const fin = new Date(fecha);
  fin.setHours(23, 59, 59, 999);
  return { desde: ini.toISOString(), hasta: fin.toISOString() };
}

/** Carga el timeline del día: salas (filas), horario (columnas) y turnos (con estado). */
export async function cargarTimeline(fecha: Date = new Date()): Promise<TimelineData> {
  const salas: SalaFila[] = RECURSOS.map((r) => ({
    codigo: r.codigo,
    nombre: r.nombre,
    comparteEquipo: Boolean(r.comparteCon?.length),
    capacidad: r.capacidad,
    reservaExclusiva: Boolean(r.reservaExclusiva),
  }));

  const horarioDia = HORARIO_SEMANAL.find((h) => h.dia === fecha.getDay());
  if (!horarioDia?.abierto || horarioDia.franjas.length === 0) {
    return { abierto: false, aperturaMin: 0, cierreMin: 0, salas, turnos: [], ahoraMin: minDelDia(new Date()) };
  }
  const aperturaMin = Math.min(...horarioDia.franjas.map((f) => hhmmAMin(f.desde)));
  const cierreMin = Math.max(...horarioDia.franjas.map((f) => hhmmAMin(f.hasta)));

  const { desde, hasta } = rango(fecha);

  const [appts, slots] = await Promise.all([
    safe(() => medplum.searchResources('Appointment', { date: `ge${desde}`, _count: 500 })),
    safe(() => medplum.searchResources('Slot', { start: `ge${desde}`, _count: 500 })),
  ]);

  // Fallback: mapa de Slot id -> código de recurso (para turnos sin la extensión).
  const recursoPorSlot = new Map<string, string>();
  for (const s of slots as Slot[]) {
    const code = s.extension?.find((e) => e.url === EXT.recursoFisico)?.valueString;
    if (s.id && code) {
      recursoPorSlot.set(s.id, code);
    }
  }

  // Nombres de pacientes (batch).
  const pacienteIds = [
    ...new Set(
      appts
        .map((a) => a.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference)
        .filter((r): r is string => Boolean(r))
        .map((r) => r.split('/')[1] as string),
    ),
  ];
  const nombrePaciente = new Map<string, string>();
  if (pacienteIds.length > 0) {
    const pacientes = await safe(() =>
      medplum.searchResources('Patient', { _id: pacienteIds.join(','), _count: pacienteIds.length }),
    );
    for (const p of pacientes as Patient[]) {
      if (p.id) {
        nombrePaciente.set(p.id, getDisplayString(p));
      }
    }
  }

  const turnos: TurnoTimeline[] = [];
  for (const a of appts as Appointment[]) {
    if (!a.id || !a.start || !a.end || a.start > hasta || ESTADOS_OCULTOS.has(a.status ?? '')) {
      continue;
    }
    const recursoCodigo =
      a.extension?.find((e) => e.url === EXT.recursoFisico)?.valueString ??
      (a.slot?.[0]?.reference ? recursoPorSlot.get(a.slot[0].reference.split('/')[1] ?? '') : undefined);
    if (!recursoCodigo) {
      continue;
    }
    const pacienteRef = a.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    const pacienteId = pacienteRef?.split('/')[1];
    turnos.push({
      appointmentId: a.id,
      recursoCodigo,
      inicioMin: minDelDia(new Date(a.start)),
      finMin: minDelDia(new Date(a.end)),
      servicio: a.description ?? 'Turno',
      paciente: (pacienteId && nombrePaciente.get(pacienteId)) || '',
      estado: a.status ?? 'booked',
      ocupantes: a.extension?.find((e) => e.url === EXT.ocupantes)?.valueInteger ?? 1,
    });
  }

  return { abierto: true, aperturaMin, cierreMin, salas, turnos, ahoraMin: minDelDia(new Date()) };
}

async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}
