import { describe, it, expect, vi } from 'vitest';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication, Extension, Patient } from '@medplum/fhirtypes';
import webpush from 'web-push';
import { NOTIFICACION_SYSTEM } from '../src/bots/_shared.js';
import {
  WEB_PUSH_EXT,
  handler,
  payloadDe,
  sinLosVencidos,
  suscripcionDe,
  tipoDe,
  urlDestino,
} from '../src/bots/web-push.js';

const notificacion = (tipo: string, extra: Partial<Communication> = {}): Communication => ({
  resourceType: 'Communication',
  id: 'c1',
  status: 'in-progress',
  category: [{ coding: [{ system: NOTIFICACION_SYSTEM, code: tipo }] }],
  recipient: [{ reference: 'Patient/p1' }],
  payload: [{ contentString: 'Tu turno quedó confirmado.' }],
  ...extra,
});

const dispositivo = (endpoint: string, completo = true): Extension => ({
  url: WEB_PUSH_EXT,
  extension: [
    { url: 'endpoint', valueUrl: endpoint },
    ...(completo
      ? [
          { url: 'p256dh', valueString: 'clave-publica' },
          { url: 'auth', valueString: 'clave-auth' },
        ]
      : []),
  ],
});

describe('qué notificación dispara un push', () => {
  it('reconoce el tipo por el CodeSystem compartido con el portal', () => {
    expect(tipoDe(notificacion('recordatorio'))).toBe('recordatorio');
  });

  it('una Communication sin ese category no es una notificación del portal', () => {
    expect(tipoDe({ resourceType: 'Communication', status: 'in-progress' })).toBe('');
    expect(tipoDe(notificacion('x', { category: [{ coding: [{ system: 'otro', code: 'y' }] }] }))).toBe('');
  });
});

// El contrato con el service worker del portal: si esto cambia, el tap del aviso
// lleva a otro lado o el título sale vacío.
describe('el payload que espera el portal', () => {
  it('lleva título, texto, destino y tag', () => {
    const p = JSON.parse(payloadDe(notificacion('reserva-confirmada'), 'reserva-confirmada'));
    expect(p).toStrictEqual({
      title: 'Reserva confirmada',
      body: 'Tu turno quedó confirmado.',
      url: '/account/membership',
      tag: 'bw-c1',
    });
  });

  it('un tipo desconocido no rompe: cae a la marca', () => {
    const p = JSON.parse(payloadDe(notificacion('inventado'), 'inventado'));
    expect(p.title).toBe('Biowellness');
  });

  it('sin texto no manda un aviso vacío', () => {
    const p = JSON.parse(payloadDe(notificacion('general', { payload: [] }), 'general'));
    expect(p.body).toContain('novedad');
  });
});

describe('a dónde lleva el tap', () => {
  it('manda el recurso del que habla la notificación, no el tipo', () => {
    // Una notificación 'general' sobre un CarePlan va al plan, no a la home.
    expect(urlDestino(notificacion('general', { about: [{ reference: 'CarePlan/x' }] }), 'general')).toBe('/care-plan');
    expect(urlDestino(notificacion('general', { about: [{ reference: 'Invoice/x' }] }), 'general')).toBe(
      '/account/membership'
    );
  });

  it('sin recurso, decide el tipo', () => {
    expect(urlDestino(notificacion('pago-recibido'), 'pago-recibido')).toBe('/account/membership');
    expect(urlDestino(notificacion('general'), 'general')).toBe('/');
  });
});

describe('las suscripciones de dispositivo', () => {
  it('una completa se convierte', () => {
    expect(suscripcionDe(dispositivo('https://fcm.example/abc'))).toStrictEqual({
      endpoint: 'https://fcm.example/abc',
      keys: { p256dh: 'clave-publica', auth: 'clave-auth' },
    });
  });

  it('a una incompleta no se le inventan las claves', () => {
    expect(suscripcionDe(dispositivo('https://fcm.example/abc', false))).toBeUndefined();
  });
});

