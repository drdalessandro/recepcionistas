/**
 * Founding Member (R-09 revisada).
 *
 * El tag no es un premio permanente: **exige membresía vigente**. El FM cambia
 * libremente de tier y de modalidad sin perderlo —de FOCUS a HEALTHSPAN, de
 * Standard a Intensivo—, y caduca sólo si queda sin membresía activa o entra en
 * mora.
 *
 * Por eso nadie debería leer `cliente.tagFoundingMember` suelto: el tag es el
 * dato guardado, `fmVigente()` es la respuesta.
 */

import type { Cliente } from '../dominio/tipos.js';

/** Por qué un tag de Founding Member no está vigente. */
export type MotivoFmCaduco = 'sin-tag' | 'en-mora' | 'sin-membresia' | 'membresia-vencida';

export interface EstadoFoundingMember {
  readonly vigente: boolean;
  readonly motivo?: MotivoFmCaduco;
}

/** Evalúa el tag contra las condiciones de R-09 y explica por qué cae. */
export function evaluarFoundingMember(cliente: Cliente): EstadoFoundingMember {
  if (!cliente.tagFoundingMember) return { vigente: false, motivo: 'sin-tag' };
  if (cliente.enMora) return { vigente: false, motivo: 'en-mora' };

  const titularidad = cliente.titularidad;
  if (!titularidad) return { vigente: false, motivo: 'sin-membresia' };

  // Una membresía pausada sigue siendo una membresía: la pausa es un derecho del
  // socio (30 días por año calendario), no una baja.
  if (titularidad.estado === 'activa' || titularidad.estado === 'pausada') {
    return { vigente: true };
  }
  return {
    vigente: false,
    motivo: titularidad.estado === 'en-mora' ? 'en-mora' : 'membresia-vencida',
  };
}

/** ¿El cliente goza hoy de los beneficios de Founding Member? */
export function fmVigente(cliente: Cliente): boolean {
  return evaluarFoundingMember(cliente).vigente;
}

/** Texto para recepción cuando el tag existe pero no está vigente. */
export function explicarFmCaduco(motivo: MotivoFmCaduco): string {
  switch (motivo) {
    case 'sin-tag':
      return 'El cliente no es Founding Member.';
    case 'en-mora':
      return 'El tag Founding Member está caduco: el cliente está en mora.';
    case 'sin-membresia':
      return 'El tag Founding Member está caduco: el cliente no tiene membresía activa.';
    case 'membresia-vencida':
      return 'El tag Founding Member está caduco: la membresía venció.';
  }
}
