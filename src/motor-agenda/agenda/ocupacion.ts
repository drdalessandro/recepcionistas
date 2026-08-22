/**
 * Estado de la agenda: qué unidad está tomada, cuándo y por cuántas plazas.
 *
 * El motor no sabe de dónde sale esta foto —en producción, de los `Slot` busy de
 * Medplum— ni la escribe. Recibe lo que ya está reservado y decide contra eso.
 *
 * REGLA DE COMPARTICIÓN
 * Dos reservas pueden compartir una unidad sólo si ocupan **exactamente la misma
 * ventana** y las plazas suman hasta la capacidad. No es un detalle: una cámara
 * multiplaza se presuriza como una sola sesión, así que sumarse a una tanda de
 * 10:00 a 11:00 es posible pero empezar una propia a las 10:30 no lo es. Eso
 * también es lo que hace cierto R-06: un cliente puede sumarse a una sesión ya
 * reservada hasta el inicio, sin piso de sesión.
 */

import { seSuperponen } from '../dominio/tiempo.js';
import type { AgendaOcupada, Ocupacion, UnidadRecurso } from '../dominio/tipos.js';

/** Agenda vacía. */
export const AGENDA_VACIA: AgendaOcupada = { ocupaciones: [] };

/** Agenda con ocupaciones agregadas. No muta la original. */
export function conOcupaciones(
  agenda: AgendaOcupada,
  nuevas: readonly Ocupacion[],
): AgendaOcupada {
  return { ocupaciones: [...agenda.ocupaciones, ...nuevas] };
}

/** Por qué una unidad no está disponible. */
export type MotivoNoDisponible =
  | { readonly tipo: 'libre' }
  | { readonly tipo: 'ventana-distinta'; readonly choca: Ocupacion }
  | { readonly tipo: 'sin-plazas'; readonly ocupadas: number; readonly capacidad: number };

/**
 * ¿Entra una reserva de `plazas` personas en esta unidad, en esta ventana?
 *
 * Devuelve el motivo, no un booleano, para que el rechazo que ve recepción
 * pueda decir si la sala está tomada por otro turno o si simplemente no quedan
 * lugares en la tanda.
 */
export function evaluarDisponibilidad(
  agenda: AgendaOcupada,
  unidad: UnidadRecurso,
  inicio: Date,
  fin: Date,
  plazas: number,
): MotivoNoDisponible {
  let ocupadas = 0;
  for (const oc of agenda.ocupaciones) {
    if (oc.unidadId !== unidad.id) continue;
    if (!seSuperponen(inicio, fin, oc.inicio, oc.fin)) continue;

    const mismaVentana =
      oc.inicio.getTime() === inicio.getTime() && oc.fin.getTime() === fin.getTime();
    if (!mismaVentana) return { tipo: 'ventana-distinta', choca: oc };

    ocupadas += oc.plazas;
  }

  if (ocupadas + plazas > unidad.capacidad) {
    return { tipo: 'sin-plazas', ocupadas, capacidad: unidad.capacidad };
  }
  return { tipo: 'libre' };
}

/** ¿Está disponible? Azúcar sobre `evaluarDisponibilidad`. */
export function estaDisponible(
  agenda: AgendaOcupada,
  unidad: UnidadRecurso,
  inicio: Date,
  fin: Date,
  plazas: number,
): boolean {
  return evaluarDisponibilidad(agenda, unidad, inicio, fin, plazas).tipo === 'libre';
}

/** Unidades de la lista que admiten la reserva, en el orden recibido. */
export function unidadesDisponibles(
  agenda: AgendaOcupada,
  unidades: readonly UnidadRecurso[],
  inicio: Date,
  fin: Date,
  plazas: number,
): UnidadRecurso[] {
  return unidades.filter((u) => estaDisponible(agenda, u, inicio, fin, plazas));
}

/**
 * Cuántas unidades de una lista están libres para una persona cada una.
 *
 * Es el número que decide si un tramo encadenado tiene lugar: cuántos puestos de
 * IHHT quedan para los que salen de la cámara, cuántas tumbonas para los que
 * salen del IHHT.
 */
export function contarUnidadesLibres(
  agenda: AgendaOcupada,
  unidades: readonly UnidadRecurso[],
  inicio: Date,
  fin: Date,
): number {
  return unidadesDisponibles(agenda, unidades, inicio, fin, 1).length;
}
