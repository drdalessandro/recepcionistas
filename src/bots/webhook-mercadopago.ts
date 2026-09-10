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
import type { Coverage } from '@medplum/fhirtypes';
import { validarFirmaMercadoPago } from '../lib/mercadopago.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
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

/** Los eventos de suscripción que este bot entiende (el resto se ignora igual que antes). */
const DE_SUSCRIPCION = ['subscription_authorized_payment', 'subscription_preapproval'];

/** Estados de un débito de suscripción que valen como PLATA ACREDITADA. */
const ACREDITADO = ['approved', 'accredited'];

/** Estados que son un rechazo con nombre y apellido: alguien tiene que mirarlos. */
const RECHAZADO = ['rejected', 'cancelled'];

/**
 * Un débito recurrente de una suscripción de MercadoPago.
 *
 * A diferencia de un pago suelto, esto NO trae un `external_reference` por
 * ciclo: la suscripción lleva uno solo y no cambia. Lo que sí trae es el
 * `preapproval_id`, y con eso se llega a la cobertura (extensión
 * `mp-suscripcion`, que carga Recepción cuando arma la suscripción).
 *
 * De ahí, la cuota que paga es **la más vieja sin pagar** de esa cobertura, que
 * es como funciona cualquier cuenta corriente. Sin cuota abierta no se inventa
 * ninguna: queda un aviso, porque plata que entra sin deuda que la explique es
 * exactamente lo que hay que mirar a mano.
 */
async function debitoDeSuscripcion(medplum: MedplumClient, token: string, id: string): Promise<ResultadoWebhook> {
  const resp = await fetch(`https://api.mercadopago.com/authorized_payments/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status === 404) {
    return { ok: true, confirmado: false, motivo: 'débito inexistente en esta cuenta (¿otro entorno?): ignorado' };
  }
  if (!resp.ok) {
    throw new Error(`MP authorized_payments respondió ${resp.status}: se responde error para que MercadoPago reintente.`);
  }
  const debito = (await resp.json()) as {
    preapproval_id?: string;
    status?: string;
    payment?: { id?: string | number; status?: string };
  };
  const preapproval = debito.preapproval_id;
  if (!preapproval) {
    return { ok: true, confirmado: false, motivo: 'el débito no trae preapproval_id: no se puede atribuir' };
  }

  const cobertura = await coberturaDeSuscripcion(medplum, preapproval);
  if (!cobertura?.id) {
    await crearAlertaRecepcion(medplum, {
      titulo: 'Débito de una suscripción que no está en ninguna cobertura',
      detalle: `Entró un débito de la suscripción ${preapproval} y ninguna cobertura la tiene cargada. Cargá el id de la suscripción en la cobertura que corresponda.`,
      clave: `suscripcion-huerfana-${preapproval}`,
    });
    return { ok: true, confirmado: false, motivo: 'suscripción sin cobertura: alerta a Recepción' };
  }

  const estado = (debito.payment?.status ?? debito.status ?? '').toLowerCase();
  const clave = await claveDeLaCuotaMasVieja(medplum, cobertura);
  if (!clave) {
    await crearAlertaRecepcion(medplum, {
      titulo: 'Débito de suscripción sin cuota que lo explique',
      detalle: `La suscripción ${preapproval} debitó (${estado || 'sin estado'}) y la cobertura ${cobertura.id} no tiene ninguna cuota abierta. Revisalo a mano.`,
      pacienteRef: cobertura.beneficiary?.reference,
      focusRef: `Coverage/${cobertura.id}`,
      clave: `debito-sin-cuota-${id}`,
    });
    return { ok: true, confirmado: false, motivo: 'sin cuota abierta: alerta a Recepción' };
  }

  if (ACREDITADO.includes(estado)) {
    await resolverInvoicePlan(medplum, {
      clave,
      resultado: 'pagado',
      detalle: `Débito automático de la suscripción ${preapproval}.`,
      medio: 'mercadopago',
      ...(debito.payment?.id ? { mpPaymentId: String(debito.payment.id) } : {}),
    });
    return { ok: true, confirmado: true, status: estado };
  }

  if (RECHAZADO.includes(estado)) {
    await resolverInvoicePlan(medplum, { clave, resultado: 'rechazado', detalle: `La suscripción ${preapproval} no pudo debitar (${estado}).` });
    return { ok: true, confirmado: false, status: estado, motivo: 'débito rechazado' };
  }

  // Ni acreditado ni rechazado (programado, en reintento): NO se toca la cuota.
  // Dar por pagada una plata que todavía no entró es peor que esperar el aviso
  // siguiente, y MercadoPago manda uno por cada cambio de estado.
  return { ok: true, confirmado: false, status: estado, motivo: 'débito todavía sin resolver: se espera el aviso siguiente' };
}

/**
 * Un cambio en la suscripción misma: la cancelaron, la pausaron, cambió el monto.
 *
 * No se toca la cobertura desde acá. Que la paciente cancele en MercadoPago no
 * es lo mismo que darla de baja del programa —puede haber deuda, puede querer
 * seguir pagando de otra forma— y esa decisión es de Recepción, no del webhook.
 * Lo que sí se hace es que no pase en silencio.
 */
async function cambioDeSuscripcion(medplum: MedplumClient, token: string, id: string): Promise<ResultadoWebhook> {
  const resp = await fetch(`https://api.mercadopago.com/preapproval/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status === 404) {
    return { ok: true, confirmado: false, motivo: 'suscripción inexistente en esta cuenta: ignorada' };
  }
  if (!resp.ok) {
    throw new Error(`MP preapproval respondió ${resp.status}: se responde error para que MercadoPago reintente.`);
  }
  const suscripcion = (await resp.json()) as { status?: string };
  const estado = (suscripcion.status ?? '').toLowerCase();
  if (estado !== 'cancelled' && estado !== 'paused') {
    return { ok: true, confirmado: false, status: estado, motivo: 'cambio de suscripción sin efecto sobre el cobro' };
  }

  const cobertura = await coberturaDeSuscripcion(medplum, id);
  await crearAlertaRecepcion(medplum, {
    titulo: estado === 'cancelled' ? 'Cancelaron una suscripción de MercadoPago' : 'Pausaron una suscripción de MercadoPago',
    detalle:
      `La suscripción ${id} quedó "${estado}"${cobertura?.id ? ` (cobertura ${cobertura.id})` : ' y no está cargada en ninguna cobertura'}. ` +
      'El plan sigue activo hasta que lo des de baja: decidí si se da de baja, se cobra de otra forma o queda deuda.',
    ...(cobertura?.beneficiary?.reference ? { pacienteRef: cobertura.beneficiary.reference } : {}),
    ...(cobertura?.id ? { focusRef: `Coverage/${cobertura.id}` } : {}),
    clave: `suscripcion-${estado}-${id}`,
  });
  return { ok: true, confirmado: false, status: estado, motivo: 'alerta a Recepción' };
}

