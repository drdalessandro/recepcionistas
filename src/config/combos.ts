/**
 * Combos — Manual de Protocolos v9. Descuento ~20% sobre lista (el Manual fija
 * lista Y precio por combo; en BIO OXYGEN el OFF real es 21%, por eso el
 * `descuento` se deriva de lista/precio en vez de asumir 20%).
 * El componente IHHT dura 30 min en combo pero lista a precio de sesión (USD 90).
 * Secuencia ordenada: HBOT siempre primero (R-01).
 */
import type { Combo, ComponenteCombo } from '../domain/types.js';

interface DefCombo {
  codigo: string;
  nombre: string;
  variante: 'INDIVIDUAL' | 'PAREJA';
  /** [servicioCodigo, duracionMin, ocupantes] en orden de ejecución. */
  componentes: Array<[string, number, number]>;
  precioListaUSD: number;
  precioUSD: number;
}

const DEFS: DefCombo[] = [
  {
    codigo: 'BIO_ENERGY',
    nombre: 'BIO ENERGY',
    variante: 'INDIVIDUAL',
    componentes: [
      ['IHHT', 30, 1],
      ['RED_LIGHT', 30, 1],
    ],
    precioListaUSD: 140,
    precioUSD: 112,
  },
  {
    codigo: 'BIO_COMPRESS',
    nombre: 'BIO COMPRESS',
    variante: 'INDIVIDUAL',
    componentes: [
      ['COMPRESION', 30, 1],
      ['RED_LIGHT', 30, 1],
    ],
    precioListaUSD: 110,
    precioUSD: 88,
  },
  {
    codigo: 'BIO_CRYO',
    nombre: 'BIO CRYO',
    variante: 'INDIVIDUAL',
    componentes: [
      ['CRIO', 30, 1],
      ['COMPRESION', 30, 1],
    ],
    precioListaUSD: 150,
    precioUSD: 120,
  },
  {
    codigo: 'BIO_OXYGEN',
    nombre: 'BIO OXYGEN',
    variante: 'INDIVIDUAL',
    componentes: [
      ['HBOT_MONO', 60, 1],
      ['IHHT', 30, 1],
    ],
    precioListaUSD: 255,
    precioUSD: 200,
  },
  {
    codigo: 'BIO_OXYGEN_PAREJA',
    nombre: 'BIO OXYGEN — Pareja',
    variante: 'PAREJA',
    componentes: [
      ['HBOT_BIPLAZA', 60, 2],
      ['IHHT', 30, 2],
    ],
    precioListaUSD: 380,
    precioUSD: 300,
  },
  {
    codigo: 'BIO_RECOVERY',
    nombre: 'BIO RECOVERY',
    variante: 'INDIVIDUAL',
    componentes: [
      ['HBOT_MONO', 60, 1],
      ['RECOVERY_PRO', 60, 1],
    ],
    precioListaUSD: 365,
    precioUSD: 292,
  },
  {
    codigo: 'BIO_RECOVERY_PAREJA',
    nombre: 'BIO RECOVERY — Pareja',
    variante: 'PAREJA',
    componentes: [
      ['HBOT_BIPLAZA', 60, 2],
      ['RECOVERY_PRO', 60, 2],
    ],
    precioListaUSD: 400,
    precioUSD: 320,
  },
  {
    codigo: 'BIO_LONGEVITY',
    nombre: 'BIO LONGEVITY',
    variante: 'INDIVIDUAL',
    componentes: [
      ['HBOT_MONO', 60, 1],
      ['IHHT', 30, 1],
      ['RECOVERY_PRO', 60, 1],
    ],
    precioListaUSD: 455,
    precioUSD: 364,
  },
  {
    codigo: 'BIO_LONGEVITY_PAREJA',
    nombre: 'BIO LONGEVITY — Pareja',
    variante: 'PAREJA',
    componentes: [
      ['HBOT_BIPLAZA', 60, 2],
      ['IHHT', 30, 2],
      ['RECOVERY_PRO', 60, 2],
    ],
    precioListaUSD: 580,
    precioUSD: 464,
  },
];

export const COMBOS: Combo[] = DEFS.map((d) => {
  const componentes: ComponenteCombo[] = d.componentes.map(([servicioCodigo, duracionMin, ocupantes], i) => ({
    servicioCodigo,
    duracionMin,
    ocupantes,
    orden: i + 1,
  }));
  return {
    codigo: d.codigo,
    nombre: d.nombre,
    variante: d.variante,
    componentes,
    precioListaUSD: d.precioListaUSD,
    precioUSD: d.precioUSD,
    descuento: 1 - d.precioUSD / d.precioListaUSD,
    duracionTotalMin: componentes.reduce((acc, c) => acc + c.duracionMin, 0),
  };
});

export const COMBOS_POR_CODIGO: ReadonlyMap<string, Combo> = new Map(COMBOS.map((c) => [c.codigo, c]));

export function getCombo(codigo: string): Combo {
  const c = COMBOS_POR_CODIGO.get(codigo);
  if (!c) {
    throw new Error(`Combo desconocido: ${codigo}`);
  }
  return c;
}
