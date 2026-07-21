/**
 * Disponibilidad real para el portal (bot `bw-disponibilidad`).
 *
 * Lógica pura: dado el servicio, el perfil del paciente y la agenda ocupada,
 * produce los horarios reservables agrupados por día. Las reglas NO se duplican
 * en el portal: acá se aplican la ventana por tipo de cliente (R-13), la
 * capacidad por personas y el desfasaje Recovery (R-07) y el horario del centro.
 *
 * La reserva sigue siendo por SOLICITUD (`bw-solicitar-turno` → Recepción
 * confirma): esto solo pinta los chips de horarios del portal.
 */
import type { IntensidadMembresia, RecursoFisico, Servicio } from '../domain/types.js';
import { HORARIO_SEMANAL, SLOT_GRANULARIDAD_MIN, type HorarioDia } from '../config/horario.js';
import { compartenEquipo, recursosParaCategoria } from '../config/recursos.js';
import { VENTANA_RESERVA_HORAS, type PerfilReserva } from '../config/reglas.js';
import { generarSlots } from './slots.js';
import {
  personasEnFranja,
  validarCapacidadRecurso,
  validarDesfasajeRecovery,
  validarVentanaReserva,
  type ReservaRecurso,
} from './reglas-turno.js';

/** Único servicio que se vende por asiento en sesión grupal ("sumate"). */
const SERVICIO_GRUPAL = 'HBOT_MULTIPLAZA';

/**
 * Perfil de reserva del paciente (R-13). La derivación canónica del server:
 * `tag-fm` en la ficha → FM; si no, la intensidad de su membresía activa
 * (INTENSIVO > STANDARD); sin membresía → público. Un paquete NO cambia la
 * ventana (no es membresía).
 */
export function perfilDeReserva(tagFm: boolean, intensidades: IntensidadMembresia[]): PerfilReserva {
  if (tagFm) {
    return 'FM';
  }
  if (intensidades.includes('INTENSIVO')) {
    return 'INTENSIVO';
  }
  if (intensidades.length > 0) {
    return 'STANDARD';
  }
  return 'PUBLICO';
}

export interface HorarioDisponible {
  /** ISO con offset -03:00. */
  inicio: string;
  fin: string;
  /** Solo sesión grupal: asientos restantes (hasta la capacidad del recurso). */
  lugares?: number;
  /** Solo sesión grupal: personas ya anotadas en la franja. */
  ocupantes?: number;
}

export interface DiaDisponible {
  /** YYYY-MM-DD (fecha argentina). */
  fecha: string;
  horarios: HorarioDisponible[];
}

export interface OpcionesDisponibilidad {
  servicio: Servicio;
  perfil: PerfilReserva;
  ahora: Date;
  /** Agenda ocupada (Slots busy → ReservaRecurso) de todo el rango a evaluar. */
  reservas: ReservaRecurso[];
  /** Horario del centro (default: HORARIO_SEMANAL). */
  horario?: HorarioDia[];
}

export interface Disponibilidad {
  ventanaHoras: number;
  grupal: boolean;
  dias: DiaDisponible[];
}

/** Los recursos donde el portal puede ofrecer el servicio. */
function candidatosPara(servicio: Servicio): RecursoFisico[] {
  const delTipo = recursosParaCategoria(servicio.categoria);
  if (servicio.codigo === SERVICIO_GRUPAL) {
    // La sesión grupal vive SOLO en la Multiplaza (asientos individuales).
    return delTipo.filter((r) => (r.minimoPersonas ?? 0) > 0);
  }
  // Un servicio individual jamás pisa la cámara grupal (esos asientos son de
  // la sesión "sumate"); el resto de las salas de la categoría valen todas,
  // igual que cuando Recepción elige sala a mano.
  return delTipo.filter((r) => (r.minimoPersonas ?? 0) === 0);
}

/**
 * Horarios reservables para el paciente, agrupados por día.
 *
 * Un horario se ofrece si existe AL MENOS un recurso de la categoría donde el
 * turno completo (duración del servicio) cabe dentro del horario del centro y
 * pasa capacidad (R-07) + desfasaje Recovery + ventana del perfil (R-13). La
 * sala concreta la decide Recepción al confirmar, como siempre.
 *
 * Sesión grupal (Multiplaza): el horario se ofrece mientras queden asientos
 * (`lugares` ≥ 1) y suma `ocupantes` ("ya somos N"). El mínimo operativo de 3
 * es advertencia, no bloqueo: el horario se devuelve igual.
 */
