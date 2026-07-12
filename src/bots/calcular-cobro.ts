/**
 * Bot · Calcular cobro.
 *
 * Recibe los ítems a cobrar y devuelve (y persiste) un Invoice con el total en
 * ARS al TC vigente y el desglose de splits en extensiones. La recepción sólo
 * elige el medio de pago: el sistema calcula todo (R-04..R-08, R-17).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Invoice, InvoiceLineItem } from '@medplum/fhirtypes';
import { calcularCobro, type ItemCobro } from '../lib/pricing.js';
import { EXT, esMedioPago } from '../fhir/identifiers.js';
import { extMedioPago, leerTcVigente } from './_shared.js';

export interface EntradaCobro {
  items: ItemCobro[];
  /** Referencia FHIR del paciente, ej. "Patient/123". */
  pacienteRef?: string;
  /** TC explícito; si no, se lee el vigente de configuración. */
  tc?: number;
  /** Medio de pago elegido por la recepción (no afecta el cálculo). */
  medioPago?: string;
  /** Si es false, no persiste el Invoice (sólo lo calcula). Default true. */
  persistir?: boolean;
}

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaCobro>): Promise<Invoice> {
  const entrada = event.input;
  const tc = entrada.tc ?? (await leerTcVigente(medplum));
  const cobro = calcularCobro(entrada.items, { tc });

  const lineItem: InvoiceLineItem[] = cobro.lineas.map((l) => ({
    chargeItemCodeableConcept: { text: l.descripcion },
    priceComponent: [
      {
        type: 'base',
        amount: {
          value: l.moneda === 'ARS' ? l.subtotalARS : l.subtotalUSD,
          currency: l.moneda,
        },
      },
    ],
  }));

  const totalBwUSD = cobro.lineas.reduce((acc, l) => acc + (l.split.bwUSD ?? 0), 0);
  const totalProfUSD = cobro.lineas.reduce(
    (acc, l) => acc + (l.split.prescriptoresUSD ?? l.split.terapeutaUSD ?? l.split.proveedorUSD ?? 0),
    0,
  );

  const invoice: Invoice = {
    resourceType: 'Invoice',
    status: 'issued',
    date: new Date().toISOString(),
    ...(entrada.pacienteRef ? { subject: { reference: entrada.pacienteRef } } : {}),
    lineItem,
    totalNet: { value: cobro.totalARS, currency: 'ARS' },
    totalGross: { value: cobro.totalARS, currency: 'ARS' },
    extension: [
      { url: EXT.tcAplicado, valueDecimal: cobro.tcAplicado },
      { url: EXT.montoSplitBw, valueMoney: { value: round2(totalBwUSD), currency: 'USD' } },
      { url: EXT.montoSplitProfesional, valueMoney: { value: round2(totalProfUSD), currency: 'USD' } },
      // Contrato Administración: medio de pago SOLO por extensión (valueString canónico).
      ...(entrada.medioPago && esMedioPago(entrada.medioPago) ? [extMedioPago(entrada.medioPago)] : []),
    ],
  };

  if (entrada.persistir === false) {
    return invoice;
  }
  return medplum.createResource(invoice);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
