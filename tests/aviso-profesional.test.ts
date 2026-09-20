/**
 * Avisos al PROFESIONAL (Andrés, 2026-09-20): reserva confirmada, recordatorio
 * de 2 h y "tu paciente está en la sala".
 *
 * Lo que se prueba acá es lo que solo existe en los bots: de dónde sale el
 * contacto (Project Secrets, no `Practitioner.telecom`), que sin contacto no
 * pasa nada y no es error, que un reintento no avisa dos veces, y que un canal
 * caído no frena al otro. Los textos se prueban en `teleconsulta.test.ts`.
 *
 * Cierra con el bot de presencia de punta a punta: el paciente entra a la sala
 * y al médico le llega el WhatsApp y el email con el nombre del paciente y el
 * link al Dashboard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, Communication, Resource } from '@medplum/fhirtypes';
import { EXT, SYSTEM } from '../src/fhir/identifiers.js';
import { practitionerCodigoDeTurno } from '../src/fhir/appointment.js';
import { avisoProfesionalReserva } from '../src/lib/teleconsulta.js';
import { avisarProfesional, contactoProfesional, dashboardUrl } from '../src/bots/_shared.js';
import { handler as presencia } from '../src/bots/teleconsulta-presencia.js';

const MEDICO = 'MED_DALESSANDRO';
const CELULAR = '+5491155550000';
const EMAIL = 'medico@example.com';
const SALA = 'tc-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

type Secretos = BotEvent['secrets'];

function secretos(extra: Record<string, string> = {}): Secretos {
  const base: Record<string, string> = {
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 'tok',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+5491100000000',
    TWILIO_CONTENT_SID_GENERICO: 'HXgenerico',
    ...extra,
  };
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { name: k, valueString: v }])) as unknown as Secretos;
}

const CON_CONTACTO = { [`PROFESIONAL_WHATSAPP_${MEDICO}`]: CELULAR, [`PROFESIONAL_EMAIL_${MEDICO}`]: EMAIL };

/** Twilio siempre acepta, salvo que se pida lo contrario. */
function mockFetch(opts: { twilio?: 'ok' | 'rechaza' } = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string | URL) => {
    if (String(url).includes('twilio.com') && opts.twilio === 'rechaza') {
      return { ok: false, status: 400, text: async () => '{"code":63016}' } as unknown as Response;
    }
    return { ok: true, status: 201, json: async () => ({ sid: 'SM1' }), text: async () => '' } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Lo que se le mandó a Twilio, decodificado. */
function envioTwilio(fn: ReturnType<typeof vi.fn>): Record<string, string> | undefined {
  const llamada = fn.mock.calls.find(([url]) => String(url).includes('twilio.com'));
  if (!llamada) {
    return undefined;
  }
  return Object.fromEntries(new URLSearchParams((llamada[1] as RequestInit).body as URLSearchParams));
}

/**
 * Un Medplum de memoria: guarda lo que se crea y responde la idempotencia por
 * identifier, que es lo que estos avisos necesitan del servidor.
 */
function fakeMedplum(opts: { appt?: Appointment } = {}): {
  medplum: MedplumClient;
  creados: Resource[];
  emails: Array<{ to: string; subject: string; text: string }>;
} {
  const creados: Resource[] = [];
  const emails: Array<{ to: string; subject: string; text: string }> = [];
  const medplum = {
    readResource: async (tipo: string, id: string) => {
      if (tipo === 'Appointment' && opts.appt) {
        return opts.appt;
      }
      if (tipo === 'Patient') {
        return { resourceType: 'Patient', id, name: [{ given: ['Ana'], family: 'Pérez' }] };
      }
      throw new Error('not found');
    },
    searchOne: async (tipo: string, query: string) => {
      if (tipo !== 'Communication') {
        return undefined;
      }
      const valor = /identifier=[^|]+\|(.+)$/.exec(query)?.[1];
      return creados.find(
        (r) => r.resourceType === 'Communication' && (r as Communication).identifier?.some((i) => i.value === valor),
      );
    },
    searchResources: async () => [],
    createResource: async (r: Resource) => {
      const creado = { ...r, id: (r as { id?: string }).id ?? `id-${creados.length + 1}` } as Resource;
      creados.push(creado);
      return creado;
    },
    updateResource: async (r: Resource) => r,
    sendEmail: async (m: { to: string; subject: string; text: string }) => {
      emails.push(m);
    },
  } as unknown as MedplumClient;
  return { medplum, creados, emails };
}

function turnoDe(codigo: string, over: Partial<Appointment> = {}): Appointment {
  const ahora = Date.now();
  return {
    resourceType: 'Appointment',
    id: 'a1',
    status: 'booked',
    description: "Teleconsulta PREAPERTURA — Dr. D'Alessandro",
    start: new Date(ahora).toISOString(),
    end: new Date(ahora + 20 * 60_000).toISOString(),
    participant: [
      { actor: { reference: 'Patient/p1' }, status: 'accepted' },
      { actor: { reference: 'Practitioner/d1' }, status: 'accepted' },
    ],
    extension: [
      { url: EXT.itemTipo, valueCode: 'servicio' },
      { url: EXT.itemCodigo, valueString: codigo },
      { url: EXT.teleconsultaSala, valueString: SALA },
    ],
    ...over,
  };
}

const aviso = avisoProfesionalReserva({
  paciente: 'Ana Pérez',
  cuando: 'lunes 16/10 19:00',
  servicio: 'Teleconsulta',
  modalidad: 'virtual',
  link: 'https://dashboard.biowellness.ar',
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('contacto del profesional · Project Secrets, no Practitioner.telecom', () => {
  it('sale de PROFESIONAL_WHATSAPP_<código> y PROFESIONAL_EMAIL_<código>', () => {
    expect(contactoProfesional(secretos(CON_CONTACTO), MEDICO)).toEqual({ whatsapp: CELULAR, email: EMAIL });
  });

  it('sin secrets no hay contacto, y un secret en blanco tampoco cuenta', () => {
    expect(contactoProfesional(secretos(), MEDICO)).toEqual({});
    expect(contactoProfesional(secretos({ [`PROFESIONAL_WHATSAPP_${MEDICO}`]: '   ' }), MEDICO)).toEqual({});
  });

  it('el Dashboard tiene default y el secret lo pisa', () => {
    expect(dashboardUrl(secretos())).toBe('https://dashboard.biowellness.ar');
    expect(dashboardUrl(secretos({ DASHBOARD_BASE_URL: 'https://dash.example' }))).toBe('https://dash.example');
  });

  it('el código del profesional sale del ítem cobrado del turno', () => {
    expect(practitionerCodigoDeTurno(turnoDe('TELECONSULTA_PREAPERTURA_MED_DALESSANDRO'))).toBe(MEDICO);
    expect(practitionerCodigoDeTurno(turnoDe('CONSULTA_MED_DALESSANDRO'))).toBe(MEDICO);
    // Una terapia no tiene profesional; un código desconocido tampoco rompe.
    expect(practitionerCodigoDeTurno(turnoDe('HBOT_MULTIPLAZA_PREAPERTURA'))).toBeUndefined();
    expect(practitionerCodigoDeTurno(turnoDe('NO_EXISTE'))).toBeUndefined();
    expect(practitionerCodigoDeTurno({ resourceType: 'Appointment', status: 'booked', participant: [] })).toBeUndefined();
  });
});

describe('avisarProfesional', () => {
  const base = { practitionerCodigo: MEDICO, clave: 'prof-reserva-a1', template: 'profesional-reserva', aviso };

  it('con contacto manda WhatsApp (por la genérica) y email, y lo dice', async () => {
    const fetch = mockFetch();
    const { medplum, creados, emails } = fakeMedplum();

    const r = await avisarProfesional(medplum, secretos(CON_CONTACTO), { ...base, about: 'Appointment/a1' });

    expect(r).toEqual({ whatsapp: true, email: true, omitido: false });
    const twilio = envioTwilio(fetch);
    expect(twilio?.To).toBe(`whatsapp:${CELULAR}`);
    // Fuera de la ventana de 24 h (él no nos escribió): plantilla genérica con
    // el cuerpo entero como única variable.
    expect(twilio?.ContentSid).toBe('HXgenerico');
    expect(twilio?.ContentVariables).toContain('Te reservaron una teleconsulta');
    expect(emails).toHaveLength(1);
    expect(emails[0]?.to).toBe(EMAIL);
    expect(emails[0]?.subject).toContain('Nueva teleconsulta');
    // Dos Communication (una por canal) y la marca de idempotencia en UNA sola.
    const comms = creados.filter((c): c is Communication => c.resourceType === 'Communication');
    expect(comms).toHaveLength(2);
    expect(comms.filter((c) => c.identifier?.some((i) => i.value === 'prof-reserva-a1'))).toHaveLength(1);
    expect(comms.every((c) => c.about?.[0]?.reference === 'Appointment/a1')).toBe(true);
  });

  it('sin contacto no manda nada, no crea nada y NO es error', async () => {
    const fetch = mockFetch();
    const { medplum, creados, emails } = fakeMedplum();

    const r = await avisarProfesional(medplum, secretos(), base);

    expect(r).toEqual({ whatsapp: false, email: false, omitido: 'sin-contacto' });
    expect(fetch).not.toHaveBeenCalled();
    expect(emails).toHaveLength(0);
    expect(creados).toHaveLength(0);
  });

  it('un reintento con la misma clave no avisa dos veces', async () => {
    // El webhook de MercadoPago reenvía notificaciones: sin esto, cada reenvío
    // sería un WhatsApp más al médico por la misma reserva.
    const fetch = mockFetch();
    const { medplum, emails } = fakeMedplum();

    await avisarProfesional(medplum, secretos(CON_CONTACTO), base);
    const r = await avisarProfesional(medplum, secretos(CON_CONTACTO), base);

    expect(r).toEqual({ whatsapp: false, email: false, omitido: 'ya-avisado' });
    expect(fetch.mock.calls.filter(([u]) => String(u).includes('twilio.com'))).toHaveLength(1);
    expect(emails).toHaveLength(1);
  });

  it('con email solo, la marca de idempotencia viaja en el email', async () => {
    // Si solo hubiera email y la marca fuera solo del WhatsApp, un reintento
    // mandaría el email de nuevo.
    mockFetch();
    const { medplum, creados, emails } = fakeMedplum();
    const soloEmail = secretos({ [`PROFESIONAL_EMAIL_${MEDICO}`]: EMAIL });

    await avisarProfesional(medplum, soloEmail, base);
    const r = await avisarProfesional(medplum, soloEmail, base);

    expect(emails).toHaveLength(1);
    expect(r.omitido).toBe('ya-avisado');
    const comm = creados.find((c): c is Communication => c.resourceType === 'Communication');
    expect(comm?.identifier?.[0]?.value).toBe('prof-reserva-a1');
  });

  it('si Twilio rechaza, el email sale igual y el resultado lo cuenta', async () => {
    mockFetch({ twilio: 'rechaza' });
    const { medplum, emails } = fakeMedplum();

    const r = await avisarProfesional(medplum, secretos(CON_CONTACTO), base);

    expect(r).toEqual({ whatsapp: false, email: true, omitido: false });
    expect(emails).toHaveLength(1);
  });
});

describe('bw-teleconsulta-presencia · el paciente entra y al médico le llega', () => {
  it('WhatsApp y email al profesional, con el nombre del paciente y el link al Dashboard', async () => {
    const fetch = mockFetch();
    const appt = turnoDe('TELECONSULTA_PREAPERTURA_MED_DALESSANDRO');
    const { medplum, creados, emails } = fakeMedplum({ appt });
    const secrets = secretos({ ...CON_CONTACTO, RECEPCION_WHATSAPP_TO: '+5491144440000' });

    const r = await presencia(medplum, {
      input: { appointmentId: 'a1', rol: 'paciente', pacienteRef: 'Patient/p1' },
      secrets,
    } as unknown as BotEvent<never>);

    expect(r.ok).toBe(true);
    expect(r.estado).toBe('arrived');
    // A Recepción (el de siempre) Y al profesional: dos WhatsApps distintos.
    const destinos = fetch.mock.calls
      .filter(([u]) => String(u).includes('twilio.com'))
      .map(([, init]) => Object.fromEntries(new URLSearchParams((init as RequestInit).body as URLSearchParams)).To);
    expect(destinos).toEqual([`whatsapp:+5491144440000`, `whatsapp:${CELULAR}`]);
    expect(emails).toHaveLength(1);
    expect(emails[0]?.text).toContain('Ana Pérez');
    expect(emails[0]?.text).toContain('https://dashboard.biowellness.ar');
    // El asunto no nombra al paciente: se lee en la pantalla bloqueada.
    expect(emails[0]?.subject).not.toContain('Pérez');
    // Idempotente por turno: la clave quedó registrada.
    expect(
      creados.some(
        (c) => c.resourceType === 'Communication' && (c as Communication).identifier?.some((i) => i.value === 'tc-en-linea-prof-a1'),
      ),
    ).toBe(true);
    expect(creados.some((c) => c.resourceType === 'Task')).toBe(true);
  });

  it('sin contacto cargado, el bot hace todo lo demás igual', async () => {
    const fetch = mockFetch();
    const appt = turnoDe('TELECONSULTA_PREAPERTURA_MED_DALESSANDRO');
    const { medplum, creados, emails } = fakeMedplum({ appt });

    const r = await presencia(medplum, {
      input: { appointmentId: 'a1', rol: 'paciente', pacienteRef: 'Patient/p1' },
      secrets: secretos(),
    } as unknown as BotEvent<never>);

    expect(r.ok).toBe(true);
    expect(r.avisada).toBe(true);
    expect(creados.some((c) => c.resourceType === 'Task')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(emails).toHaveLength(0);
  });
});
