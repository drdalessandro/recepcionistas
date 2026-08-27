import type { Appointment, Slot } from '@medplum/fhirtypes';
import { medplum } from '../medplum';
import { HORARIO_SEMANAL } from '@bw/config/horario';
import { EXT } from '@bw/fhir/identifiers';
import { armarMapaSemana, fechaLocalISO, type MapaSemana, type TurnoMapa } from '@bw/lib/mapa-semana';

// Igual que en timeline/proximos: cancelados y lista de espera no ocupan sala.
const ESTADOS_OCULTOS = new Set(['cancelled', 'entered-in-error', 'waitlist']);

function minDelDia(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Carga el mapa de ocupación de la semana que arranca en `lunes`.
 *
 * Deliberadamente más liviano que `cargarProximos`: la ocupación no necesita
 * nombres de pacientes (no hay batch de Patient) y la consulta va acotada
 * ARRIBA Y ABAJO a la semana pedida — sin el tope superior, un lunes con mucho
 * por delante podía perder sus propios turnos contra el `_count`.
 */
export async function cargarMapaSemana(lunes: Date): Promise<MapaSemana> {
  const desde = new Date(lunes);
  desde.setHours(0, 0, 0, 0);
  const hasta = new Date(desde);
  hasta.setDate(hasta.getDate() + 7);

  const [appts, slots] = await Promise.all([
    safe(() =>
      medplum.searchResources('Appointment', [
        ['date', `ge${desde.toISOString()}`],
        ['date', `lt${hasta.toISOString()}`],
        ['_count', '1000'],
      ]),
    ),
    safe(() =>
      medplum.searchResources('Slot', [
        ['start', `ge${desde.toISOString()}`],
        ['start', `lt${hasta.toISOString()}`],
        ['_count', '1000'],
      ]),
    ),
  ]);

  // Fallback: Slot id -> código de recurso (turnos sin la extensión directa).
  const recursoPorSlot = new Map<string, string>();
  for (const s of slots as Slot[]) {
    const code = s.extension?.find((e) => e.url === EXT.recursoFisico)?.valueString;
    if (s.id && code) {
      recursoPorSlot.set(s.id, code);
    }
  }

  const turnos: TurnoMapa[] = [];
  for (const a of appts as Appointment[]) {
    if (!a.id || !a.start || !a.end || ESTADOS_OCULTOS.has(a.status ?? '')) {
      continue;
    }
    const recursoCodigo =
      a.extension?.find((e) => e.url === EXT.recursoFisico)?.valueString ??
      (a.slot?.[0]?.reference ? recursoPorSlot.get(a.slot[0].reference.split('/')[1] ?? '') : undefined);
    if (!recursoCodigo) {
      continue;
    }
    const inicio = new Date(a.start);
    turnos.push({
      recursoCodigo,
      fecha: fechaLocalISO(inicio),
      inicioMin: minDelDia(inicio),
      finMin: minDelDia(new Date(a.end)),
    });
  }

  return armarMapaSemana(turnos, desde, HORARIO_SEMANAL);
}

async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}
