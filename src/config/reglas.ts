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
 * MercadoPago — condiciones de los links de pago.
 *
 * ⚠️ **`maxCuotas` es una decisión comercial, no técnica.** Hasta 2026-08-22 no
 * se mandaba nada: cada link aceptaba el máximo de cuotas que la cuenta ofrezca
 * por default. Quién paga ese financiamiento depende de cómo esté configurada
 * la cuenta de MercadoPago (si tiene "cuotas sin interés", lo absorbe
 * Biowellness; si no, lo paga el cliente). Como el sistema guarda montos BRUTOS
 * a propósito (R-18: la comisión es gasto del P&L de Administración), la
 * diferencia no aparece en ningún tablero — solo en la liquidación.
 *
 * **Hasta 3 cuotas** (Andrés, 2026-08-22). Ojo con cómo lo expresa MercadoPago:
 * `installments` es un **máximo, no una lista**, así que con 3 el cliente ve
 * las opciones de 1, 2 y 3 — no hay forma de ofrecer "1 y 3" salteando el 2.
 *
 * El resto de los medios queda ABIERTO a propósito: no se manda
 * `excluded_payment_types` ni `excluded_payment_methods`, así que sirven
 * tarjeta, dinero en cuenta, transferencia y efectivo como siempre.
 */
export const MERCADOPAGO = {
  /** Cuotas MÁXIMAS ofrecidas en los links de pago (1 = sin cuotas). */
  maxCuotas: 3,
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

/**
 * Gestión semanal de membresías (R-21, decisión 2026-09-01).
 *
 * Las sesiones del plan se usan dentro de la SEMANA CALENDARIO (lunes a domingo,
 * hora de Argentina): el tope semanal es la frecuencia del plan (2x Standard /
 * 3x Intensivo) y **no hay recupero** — la sesión que una semana no se usó no se
 * amontona en otra. La asignación corre sola (bot `bw-agenda-semanal`, cron
 * horario): reserva la preferencia del socio apenas su ventana R-13 se abre, así
 * la prioridad FM 7 días → Intensivo 96 h → Standard 72 h → público 48 h se da
 * por sí misma. Igual que R-13, rige para el portal y el cron; el mostrador
 * puede sobrepasarla a criterio humano (los bots la validan solo si reciben
 * `perfil`).
 */
export const SEMANA_MEMBRESIA = {
  /** Recupero de sesiones perdidas en semanas anteriores (0 = tope duro). */
  recuperoSesiones: 0,
  /** Cuántos horarios alternativos del MISMO día prueba la asignación automática. */
  maxAlternativasDia: 8,
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

/**
 * Grilla comercial de inicio de turnos (R-22, decisión del PO 2026-09-01).
 *
 * Todos los turnos arrancan a la hora en punto — la visita del cliente ocupa
 * "su hora" y la recepción piensa en horas, no en medias horas. La única
 * excepción es Recovery Pro: sus dos gabinetes se desfasan 30 minutos entre sí
 * porque comparten las tumbonas (R-07), así que arranca en punto o a la media.
 *
 * Es la grilla del TURNO (lo que se ofrece y se reserva), no la de los
 * recursos: por dentro un combo sigue encadenando tramos cada 30 (la tumbona
 * de un BIO ENERGY entra a la media, `SLOT_GRANULARIDAD_MIN` no cambia).
 */
export const GRILLA_TURNO = {
  /** Inicios válidos para todos los servicios: cada 60 min (en punto). */
  defaultMin: 60,
  /** Excepciones por categoría de servicio. */
  porCategoria: {
    RECOVERY_PRO: 30,
  } as Record<string, number>,
} as const;

/** Grilla de inicio (minutos) que le corresponde a una categoría de servicio (R-22). */
export function grillaTurnoMin(categoria: string): number {
  return GRILLA_TURNO.porCategoria[categoria] ?? GRILLA_TURNO.defaultMin;
}
