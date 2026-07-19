/**
 * Bot · Webhook de MercadoPago.
 *
 * URL pública que MercadoPago llama al cambiar un pago. NO confía en el payload:
 * toma el id del pago y lo VERIFICA contra la API de MP (con el access token).
 *
 * El destino depende del external_reference del pago:
 *  - `plan-…`  → cuota de membresía/paquete: approved → Invoice `balanced` +
 *    ChargeItem + levanta bloqueo; rejected → Invoice `cancelled` + bloqueo de
 *    reservas (R-11) + alerta a recepción (Task).
 *  - otro id   → seña de turno: approved → confirmarReserva (idempotente).
 *
 * Configurar en MercadoPago (Webhooks, evento "Pagos") la URL del $execute de este
 * bot. Requiere el secret MERCADOPAGO_ACCESS_TOKEN.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { confirmarReserva, resolverInvoicePlan } from './_shared.js';

interface NotificacionMP {
  type?: string;
  topic?: string;
  action?: string;
  data?: { id?: string | number };
  id?: string | number;
}

export interface ResultadoWebhook {
  ok: boolean;
  confirmado?: boolean;
  status?: string;
  motivo?: string;
  appointmentId?: string;
}

export async function handler(medplum: MedplumClient, event: BotEvent): Promise<ResultadoWebhook> {
  const body = (event.input ?? {}) as NotificacionMP;
  const tipo = body.type ?? body.topic;
  if (tipo && tipo !== 'payment') {
    return { ok: true, confirmado: false, motivo: `evento ignorado (${tipo})` };
  }
  const paymentId = body.data?.id ?? body.id;
  if (!paymentId) {
    return { ok: true, confirmado: false, motivo: 'sin id de pago' };
  }

  const token = event.secrets['MERCADOPAGO_ACCESS_TOKEN']?.valueString;
  if (!token) {
    return { ok: false, motivo: 'falta MERCADOPAGO_ACCESS_TOKEN' };
  }

  // Verificación autoritativa contra MP.
  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    return { ok: false, motivo: `MP payments respondió ${resp.status}` };
  }
  const pago = (await resp.json()) as { status?: string; status_detail?: string; external_reference?: string };
  const ref = pago.external_reference;
  if (!ref) {
    return { ok: false, motivo: 'el pago no tiene external_reference' };
  }

  // Cuotas de membresía / paquete (Invoice pendiente con clave `plan-…`).
  if (ref.startsWith('plan-')) {
    if (pago.status === 'approved') {
      // `secrets`: si el plan estaba pendiente (alta inicial con MP), la
      // activación manda la bienvenida por WhatsApp.
      const r = await resolverInvoicePlan(medplum, { clave: ref, resultado: 'pagado', secrets: event.secrets });
      return { ok: r.ok, confirmado: true, status: 'approved', motivo: r.mensaje ?? 'cuota acreditada' };
    }
    if (pago.status === 'rejected' || pago.status === 'cancelled') {
      const r = await resolverInvoicePlan(medplum, {
        clave: ref,
        resultado: 'rechazado',
        detalle: `MP: ${pago.status}${pago.status_detail ? ` (${pago.status_detail})` : ''}.`,
        secrets: event.secrets,
      });
      return { ok: r.ok, confirmado: false, status: pago.status, motivo: r.mensaje ?? 'cuota rechazada: bloqueo R-11 aplicado' };
    }
    return { ok: true, confirmado: false, status: pago.status, motivo: 'estado no terminal' };
  }

  // Saldos de turno (Invoice pendiente con clave `saldo-{appointmentId}`).
  // Un rechazo NO cancela ni bloquea (a diferencia de las cuotas de plan): el
  // saldo sigue pendiente y se cobra en el mostrador.
  if (ref.startsWith('saldo-')) {
    if (pago.status === 'approved') {
      const r = await resolverInvoicePlan(medplum, { clave: ref, resultado: 'pagado', medio: 'mercadopago' });
      return { ok: r.ok, confirmado: true, status: 'approved', motivo: r.mensaje ?? 'saldo acreditado' };
    }
    return { ok: true, confirmado: false, status: pago.status, motivo: 'saldo sigue pendiente' };
  }

  // Señas de turno (external_reference = appointmentId).
  if (pago.status !== 'approved') {
    return { ok: true, confirmado: false, status: pago.status };
  }
  const r = await confirmarReserva(medplum, event.secrets, {
    appointmentId: ref,
    medioPago: 'mercadopago',
    mpPaymentId: String(paymentId),
  });
  if (r.rechazado) {
    // Pago tardío (R-19): el turno ya se liberó. La alerta a Recepción ya quedó
    // creada (idempotente); se responde ok para que MP no reintente.
    return { ok: true, confirmado: false, appointmentId: ref, status: 'approved', motivo: r.rechazado };
  }
  return { ok: true, confirmado: true, appointmentId: ref, status: 'approved', motivo: r.yaConfirmado ? 'ya confirmado' : 'confirmado' };
}
