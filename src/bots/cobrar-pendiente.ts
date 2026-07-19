/**
 * Bot · Cobrar en recepción un Invoice pendiente (`issued`).
 *
 * Cubre dos pendientes:
 *  - cuotas de plan (`plan-…`): cierra el circuito R-11 en el mostrador;
 *  - saldos de turno (`saldo-…`): el 50% restante después de la seña.
 * Reutiliza `resolverInvoicePlan`: Invoice → `balanced` (monto bruto, medio
 * canónico en valueString), crea el ChargeItem correspondiente y LEVANTA el
 * bloqueo de reservas si lo había. También recupera un Invoice `cancelled`
 * (regularización después de un rechazo de MP).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { SYSTEM, esMedioPago } from '../fhir/identifiers.js';
import { resolverInvoicePlan } from './_shared.js';

export interface EntradaCobrarPendiente {
  invoiceId: string;
  /** Uno de los 5 medios canónicos. */
  medio: string;
}

export interface ResultadoCobrarPendiente {
  ok: boolean;
  mensaje?: string;
  invoiceId?: string;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaCobrarPendiente>,
): Promise<ResultadoCobrarPendiente> {
  const e = event.input;
  try {
    if (!esMedioPago(e.medio)) {
      return { ok: false, mensaje: `Medio de pago inválido: "${e.medio}".` };
    }
    const invoice = await medplum.readResource('Invoice', e.invoiceId);
    const clave = invoice.identifier?.find((i) => i.system === SYSTEM.invoice)?.value;
    if (!clave?.startsWith('plan-') && !clave?.startsWith('saldo-')) {
      return { ok: false, mensaje: 'Este Invoice no es un pendiente cobrable (cuota de plan o saldo de turno).' };
    }
    // `secrets`: si era un plan pendiente de pago (alta inicial), al cobrarlo
    // en mostrador también se activa y sale la bienvenida.
    const r = await resolverInvoicePlan(medplum, { clave, resultado: 'pagado', medio: e.medio, secrets: event.secrets });
    return { ok: r.ok, invoiceId: r.invoiceId, mensaje: r.mensaje };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : 'No se pudo cobrar el pendiente.' };
  }
}
