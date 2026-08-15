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
import { getCombo } from './combos.js';

interface DefMembresia {
  codigo: string;
  tier: Membresia['tier'];
  intensidad: Membresia['intensidad'];
  variante: Membresia['variante'];
  comboBaseCodigo: string;
  sesionesMes: number;
  frecuenciaSemanal: number;
  descuentoContinuidad: number;
}

/**
 * Bajada de cada tier, en voz de paciente. **Vive acá y no en el front**: hasta
 * 2026-08-15 el portal la tenía hardcodeada en `PlanesPage.tsx`, y esa copia
 * decía de Prime "suma el circuito Recovery" olvidándose de la cámara — que es
 * la mitad del combo. El contenido va en el dato: un solo lugar donde estar mal.
 */
const DESCRIPCION_TIER: Record<Membresia['tier'], string> = {
  FOCUS:
    'El punto de partida: tu protocolo base, todos los meses. Cada sesión es un Bio Energy — IHHT más Red Light.',
  PRIME:
    'Recuperación completa: cada sesión es un Bio Recovery — cámara hiperbárica y el circuito Recovery Pro, en ese orden.',
  HEALTHSPAN:
    'El programa integral de longevidad, con el protocolo más completo: cada sesión es un Bio Longevity — cámara hiperbárica, IHHT y circuito Recovery Pro.',
};

/**
 * Descuento del socio sobre lo que compre **suelto**, fuera del plan (%).
 * Standard 10 · Intensivo 15.
 */
const DESCUENTO_A_LA_CARTE: Record<Membresia['intensidad'], number> = {
  STANDARD: 10,
  INTENSIVO: 15,
};

/** Cuatro decimales: mata el ruido binario sin inventar redondeos comerciales. */
function exacto(n: number): number {
  return Number(n.toFixed(4));
}

const DEFS: DefMembresia[] = [
  // FOCUS (base BIO ENERGY) — precios v9 finales (arrastran BIO ENERGY 112)
  { codigo: 'FOCUS_STD_IND', tier: 'FOCUS', intensidad: 'STANDARD', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_ENERGY', sesionesMes: 8, frecuenciaSemanal: 2, descuentoContinuidad: 0.2 },
  { codigo: 'FOCUS_INT_IND', tier: 'FOCUS', intensidad: 'INTENSIVO', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_ENERGY', sesionesMes: 12, frecuenciaSemanal: 3, descuentoContinuidad: 0.25 },

  // PRIME (base BIO RECOVERY) — sin cambios en v9
  { codigo: 'PRIME_STD_IND', tier: 'PRIME', intensidad: 'STANDARD', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_RECOVERY', sesionesMes: 8, frecuenciaSemanal: 2, descuentoContinuidad: 0.25 },
  { codigo: 'PRIME_INT_IND', tier: 'PRIME', intensidad: 'INTENSIVO', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_RECOVERY', sesionesMes: 12, frecuenciaSemanal: 3, descuentoContinuidad: 0.3 },
  { codigo: 'PRIME_STD_PAR', tier: 'PRIME', intensidad: 'STANDARD', variante: 'PAREJA', comboBaseCodigo: 'BIO_RECOVERY_PAREJA', sesionesMes: 8, frecuenciaSemanal: 2, descuentoContinuidad: 0.25 },
  { codigo: 'PRIME_INT_PAR', tier: 'PRIME', intensidad: 'INTENSIVO', variante: 'PAREJA', comboBaseCodigo: 'BIO_RECOVERY_PAREJA', sesionesMes: 12, frecuenciaSemanal: 3, descuentoContinuidad: 0.3 },

  // HEALTHSPAN (base BIO LONGEVITY) — precios v9 finales (arrastran LONGEVITY 364/464)
  { codigo: 'HEALTHSPAN_STD_IND', tier: 'HEALTHSPAN', intensidad: 'STANDARD', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_LONGEVITY', sesionesMes: 8, frecuenciaSemanal: 2, descuentoContinuidad: 0.25 },
  { codigo: 'HEALTHSPAN_INT_IND', tier: 'HEALTHSPAN', intensidad: 'INTENSIVO', variante: 'INDIVIDUAL', comboBaseCodigo: 'BIO_LONGEVITY', sesionesMes: 12, frecuenciaSemanal: 3, descuentoContinuidad: 0.3 },
  { codigo: 'HEALTHSPAN_STD_PAR', tier: 'HEALTHSPAN', intensidad: 'STANDARD', variante: 'PAREJA', comboBaseCodigo: 'BIO_LONGEVITY_PAREJA', sesionesMes: 8, frecuenciaSemanal: 2, descuentoContinuidad: 0.25 },
  { codigo: 'HEALTHSPAN_INT_PAR', tier: 'HEALTHSPAN', intensidad: 'INTENSIVO', variante: 'PAREJA', comboBaseCodigo: 'BIO_LONGEVITY_PAREJA', sesionesMes: 12, frecuenciaSemanal: 3, descuentoContinuidad: 0.3 },
];

/**
 * El precio del mes **se deriva**, no se escribe: `combo × sesiones × (1 −
 * continuidad)`. Antes estaban a mano y cuatro habían quedado redondeados hacia
 * arriba — FOCUS_STD_IND llegó a decir 718 cuando la cuenta da **716,80**, o
 * sea 1,20 de más por mes que nadie podía explicar de dónde salía. Derivándolo,
 * el día que cambie un combo las diez membresías siguen solas.
 *
 * Efecto colateral bueno: con los valores exactos la grilla cierra redonda —
 * el ahorro contra sesiones sueltas da 36 / 40 / 44 % clavado (ver el test).
 */
export const MEMBRESIAS: Membresia[] = DEFS.map((d): Membresia => {
  const combo = getCombo(d.comboBaseCodigo);
  return {
    ...d,
    precioMesUSD: exacto(combo.precioUSD * d.sesionesMes * (1 - d.descuentoContinuidad)),
    precioListaMesUSD: exacto(combo.precioListaUSD * d.sesionesMes),
    descuentoALaCarte: DESCUENTO_A_LA_CARTE[d.intensidad],
    descripcion: DESCRIPCION_TIER[d.tier],
  };
});

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
