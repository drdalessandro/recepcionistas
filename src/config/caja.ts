/**
 * Caja chica de recepción — parámetros de gestión.
 *
 * ✅ CONFIRMADOS por Andrés vía Administración (2026-08-10, sin cambios):
 * fondo $200.000 · tope $25.000 · arqueo diario al cierre · reposiciones las
 * registra recepción. El diseño (opción 2: movimientos en `Basic` + arqueo en
 * `PaymentReconciliation`) ya estaba aprobado del 2026-08-09. Si algún valor
 * cambia a futuro, se toca solo acá — ninguna otra pieza depende de ellos.
 *
 * Principio: los INGRESOS en efectivo no se registran acá — ya existen como
 * Invoice balanced con medio-pago=efectivo. La caja solo agrega lo que no
 * existía: egresos, reposiciones y arqueos. El saldo esperado se DERIVA.
 */

/** Fondo fijo de la caja (ARS). Arranque del primer arqueo. Confirmado 2026-08-10. */
export const CAJA_FONDO_FIJO_ARS = 200_000;

/**
 * Tope por gasto individual sin autorización previa de Administración (ARS).
 * Por encima, la UI exige marcar "autorizado por Andrés". Confirmado 2026-08-10.
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
