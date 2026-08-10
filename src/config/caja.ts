/**
 * Caja chica de recepción — parámetros de gestión.
 *
 * ⚠️ PROVISORIOS (2026-08-09): Andrés aprobó el diseño (opción 2: movimientos
 * en `Basic` + arqueo en `PaymentReconciliation`) pero los montos y la
 * frecuencia quedaron con estos defaults hasta su confirmación
 * (docs/decisiones-pendientes.md). Cambiarlos acá no toca ninguna otra pieza.
 *
 * Principio: los INGRESOS en efectivo no se registran acá — ya existen como
 * Invoice balanced con medio-pago=efectivo. La caja solo agrega lo que no
 * existía: egresos, reposiciones y arqueos. El saldo esperado se DERIVA.
 */

/** Fondo fijo de la caja (ARS). Arranque del primer arqueo. PROVISORIO. */
export const CAJA_FONDO_FIJO_ARS = 200_000;

/**
 * Tope por gasto individual sin autorización previa de Administración (ARS).
 * Por encima, la UI exige marcar "autorizado por Andrés". PROVISORIO.
 */
export const CAJA_TOPE_GASTO_ARS = 25_000;

/** Tipos de movimiento de caja (código del Basic). */
export const TIPOS_MOVIMIENTO_CAJA = ['egreso', 'reposicion', 'ajuste'] as const;
export type TipoMovimientoCaja = (typeof TIPOS_MOVIMIENTO_CAJA)[number];

/**
 * Categorías de gasto — lista CERRADA (como MEDIOS_PAGO / ORIGENES_LEAD):
 * se persiste SIEMPRE el código, nunca texto libre, para que Administración
 * pueda comparar meses. Ampliar acá si Andrés suma rubros.
 */
export const CATEGORIAS_GASTO = [
  'insumos',
  'limpieza',
  'mantenimiento',
  'viaticos-mensajeria',
  'libreria',
  'otros',
] as const;

export type CategoriaGasto = (typeof CATEGORIAS_GASTO)[number];

export function esCategoriaGasto(v: string | undefined | null): v is CategoriaGasto {
  return Boolean(v) && (CATEGORIAS_GASTO as readonly string[]).includes(v as string);
}

/** Etiquetas para la UI (el valor persistido es SIEMPRE el código). */
export const CATEGORIAS_GASTO_LABELS: Record<CategoriaGasto, string> = {
  insumos: 'Insumos',
  limpieza: 'Limpieza',
  mantenimiento: 'Mantenimiento',
  'viaticos-mensajeria': 'Viáticos / mensajería',
  libreria: 'Librería',
  otros: 'Otros',
};
