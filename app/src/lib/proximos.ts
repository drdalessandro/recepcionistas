import type { Appointment, Patient, Slot } from '@medplum/fhirtypes';
import { getDisplayString } from '@medplum/core';
import { medplum } from '../medplum';
import { RECURSOS } from '@bw/config/recursos';
import { EXT } from '@bw/fhir/identifiers';
import type { TurnoTimeline } from './timeline';

/**
 * Un turno de la vista "Próximos turnos" (agenda de 7/14 días).
 *
 * Extiende `TurnoTimeline` (para reusar `TurnoModal`) sumando la fecha del turno
 * y el nombre legible de la sala, que en la vista de hoy no hacían falta.
 */
export interface TurnoProximo extends TurnoTimeline {
  /** Inicio del turno (ISO con offset). */
  inicioISO: string;
  /** Clave de día local "YYYY-MM-DD" (para agrupar). */
  fecha: string;
  /** Nombre legible de la sala/recurso. */
  recursoNombre: string;
}

/** Un día con sus turnos, ya ordenados por hora. */
export interface DiaAgenda {
  /** Clave "YYYY-MM-DD". */
  fecha: string;
  /** Etiqueta amigable: "Hoy", "Mañana" o "lunes 23 de junio". */
  etiqueta: string;
  /** Cantidad de turnos tentativos (falta seña) del día. */
  tentativos: number;
  turnos: TurnoProximo[];
}

const ESTADOS_OCULTOS = new Set(['cancelled', 'entered-in-error']);
const TENTATIVOS = new Set(['pending', 'proposed']);

const fmtEtiqueta = new Intl.DateTimeFormat('es-AR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

function minDelDia(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function claveFecha(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function etiquetaDia(fecha: string, hoyKey: string, mananaKey: string): string {
  if (fecha === hoyKey) {
    return 'Hoy';
  }
  if (fecha === mananaKey) {
    return 'Mañana';
  }
  // fecha es "YYYY-MM-DD" local; reconstruyo un Date local para formatear.
  const [y, m, d] = fecha.split('-').map(Number);
  return fmtEtiqueta.format(new Date(y as number, (m as number) - 1, d as number));
}

/**
 * Carga los turnos desde el inicio de hoy hasta `dias` días en adelante,
 * agrupados por día. Pensada para "ver y confirmar" la ventana de 7/14 días.
 */
export async function cargarProximos(dias: number): Promise<DiaAgenda[]> {
  const desde = new Date();
  desde.setHours(0, 0, 0, 0);
  const hasta = new Date(desde);
  hasta.setDate(hasta.getDate() + dias);
  hasta.setHours(23, 59, 59, 999);

  const recursoNombre = new Map(RECURSOS.map((r) => [r.codigo, r.nombre]));

  const [appts, slots] = await Promise.all([
    safe(() => medplum.searchResources('Appointment', { date: `ge${desde.toISOString()}`, _count: 1000, _sort: 'date' })),
    safe(() => medplum.searchResources('Slot', { start: `ge${desde.toISOString()}`, _count: 1000 })),
  ]);

  // Fallback: Slot id -> código de recurso (turnos sin la extensión directa).
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

  const hastaISO = hasta.toISOString();
  const items: TurnoProximo[] = [];
  for (const a of appts as Appointment[]) {
    if (!a.id || !a.start || !a.end || a.start > hastaISO || ESTADOS_OCULTOS.has(a.status ?? '')) {
      continue;
    }
    const recursoCodigo =
      a.extension?.find((e) => e.url === EXT.recursoFisico)?.valueString ??
      (a.slot?.[0]?.reference ? recursoPorSlot.get(a.slot[0].reference.split('/')[1] ?? '') : undefined);
    if (!recursoCodigo) {
      continue;
    }
    const inicio = new Date(a.start);
    const pacienteRef = a.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    const pacienteId = pacienteRef?.split('/')[1];
    items.push({
      appointmentId: a.id,
      recursoCodigo,
      recursoNombre: recursoNombre.get(recursoCodigo) ?? recursoCodigo,
      inicioISO: a.start,
      fecha: claveFecha(inicio),
      inicioMin: minDelDia(inicio),
      finMin: minDelDia(new Date(a.end)),
      servicio: a.description ?? 'Turno',
      paciente: (pacienteId && nombrePaciente.get(pacienteId)) || '',
      estado: a.status ?? 'booked',
      ocupantes: a.extension?.find((e) => e.url === EXT.ocupantes)?.valueInteger ?? 1,
    });
  }

  items.sort((a, b) => a.inicioISO.localeCompare(b.inicioISO));

  // Agrupar por día preservando el orden cronológico.
  const hoyKey = claveFecha(new Date());
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const mananaKey = claveFecha(manana);

  const porDia = new Map<string, DiaAgenda>();
  for (const t of items) {
    let dia = porDia.get(t.fecha);
    if (!dia) {
      dia = { fecha: t.fecha, etiqueta: etiquetaDia(t.fecha, hoyKey, mananaKey), tentativos: 0, turnos: [] };
      porDia.set(t.fecha, dia);
    }
    dia.turnos.push(t);
    if (TENTATIVOS.has(t.estado)) {
      dia.tentativos += 1;
    }
  }

  return [...porDia.values()];
}

async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}
