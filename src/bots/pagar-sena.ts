/**
 * Bot · Pagar seña (50%).
 *
 * Registra el pago manual de la seña (50%) de un turno tentativo y lo confirma.
 * La lógica vive en `_shared.confirmarReserva` (la misma que usa el webhook de MP):
 * emite el Invoice de la seña, pasa el/los turno(s) a 'booked' y envía el WhatsApp.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { confirmarReserva } from './_shared.js';

export interface EntradaSena {
  appointmentId: string;
  /** efectivo / transferencia / tarjeta / mercadopago */
  medioPago?: string;
  tc?: number;
}

export interface ResultadoSena {
  ok: boolean;
  mensaje?: string;
  totalARS?: number;
  senaARS?: number;
  invoiceId?: string;
  confirmados?: number;
}

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaSena>): Promise<ResultadoSena> {
  const { appointmentId, medioPago, tc } = event.input;
  try {
    const r = await confirmarReserva(medplum, event.secrets, { appointmentId, medioPago, tc });
    if (r.rechazado) {
      return { ok: false, mensaje: r.rechazado, totalARS: r.totalARS, senaARS: r.senaARS };
    }
    return { ok: true, totalARS: r.totalARS, senaARS: r.senaARS, invoiceId: r.invoiceId, confirmados: r.confirmados };
  } catch (e) {
    return { ok: false, mensaje: e instanceof Error ? e.message : 'No se pudo registrar la seña.' };
  }
}
