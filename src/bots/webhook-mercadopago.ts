/**
 * Bot · Webhook de MercadoPago.
 *
 * URL pública que MercadoPago llama al cambiar un pago. NO confía en el payload:
 * toma el id del pago y lo VERIFICA contra la API de MP (con el access token).
 * Si además está cargado el secret MERCADOPAGO_WEBHOOK_SECRET (la "clave
 * secreta" del panel de Webhooks), valida la firma `x-signature` antes de nada
 * (mismo patrón opcional que la firma de Twilio en bw-whatsapp-entrante).
 *
 * SEMÁNTICA DE REINTENTOS (importa con plata real): MP reintenta la
 * notificación SOLO si respondemos no-2xx (con backoff, hasta ~24 h). El
 * $execute de Medplum devuelve 200 salvo que el bot LANCE. Por eso acá:
 *  - falla transitoria (falta el token, MP caído, 5xx/429) → THROW: MP
 *    reintenta y el pago no se pierde;
 *  - condición permanente (pago inexistente en esta cuenta, referencia
 *    desconocida, firma inválida) → 200 con motivo: reintentar no cambia nada,
 *    y lo que necesita ojos humanos deja una alerta a Recepción.
 *
 * El destino depende del external_reference del pago:
 *  - `plan-…`  → cuota de membresía/paquete: approved → Invoice `balanced` +
 *    ChargeItem + levanta bloqueo; rejected → Invoice `cancelled` + bloqueo de
 *    reservas (R-11) + alerta a recepción (Task).
 *  - `saldo-…` → saldo de turno: approved → Invoice `balanced`.
 *  - otro id   → seña de turno: approved → confirmarReserva (idempotente).
 * Un pago `refunded` / `charged_back` / `in_mediation` NUNCA pasa en silencio:
 * alerta a Recepción (la devolución se decide a mano; el sistema no descobra).
 *
 * Configurar en MercadoPago (Webhooks en MODO PRODUCTIVO, evento "Pagos") la URL
 * pública del bloque nginx (ver docs/puesta-en-produccion.md § MercadoPago).
 * Requiere el secret MERCADOPAGO_ACCESS_TOKEN.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { validarFirmaMercadoPago } from '../lib/mercadopago.js';
import { confirmarReserva, crearAlertaRecepcion, resolverInvoicePlan } from './_shared.js';

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

  // Firma x-signature (hardening): se valida solo si el secret está cargado.
  // Inválida → 200 a propósito: si lanzáramos, cualquiera que le pegue a la URL
  // pública induciría reintentos; las notificaciones legítimas de MP traen la
  // firma correcta. (Si la clave cargada estuviera MAL, esto descartaría
  // eventos reales: por eso el runbook exige la prueba de humo tras cargarla.)
  const secretoFirma = event.secrets['MERCADOPAGO_WEBHOOK_SECRET']?.valueString;
  if (secretoFirma) {
    const xSig = event.headers?.['x-signature'];
    const xReq = event.headers?.['x-request-id'];
    const valida = validarFirmaMercadoPago({
      xSignature: typeof xSig === 'string' ? xSig : undefined,
      xRequestId: typeof xReq === 'string' ? xReq : undefined,
      dataId: String(paymentId),
      secret: secretoFirma,
    });
    if (!valida) {
      return { ok: false, confirmado: false, motivo: 'firma x-signature inválida: notificación ignorada' };
    }
  }

  const token = event.secrets['MERCADOPAGO_ACCESS_TOKEN']?.valueString;
  if (!token) {
    // Transitorio (config incompleta): lanzar para que MP reintente hasta que
    // el secret esté cargado — antes esto respondía 200 y el pago se perdía.
    throw new Error('Falta el Project Secret MERCADOPAGO_ACCESS_TOKEN: se responde error para que MercadoPago reintente.');
  }

  // Verificación autoritativa contra MP.
  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status === 404) {
    // El pago no existe PARA ESTE TOKEN: típico tráfico del otro entorno (una
    // notificación de la cuenta de prueba con el token productivo cargado, o
    // viceversa). Permanente: reintentar no lo va a hacer aparecer.
    return { ok: true, confirmado: false, motivo: 'pago inexistente en esta cuenta (¿de otro entorno u otra aplicación?): ignorado' };
  }
  if (!resp.ok) {
    // 401/403 = token vencido o mal cargado; 5xx/429 = MP con problemas.
    // En ambos casos el reintento de MP es la red de seguridad.
    throw new Error(`MP payments respondió ${resp.status}: se responde error para que MercadoPago reintente.`);
  }
  const pago = (await resp.json()) as { status?: string; status_detail?: string; external_reference?: string };
  const ref = pago.external_reference;
  if (!ref) {
    return { ok: true, confirmado: false, motivo: 'el pago no tiene external_reference: ignorado' };
  }

  // Plata que VUELVE (devolución, contracargo, mediación): jamás en silencio.
  // El sistema no descobra solo — Recepción decide (devolver sesión, cancelar
  // turno, disputar el contracargo) con el pago a la vista.
  if (pago.status === 'refunded' || pago.status === 'charged_back' || pago.status === 'in_mediation') {
    await crearAlertaRecepcion(medplum, {
      titulo: pago.status === 'refunded' ? 'Pago DEVUELTO en MercadoPago' : 'Contracargo/mediación en MercadoPago',
      detalle: `El pago ${paymentId} (referencia "${ref}") pasó a estado ${pago.status}${
        pago.status_detail ? ` (${pago.status_detail})` : ''
      }. El cobro sigue registrado en el sistema: revisar en el panel de MP y ajustar a mano lo que corresponda (turno, sesiones del plan o saldo).`,
      clave: `mp-devuelto-${paymentId}`,
    });
    return { ok: true, confirmado: false, status: pago.status, motivo: 'alerta a Recepción creada' };
  }

  // Cuotas de membresía / paquete (Invoice pendiente con clave `plan-…`).
  if (ref.startsWith('plan-')) {
    if (pago.status === 'approved') {
      // `secrets`: si el plan estaba pendiente (alta inicial con MP), la
      // activación manda la bienvenida. `mpPaymentId`: huella del pago — un id
      // distinto sobre un Invoice ya saldado = pago doble → alerta.
      const r = await resolverInvoicePlan(medplum, {
        clave: ref,
        resultado: 'pagado',
        secrets: event.secrets,
        mpPaymentId: String(paymentId),
      });
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
      const r = await resolverInvoicePlan(medplum, {
        clave: ref,
        resultado: 'pagado',
        medio: 'mercadopago',
        secrets: event.secrets,
        mpPaymentId: String(paymentId),
      });
      return { ok: r.ok, confirmado: true, status: 'approved', motivo: r.mensaje ?? 'saldo acreditado' };
    }
    return { ok: true, confirmado: false, status: pago.status, motivo: 'saldo sigue pendiente' };
  }

  // Señas de turno (external_reference = appointmentId).
  if (pago.status !== 'approved') {
    return { ok: true, confirmado: false, status: pago.status };
  }
  let r;
  try {
    r = await confirmarReserva(medplum, event.secrets, {
      appointmentId: ref,
      medioPago: 'mercadopago',
      mpPaymentId: String(paymentId),
    });
  } catch (err) {
    // Referencia que no es un turno de este sistema (pago de otra aplicación
    // de la misma cuenta, prueba manual) o turno sin ítem: condición
    // PERMANENTE. Responder error haría a MP reintentar por días; plata real
    // acreditada sin registro va a alerta, nunca en silencio.
    const msg = err instanceof Error ? err.message : String(err);
    if (/not.?found|no encontrado|no tiene ítem/i.test(msg)) {
      await crearAlertaRecepcion(medplum, {
        titulo: 'Pago acreditado SIN registro interno',
        detalle: `MercadoPago acreditó el pago ${paymentId} con referencia "${ref}", pero no corresponde a ningún turno del sistema (${msg}). Verificar el pago en el panel de MP y registrarlo (o devolverlo) a mano.`,
        clave: `pago-sin-turno-${ref}-${paymentId}`,
      });
      return { ok: true, confirmado: false, status: 'approved', motivo: `referencia desconocida (${ref}): alerta a Recepción creada` };
    }
    throw err;
  }
  if (r.rechazado) {
    // Pago tardío (R-19): el turno ya se liberó. La alerta a Recepción ya quedó
    // creada (idempotente); se responde ok para que MP no reintente.
    return { ok: true, confirmado: false, appointmentId: ref, status: 'approved', motivo: r.rechazado };
  }
  return { ok: true, confirmado: true, appointmentId: ref, status: 'approved', motivo: r.yaConfirmado ? 'ya confirmado' : 'confirmado' };
}
