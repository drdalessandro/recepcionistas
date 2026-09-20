/**
 * Bot · Link de pago MercadoPago (seña o saldo restante).
 *
 * Crea una preferencia de checkout de MercadoPago y devuelve el link:
 *  - concepto 'sena' (default): lo que hay que pagar para confirmar el turno
 *    (con el vencimiento de la tentativa si el turno lo tiene, R-19). **Cuánto
 *    es depende de la modalidad**: el 50% de seña en un turno presencial, el
 *    **100%** en uno virtual — una teleconsulta se cobra entera por adelantado
 *    porque no hay mostrador donde cobrar el resto. La cuenta la hace
 *    `linkSena` leyendo el turno, no este bot;
 *  - concepto 'saldo': el 50% restante (lee el Invoice pendiente `saldo-{turno}`).
 *    Un turno virtual no tiene saldo, así que este concepto no aplica.
 *
 * Con `enviar: true` (solo en 'saldo') además **se lo manda al paciente por
 * WhatsApp**. Hasta el 2026-09-20 no existía: el link del saldo había que
 * copiarlo a mano de la pantalla, así que el camino de MercadoPago para el
 * saldo estaba construido y no lo usaba nadie.
 *
 * La creación de la preferencia vive en `_shared.crearPreferenciaMP` (la misma
 * que usa el link automático de la reserva). Requiere el secret
 * MERCADOPAGO_ACCESS_TOKEN; si no está, devuelve un aviso claro (el cobro
 * presencial sigue funcionando).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { enviarLinkSaldo, linkSaldo, linkSena } from './_shared.js';

export interface EntradaLinkMP {
  appointmentId: string;
  /** Qué se cobra: la seña del 50% (default) o el saldo restante. */
  concepto?: 'sena' | 'saldo';
  tc?: number;
  /**
   * Además de generar el link, mandárselo al paciente por WhatsApp.
   *
   * **Solo aplica a `concepto: 'saldo'`.** El de la seña ya sale solo al
   * reservar y vuelve a salir 60 min antes de vencer (R-19): un envío manual
   * ahí duplicaría un mensaje que el sistema ya manda.
   */
  enviar?: boolean;
}

export interface ResultadoLinkMP {
  ok: boolean;
  mensaje?: string;
  /** Monto del link (seña o saldo, según concepto). */
  montoARS?: number;
  /**
   * Compat: el mismo monto que `montoARS` cuando concepto = 'sena'. El nombre
   * quedó de cuando todo era seña del 50%; en un turno virtual trae el TOTAL.
   */
  senaARS?: number;
  url?: string;
  /** Solo con `enviar: true`: si el WhatsApp con el link salió de verdad. */
  enviado?: boolean;
}

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaLinkMP>): Promise<ResultadoLinkMP> {
  const appt = await medplum.readResource('Appointment', event.input.appointmentId);
  const concepto = event.input.concepto ?? 'sena';

  if (concepto === 'saldo') {
    // El monto sale del Invoice pendiente emitido al cobrar la seña (no se
    // recalcula): el porqué está en `linkSaldo`. Con `enviar` además se lo
    // manda al paciente por WhatsApp, que es lo que hasta ahora no hacía
    // nadie y dejaba el camino de MP del saldo sin usar.
    const r = event.input.enviar
      ? await enviarLinkSaldo(medplum, event.secrets, appt)
      : await linkSaldo(medplum, event.secrets, appt);
    return {
      ok: r.ok,
      ...(r.montoARS !== undefined ? { montoARS: r.montoARS } : {}),
      ...(r.url ? { url: r.url } : {}),
      ...(r.mensaje ? { mensaje: r.mensaje } : {}),
      ...(r.enviado !== undefined ? { enviado: r.enviado } : {}),
    };
  }

  try {
    const r = await linkSena(medplum, event.secrets, appt, { tc: event.input.tc });
    return r.url
      ? { ok: true, montoARS: r.senaARS, senaARS: r.senaARS, url: r.url }
      : { ok: false, montoARS: r.senaARS, senaARS: r.senaARS, mensaje: r.mensaje };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : 'No se pudo generar el link de la seña.' };
  }
}
