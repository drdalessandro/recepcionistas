/**
 * Caja chica de recepción — lógica pura (sin FHIR ni red).
 *
 * Diseño (opción 2, aprobada por Andrés 2026-08-09): los ingresos en efectivo
 * NO se re-registran (ya son Invoice balanced medio-pago=efectivo); la caja
 * solo suma egresos, reposiciones y ajustes, y el saldo esperado se DERIVA:
 *
 *   esperado = arranque + efectivo cobrado + reposiciones + ajustes − egresos
 *
 * donde `arranque` es el contado del último arqueo (o el fondo fijo si nunca
 * hubo arqueo). El arqueo compara ese esperado contra el efectivo CONTADO
 * físicamente; una diferencia ≠ 0 dispara alerta a Administración.
 */
import { CAJA_TOPE_GASTO_ARS, esCategoriaGasto, type TipoMovimientoCaja } from '../config/caja.js';

export interface MovimientoCaja {
  tipo: TipoMovimientoCaja;
  /** Siempre positivo; el signo lo da el tipo (egreso resta; reposición/ajuste suman). */
  montoARS: number;
  /** Obligatoria en egresos (lista cerrada); ignorada en reposiciones. */
  categoria?: string;
  detalle?: string;
  /** Gasto sobre el tope marcado como autorizado por Administración. */
  autorizado?: boolean;
}

/** Efecto del movimiento sobre el saldo (egreso resta; ajuste puede ser ±). */
export function efectoEnSaldo(m: MovimientoCaja): number {
  if (m.tipo === 'egreso') {
    return -Math.abs(m.montoARS);
  }
  // Ajuste: corrige para cualquier lado (se persiste con signo en montoARS).
  return m.tipo === 'ajuste' ? m.montoARS : Math.abs(m.montoARS);
}

/**
 * Saldo esperado en caja.
 * @param arranqueARS contado del último arqueo (o fondo fijo si no hubo).
 * @param efectivoCobradoARS suma de Invoices balanced medio-pago=efectivo del período.
 * @param movimientos egresos/reposiciones/ajustes del período.
 */
export function saldoEsperado(arranqueARS: number, efectivoCobradoARS: number, movimientos: readonly MovimientoCaja[]): number {
  return movimientos.reduce((acc, m) => acc + efectoEnSaldo(m), arranqueARS + efectivoCobradoARS);
}

export interface ValidacionGasto {
  ok: boolean;
  errores: string[];
  /** true si supera el tope y por eso exige la marca "autorizado por Administración". */
  requiereAutorizacion: boolean;
}

/** Valida un egreso antes de registrarlo (R de caja: lista cerrada + tope). */
export function validarGasto(g: { montoARS: number; categoria?: string; autorizado?: boolean }): ValidacionGasto {
  const errores: string[] = [];
  if (!Number.isFinite(g.montoARS) || g.montoARS <= 0) {
    errores.push('El monto debe ser mayor a cero.');
  }
  if (!esCategoriaGasto(g.categoria)) {
    errores.push('Elegí una categoría de la lista (no hay texto libre: Administración compara por rubro).');
  }
  const requiereAutorizacion = g.montoARS > CAJA_TOPE_GASTO_ARS;
  if (requiereAutorizacion && !g.autorizado) {
    errores.push(
      `Supera el tope de $${CAJA_TOPE_GASTO_ARS.toLocaleString('es-AR')}: necesita autorización previa de Administración (marcá la casilla si ya la tenés).`,
    );
  }
  return { ok: errores.length === 0, errores, requiereAutorizacion };
}

export interface ResultadoArqueo {
  esperadoARS: number;
  contadoARS: number;
  /** contado − esperado: negativo = falta plata; positivo = sobra. */
  diferenciaARS: number;
  cuadra: boolean;
}

/** Arqueo: compara el efectivo contado físicamente contra el esperado. */
export function armarArqueo(esperadoARS: number, contadoARS: number): ResultadoArqueo {
  const diferenciaARS = Math.round((contadoARS - esperadoARS) * 100) / 100;
  return { esperadoARS, contadoARS, diferenciaARS, cuadra: diferenciaARS === 0 };
}
