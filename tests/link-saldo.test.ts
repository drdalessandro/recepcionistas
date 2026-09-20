import { describe, expect, it, vi, afterEach } from 'vitest';
import type { BotEvent, MedplumClient } from '@medplum/core';
import { handler, type EntradaLinkMP } from '../src/bots/link-mercadopago.js';
import { EXT, SYSTEM } from '../src/fhir/identifiers.js';

/**
 * Envío del link del SALDO por WhatsApp.
 *
 * Por qué existe este test: el camino de MercadoPago para el saldo estaba
 * construido desde hacía meses y **no lo usaba nadie**. No había plantilla, ni
 * envío automático, ni recordatorio, ni forma de que la paciente se lo
 * generara: el único que podía era Recepción, copiando una URL a mano de la
 * pantalla del turno. Un camino de cobro que exige copiar y pegar es un camino
 * que no se usa, y la plata queda colgada.
 *
 * Lo que estos casos fijan:
 *  - con `enviar` sale el WhatsApp con el link adentro;
 *  - SIN `enviar` no sale nada (el botón viejo "Link MercadoPago" no puede
 *    empezar a mandar mensajes de un día para el otro);
 *  - el monto sale del Invoice emitido, NUNCA se recalcula (lleva congelado el
 *    TC del día de la reserva);
 *  - un saldo ya pagado o inexistente no manda nada y lo dice.
 */

const APPOINTMENT_ID = 'appt-1';
const MONTO_SALDO = 119_708;

const SECRETS = {
  MERCADOPAGO_ACCESS_TOKEN: { name: 'MERCADOPAGO_ACCESS_TOKEN', valueString: 'APP_USR-x' },
  MP_WEBHOOK_URL: { name: 'MP_WEBHOOK_URL', valueString: 'https://api.example.com/webhooks/mp' },
  TWILIO_ACCOUNT_SID: { name: 'TWILIO_ACCOUNT_SID', valueString: 'AC123' },
  TWILIO_AUTH_TOKEN: { name: 'TWILIO_AUTH_TOKEN', valueString: 'tok' },
  TWILIO_WHATSAPP_FROM: { name: 'TWILIO_WHATSAPP_FROM', valueString: 'whatsapp:+5491100000000' },
} as unknown as BotEvent['secrets'];

/**
 * Un turno confirmado, con paciente, tal como queda tras acreditarse la seña.
 * Lleva el ítem para que `linkSena` también pueda calcular: así el caso de la
 * seña prueba que `enviar` NO la afecta, y no que la seña se rompió sola.
 */
function turno(opts: { conPaciente?: boolean } = {}) {
  return {
    resourceType: 'Appointment',
    id: APPOINTMENT_ID,
    status: 'booked',
    description: 'Cámara Hiperbárica (HBOT) — Monoplaza · 60 min',
    start: '2026-07-31T19:00:00.000Z',
    extension: [
      { url: EXT.itemTipo, valueCode: 'servicio' },
      { url: EXT.itemCodigo, valueString: 'HBOT_MONO' },
    ],
    participant: opts.conPaciente === false ? [] : [{ actor: { reference: 'Patient/p1' }, status: 'accepted' }],
  };
}

/** El Invoice `saldo-{turno}` que emitió confirmarReserva al acreditar la seña. */
function invoiceSaldo(status: 'issued' | 'balanced' | 'cancelled') {
  return {
    resourceType: 'Invoice',
    id: 'inv-saldo',
    status,
    identifier: [{ system: SYSTEM.invoice, value: `saldo-${APPOINTMENT_ID}` }],
    totalGross: { value: MONTO_SALDO, currency: 'ARS' },
    lineItem: [{ chargeItemCodeableConcept: { text: 'Saldo 50% · Cámara Hiperbárica (HBOT) — Monoplaza' } }],
  };
}

function fakeMedplum(opts: { saldo?: ReturnType<typeof invoiceSaldo>; conPaciente?: boolean } = {}) {
  const creadas: Record<string, unknown>[] = [];
  const medplum = {
    readResource: async (tipo: string) =>
      tipo === 'Appointment'
        ? turno({ conPaciente: opts.conPaciente })
        : { resourceType: 'Patient', id: 'p1', telecom: [{ system: 'phone', value: '+5491169315830' }] },
    // La ventana de 24 h mira Communications previas: sin ninguna, cerrada.
    searchResources: async () => [],
    searchOne: async (tipo: string) => (tipo === 'Invoice' ? opts.saldo : undefined),
    createResource: async (r: Record<string, unknown>) => {
      creadas.push(r);
      return { ...r, id: `c${creadas.length}` };
    },
  } as unknown as MedplumClient;
  return { medplum, creadas };
}

/** Las Communication creadas son los mensajes que salieron. */
function mensajes(creadas: Record<string, unknown>[]): string[] {
  return creadas
    .filter((r) => r.resourceType === 'Communication')
    .flatMap((r) => ((r.payload ?? []) as Array<{ contentString?: string }>).map((p) => p.contentString ?? ''));
}

function mockFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('mercadopago.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ init_point: 'https://mp.example/checkout/abc123' }),
      } as unknown as Response;
    }
    return { ok: true, status: 201, json: async () => ({ sid: 'SM1' }), text: async () => '' } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function evento(input: EntradaLinkMP): BotEvent<EntradaLinkMP> {
  return { input, secrets: SECRETS } as unknown as BotEvent<EntradaLinkMP>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('link del saldo · envío por WhatsApp', () => {
  it('con `enviar` manda el link por WhatsApp y lo dice', async () => {
    mockFetch();
    const { medplum, creadas } = fakeMedplum({ saldo: invoiceSaldo('issued') });

    const r = await handler(medplum, evento({ appointmentId: APPOINTMENT_ID, concepto: 'saldo', enviar: true }));

    expect(r.ok).toBe(true);
    expect(r.enviado).toBe(true);
    expect(r.url).toBe('https://mp.example/checkout/abc123');

    const salidos = mensajes(creadas);
    expect(salidos).toHaveLength(1);
    expect(salidos[0]).toContain('https://mp.example/checkout/abc123');
  });

  it('SIN `enviar` genera el link y NO manda ningún mensaje', async () => {
    // Regresión: el botón "Link MercadoPago" ya existía. Sumarle el envío al
    // mismo camino habría hecho que Recepción mandara un WhatsApp sin querer.
    mockFetch();
    const { medplum, creadas } = fakeMedplum({ saldo: invoiceSaldo('issued') });

    const r = await handler(medplum, evento({ appointmentId: APPOINTMENT_ID, concepto: 'saldo' }));

    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://mp.example/checkout/abc123');
    expect(r.enviado).toBeUndefined();
    expect(mensajes(creadas)).toHaveLength(0);
  });

  it('el monto sale del Invoice emitido, no se recalcula', async () => {
    // El Invoice lleva congelado el TC del día de la reserva. Recalcular acá
    // le movería el precio a alguien que ya tiene el turno confirmado.
    const fetchMock = mockFetch();
    const { medplum, creadas } = fakeMedplum({ saldo: invoiceSaldo('issued') });

    const r = await handler(medplum, evento({ appointmentId: APPOINTMENT_ID, concepto: 'saldo', enviar: true }));

    expect(r.montoARS).toBe(MONTO_SALDO);
    const cuerpoMP = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      items: Array<{ unit_price: number }>;
      external_reference: string;
    };
    expect(cuerpoMP.items[0]?.unit_price).toBe(MONTO_SALDO);
    expect(cuerpoMP.external_reference).toBe(`saldo-${APPOINTMENT_ID}`);
    expect(mensajes(creadas)[0]).toContain(MONTO_SALDO.toLocaleString('es-AR'));
  });

  it('el link del saldo NO lleva binary_mode ni vencimiento, al revés que la seña', async () => {
    // El saldo no sostiene ningún lugar: si no entra, el turno sigue en pie y
    // se cobra en el mostrador. No hay nada que liberar a las dos horas.
    const fetchMock = mockFetch();
    const { medplum } = fakeMedplum({ saldo: invoiceSaldo('issued') });

    await handler(medplum, evento({ appointmentId: APPOINTMENT_ID, concepto: 'saldo', enviar: true }));

    const cuerpoMP = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as Record<string, unknown>;
    expect(cuerpoMP.binary_mode).toBeUndefined();
    expect(cuerpoMP.expires).toBeUndefined();
    expect(cuerpoMP.expiration_date_to).toBeUndefined();
  });

  it('un saldo ya pagado no manda nada y lo dice', async () => {
    mockFetch();
    const { medplum, creadas } = fakeMedplum({ saldo: invoiceSaldo('balanced') });

    const r = await handler(medplum, evento({ appointmentId: APPOINTMENT_ID, concepto: 'saldo', enviar: true }));

    expect(r.ok).toBe(false);
    expect(r.enviado).toBe(false);
    expect(r.mensaje).toContain('pagado');
    expect(mensajes(creadas)).toHaveLength(0);
  });

  it('un turno sin saldo emitido no manda nada y lo dice', async () => {
    // Pasa con las teleconsultas (se cobran enteras) y con los turnos cuya
    // seña se cobró con una versión anterior del sistema.
    mockFetch();
    const { medplum, creadas } = fakeMedplum({ saldo: undefined });

    const r = await handler(medplum, evento({ appointmentId: APPOINTMENT_ID, concepto: 'saldo', enviar: true }));

    expect(r.ok).toBe(false);
    expect(r.enviado).toBe(false);
    expect(r.mensaje).toContain('no tiene saldo registrado');
    expect(mensajes(creadas)).toHaveLength(0);
  });

  it('turno sin paciente: el link sirve igual, pero avisa que no se pudo enviar', async () => {
    // Distinguir "no corresponde" de "falló" importa: el link es válido y
    // Recepción lo puede compartir a mano.
    mockFetch();
    const { medplum, creadas } = fakeMedplum({ saldo: invoiceSaldo('issued'), conPaciente: false });

    const r = await handler(medplum, evento({ appointmentId: APPOINTMENT_ID, concepto: 'saldo', enviar: true }));

    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://mp.example/checkout/abc123');
    expect(r.enviado).toBe(false);
    expect(r.mensaje).toContain('no se pudo enviar');
    expect(mensajes(creadas)).toHaveLength(0);
  });

  it('`enviar` no tiene efecto sobre la seña: ese link ya sale solo', async () => {
    // La seña se manda al reservar y de nuevo 60 min antes de vencer (R-19).
    // Un envío manual desde acá duplicaría un mensaje que el sistema ya manda.
    mockFetch();
    const { medplum, creadas } = fakeMedplum({ saldo: invoiceSaldo('issued') });

    const r = await handler(medplum, evento({ appointmentId: APPOINTMENT_ID, concepto: 'sena', enviar: true }));

    // El link de la seña SÍ se genera (si no, este caso pasaría por haberse
    // roto, no por respetar la regla).
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://mp.example/checkout/abc123');
    expect(mensajes(creadas)).toHaveLength(0);
  });
});
