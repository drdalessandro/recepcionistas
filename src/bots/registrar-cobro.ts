/**
 * Bot · Registrar cobro presencial.
 *
 * La recepcionista elige QUÉ se cobra y CON QUÉ medio(s); el sistema calcula el
 * monto (tipo de cliente: FM 20% en sueltas/paquetes; a la carte de miembros
 * Std 10% / Int 15% — PROVISORIO: el mayor, no acumulan) y registra el cobro
 * según el CONTRATO con Administración:
 *
 *  - un ChargeItem por ítem (monto bruto ARS, fecha, servicio, profesional,
 *    linea-comercial);
 *  - UN Invoice `balanced` por MEDIO de pago (pago mixto = N Invoices, cada uno
 *    con su porción, referenciando los MISMOS ChargeItems), medio en la extensión
 *    medio-pago (valueString, códigos canónicos), montos SIEMPRE brutos
 *    (la comisión de MP es un gasto de Administración, nunca se descuenta acá).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Invoice } from '@medplum/fhirtypes';
import { calcularCobro, descuentoALaCarteDe, type ItemCobro } from '../lib/pricing.js';
import { validarMedios } from '../lib/cobros.js';
import { estadoDeCoverage, planCodigoDeCoverage } from '../fhir/coverage.js';
import { getMembresia } from '../config/membresias.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { crearChargeItems, extMedioPago, leerTcVigente, lineaAChargeItem } from './_shared.js';

export interface EntradaRegistrarCobro {
  pacienteRef: string; // "Patient/123"
  items: ItemCobro[];
  /** Pago simple: [{medio, montoARS?}] (monto opcional = total). Mixto: N porciones. */
  medios: Array<{ medio: string; montoARS?: number }>;
  tc?: number;
  /** Clave de idempotencia opcional (reintentos del front no duplican). */
  clave?: string;
  /** true = solo calcula (con descuentos del cliente) sin registrar nada. */
  soloCalcular?: boolean;
}

export interface ResultadoRegistrarCobro {
  ok: boolean;
  mensaje?: string;
  totalARS?: number;
  tcAplicado?: number;
  /** Descuento aplicado por línea (para mostrar en recepción). */
  lineas?: Array<{ descripcion: string; montoARS: number; descuentoPct?: number; descuentoOrigen?: string }>;
  invoices?: Array<{ id: string; medio: string; montoARS: number }>;
  chargeItemIds?: string[];
  yaRegistrado?: boolean;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaRegistrarCobro>,
): Promise<ResultadoRegistrarCobro> {
  const e = event.input;
  try {
    if (!e.pacienteRef?.startsWith('Patient/')) {
      return { ok: false, mensaje: 'Falta el paciente del cobro.' };
    }
    if (!e.items?.length) {
      return { ok: false, mensaje: 'No hay ítems para cobrar.' };
    }

    // Idempotencia (reintentos): si ya se registró esta clave, devolver lo hecho.
    if (e.clave) {
      const previo = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|cobro-${e.clave}-0`);
      if (previo?.id) {
        return { ok: true, yaRegistrado: true, mensaje: 'Este cobro ya estaba registrado.', invoices: [] };
      }
    }

    // 1) Tipo de cliente → descuentos (la recepción NO los elige a mano).
    const pacienteId = e.pacienteRef.split('/')[1]!;
    const paciente = await medplum.readResource('Patient', pacienteId);
    const fm = paciente.extension?.find((x) => x.url === EXT.tipoCliente)?.valueCode === 'FM';

    let aLaCartePct = 0;
    const coberturas = await medplum.searchResources('Coverage', {
      beneficiary: e.pacienteRef,
      status: 'active',
      _count: 20,
    });
    for (const c of coberturas) {
      const estado = estadoDeCoverage(c);
      if (estado.tipo !== 'membresia') {
        continue;
      }
      const codigo = planCodigoDeCoverage(c);
      if (!codigo) {
        continue;
      }
      try {
        const m = getMembresia(codigo);
        aLaCartePct = Math.max(aLaCartePct, descuentoALaCarteDe(m.intensidad));
      } catch {
        // plan desconocido: sin descuento
      }
    }

    // 2) Calcular el cobro (montos brutos, descuentos, splits, USD→ARS al TC).
    const tc = e.tc ?? (await leerTcVigente(medplum));
    const cobro = calcularCobro(e.items, { tc, descuentos: { fm, aLaCartePct } });

    const lineasDTO = cobro.lineas.map((l) => ({
      descripcion: l.descripcion,
      montoARS: l.subtotalARS,
      descuentoPct: l.descuentoPct,
      descuentoOrigen: l.descuentoOrigen,
    }));

    // Solo cotización: monto real (con descuentos del cliente) sin registrar nada.
    if (e.soloCalcular) {
      return { ok: true, totalARS: cobro.totalARS, tcAplicado: cobro.tcAplicado, lineas: lineasDTO };
    }

    // 3) Validar medios (canónicos, suma EXACTA). Pago simple: monto = total.
    const porciones = e.medios.map((m) => ({ medio: m.medio, montoARS: m.montoARS ?? cobro.totalARS }));
    const medios = validarMedios(porciones, cobro.totalARS);
    if (!medios.ok) {
      return { ok: false, mensaje: medios.mensaje };
    }

    // 4) ChargeItems (uno por línea, monto bruto).
    const fecha = new Date().toISOString();
    const chargeItems = await crearChargeItems(medplum, {
      pacienteRef: e.pacienteRef,
      tc,
      fecha,
      lineas: cobro.lineas.map(lineaAChargeItem),
    });

    // 5) Un Invoice `balanced` por medio, referenciando los MISMOS ChargeItems.
    const lineItem: Invoice['lineItem'] = chargeItems.map((ci, i) => ({
      chargeItemReference: { reference: `ChargeItem/${ci.id}`, display: cobro.lineas[i]?.descripcion },
      priceComponent: [
        { type: 'base' as const, amount: { value: cobro.lineas[i]?.subtotalARS ?? 0, currency: 'ARS' as const } },
      ],
    }));

    const invoices: Array<{ id: string; medio: string; montoARS: number }> = [];
    for (const [i, p] of medios.porciones.entries()) {
      const inv = await medplum.createResource<Invoice>({
        resourceType: 'Invoice',
        status: 'balanced',
        date: fecha,
        ...(e.clave ? { identifier: [{ system: SYSTEM.invoice, value: `cobro-${e.clave}-${i}` }] } : {}),
        subject: { reference: e.pacienteRef },
        lineItem,
        totalNet: { value: p.montoARS, currency: 'ARS' },
        totalGross: { value: p.montoARS, currency: 'ARS' },
        extension: [extMedioPago(p.medio), { url: EXT.tcAplicado, valueDecimal: cobro.tcAplicado }],
      });
      if (inv.id) {
        invoices.push({ id: inv.id, medio: p.medio, montoARS: p.montoARS });
      }
    }

    return {
      ok: true,
      totalARS: cobro.totalARS,
      tcAplicado: cobro.tcAplicado,
      lineas: lineasDTO,
      invoices,
      chargeItemIds: chargeItems.map((c) => c.id!).filter(Boolean),
    };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : 'No se pudo registrar el cobro.' };
  }
}