/** La cobertura que declara esta suscripción de MercadoPago en `mp-suscripcion`. */
async function coberturaDeSuscripcion(medplum: MedplumClient, preapproval: string): Promise<Coverage | undefined> {
  const coberturas = await medplum.searchResources('Coverage', { _count: 500 });
  return coberturas.find((c) => c.extension?.some((x) => x.url === EXT.mpSuscripcion && x.valueString === preapproval));
}

/**
 * La clave del Invoice de la cuota más vieja sin pagar de una cobertura.
 *
 * La más vieja y no la última: si quedaron dos meses abiertos, el débito de hoy
 * paga el que se debe desde hace más tiempo. Al revés, la deuda vieja no se
 * salda nunca y queda un mes fantasma que nadie va a reclamar.
 */
async function claveDeLaCuotaMasVieja(medplum: MedplumClient, cobertura: Coverage): Promise<string | undefined> {
  const abiertas = await medplum.searchResources('Invoice', { status: 'issued', _sort: 'date', _count: 100 });
  const prefijo = `plan-${cobertura.id}`;
  const suya = abiertas.find((i) =>
    (i.identifier ?? []).some((x) => x.system === SYSTEM.invoice && (x.value ?? '').startsWith(`${prefijo}-`)),
  );
  return suya?.identifier?.find((x) => x.system === SYSTEM.invoice)?.value;
}

export async function handler(medplum: MedplumClient, event: BotEvent): Promise<ResultadoWebhook> {
  const body = (event.input ?? {}) as NotificacionMP;
  const tipo = body.type ?? body.topic;
  // Los débitos de una SUSCRIPCIÓN no llegan como `payment`: MercadoPago los
  // manda como `subscription_authorized_payment`, y los cambios de la
  // suscripción (cancelada, pausada) como `subscription_preapproval`. Hasta acá
  // los dos caían en el "evento ignorado" de abajo, así que un programa mensual
  // debitado por suscripción cobraba la plata y el sistema no se enteraba nunca.
  if (tipo && tipo !== 'payment' && !DE_SUSCRIPCION.includes(tipo)) {
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

  if (tipo === 'subscription_authorized_payment') {
    return debitoDeSuscripcion(medplum, token, String(paymentId));
  }
  if (tipo === 'subscription_preapproval') {
    return cambioDeSuscripcion(medplum, token, String(paymentId));
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
