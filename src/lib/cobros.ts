/**
 * Registro de cobros — lógica pura (contrato con Administración).
 *
 * - Cada ítem cobrado → un ChargeItem (línea comercial, monto, fecha, profesional).
 * - Cada cobro → un Invoice `balanced` por MEDIO de pago (pago mixto = N Invoices
 *   con su porción, referenciando los MISMOS ChargeItems). Montos SIEMPRE brutos.
 */
import type { CategoriaServicio } from '../domain/types.js';
import { esMedioPago, type LineaComercial, type MedioPago } from '../fhir/identifiers.js';
import type { TipoItemCobro } from './pricing.js';

/** Línea comercial de un ítem cobrado (la lee kpis-finanzas de administracion). */
export function lineaComercialDeItem(tipo: TipoItemCobro, categoria?: CategoriaServicio): LineaComercial {
  switch (tipo) {
    case 'membresia':
      return 'membresias';
    case 'paquete':
      return 'paquetes';
    case 'combo':
      return 'sueltas-combos';
    case 'servicio':
      if (categoria === 'IV_THERAPY' || categoria === 'TERAPIA_BIOLOGICA') {
        return 'iv-tb';
      }
      if (categoria === 'CONSULTA') {
        return 'consultas';
      }
      return categoria ? 'sueltas-combos' : 'otros';
    default:
      return 'otros';
  }
}

export interface PorcionPago {
  medio: MedioPago;
  /** Porción del total en ARS (entera, en pesos). */
  montoARS: number;
}

export interface ErrorMedios {
  ok: false;
  mensaje: string;
}

export interface MediosOk {
  ok: true;
  porciones: PorcionPago[];
}

/**
 * Valida las porciones de un cobro (simple o mixto): medios canónicos, sin
 * repetidos, montos enteros positivos y suma EXACTA al total. El tablero de
 * Administración suma por medio: acá no puede haber redondeos sueltos.
 */
export function validarMedios(porciones: Array<{ medio: string; montoARS: number }>, totalARS: number): ErrorMedios | MediosOk {
  if (porciones.length === 0) {
    return { ok: false, mensaje: 'Elegí al menos un medio de pago.' };
  }
  const vistos = new Set<string>();
  for (const p of porciones) {
    if (!esMedioPago(p.medio)) {
      return { ok: false, mensaje: `Medio de pago inválido: "${p.medio}". Usá uno de los 5 canónicos.` };
    }
    if (vistos.has(p.medio)) {
      return { ok: false, mensaje: `Medio de pago repetido: ${p.medio}. Uní las porciones.` };
    }
    vistos.add(p.medio);
    if (!Number.isInteger(p.montoARS) || p.montoARS <= 0) {
      return { ok: false, mensaje: `Monto inválido para ${p.medio}: debe ser un entero en pesos mayor a 0.` };
    }
  }
  const suma = porciones.reduce((acc, p) => acc + p.montoARS, 0);
  if (suma !== totalARS) {
    return {
      ok: false,
      mensaje: `Las porciones suman $${suma.toLocaleString('es-AR')} pero el total es $${totalARS.toLocaleString('es-AR')}.`,
    };
  }
  return { ok: true, porciones: porciones as PorcionPago[] };
}

/**
 * Reparte un total entero en N porciones enteras que suman EXACTO (la última
 * absorbe el redondeo). Para precargar el 50/50 del pago mixto en la UI.
 */
export function repartirEnPartes(totalARS: number, partes: number): number[] {
  if (partes <= 0) {
    return [];
  }
  const base = Math.floor(totalARS / partes);
  const resultado = Array.from({ length: partes }, () => base);
  resultado[partes - 1] = totalARS - base * (partes - 1);
  return resultado;
}
