/**
 * Seña autoservicio (R-19) — lógica pura (sin FHIR ni red).
 *
 * La reserva tentativa nace con un vencimiento: si la seña del 50% no se
 * acredita antes, el lugar se libera solo. Un rato antes de vencer (si todavía
 * no pagó) se manda un único recordatorio con el mismo link de pago.
 *
 * Igual que los recordatorios de turnos, las ventanas son "hacia abajo": el
 * cron no corre en el instante exacto, así que se evalúa el estado en cada
 * tick y la idempotencia (no repetir avisos) la resuelve el bot.
 */
import { SENA } from '../config/reglas.js';

const MINUTO_MS = 60_000;

/**
 * Vencimiento de la tentativa: `reservadoEn` + las horas de la regla, pero
 * nunca después del inicio del turno (reservar a último momento no regala
 * tiempo de más: si el turno arranca antes, la seña vence al arrancar).
 */
export function vencimientoSena(reservadoEn: Date, inicioTurno?: Date): Date {
  const porRegla = new Date(reservadoEn.getTime() + SENA.vencimientoHoras * 60 * MINUTO_MS);
  if (inicioTurno && inicioTurno.getTime() < porRegla.getTime()) {
    return inicioTurno;
  }
  return porRegla;
}

export type EstadoSenaPendiente = 'vigente' | 'recordatorio' | 'vencida';

/**
 * Estado de una tentativa impaga evaluada en `ahora`:
 *  - 'vencida': pasó el vencimiento → liberar el lugar;
 *  - 'recordatorio': falta menos que la ventana de aviso → último recordatorio;
 *  - 'vigente': todavía hay tiempo, no se hace nada.
 */
export function estadoSenaPendiente(vence: Date, ahora: Date): EstadoSenaPendiente {
  const faltaMs = vence.getTime() - ahora.getTime();
  if (faltaMs <= 0) {
    return 'vencida';
  }
  if (faltaMs <= SENA.recordatorioMinutosAntes * MINUTO_MS) {
    return 'recordatorio';
  }
  return 'vigente';
}

/**
 * ISO-8601 con offset fijo de Argentina (-03:00, sin DST), el formato que exige
 * MercadoPago en `expiration_date_to` (rechaza el sufijo "Z" de toISOString).
 */
export function isoArgentina(fecha: Date): string {
  const corrida = new Date(fecha.getTime() - 3 * 60 * MINUTO_MS);
  return `${corrida.toISOString().slice(0, -1)}-03:00`;
}
