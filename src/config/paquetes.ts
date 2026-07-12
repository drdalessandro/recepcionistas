/**
 * Paquetes de sesiones — Manual de Protocolos v9 (Sección 2).
 * Nombres comerciales por tramo: x5 = Starter · x10 = Core · x20 = Pro.
 * Descuento por volumen: x5 = 5% · x10 = 10% · x20 = 15%.
 * Vigencias: 15 / 30 / 60 días. Founding Member: 20% adicional sobre el paquete.
 *
 * Los totales generados coinciden EXACTOS con las tablas del Manual (redondeo
 * Math.round sobre precioSesión × sesiones, y sobre total × 0.8 para FM).
 */
import type { Paquete } from '../domain/types.js';

interface BasePaquete {
  servicioBaseCodigo: string;
  etiqueta: string;
  /** Nombre comercial de la base, como figura en el Manual. */
  nombreBase: string;
  /** Precio base por sesión para el paquete (USD). */
  precioBaseUSD: number;
}

const BASES: BasePaquete[] = [
  { servicioBaseCodigo: 'HBOT_MONO', etiqueta: 'HBOT_MONO', nombreBase: 'HBOT MONO', precioBaseUSD: 165 },
  { servicioBaseCodigo: 'HBOT_BIPLAZA', etiqueta: 'HBOT_BIPLAZA', nombreBase: 'HBOT BIPLAZA', precioBaseUSD: 200 }, // por pareja
  { servicioBaseCodigo: 'IHHT', etiqueta: 'IHHT', nombreBase: 'IHHT', precioBaseUSD: 90 },
  { servicioBaseCodigo: 'RED_LIGHT', etiqueta: 'RED_LIGHT', nombreBase: 'RED LIGHT', precioBaseUSD: 50 },
  { servicioBaseCodigo: 'COMPRESION', etiqueta: 'BOTAS_COMP', nombreBase: 'BOTAS COMP', precioBaseUSD: 60 },
  { servicioBaseCodigo: 'CRIO', etiqueta: 'BOTAS_CRYO', nombreBase: 'BOTAS CRYO', precioBaseUSD: 90 },
];

const TRAMOS: Array<{ tamano: number; nombre: string; descuento: number; vigenciaDias: number }> = [
  { tamano: 5, nombre: 'Starter', descuento: 0.05, vigenciaDias: 15 },
  { tamano: 10, nombre: 'Core', descuento: 0.1, vigenciaDias: 30 },
  { tamano: 20, nombre: 'Pro', descuento: 0.15, vigenciaDias: 60 },
];

const FM_DESC = 0.2;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const PAQUETES: Paquete[] = BASES.flatMap((base) =>
  TRAMOS.map((t): Paquete => {
    const precioSesionUSD = round2(base.precioBaseUSD * (1 - t.descuento));
    const totalUSD = Math.round(precioSesionUSD * t.tamano);
    const totalFMUSD = Math.round(totalUSD * (1 - FM_DESC));
    return {
      codigo: `PAQ_${base.etiqueta}_X${t.tamano}`,
      nombre: `${base.nombreBase} — ${t.nombre}`,
      servicioBaseCodigo: base.servicioBaseCodigo,
      tamano: t.tamano,
      vigenciaDias: t.vigenciaDias,
      descuento: t.descuento,
      precioSesionUSD,
      totalUSD,
      totalFMUSD,
    };
  }),
);

export const PAQUETES_POR_CODIGO: ReadonlyMap<string, Paquete> = new Map(
  PAQUETES.map((p) => [p.codigo, p]),
);

export function getPaquete(codigo: string): Paquete {
  const p = PAQUETES_POR_CODIGO.get(codigo);
  if (!p) {
    throw new Error(`Paquete desconocido: ${codigo}`);
  }
  return p;
}
