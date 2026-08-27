import { describe, it, expect, vi, afterEach } from 'vitest';
import type { BotEvent, MedplumClient } from '@medplum/core';
import { enviarWhatsApp, enviarEmail } from '../src/bots/_shared.js';
import { SYSTEM } from '../src/fhir/identifiers.js';

/**
 * MODO AVIÓN de los pacientes demo.
 *
 * Los crons (recordatorios, vencimientos, cobros) no distinguen demo de real,
 * y Twilio/SES están operativos: sin este guard, una demo de ocupación manda
 * WhatsApp REALES a números inventados —que pueden ser de gente real— y los
 * emails `@example.com` rebotan en SES dañando la reputación del remitente.
 *
 * El contrato: paciente con tag `demo` → la Communication se registra igual
 * (el hilo se ve vivo, sirve para capacitar) pero NADA sale del edificio, y el
 * mensaje queda etiquetado demo para que la limpieza de 48 h se lo lleve.
 */

const TAG_DEMO = { system: SYSTEM.demo, code: 'demo' };

function fakeMedplum(opts: { demo: boolean; telefono?: string; email?: string }) {
  const creadas: Record<string, unknown>[] = [];
  const sendEmail = vi.fn(async () => ({}) as unknown);
  const medplum = {
    searchResources: async () => [],
    readResource: async () => ({
      resourceType: 'Patient',
      ...(opts.demo ? { meta: { tag: [TAG_DEMO] } } : {}),
      telecom: [
        ...(opts.telefono ? [{ system: 'phone', value: opts.telefono }] : []),
        ...(opts.email ? [{ system: 'email', value: opts.email }] : []),
      ],
    }),
    createResource: async (r: Record<string, unknown>) => {
      creadas.push(r);
      return { ...r, id: `c${creadas.length}` };
    },
    sendEmail,
  } as unknown as MedplumClient;
  return { medplum, creadas, sendEmail };
}

const secretsTwilio = {
  TWILIO_ACCOUNT_SID: { name: 'TWILIO_ACCOUNT_SID', valueString: 'AC123' },
  TWILIO_AUTH_TOKEN: { name: 'TWILIO_AUTH_TOKEN', valueString: 'tok' },
  TWILIO_WHATSAPP_FROM: { name: 'TWILIO_WHATSAPP_FROM', valueString: 'whatsapp:+5491100000000' },
} as unknown as BotEvent['secrets'];

function tieneTagDemo(r: Record<string, unknown>): boolean {
  const meta = r.meta as { tag?: Array<{ system?: string; code?: string }> } | undefined;
  return Boolean(meta?.tag?.some((t) => t.system === TAG_DEMO.system && t.code === TAG_DEMO.code));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('modo avión · WhatsApp', () => {
  it('paciente demo: NO llama a Twilio, pero el hilo muestra el mensaje como enviado', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { medplum, creadas } = fakeMedplum({ demo: true, telefono: '+5491133334444' });

    const c = await enviarWhatsApp(medplum, secretsTwilio, {
      template: 'recordatorio-turno',
      body: 'Te esperamos mañana a las 10:00.',
      pacienteRef: 'Patient/demo1',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    // 'completed', no 'preparation': en el hilo se ve como salido, que es la gracia.
    expect(c.status).toBe('completed');
    // Etiquetada demo: la limpieza de 48 h también se lleva estos mensajes.
    expect(tieneTagDemo(creadas[0]!)).toBe(true);
  });

  it('paciente demo con `to` explícito: tampoco sale (el guard no depende del teléfono)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { medplum } = fakeMedplum({ demo: true, telefono: '+5491133334444' });

    await enviarWhatsApp(medplum, secretsTwilio, {
      template: 'recordatorio-turno',
      body: 'Hola',
      pacienteRef: 'Patient/demo1',
      to: '+5491133334444',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paciente real: Twilio se llama igual que siempre, sin tag demo', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { medplum, creadas } = fakeMedplum({ demo: false, telefono: '+5491133334444' });

    const c = await enviarWhatsApp(medplum, secretsTwilio, {
      template: 'recordatorio-turno',
      body: 'Te esperamos mañana a las 10:00.',
      pacienteRef: 'Patient/p1',
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(c.status).toBe('completed');
    expect(tieneTagDemo(creadas[0]!)).toBe(false);
  });
});

describe('modo avión · email', () => {
  it('paciente demo: NO llama a SES (los @example.com rebotan y dañan la reputación)', async () => {
    const { medplum, creadas, sendEmail } = fakeMedplum({ demo: true, email: 'maria.demo@example.com' });

    const c = await enviarEmail(medplum, {
      asunto: 'Bienvenida',
      cuerpo: 'Hola María',
      template: 'bienvenida-plan',
      pacienteRef: 'Patient/demo1',
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(c.status).toBe('completed');
    expect(tieneTagDemo(creadas[0]!)).toBe(true);
  });

  it('paciente real: SES se llama igual que siempre', async () => {
    const { medplum, creadas, sendEmail } = fakeMedplum({ demo: false, email: 'real@biowellness.ar' });

    await enviarEmail(medplum, {
      asunto: 'Bienvenida',
      cuerpo: 'Hola',
      template: 'bienvenida-plan',
      pacienteRef: 'Patient/p1',
    });

    expect(sendEmail).toHaveBeenCalled();
    expect(tieneTagDemo(creadas[0]!)).toBe(false);
  });
});
