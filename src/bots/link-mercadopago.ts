/**
 * Bot · Link de pago MercadoPago (seña o saldo restante).
 *
 * Crea una preferencia de checkout de MercadoPago y devuelve el link:
 *  - concepto 'sena' (default): el 50% de seña para confirmar el turno;
 *  - concepto 'saldo': el 50% restante (lee el Invoice pendiente `saldo-{turno}`).
 * Requiere el secret MERCADOPAGO_ACCESS_TOKEN en los Project Secrets; si no está,
 * devuelve un aviso claro (el cobro presencial sigue funcionando).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { calcularSenaARS, type ItemCobro } from '../lib/pricing.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { leerTcVigente } from './_shared.js';

export interface EntradaLinkMP {
  appointmentId: string;
  /** Qué se cobra: la seña del 50% (default) o el saldo restante. */
  concepto?: 'sena' | 'saldo';
  tc?: number;
}

export interface ResultadoLinkMP {
  ok: boolean;
  mensaje?: string;
  /** Monto del link (seña o saldo, según concepto). */
  montoARS?: number;
  /** Compat: monto de la seña cuando concepto = 'sena'. */
  senaARS?: number;
  url?: string;
}

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaLinkMP>): Promise<ResultadoLinkMP> {
  const appt = await medplum.readResource('Appointment', event.input.appointmentId);
  const itemTipo = appt.extension?.find((e) => e.url === EXT.itemTipo)?.valueCode;
  const itemCodigo = appt.extension?.find((e) => e.url === EXT.itemCodigo)?.valueString;
  if (!itemTipo || !itemCodigo) {
    return { ok: false, mensaje: 'El turno no tiene ítem asociado para calcular la seña.' };
  }

  const concepto = event.input.concepto ?? 'sena';
  let montoARS: number;
  let titulo: string;
  let referencia: string;
  if (concepto === 'saldo') {
    // El monto sale del Invoice pendiente emitido al cobrar la seña (no se recalcula).
    const saldoInv = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|saldo-${event.input.appointmentId}`);
    if (!saldoInv) {
      return { ok: false, mensaje: 'Este turno no tiene saldo registrado (¿se cobró la seña con esta versión del sistema?).' };
    }
    if (saldoInv.status !== 'issued') {
      return { ok: false, mensaje: `El saldo ya está ${saldoInv.status === 'balanced' ? 'pagado' : saldoInv.status}.` };
    }
    montoARS = saldoInv.totalGross?.value ?? 0;
    titulo = saldoInv.lineItem?.[0]?.chargeItemCodeableConcept?.text ?? `Saldo · ${appt.description ?? itemCodigo}`;
    referencia = `saldo-${event.input.appointmentId}`;
  } else {
    const tc = event.input.tc ?? (await leerTcVigente(medplum));
    const { senaARS } = calcularSenaARS([{ tipo: itemTipo as ItemCobro['tipo'], codigo: itemCodigo }], { tc });
    montoARS = senaARS;
    titulo = `Seña 50% · ${appt.description ?? itemCodigo}`;
    // Compat con el webhook: las señas viajan con el appointmentId pelado.
    referencia = event.input.appointmentId;
  }

  const token = event.secrets['MERCADOPAGO_ACCESS_TOKEN']?.valueString;
  if (!token) {
    return {
      ok: false,
      montoARS,
      ...(concepto === 'sena' ? { senaARS: montoARS } : {}),
      mensaje: 'MercadoPago no está configurado (falta MERCADOPAGO_ACCESS_TOKEN en Project Secrets).',
    };
  }

  const appUrl = event.secrets['APP_BASE_URL']?.valueString ?? 'https://recepcion.medplum.com.ar';
  const notifUrl = event.secrets['MP_WEBHOOK_URL']?.valueString;

  const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `${concepto}-${event.input.appointmentId}`,
    },
    body: JSON.stringify({
      items: [
        {
          title: titulo,
          quantity: 1,
          unit_price: montoARS,
          currency_id: 'ARS',
        },
      ],
      external_reference: referencia,
      metadata: { appointmentId: event.input.appointmentId },
      back_urls: { success: appUrl, pending: appUrl, failure: appUrl },
      auto_return: 'approved',
      ...(notifUrl ? { notification_url: notifUrl } : {}),
    }),
  });

  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    return { ok: false, montoARS, mensaje: `MercadoPago respondió ${resp.status}: ${detalle.slice(0, 400)}` };
  }
  const pref = (await resp.json()) as { init_point?: string; sandbox_init_point?: string };
  const url = pref.init_point ?? pref.sandbox_init_point;
  if (!url) {
    return { ok: false, montoARS, mensaje: 'MercadoPago no devolvió un link de pago (init_point).' };
  }
  return { ok: true, montoARS, ...(concepto === 'sena' ? { senaARS: montoARS } : {}), url };
}
