import { describe, expect, it, vi, afterEach } from 'vitest';
import type { BotEvent, MedplumClient } from '@medplum/core';
import { handler, type EntradaCobroMembresias } from '../src/bots/cobro-membresias.js';
import { MEMBRESIAS } from '../src/config/membresias.js';
import { MERCADOPAGO } from '../src/config/reglas.js';
import { EXT } from '../src/fhir/identifiers.js';

/**
 * Regresión: el cron marcaba el ciclo como facturado ANTES de emitir el Invoice.
 *
 * Si el proceso moría entre las dos escrituras, el socio quedaba "facturado"
 * sin factura — y como `debeRenovarMembresia` filtra por ese campo y el cobro
 * solo corre los días 1-5, ese mes no se cobraba nunca y nadie se enteraba.
 */

const PLAN = MEMBRESIAS[0]!;

/** Coverage de una membresía activa que todavía no se facturó este ciclo. */
function coberturaMembresia(cicloRegistrado?: string) {
  return {
    resourceType: 'Coverage',
    id: 'cov1',
    status: 'active',
    beneficiary: { reference: 'Patient/p1' },
    extension: [
      { url: EXT.tipoCobertura, valueCode: 'membresia' },
      { url: EXT.planCodigo, valueString: PLAN.codigo },
      { url: EXT.sesionesMes, valueInteger: PLAN.sesionesMes },
      { url: EXT.sesionesUsadas, valueInteger: 4 },
      ...(cicloRegistrado ? [{ url: EXT.cicloMes, valueString: cicloRegistrado }] : []),
    ],
  };
}

/** Fake que ANOTA el orden de las escrituras. `invoiceExistente` simula una corrida previa. */
function fakeMedplum(opts: { invoiceExistente?: boolean } = {}) {
  const orden: string[] = [];
  const creados: Record<string, unknown>[] = [];
  const medplum = {
    searchResources: async (tipo: string) => (tipo === 'Coverage' ? [coberturaMembresia()] : []),
    searchOne: async (tipo: string) =>
      tipo === 'Invoice' && opts.invoiceExistente ? { resourceType: 'Invoice', id: 'inv-previo' } : undefined,
    readResource: async () => ({ resourceType: 'Patient', id: 'p1', telecom: [] }),
    createResource: async (r: Record<string, unknown>) => {
      orden.push(`crear:${r.resourceType}`);
      creados.push(r);
      return { ...r, id: `x${creados.length}` };
    },
    updateResource: async (r: Record<string, unknown>) => {
      orden.push(`actualizar:${r.resourceType}`);
      return r;
    },
  } as unknown as MedplumClient;
  return { medplum, orden, creados };
}

const evento = (hoy: string): BotEvent<EntradaCobroMembresias> =>
  ({ input: { hoy }, secrets: {} }) as unknown as BotEvent<EntradaCobroMembresias>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cobro-membresias · el ciclo se marca DESPUÉS de que exista la deuda', () => {
  it('emite el Invoice antes de tocar el Coverage', async () => {
    const { medplum, orden } = fakeMedplum();
    await handler(medplum, evento('2026-09-01T12:00:00-03:00'));

    const iInvoice = orden.indexOf('crear:Invoice');
    const iCoverage = orden.indexOf('actualizar:Coverage');
    expect(iInvoice).toBeGreaterThanOrEqual(0);
    expect(iCoverage).toBeGreaterThanOrEqual(0);
    // Si esto se invierte, vuelve la ventana en la que un mes no se cobra nunca.
    expect(iInvoice).toBeLessThan(iCoverage);
  });

  it('si una corrida anterior ya emitió el Invoice, NO lo duplica y marca el ciclo igual', async () => {
    // Escenario del crash: existe el Invoice pero el Coverage quedó sin marcar.
    const { medplum, orden, creados } = fakeMedplum({ invoiceExistente: true });
    const r = await handler(medplum, evento('2026-09-02T12:00:00-03:00'));

    expect(creados.filter((c) => c.resourceType === 'Invoice')).toHaveLength(0);
    // El ciclo SÍ se marca: si no, el cron reintentaría todos los días 1-5.
    expect(orden).toContain('actualizar:Coverage');
    expect(r.omitidas).toBe(1);
  });

  it('fuera de los días 1-5 no hace nada', async () => {
    const { medplum, orden } = fakeMedplum();
    await handler(medplum, evento('2026-09-15T12:00:00-03:00'));
    expect(orden).toHaveLength(0);
  });
});

describe('links de pago · cuotas explícitas', () => {
  it('la preferencia manda payment_methods.installments desde la config', async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) => ({ ok: true, json: async () => ({ init_point: 'https://mp/x' }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { crearPreferenciaMP } = await import('../src/bots/_shared.js');

    await crearPreferenciaMP(
      {
        MERCADOPAGO_ACCESS_TOKEN: { name: 'MERCADOPAGO_ACCESS_TOKEN', valueString: 'tok' },
        MP_WEBHOOK_URL: { name: 'MP_WEBHOOK_URL', valueString: 'https://api/webhooks/mercadopago' },
      } as unknown as BotEvent['secrets'],
      { titulo: 'Seña', montoARS: 1000, referencia: 'r1', idempotencia: 'i1' },
    );

    const init = fetchMock.mock.calls[0]?.[1] as { body: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}');
    // Sin esto, cada link aceptaba el máximo de cuotas que ofreciera la cuenta.
    expect(body.payment_methods.installments).toBe(MERCADOPAGO.maxCuotas);
  });
});
