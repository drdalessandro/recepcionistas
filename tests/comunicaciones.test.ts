import { describe, it, expect, vi, afterEach } from 'vitest';
import type { BotEvent, MedplumClient } from '@medplum/core';
import { enviarWhatsApp, enviarEmail, notificarPortal, NOTIFICACION_SYSTEM } from '../src/bots/_shared.js';

/** MedplumClient falso: captura las Communication creadas y espía sendEmail. */
function fakeMedplum(opts: { telefono?: string; email?: string; existente?: Record<string, unknown> } = {}) {
  const creadas: Record<string, unknown>[] = [];
  const sendEmail = vi.fn(async () => ({}) as unknown);
  const searchOne = vi.fn(async () => opts.existente);
  const medplum = {
    readResource: async () => ({
      resourceType: 'Patient',
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
    searchOne,
  } as unknown as MedplumClient;
  return { medplum, creadas, sendEmail, searchOne };
}

const secretsTwilio = {
  TWILIO_ACCOUNT_SID: { name: 'TWILIO_ACCOUNT_SID', valueString: 'AC123' },
  TWILIO_AUTH_TOKEN: { name: 'TWILIO_AUTH_TOKEN', valueString: 'tok' },
  TWILIO_WHATSAPP_FROM: { name: 'TWILIO_WHATSAPP_FROM', valueString: 'whatsapp:+5491100000000' },
} as unknown as BotEvent['secrets'];

const sinSecretos = {} as unknown as BotEvent['secrets'];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('enviarWhatsApp · solo envía con secretos + teléfono', () => {
  it('Con secretos y teléfono: llama a Twilio y la Communication queda "completed"', async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { medplum, creadas } = fakeMedplum({ telefono: '+5491150000000' });

    const comm = await enviarWhatsApp(medplum, secretsTwilio, {
      template: 'recordatorio-turno-24h',
      body: 'hola',
      pacienteRef: 'Patient/p1',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('api.twilio.com');
    expect(comm.status).toBe('completed');
    expect(creadas[0]?.resourceType).toBe('Communication');
  });

  it('Sin secretos: NO llama a Twilio pero igual registra la Communication ("preparation")', async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { medplum } = fakeMedplum({ telefono: '+5491150000000' });

    const comm = await enviarWhatsApp(medplum, sinSecretos, { template: 't', body: 'hola', pacienteRef: 'Patient/p1' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(comm.status).toBe('preparation');
  });

  it('Con secretos pero sin teléfono del paciente: no envía (queda "preparation")', async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { medplum } = fakeMedplum({}); // sin telecom

    const comm = await enviarWhatsApp(medplum, secretsTwilio, { template: 't', body: 'hola', pacienteRef: 'Patient/p1' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(comm.status).toBe('preparation');
  });

  it('Adjunta identifier (dedup) y about cuando se pasan', async () => {
    vi.stubGlobal('fetch', vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Response));
    const { medplum, creadas } = fakeMedplum({ telefono: '+549115' });

    await enviarWhatsApp(medplum, secretsTwilio, {
      template: 't',
      body: 'hola',
      pacienteRef: 'Patient/p1',
      identifier: { system: 'sys', value: 'turno-x-24h' },
      about: 'Appointment/a1',
    });

    const comm = creadas[0] as { identifier?: { value: string }[]; about?: { reference: string }[] };
    expect(comm.identifier?.[0]?.value).toBe('turno-x-24h');
    expect(comm.about?.[0]?.reference).toBe('Appointment/a1');
  });
});

describe('enviarEmail · solo envía con email del paciente', () => {
  it('Con email: llama a sendEmail y queda "completed"', async () => {
    const { medplum, sendEmail } = fakeMedplum({ email: 'pac@example.com' });

    const comm = await enviarEmail(medplum, {
      template: 'recordatorio-turno-24h',
      asunto: 'Recordatorio',
      cuerpo: 'hola',
      pacienteRef: 'Patient/p1',
    });

    expect(sendEmail).toHaveBeenCalledOnce();
    expect(comm.status).toBe('completed');
    expect(comm.extension?.find((e) => e.url.endsWith('/canal'))?.valueCode).toBe('email');
  });

  it('Sin email del paciente: no envía (queda "preparation")', async () => {
    const { medplum, sendEmail } = fakeMedplum({});

    const comm = await enviarEmail(medplum, { template: 't', asunto: 'a', cuerpo: 'hola', pacienteRef: 'Patient/p1' });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(comm.status).toBe('preparation');
  });

  it('Si SES falla: la Communication queda "entered-in-error" (no rompe el flujo)', async () => {
    const { medplum, sendEmail } = fakeMedplum({ email: 'pac@example.com' });
    (sendEmail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('SES down'));

    const comm = await enviarEmail(medplum, { template: 't', asunto: 'a', cuerpo: 'hola', pacienteRef: 'Patient/p1' });

    expect(comm.status).toBe('entered-in-error');
  });
});

describe('notificarPortal · campanita del portal', () => {
  it('Crea la Communication-notificación: in-progress, category propia, subject/recipient = paciente', async () => {
    const { medplum, creadas } = fakeMedplum();

    const comm = await notificarPortal(medplum, {
      tipo: 'reserva-confirmada',
      pacienteRef: 'Patient/p1',
      about: 'Appointment/a1',
      texto: '¡Tu turno quedó confirmado!',
    });

    expect(comm).toBeDefined();
    const c = creadas[0] as {
      status: string;
      subject?: { reference: string };
      recipient?: { reference: string }[];
      category?: { coding?: { system?: string; code?: string }[] }[];
      about?: { reference: string }[];
      partOf?: unknown;
      payload?: { contentString?: string }[];
    };
    expect(c.status).toBe('in-progress'); // no leída
    expect(c.subject?.reference).toBe('Patient/p1');
    expect(c.recipient?.[0]?.reference).toBe('Patient/p1');
    expect(c.category?.[0]?.coding?.[0]?.system).toBe(NOTIFICACION_SYSTEM);
    expect(c.category?.[0]?.coding?.[0]?.code).toBe('reserva-confirmada');
    expect(c.about?.[0]?.reference).toBe('Appointment/a1');
    expect(c.partOf).toBeUndefined(); // sin partOf: nunca aparece en el chat
    expect(c.payload?.[0]?.contentString).toBe('¡Tu turno quedó confirmado!');
  });

  it('Sin pacienteRef: no crea nada y devuelve undefined', async () => {
    const { medplum, creadas } = fakeMedplum();
    const comm = await notificarPortal(medplum, { tipo: 'general', texto: 'hola' });
    expect(comm).toBeUndefined();
    expect(creadas).toHaveLength(0);
  });

  it('Idempotente por identifier: si ya existe, no duplica', async () => {
    const existente = { resourceType: 'Communication', id: 'ya-estaba' };
    const { medplum, creadas, searchOne } = fakeMedplum({ existente });

    const comm = await notificarPortal(medplum, {
      tipo: 'recordatorio',
      pacienteRef: 'Patient/p1',
      texto: 'recordatorio',
      identifier: { system: 'sys', value: 'portal-recordatorio-48h-x' },
    });

    expect(searchOne).toHaveBeenCalledOnce();
    expect((comm as { id?: string })?.id).toBe('ya-estaba');
    expect(creadas).toHaveLength(0);
  });

  it('Si la creación falla: loguea y devuelve undefined (no interrumpe el flujo)', async () => {
    const { medplum } = fakeMedplum();
    (medplum.createResource as unknown as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockRejectedValueOnce(new Error('server down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const comm = await notificarPortal(medplum, { tipo: 'general', pacienteRef: 'Patient/p1', texto: 'x' });

    expect(comm).toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});
