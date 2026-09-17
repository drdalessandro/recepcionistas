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
 * La creación de la preferencia vive en `_shared.crearPreferenciaMP` (la misma
 * que usa el link automático de la reserva). Requiere el secret
 * MERCADOPAGO_ACCESS_TOKEN; si no está, devuelve un aviso claro (el cobro
 * presencial sigue funcionando).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { SYSTEM } from '../fhir/identifiers.js';
import { crearPreferenciaMP, linkSena } from './_shared.js';

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
  /**
   * Compat: el mismo monto que `montoARS` cuando concepto = 'sena'. El nombre
   * quedó de cuando todo era seña del 50%; en un turno virtual trae el TOTAL.
   */
  senaARS?: number;
  url?: string;
}

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaLinkMP>): Promise<ResultadoLinkMP> {
  const appt = await medplum.readResource('Appointment', event.input.appointmentId);
  const concepto = event.input.concepto ?? 'sena';

  if (concepto === 'saldo') {
    // El monto sale del Invoice pendiente emitido al cobrar la seña (no se recalcula).
    const saldoInv = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|saldo-${event.input.appointmentId}`);
    if (!saldoInv) {
      return { ok: false, mensaje: 'Este turno no tiene saldo registrado (¿se cobró la seña con esta versión del sistema?).' };
    }
    if (saldoInv.status !== 'issued') {
      return { ok: false, mensaje: `El saldo ya está ${saldoInv.status === 'balanced' ? 'pagado' : saldoInv.status}.` };
    }
    const montoARS = saldoInv.totalGross?.value ?? 0;
    const pref = await crearPreferenciaMP(event.secrets, {
      titulo: saldoInv.lineItem?.[0]?.chargeItemCodeableConcept?.text ?? `Saldo · ${appt.description ?? 'turno'}`,
      montoARS,
      referencia: `saldo-${event.input.appointmentId}`,
      idempotencia: `saldo-${event.input.appointmentId}`,
      appointmentId: event.input.appointmentId,
    });
    return pref.ok ? { ok: true, montoARS, url: pref.url } : { ok: false, montoARS, mensaje: pref.mensaje };
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
