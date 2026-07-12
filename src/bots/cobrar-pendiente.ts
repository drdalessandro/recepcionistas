/**
 * Bot · Cobrar en recepción un Invoice pendiente (`issued`).
 *
 * Cierra el circuito R-11 en el mostrador: cuando la cuota de membresía (o el
 * cobro inicial de un plan) quedó `issued` (sin MP configurado, o el paciente
 * prefiere pagar presencial), la recepcionista la cobra eligiendo el medio.
 * Reutiliza `resolverInvoicePlan`: Invoice → `balanced` (monto bruto, medio
 * canónico en valueString), crea el ChargeItem del plan y LEVANTA el bloqueo de
 * reservas si lo había. También recupera un Invoice `cancelled` (regularización
 * después de un rechazo de MP).
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
    if (!clave?.startsWith('plan-')) {
      return { ok: false, mensaje: 'Este Invoice no es una cuota de plan pendiente.' };
    }
    const r = await resolverInvoicePlan(medplum, { clave, resultado: 'pagado', medio: e.medio });
    return { ok: r.ok, invoiceId: r.invoiceId, mensaje: r.mensaje };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : 'No se pudo cobrar el pendiente.' };
  }
}