// Higiene: sin esto la ficha acumula dispositivos muertos y cada notificación
// gasta un intento en cada uno.
describe('la baja de endpoints vencidos', () => {
  it('saca sólo los vencidos y no toca las otras extensiones', () => {
    const otra: Extension = { url: 'https://biowellness.ar/fhir/StructureDefinition/otra-cosa', valueString: 'x' };
    const quedan = sinLosVencidos(
      [dispositivo('https://a'), dispositivo('https://b'), otra],
      ['https://a']
    );
    expect(quedan).toHaveLength(2);
    expect(quedan).toContain(otra);
    expect(quedan.some((e) => e.extension?.some((s) => s.valueUrl === 'https://b'))).toBe(true);
  });

  it('sin vencidos no cambia nada', () => {
    const lista = [dispositivo('https://a')];
    expect(sinLosVencidos(lista, [])).toStrictEqual(lista);
  });
});

// El bot NUNCA debe interrumpir el flujo que lo dispara: la notificación ya
// está creada y la campanita la muestra igual.
describe('cuándo no hace nada, sin fallar', () => {
  const medplum = { readResource: vi.fn() } as unknown as MedplumClient;
  const evento = (input: Communication, secrets: Record<string, { valueString?: string }> = {}): BotEvent<Communication> =>
    ({ input, secrets, contentType: 'application/fhir+json', bot: { reference: 'Bot/x' } }) as unknown as BotEvent<Communication>;

  it('con una Communication que no es del portal', async () => {
    const r = (await handler(medplum, evento({ resourceType: 'Communication', status: 'in-progress' }))) as {
      ok: boolean;
    };
    expect(r.ok).toBe(true);
    expect(medplum.readResource).not.toHaveBeenCalled();
  });

  it('sin paciente destinatario', async () => {
    const r = (await handler(medplum, evento(notificacion('general', { recipient: [] })))) as { motivo: string };
    expect(r.motivo).toContain('sin paciente');
  });

  it('sin claves VAPID avisa y NO lee la ficha', async () => {
    const r = (await handler(medplum, evento(notificacion('general')))) as { ok: boolean; motivo: string };
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('VAPID');
    expect(medplum.readResource).not.toHaveBeenCalled();
  });
});

describe('con claves VAPID de verdad', () => {
  // Generadas en el test, nunca fijas en el repo.
  const claves = webpush.generateVAPIDKeys();
  const secretos = {
    VAPID_PUBLIC_KEY: { valueString: claves.publicKey },
    VAPID_PRIVATE_KEY: { valueString: claves.privateKey },
  };

  it('una paciente sin dispositivos activados no es un error', async () => {
    const paciente: Patient = { resourceType: 'Patient', id: 'p1' };
    const medplum = {
      readResource: vi.fn(async () => paciente),
      updateResource: vi.fn(),
    } as unknown as MedplumClient;
    const evento = { input: notificacion('general'), secrets: secretos } as unknown as BotEvent<Communication>;

    const r = (await handler(medplum, evento)) as { ok: boolean; enviados: number };
    expect(r.ok).toBe(true);
    expect(r.enviados).toBe(0);
    expect(medplum.updateResource).not.toHaveBeenCalled();
  });

  // `setVapidDetails` LANZA con una clave mal pegada. El bot promete no lanzar
  // nunca: sin el catch, la Subscription reintentaría en cada notificación.
  it('una clave mal formada NO hace lanzar al bot', async () => {
    const medplum = { readResource: vi.fn(), updateResource: vi.fn() } as unknown as MedplumClient;
    const evento = {
      input: notificacion('general'),
      secrets: { VAPID_PUBLIC_KEY: { valueString: 'a-medio-pegar' }, VAPID_PRIVATE_KEY: { valueString: 'x' } },
    } as unknown as BotEvent<Communication>;

    const r = (await handler(medplum, evento)) as { ok: boolean; motivo: string };
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('inválidas');
    expect(medplum.readResource).not.toHaveBeenCalled();
  });
});
