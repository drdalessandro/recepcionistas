/**
 * Membresías — Manual de Protocolos v9.
 * Cada membresía = su combo base repetido N veces/mes con descuento por continuidad.
 * Standard = 8 sesiones/mes (2x/sem). Intensivo = 12 sesiones/mes (3x/sem).
 *
 * Reglas operativas (R-09..R-12, ver docs/reglas-negocio.md):
 *  - Sesiones NO acumulables (reset mensual / a 30 días / al consumirse).
 *  - Cobro adelantado días 1-5 (MercadoPago).
 *  - Compromiso mínimo 3 meses; baja avisando 15 días antes.
 *  - 1 pausa de 30 días/año. Upgrade prorrateado; downgrade al ciclo siguiente.
 */
import type { Membresia } from '../domain/types.js';

interface DefMembresia {
  codigo: string;
  tier: Membresia['tier'];
  intensidad: Membresia['intensidad'];
  variante: Membresia['variante'];
  comboBaseCodigo: string;
  sesionesMes: number;
  frecuenciaSemanal: number;
  precioMesUSD: number;
  descuentoContinuidad: number;
}

const DEFS: DefMembresia[] = [
  // FOCUS (base BIO ENERGY) — precios v9 finales (arrastran BIO ENERGY 112)
  { codigo: 'FOCUS_STD_IND', tier: 'FOCUS', intensidad: 'STANDARD', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_ENERGY', sesionesMes: 8, frecuenciaSemanal: 2, precioMesUSD: 718, descuentoContinuidad: 0.2 },
  { codigo: 'FOCUS_INT_IND', tier: 'FOCUS', intensidad: 'INTENSIVO', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_ENERGY', sesionesMes: 12, frecuenciaSemanal: 3, precioMesUSD: 1008, descuentoContinuidad: 0.25 },

  // PRIME (base BIO RECOVERY) — sin cambios en v9
  { codigo: 'PRIME_STD_IND', tier: 'PRIME', intensidad: 'STANDARD', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_RECOVERY', sesionesMes: 8, frecuenciaSemanal: 2, precioMesUSD: 1752, descuentoContinuidad: 0.25 },
  { codigo: 'PRIME_INT_IND', tier: 'PRIME', intensidad: 'INTENSIVO', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_RECOVERY', sesionesMes: 12, frecuenciaSemanal: 3, precioMesUSD: 2453, descuentoContinuidad: 0.3 },
  { codigo: 'PRIME_STD_PAR', tier: 'PRIME', intensidad: 'STANDARD', variante: 'PAREJA', comboBaseCodigo: 'BIO_RECOVERY_PAREJA', sesionesMes: 8, frecuenciaSemanal: 2, precioMesUSD: 1920, descuentoContinuidad: 0.25 },
  { codigo: 'PRIME_INT_PAR', tier: 'PRIME', intensidad: 'INTENSIVO', variante: 'PAREJA', comboBaseCodigo: 'BIO_RECOVERY_PAREJA', sesionesMes: 12, frecuenciaSemanal: 3, precioMesUSD: 2688, descuentoContinuidad: 0.3 },

  // HEALTHSPAN (base BIO LONGEVITY) — precios v9 finales (arrastran LONGEVITY 364/464)
  { codigo: 'HEALTHSPAN_STD_IND', tier: 'HEALTHSPAN', intensidad: 'STANDARD', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_LONGEVITY', sesionesMes: 8, frecuenciaSemanal: 2, precioMesUSD: 2184, descuentoContinuidad: 0.25 },
  { codigo: 'HEALTHSPAN_INT_IND', tier: 'HEALTHSPAN', intensidad: 'INTENSIVO', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_LONGEVITY', sesionesMes: 12, frecuenciaSemanal: 3, precioMesUSD: 3058, descuentoContinuidad: 0.3 },
  { codigo: 'HEALTHSPAN_STD_PAR', tier: 'HEALTHSPAN', intensidad: 'STANDARD', variante: 'PAREJA', comboBaseCodigo: 'BIO_LONGEVITY_PAREJA', sesionesMes: 8, frecuenciaSemanal: 2, precioMesUSD: 2784, descuentoContinuidad: 0.25 },
  { codigo: 'HEALTHSPAN_INT_PAR', tier: 'HEALTHSPAN', intensidad: 'INTENSIVO', variante: 'PAREJA', comboBaseCodigo: 'BIO_LONGEVITY_PAREJA', sesionesMes: 12, frecuenciaSemanal: 3, precioMesUSD: 3898, descuentoContinuidad: 0.3 },
];

export const MEMBRESIAS: Membresia[] = DEFS;

export const MEMBRESIAS_POR_CODIGO: ReadonlyMap<string, Membresia> = new Map(
  MEMBRESIAS.map((m) => [m.codigo, m]),
);

export function getMembresia(codigo: string): Membresia {
  const m = MEMBRESIAS_POR_CODIGO.get(codigo);
  if (!m) {
    throw new Error(`Membresía desconocida: ${codigo}`);
  }
  return m;
}
