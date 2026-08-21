import { describe, it, expect, vi, afterEach } from 'vitest';
import type { BotEvent, MedplumClient } from '@medplum/core';
import { crearAlertaRecepcion, enviarWhatsApp, enviarEmail, notificarPortal, NOTIFICACION_SYSTEM } from '../src/bots/_shared.js';
import { COD, EXT, SYSTEM, TIPO_AVISO } from '../src/fhir/identifiers.js';

/** MedplumClient falso: captura las Communication creadas y espía sendEmail. */
function fakeMedplum(
  opts: {
    telefono?: string;
    email?: string;
    existente?: Record<string, unknown>;
    /** Último WhatsApp entrante del paciente (ISO): abre la ventana de 24 h. */
    ultimoEntranteISO?: string;
  } = {},
) {
  const creadas: Record<string, unknown>[] = [];
  const sendEmail = vi.fn(async () => ({}) as unknown);
  const searchOne = vi.fn(async () => opts.existente);
  const searchResources = vi.fn(async () =>
    opts.ultimoEntranteISO
      ? [
          {
            resourceType: 'Communication',
            sent: opts.ultimoEntranteISO,
            extension: [{ url: EXT.canal, valueCode: 'whatsapp' }],
          },
        ]
      : [],
  );
  const medplum = {
    searchResources,
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
  return { medplum, creadas, sendEmail, searchOne, searchResources };
}

/** Los parámetros del POST a Twilio de la llamada `n`. */
function cuerpoTwilio(fetchMock: { mock: { calls: unknown[][] } }, n = 0): URLSearchParams {
  const init = fetchMock.mock.calls[n]?.[1] as { body: URLSearchParams };
  return init.body;
}

const secretsTwilio = {
  TWILIO_ACCOUNT_SID: { name: 'TWILIO_ACCOUNT_SID', valueString: 'AC123' },
  TWILIO_AUTH_TOKEN: { name: 'TWILIO_AUTH_TOKEN', valueString: 'tok' },
  TWILIO_WHATSAPP_FROM: { name: 'TWILIO_WHATSAPP_FROM', valueString: 'whatsapp:+5491100000000' },
} as unknown as BotEvent['secrets'];

/** La plantilla genérica aprobada por Meta: "Hola: {{1}} …". */
const secretsPlantilla = {
  TWILIO_CONTENT_SID_GENERICO: { name: 'TWILIO_CONTENT_SID_GENERICO', valueString: 'HXgenerico' },
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

  it('DENTRO de la ventana de 24 h manda texto libre, no la plantilla', async () => {
    // La plantilla genérica es "Hola: {{1}} …" y Meta borra los saltos de línea
    // de las variables: un mensaje de varios párrafos llegaba aplastado y con el
    // saludo duplicado. Dentro de la ventana, el texto libre sale tal cual.
    const fetchMock = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { medplum } = fakeMedplum({
      telefono: '+5491150000000',
      ultimoEntranteISO: new Date(Date.now() - 60 * 60_000).toISOString(), // hace 1 h
    });

    await enviarWhatsApp(medplum, { ...secretsTwilio, ...secretsPlantilla }, {
      template: 'mensaje-recepcion',
      body: 'Primer párrafo.\n\nSegundo párrafo.',
      pacienteRef: 'Patient/p1',
    });

    const body = cuerpoTwilio(fetchMock);
    expect(body.get('ContentSid')).toBeNull();
    expect(body.get('Body')).toBe('Primer párrafo.\n\nSegundo párrafo.');
  });

  it('FUERA de la ventana usa la plantilla aprobada (es lo único que Meta acepta)', async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { medplum } = fakeMedplum({
      telefono: '+5491150000000',
      ultimoEntranteISO: new Date(Date.now() - 30 * 60 * 60_000).toISOString(), // hace 30 h
    });

    await enviarWhatsApp(medplum, { ...secretsTwilio, ...secretsPlantilla }, {
      template: 'mensaje-recepcion',
      body: 'hola',
      pacienteRef: 'Patient/p1',
    });

    expect(cuerpoTwilio(fetchMock).get('ContentSid')).toBe('HXgenerico');
  });

  it('Un mensaje del PORTAL no abre la ventana de WhatsApp', async () => {
    // Escribir desde el portal deja una Communication con sender = Patient, pero
    // Meta no se entera: la ventana sigue cerrada y el texto libre fallaría.
    const fetchMock = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { medplum } = fakeMedplum({ telefono: '+5491150000000' }); // sin canal whatsapp

    await enviarWhatsApp(medplum, { ...secretsTwilio, ...secretsPlantilla }, {
      template: 'mensaje-recepcion',
      body: 'hola',
      pacienteRef: 'Patient/p1',
    });

    expect(cuerpoTwilio(fetchMock).get('ContentSid')).toBe('HXgenerico');
  });

  it('Si el texto libre es rechazado, reintenta con la plantilla', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'fuera de ventana' } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { medplum } = fakeMedplum({
      telefono: '+5491150000000',
      ultimoEntranteISO: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const comm = await enviarWhatsApp(medplum, { ...secretsTwilio, ...secretsPlantilla }, {
      template: 'mensaje-recepcion',
      body: 'hola',
      pacienteRef: 'Patient/p1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cuerpoTwilio(fetchMock, 0).get('Body')).toBe('hola'); // 1º texto libre
    expect(cuerpoTwilio(fetchMock, 1).get('ContentSid')).toBe('HXgenerico'); // 2º plantilla
    expect(comm.status).toBe('completed');
  });

  it('`sinPlantilla` fuerza texto libre sin consultar la ventana (auto-respuestas)', async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { medplum, searchResources } = fakeMedplum({ telefono: '+5491150000000' });

    await enviarWhatsApp(medplum, { ...secretsTwilio, ...secretsPlantilla }, {
      template: 'auto-respuesta',
      body: 'hola',
      pacienteRef: 'Patient/p1',
      sinPlantilla: true,
    });

    expect(searchResources).not.toHaveBeenCalled();
    expect(cuerpoTwilio(fetchMock).get('Body')).toBe('hola');
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

describe('crearAlertaRecepcion · los avisos tienen que ser ENCONTRABLES', () => {
  /** Medplum falso mínimo: captura los Task creados. */
  function fake() {
    const creados: Record<string, any>[] = [];
    const medplum = {
      searchOne: async () => undefined,
      createResource: async (r: Record<string, any>) => {
        creados.push(r);
        return { ...r, id: `t${creados.length}` };
      },
    } as unknown as MedplumClient;
    return { medplum, creados };
  }

  it('lleva el code aviso-recepcion: sin él, la búsqueda por token no lo encuentra y el aviso queda invisible', async () => {
    const { medplum, creados } = fake();
    await crearAlertaRecepcion(medplum, { titulo: 'Pago DUPLICADO', detalle: 'Devolver desde MercadoPago.' });
    const coding = creados[0]?.code?.coding?.[0];
    expect(coding?.code).toBe(COD.avisoRecepcion);
    expect(coding?.system).toBe(SYSTEM.taskTipo);
    // El título sigue en text (es lo que muestra la card).
    expect(creados[0]?.code?.text).toBe('Pago DUPLICADO');
    expect(creados[0]?.status).toBe('requested');
  });

  it('WhatsApp desconocido: teléfono y texto viajan en input (para responder sin parsear el detalle)', async () => {
    const { medplum, creados } = fake();
    await crearAlertaRecepcion(medplum, {
      titulo: 'WhatsApp de número desconocido',
      detalle: 'escribió: "Hola!"',
      tipo: TIPO_AVISO.whatsappDesconocido,
      datos: { telefono: '+5491134278858', texto: 'Hola!', perfil: undefined },
    });
    const input = creados[0]?.input as Array<{ type: { text: string }; valueString: string }>;
    expect(input.find((i) => i.type.text === 'tipo')?.valueString).toBe(TIPO_AVISO.whatsappDesconocido);
    expect(input.find((i) => i.type.text === 'telefono')?.valueString).toBe('+5491134278858');
    expect(input.find((i) => i.type.text === 'texto')?.valueString).toBe('Hola!');
    // Los datos vacíos no ensucian el Task.
    expect(input.some((i) => i.type.text === 'perfil')).toBe(false);
  });
});
