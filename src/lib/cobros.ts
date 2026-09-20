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

// ============================================================================
// Pendientes cobrables en el mostrador ("Pagos pendientes" de Atender).
// ============================================================================

/**
 * ¿Este Invoice es algo que Recepción tiene que cobrar?
 *
 * Dos claves entran al panel: `plan-…` (cuota de plan) y `saldo-…` (el 50 %
 * restante de un turno). Y dos estados: `issued` (pendiente) y `cancelled`.
 * Pero `cancelled` no significa lo mismo en las dos claves:
 *
 *  - En una cuota de plan, `cancelled` es un **rechazo de MercadoPago** (R-11):
 *    el socio debe la cuota, quedó bloqueado, y el mostrador la cobra para
 *    regularizar. Sí es cobrable.
 *  - En un saldo de turno, `cancelled` es un **turno cancelado**: el único
 *    camino que deja un saldo en ese estado es `cancelarTurno`, porque el
 *    webhook de MP no cancela un saldo rechazado (sigue `issued` y se cobra en
 *    el mostrador). No se debe nada.
 *
 * Hasta el 2026-09-20 el panel mostraba los dos como "Rechazado (R-11)" con
 * botón de Cobrar. Sobre un saldo de turno cancelado eso cobraba $60.000 por
 * una sesión que no existe: `resolverInvoicePlan` recupera un Invoice
 * `cancelled` a propósito (es el camino del socio que regulariza), así que el
 * cobro salía andando y con ChargeItem para Administración.
 */
export function esPendienteCobrable(inv: { status?: string; claves: string[] }): boolean {
  const esPlan = inv.claves.some((c) => c.startsWith('plan-'));
  const esSaldo = inv.claves.some((c) => c.startsWith('saldo-'));
  if (inv.status === 'issued') {
    return esPlan || esSaldo;
  }
  if (inv.status === 'cancelled') {
    return esPlan; // un saldo cancelado es un turno cancelado: no se debe
  }
  return false;
}
