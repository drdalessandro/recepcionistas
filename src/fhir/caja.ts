/**
 * Caja chica sobre FHIR (transformaciones puras; quien llama hace el I/O).
 *
 *  - Movimiento (egreso/reposicion/ajuste) → `Basic` con code del sistema
 *    SYSTEM.caja. La AccessPolicy de recepción SOLO permite escribir Basic
 *    con ese code: el config del TC (también Basic) queda fuera de alcance.
 *  - Arqueo → `PaymentReconciliation` (ya estaba en la policy de recepción):
 *    period desde el arqueo anterior, contado en paymentAmount, esperado y
 *    diferencia en extensiones. Identifier con fecha para no duplicar.
 *
 * Auditoría: quién y cuándo los pone Medplum solo (meta.author + AuditEvent).
 */
import type { Basic, PaymentReconciliation } from '@medplum/fhirtypes';
import type { MovimientoCaja } from '../lib/caja.js';
import type { ResultadoArqueo } from '../lib/caja.js';
import { TIPOS_MOVIMIENTO_CAJA, type TipoMovimientoCaja } from '../config/caja.js';
import { EXT, SYSTEM } from './identifiers.js';

/** Movimiento → Basic listo para crear. */
export function movimientoABasic(m: MovimientoCaja, fechaISO: string): Basic {
  return {
    resourceType: 'Basic',
    code: {
      coding: [{ system: SYSTEM.caja, code: m.tipo }],
      ...(m.detalle ? { text: m.detalle } : {}),
    },
    created: fechaISO.slice(0, 10),
    extension: [
      { url: EXT.cajaMontoArs, valueDecimal: m.montoARS },
      ...(m.categoria ? [{ url: EXT.cajaCategoria, valueCode: m.categoria }] : []),
      ...(m.autorizado ? [{ url: EXT.cajaAutorizado, valueBoolean: true }] : []),
    ],
  };
}

/** Basic → movimiento (para listar y para derivar el saldo). */
export function basicAMovimiento(b: Basic): MovimientoCaja | undefined {
  const tipo = b.code?.coding?.find((c) => c.system === SYSTEM.caja)?.code as TipoMovimientoCaja | undefined;
  const montoARS = b.extension?.find((e) => e.url === EXT.cajaMontoArs)?.valueDecimal;
  if (!tipo || !(TIPOS_MOVIMIENTO_CAJA as readonly string[]).includes(tipo) || typeof montoARS !== 'number') {
    return undefined;
  }
  return {
    tipo,
    montoARS,
    categoria: b.extension?.find((e) => e.url === EXT.cajaCategoria)?.valueCode,
    detalle: b.code?.text,
    autorizado: b.extension?.find((e) => e.url === EXT.cajaAutorizado)?.valueBoolean === true,
  };
}

/** Arqueo → PaymentReconciliation listo para crear. */
export function arqueoAPaymentReconciliation(
  r: ResultadoArqueo,
  opts: { desdeISO: string; hastaISO: string },
): PaymentReconciliation {
  return {
    resourceType: 'PaymentReconciliation',
    status: 'active',
    // Un arqueo por instante de cierre: el identifier evita duplicados por doble click.
    identifier: [{ system: SYSTEM.caja, value: `arqueo-${opts.hastaISO}` }],
    created: opts.hastaISO,
    period: { start: opts.desdeISO, end: opts.hastaISO },
    outcome: 'complete',
    disposition: r.cuadra
      ? `Arqueo OK: contado $${r.contadoARS.toLocaleString('es-AR')} = esperado.`
      : `DIFERENCIA de $${r.diferenciaARS.toLocaleString('es-AR')} (contado $${r.contadoARS.toLocaleString('es-AR')} vs esperado $${r.esperadoARS.toLocaleString('es-AR')}).`,
    paymentAmount: { value: r.contadoARS, currency: 'ARS' },
    paymentDate: opts.hastaISO.slice(0, 10),
    extension: [
      { url: EXT.cajaEsperado, valueDecimal: r.esperadoARS },
      { url: EXT.cajaDiferencia, valueDecimal: r.diferenciaARS },
    ],
  };
}

/** PaymentReconciliation → datos del arqueo (para el arranque del período siguiente). */
export function reconciliationAArqueo(p: PaymentReconciliation): { contadoARS: number; fechaISO: string } | undefined {
  const contadoARS = p.paymentAmount?.value;
  const fechaISO = p.period?.end ?? p.created;
  if (typeof contadoARS !== 'number' || !fechaISO) {
    return undefined;
  }
  return { contadoARS, fechaISO };
}
