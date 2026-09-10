import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Coverage } from '@medplum/fhirtypes';
import { handler, type EntradaCobroProgramas } from '../src/bots/cobro-programas.js';
import { handler as webhook } from '../src/bots/webhook-mercadopago.js';
import { MAXIMO_CICLOS_POR_CORRIDA, ciclosACobrar, cicloDePrograma, claveCicloPrograma } from '../src/lib/programas.js';
import { parseClavePlan } from '../src/lib/planes.js';
import { EXT, SYSTEM } from '../src/fhir/identifiers.js';

/**
 * Cobro recurrente del programa mensual (handoff PB100D §6.10).
 *
 * Hasta acá los programas no se cobraban NUNCA: el cron de membresías los
 * saltea porque su cadencia es otra, y `tests/programas.test.ts` documentaba el
 * hueco esperando esta decisión. La cadencia la fija el brief: cada 30 días
 * desde el alta, no el mes calendario.
 */

const ALTA = '2026-09-01T12:00:00.000Z';
const dia = (n: number): Date => new Date(new Date(ALTA).getTime() + n * 86_400_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('los ciclos de 30 días', () => {
  it('el ciclo 1 es el del alta y no lo cobra el cron', () => {
    expect(cicloDePrograma(ALTA, dia(0))?.numero).toBe(1);
    expect(cicloDePrograma(ALTA, dia(29))?.numero).toBe(1);
    expect(ciclosACobrar(ALTA, dia(0))).toStrictEqual([]);
    expect(ciclosACobrar(ALTA, dia(29))).toStrictEqual([]);
  });

  it('el día 30 arranca el ciclo 2: el primero que cobra el cron', () => {
    expect(cicloDePrograma(ALTA, dia(30))?.numero).toBe(2);
    expect(ciclosACobrar(ALTA, dia(30)).map((c) => c.numero)).toStrictEqual([2]);
  });

  // Si el bot estuvo caído, el ciclo que pasó igual se cobra. Con "sólo el
  // actual" ese mes no se cobraría nunca y nadie se enteraría.
  it('se pone al día con los ciclos que se perdió', () => {
    expect(ciclosACobrar(ALTA, dia(95)).map((c) => c.numero)).toStrictEqual([2, 3, 4]);
  });

  it('un período disparatado no genera cuarenta facturas de una vez', () => {
    const muchos = ciclosACobrar(ALTA, dia(30 * 40));
    expect(muchos).toHaveLength(MAXIMO_CICLOS_POR_CORRIDA);
    expect(muchos.at(-1)?.numero).toBe(41);
  });

  // Cobrar antes de que el plan empiece no es un caso: es un dato mal cargado.
  it('una fecha anterior al alta no da ciclo 0 ni negativo', () => {
    expect(cicloDePrograma(ALTA, dia(-5))).toBeUndefined();
    expect(ciclosACobrar(ALTA, dia(-5))).toStrictEqual([]);
    expect(ciclosACobrar(undefined, dia(60))).toStrictEqual([]);
  });

  it('la clave del ciclo se parsea de vuelta sin confundirse con un UUID', () => {
    const uuid = 'a1e8c662-48c1-4495-b32e-685f8a78be2f';
    expect(parseClavePlan(`plan-${uuid}-c3`)).toStrictEqual({ coverageId: uuid, ciclo: 'c3' });
    expect(parseClavePlan(`plan-${uuid}-2026-09`)).toStrictEqual({ coverageId: uuid, ciclo: '2026-09' });
    expect(parseClavePlan(`plan-${uuid}`)).toStrictEqual({ coverageId: uuid, ciclo: undefined });
  });
});

/** Coverage de programa, con o sin suscripción de MP armada. */
function coberturaPrograma(codigo: string, opts: { suscripcion?: string } = {}): Coverage {
  return {
    resourceType: 'Coverage',
    id: 'cov-prog',
    status: 'active',
    beneficiary: { reference: 'Patient/p1' },
    payor: [{ reference: 'Patient/p1' }],
    period: { start: ALTA },
    extension: [
      { url: EXT.tipoCobertura, valueCode: 'programa' },
      { url: EXT.planCodigo, valueString: codigo },
      ...(opts.suscripcion ? [{ url: EXT.mpSuscripcion, valueString: opts.suscripcion }] : []),
    ],
  } as Coverage;
}

function fakeMedplum(coberturas: Coverage[], opts: { invoiceExistente?: boolean } = {}) {
  const creados: Record<string, unknown>[] = [];
  const medplum = {
    searchResources: async (tipo: string) => (tipo === 'Coverage' ? coberturas : []),
    searchOne: async (tipo: string) =>
      tipo === 'Invoice' && opts.invoiceExistente ? { resourceType: 'Invoice', id: 'inv-previo' } : undefined,
    readResource: async () => ({ resourceType: 'Patient', id: 'p1', telecom: [] }),
    createResource: async (r: Record<string, unknown>) => {
      creados.push(r);
      return { ...r, id: `x${creados.length}` };
    },
    updateResource: async (r: Record<string, unknown>) => r,
  } as unknown as MedplumClient;
  return { medplum, creados };
}

const evento = (hoy: Date): BotEvent<EntradaCobroProgramas> =>
  ({ input: { hoy: hoy.toISOString() }, secrets: {} }) as unknown as BotEvent<EntradaCobroProgramas>;

const facturas = (creados: Record<string, unknown>[]) => creados.filter((c) => c.resourceType === 'Invoice');
const avisos = (creados: Record<string, unknown>[]) => creados.filter((c) => c.resourceType === 'Task');

describe('bw-cobro-programas', () => {
  it('cobra el mensual recién en el día 30, no antes', async () => {
    const antes = fakeMedplum([coberturaPrograma('PB100D_PREMIUM_MENSUAL')]);
    await handler(antes.medplum, evento(dia(29)));
    expect(facturas(antes.creados)).toHaveLength(0);

    const despues = fakeMedplum([coberturaPrograma('PB100D_PREMIUM_MENSUAL')]);
    const r = await handler(despues.medplum, evento(dia(30)));
    expect(r.cobrados).toBe(1);
    const inv = facturas(despues.creados)[0] as { identifier?: { value?: string }[]; status?: string };
    expect(inv.identifier?.[0]?.value).toBe(`plan-cov-prog-${claveCicloPrograma(2)}`);
    // `issued`, no `balanced`: pone la deuda, la plata la debita MercadoPago.
    expect(inv.status).toBe('issued');
  });

  // El de 100 días se pagó entero en el alta y su Coverage vence solo.
  it('NO cobra el de pago único', async () => {
    const { medplum, creados } = fakeMedplum([coberturaPrograma('PB100D_PREMIUM_100D')]);
    const r = await handler(medplum, evento(dia(60)));
    expect(r.cobrados).toBe(0);
    expect(facturas(creados)).toHaveLength(0);
  });

  it('no toca las membresías: ésas son del otro cron', async () => {
    const membresia = {
      resourceType: 'Coverage',
      id: 'cov-mem',
      status: 'active',
      beneficiary: { reference: 'Patient/p1' },
      period: { start: ALTA },
      extension: [
        { url: EXT.tipoCobertura, valueCode: 'membresia' },
        { url: EXT.planCodigo, valueString: 'PRIME_STD_IND' },
      ],
    } as Coverage;
    const { medplum, creados } = fakeMedplum([membresia]);
    await handler(medplum, evento(dia(60)));
    expect(facturas(creados)).toHaveLength(0);
  });

  it('correrlo de más no cobra de más', async () => {
    const { medplum, creados } = fakeMedplum([coberturaPrograma('PB100D_PREMIUM_MENSUAL')], { invoiceExistente: true });
    const r = await handler(medplum, evento(dia(30)));
    expect(r.cobrados).toBe(0);
    expect(r.omitidos).toBe(1);
    expect(facturas(creados)).toHaveLength(0);
  });

  // Mejor una deuda visible que una plata que nadie va a ir a pedir.
  it('sin suscripción armada, factura igual y avisa a Recepción', async () => {
    const { medplum, creados } = fakeMedplum([coberturaPrograma('PB100D_PREMIUM_MENSUAL')]);
    const r = await handler(medplum, evento(dia(30)));
    expect(r.cobrados).toBe(1);
    expect(r.sinSuscripcion).toBe(1);
    expect(JSON.stringify(avisos(creados))).toContain('sin suscripción');
  });

  it('con la suscripción armada no molesta a nadie', async () => {
    const { medplum, creados } = fakeMedplum([coberturaPrograma('PB100D_PREMIUM_MENSUAL', { suscripcion: 'pre-1' })]);
    const r = await handler(medplum, evento(dia(30)));
    expect(r.cobrados).toBe(1);
    expect(r.sinSuscripcion).toBe(0);
    expect(avisos(creados)).toHaveLength(0);
  });

  // `getPrograma` lanzaría y cortaría la corrida: las demás pacientes se
  // quedarían sin cobrar por culpa de un código mal cargado en una.
  it('un código que no existe avisa y NO corta la corrida', async () => {
    const rota = coberturaPrograma('NO_EXISTE');
    const buena = { ...coberturaPrograma('PB100D_PREMIUM_MENSUAL'), id: 'cov-ok' } as Coverage;
    const { medplum, creados } = fakeMedplum([rota, buena]);
    const r = await handler(medplum, evento(dia(30)));
    expect(r.cobrados, 'la segunda cobertura se cobró igual').toBe(1);
    expect(JSON.stringify(avisos(creados))).toContain('no existe en el catálogo');
  });
});

// ---------------------------------------------------------------------------
// El webhook: los débitos de una suscripción no llegan como `payment`.
// ---------------------------------------------------------------------------

const CUOTA_VIEJA = 'plan-cov-prog-c2';

/**
 * Fake con una cuota abierta.
 *
 * Lleva `patchResource` a propósito: `resolverInvoicePlan` salda con un
 * JSONPatch `test`+`replace` (el candado atómico contra dos webhooks a la vez).
 * Sin ese método el fake lanza, el código cree que ganó otra invocación y el
 * test pasaría por el camino equivocado sin saldar nada.
 */
function fakeConCuota(coberturas: Coverage[]) {
  const actualizados: Record<string, unknown>[] = [];
  const creados: Record<string, unknown>[] = [];
  const cuota: Record<string, unknown> = {
    resourceType: 'Invoice',
    id: 'inv-2',
    status: 'issued',
    subject: { reference: 'Patient/p1' },
    identifier: [{ system: SYSTEM.invoice, value: CUOTA_VIEJA }],
    totalGross: { value: 100000, currency: 'ARS' },
  };
  const medplum = {
    searchResources: async (tipo: string) => (tipo === 'Coverage' ? coberturas : tipo === 'Invoice' ? [cuota] : []),
    searchOne: async (tipo: string) => (tipo === 'Invoice' ? cuota : undefined),
    readResource: async (tipo: string) =>
      tipo === 'Invoice' ? cuota : tipo === 'Coverage' ? coberturas[0] : { resourceType: 'Patient', id: 'p1', telecom: [] },
    patchResource: async (_t: string, _id: string, ops: { op: string; path: string; value?: unknown }[]) => {
      for (const op of ops) {
        if (op.op === 'test' && cuota[op.path.slice(1)] !== op.value) {
          throw new Error('el candado no dio');
        }
        if (op.op === 'replace') {
          cuota[op.path.slice(1)] = op.value;
        }
      }
      return cuota;
    },
    createResource: async (r: Record<string, unknown>) => {
      creados.push(r);
      return { ...r, id: `x${creados.length}` };
    },
    updateResource: async (r: Record<string, unknown>) => {
      actualizados.push(r);
      return r;
    },
  } as unknown as MedplumClient;
  return { medplum, creados, actualizados, cuota };
}

const eventoMP = (tipo: string, id: string) =>
  ({ input: { type: tipo, data: { id } }, secrets: { MERCADOPAGO_ACCESS_TOKEN: { valueString: 'tok' } }, headers: {} }) as never;

/** Respuestas de la API de MP, por URL. */
function stubMP(porUrl: Record<string, unknown>): void {
  vi.stubGlobal('fetch', async (url: string) => {
    const cuerpo = Object.entries(porUrl).find(([k]) => String(url).includes(k))?.[1];
    return cuerpo
      ? { ok: true, status: 200, json: async () => cuerpo }
      : { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('webhook · débito de una suscripción', () => {
  it('un débito acreditado salda la cuota más vieja abierta', async () => {
    stubMP({ '/authorized_payments/': { preapproval_id: 'pre-1', status: 'processed', payment: { id: 987, status: 'approved' } } });
    const { medplum, actualizados } = fakeConCuota([coberturaPrograma('PB100D_PREMIUM_MENSUAL', { suscripcion: 'pre-1' })]);
    const r = await webhook(medplum, eventoMP('subscription_authorized_payment', '55'));
    expect(r.confirmado).toBe(true);
    const inv = actualizados.find((x) => x.resourceType === 'Invoice') as { status?: string } | undefined;
    expect(inv?.status, 'la cuota tiene que quedar paga').toBe('balanced');
  });

  // Dar por pagada una plata que todavía no entró es peor que esperar: MP manda
  // un aviso por cada cambio de estado.
  it('un débito programado o en reintento NO salda nada', async () => {
    stubMP({ '/authorized_payments/': { preapproval_id: 'pre-1', status: 'scheduled', payment: { status: 'pending' } } });
    const { medplum, actualizados } = fakeConCuota([coberturaPrograma('PB100D_PREMIUM_MENSUAL', { suscripcion: 'pre-1' })]);
    const r = await webhook(medplum, eventoMP('subscription_authorized_payment', '55'));
    expect(r.confirmado).toBe(false);
    expect(actualizados.filter((x) => x.resourceType === 'Invoice')).toHaveLength(0);
  });

  it('un débito de una suscripción que no está en ninguna cobertura avisa a Recepción', async () => {
    stubMP({ '/authorized_payments/': { preapproval_id: 'pre-huerfana', payment: { status: 'approved' } } });
    const { medplum, creados } = fakeConCuota([coberturaPrograma('PB100D_PREMIUM_MENSUAL', { suscripcion: 'otra' })]);
    const r = await webhook(medplum, eventoMP('subscription_authorized_payment', '55'));
    expect(r.confirmado).toBe(false);
    expect(JSON.stringify(creados.filter((c) => c.resourceType === 'Task'))).toContain('no está en ninguna cobertura');
  });

  // El plan sigue activo hasta que Recepción lo dé de baja: puede haber deuda o
  // querer pagar de otra forma. Esa decisión no es del webhook.
  it('cancelar la suscripción en MP avisa, pero no da de baja el plan solo', async () => {
    stubMP({ '/preapproval/': { status: 'cancelled' } });
    const cobertura = coberturaPrograma('PB100D_PREMIUM_MENSUAL', { suscripcion: 'pre-1' });
    const { medplum, creados, actualizados } = fakeConCuota([cobertura]);
    await webhook(medplum, eventoMP('subscription_preapproval', 'pre-1'));
    expect(JSON.stringify(creados.filter((c) => c.resourceType === 'Task'))).toContain('Cancelaron');
    expect(actualizados.filter((x) => x.resourceType === 'Coverage')).toHaveLength(0);
  });

  it('lo que no es de suscripción ni de pago se sigue ignorando', async () => {
    const { medplum } = fakeConCuota([]);
    const r = await webhook(medplum, eventoMP('merchant_order', '1'));
    expect(r.motivo).toContain('evento ignorado');
  });
});