export function calcularDisponibilidad(opts: OpcionesDisponibilidad): Disponibilidad {
  const { servicio, perfil, ahora } = opts;
  const horario = opts.horario ?? HORARIO_SEMANAL;
  const ventanaHoras = VENTANA_RESERVA_HORAS[perfil];
  const grupal = servicio.codigo === SERVICIO_GRUPAL;
  const candidatos = candidatosPara(servicio);
  if (candidatos.length === 0 || servicio.duracionMin <= 0) {
    return { ventanaHoras, grupal, dias: [] };
  }

  // Grilla de arranques posibles (granularidad 30') por recurso, cubriendo
  // toda la ventana. `generarSlots` ya respeta el horario semanal del centro.
  const nDias = Math.ceil(ventanaHoras / 24) + 1;
  const grilla = generarSlots(candidatos, horario, { desde: ahora, dias: nDias });
  const slotsPorRecurso = new Map<string, Set<string>>();
  const arranques = new Set<string>();
  for (const s of grilla) {
    const set = slotsPorRecurso.get(s.recursoCodigo) ?? new Set<string>();
    set.add(s.inicio);
    slotsPorRecurso.set(s.recursoCodigo, set);
    arranques.add(s.inicio);
  }

  const gran = SLOT_GRANULARIDAD_MIN;
  const subSlots = Math.ceil(servicio.duracionMin / gran);
  const porDia = new Map<string, HorarioDisponible[]>();

  for (const inicioISO of [...arranques].sort()) {
    const inicio = new Date(inicioISO);
    if (inicio.getTime() <= ahora.getTime()) {
      continue; // solo a futuro
    }
    if (!validarVentanaReserva(perfil, ahora, inicio).ok) {
      continue; // fuera de la ventana del perfil (R-13)
    }
    const fin = new Date(inicio.getTime() + servicio.duracionMin * 60_000);

    let horarioOfrecible: HorarioDisponible | undefined;
    for (const recurso of candidatos) {
      // El turno completo tiene que caber en la misma franja del centro: todos
      // los sub-slots de la duración deben existir en la grilla del recurso.
      const set = slotsPorRecurso.get(recurso.codigo);
      let cabe = Boolean(set);
      for (let k = 0; cabe && k < subSlots; k++) {
        const sub = new Date(inicio.getTime() + k * gran * 60_000);
        if (!set!.has(isoArgentina(sub))) {
          cabe = false;
        }
      }
      if (!cabe) {
        continue;
      }

      // R-07 sobre la agenda real: capacidad del recurso + desfasaje Recovery.
      // Solo las reservas de ESTE recurso y de los que comparten equipo (el
      // gabinete Recovery hermano): un problema preexistente en otra sala no
      // debe envenenar los horarios de esta.
      const candidata: ReservaRecurso = { recursoCodigo: recurso.codigo, inicio, fin, ocupantes: 1 };
      const relevantes = opts.reservas.filter(
        (r) => r.recursoCodigo === recurso.codigo || compartenEquipo(r.recursoCodigo, recurso.codigo),
      );
      const conCandidata = [...relevantes, candidata];
      if (!validarCapacidadRecurso(conCandidata).ok || !validarDesfasajeRecovery(conCandidata).ok) {
        continue;
      }

      if (grupal) {
        const ocupantes = personasEnFranja(opts.reservas, recurso.codigo, inicio, fin);
        horarioOfrecible = {
          inicio: inicioISO,
          fin: isoArgentina(fin),
          lugares: Math.max(recurso.capacidad - ocupantes, 0),
          ocupantes,
        };
      } else {
        horarioOfrecible = { inicio: inicioISO, fin: isoArgentina(fin) };
      }
      break; // con un recurso alcanza: la sala la elige Recepción
    }

    if (horarioOfrecible) {
      const fecha = inicioISO.slice(0, 10);
      const arr = porDia.get(fecha) ?? [];
      arr.push(horarioOfrecible);
      porDia.set(fecha, arr);
    }
  }

  const dias: DiaDisponible[] = [...porDia.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fecha, horarios]) => ({ fecha, horarios }));
  return { ventanaHoras, grupal, dias };
}

/** ISO con offset fijo de Argentina (mismo formato que generarSlots). */
function isoArgentina(d: Date): string {
  const local = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return `${local.toISOString().slice(0, 19)}-03:00`;
}
