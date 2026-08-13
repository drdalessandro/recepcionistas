/**
 * Agendas publicadas de los médicos — lógica pura (sin FHIR ni red).
 *
 * Hay UN solo consultorio (R_CONSULTORIO, capacidad 1) y varios médicos que
 * atienden ahí. Si dos agendas se superponen, el portal ofrece las dos franjas
 * pero la regla R-07 solo deja reservar una: el segundo paciente elige un
 * horario que después se le rechaza. No es un bug del sistema —es una decisión
 * de agenda— así que esto no bloquea nada: lo detecta y lo reporta
 * (`npm run agenda:check`) para que la superposición sea deliberada y no una
 * sorpresa en el mostrador.
 */
import type { FranjaAgendaMedico, Medico } from '../config/medicos.js';

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** "HH:MM" → minutos desde medianoche. */
function aMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export interface SolapamientoAgenda {
  medicoA: string;
  medicoB: string;
  dia: number;
  /** Franja compartida, en "HH:MM". */
  desde: string;
  hasta: string;
  /** Frase lista para imprimir. */
  detalle: string;
}

function aHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function solapan(a: FranjaAgendaMedico, b: FranjaAgendaMedico): { desde: number; hasta: number } | undefined {
  if (a.dia !== b.dia) {
    return undefined;
  }
  const desde = Math.max(aMinutos(a.desde), aMinutos(b.desde));
  const hasta = Math.min(aMinutos(a.hasta), aMinutos(b.hasta));
  // Tocarse (una termina justo cuando la otra empieza) NO es superponerse.
  return desde < hasta ? { desde, hasta } : undefined;
}

/**
 * Superposiciones entre las agendas declaradas: cada par de médicos que
 * comparte franja el mismo día compite por el único consultorio.
 */
export function solapamientosDeAgendas(medicos: readonly Medico[]): SolapamientoAgenda[] {
  const conAgenda = medicos.filter((m) => (m.agenda?.length ?? 0) > 0);
  const conflictos: SolapamientoAgenda[] = [];
  for (let i = 0; i < conAgenda.length; i++) {
    for (let j = i + 1; j < conAgenda.length; j++) {
      const a = conAgenda[i]!;
      const b = conAgenda[j]!;
      for (const fa of a.agenda!) {
        for (const fb of b.agenda!) {
          const cruce = solapan(fa, fb);
          if (!cruce) {
            continue;
          }
          const desde = aHHMM(cruce.desde);
          const hasta = aHHMM(cruce.hasta);
          conflictos.push({
            medicoA: a.nombre,
            medicoB: b.nombre,
            dia: fa.dia,
            desde,
            hasta,
            detalle: `${a.nombre} y ${b.nombre} comparten ${DIAS[fa.dia] ?? fa.dia} ${desde}-${hasta} (un solo consultorio: solo uno puede reservarse por franja).`,
          });
        }
      }
    }
  }
  return conflictos;
}
