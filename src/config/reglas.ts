/**
 * Constantes de reglas de negocio (motor de reglas, Documento de Requerimientos §7).
 * Centralizadas para que el pricing engine, la validación de turnos y los tests
 * compartan exactamente los mismos valores. Cada constante referencia su regla R-xx.
 */

/**
 * Founding Members (R-09). Programa FM-100 (Andrés, 2026-08-09): dos cohortes
 * consecutivas — el 1 a 1 personal (números 1–50) y la Web founding.html
 * (51–100). El cupo AVISA, nunca bloquea: marcar el 51 o el 101 es una
 * decisión de Andrés y el sistema la deja pasar con la advertencia a la vista.
 */
export const FM = {
  /** Cupo 1 a 1 (lista personal de Andrés, boca en boca, Friends & Family). */
  cupos1a1: 50,
  /** Programa completo: 1 a 1 + cohorte Web. */
  cuposTotales: 100,
  /** Aviso temprano: el cupo 1 a 1 se está agotando. */
  alertaEnCupo: 40,
  /** 20% OFF lifetime en sueltas y paquetes (NO en combos, membresías ni TB). */
  descuento: 0.2,
  /** Ventana de reserva: 7 días (sobrescribe la del tier). */
  ventanaDias: 7,
} as const;

/** Ventanas máximas de anticipación para reservar, en horas (R-13). */
export const VENTANA_RESERVA_HORAS = {
  PUBLICO: 48,
  STANDARD: 72,
  INTENSIVO: 96,
  FM: 7 * 24,
} as const;

export type PerfilReserva = keyof typeof VENTANA_RESERVA_HORAS;

/** Cancelación / reagenda (R-14). */
export const CANCELACION = {
  /** Cancelar/reagendar con menos de estas horas => sesión consumida. */
  minHoras: 24,
} as const;

/**
 * Mover un turno desde el portal (autogestión del paciente).
 *
 * El tope existe para que mover no se convierta en una reserva indefinida: sin
 * él, un lugar puede quedar "guardado" y correrse semana a semana sin liberarse
 * nunca para otro.
 */
export const MOVIMIENTOS = {
  /** Cuántas veces puede mover el paciente UN MISMO turno. */
  max: 3,
} as const;

/**
 * Seña autoservicio (R-19): la reserva tentativa nace con un link de pago y un
 * vencimiento; si la seña no se acredita a tiempo, el lugar se libera solo.
 */
export const SENA = {
  /** Horas desde la reserva para pagar la seña; después el lugar se libera. */
  vencimientoHoras: 2,
  /** Minutos antes del vencimiento para el recordatorio si todavía no pagó. */
  recordatorioMinutosAntes: 60,
} as const;

/**
 * Recordatorios automáticos de turnos confirmados (cron + WhatsApp).
 * Se avisa a las 48 h y a las 2 h del turno. El orden importa: de mayor a menor
 * antelación (el motor elige el más urgente que aún no se envió).
 */
export const RECORDATORIO_HORAS = [48, 2] as const;

/** Membresías (R-09..R-12). */
export const MEMBRESIA = {
  sesionesStandard: 8,
  sesionesIntensivo: 12,
  descuentoALaCarteStandard: 0.1,
  descuentoALaCarteIntensivo: 0.15,
  compromisoMinMeses: 3,
  bajaAvisoDias: 15,
  pausaDiasPorAnio: 30,
  /** Cobro adelantado: primeros días del mes (MercadoPago). */
  cobroDiaDesde: 1,
  cobroDiaHasta: 5,
} as const;

/** Cascada de pricing para IV Therapy + Terapias Biológicas (R-08). */
export const CASCADA_TB = {
  /** Costo fiscal: 25% del precio. */
  costoFiscal: 0.25,
  /** Costo fijo de enfermería (USD), sin IVA. */
  enfermeriaUSD: 15,
  /** Factor que queda para BW tras el 15% de honorarios médicos. */
  factorBw: 0.85,
  /** Honorario de médicos prescriptores. */
  honorarioMedicos: 0.15,
  /** Piso de margen neto de BW. */
  margenNetoMin: 0.25,
} as const;

/** Descuentos estructurales del catálogo. */
export const DESCUENTOS = {
  combo: 0.2, // R-15
  paqueteX5: 0.05, // R-16
  paqueteX10: 0.1,
  paqueteX20: 0.15,
} as const;
