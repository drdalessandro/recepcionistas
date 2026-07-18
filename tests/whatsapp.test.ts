import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  contentVariables,
  nombreSecretContentSid,
  SECRET_CONTENT_SID_GENERICO,
  validarFirmaTwilio,
  variantesTelefono,
} from '../src/lib/whatsapp.js';

describe('WhatsApp — plantillas de producción (Twilio Content API)', () => {
  it('nombreSecretContentSid deriva el secret desde el nombre interno de la plantilla', () => {
    expect(nombreSecretContentSid('turno-confirmado')).toBe('TWILIO_CONTENT_SID_TURNO_CONFIRMADO');
    expect(nombreSecretContentSid('recordatorio-48h')).toBe('TWILIO_CONTENT_SID_RECORDATORIO_48H');
    expect(nombreSecretContentSid('reserva-plan')).toBe('TWILIO_CONTENT_SID_RESERVA_PLAN');
  });

  it('contentVariables arma el JSON posicional {{1}}, {{2}}, …', () => {
    expect(JSON.parse(contentVariables(['HBOT Monoplaza', '15/07 16:00']))).toEqual({
      '1': 'HBOT Monoplaza',
      '2': '15/07 16:00',
    });
    expect(contentVariables([])).toBe('{}');
  });

  it('El secret genérico tiene el nombre esperado', () => {
    expect(SECRET_CONTENT_SID_GENERICO).toBe('TWILIO_CONTENT_SID_GENERICO');
  });
});

describe('WhatsApp — entrada (Twilio → bandeja de Mensajes)', () => {
  it('variantesTelefono genera las formas argentinas habituales desde el From de Twilio', () => {
    const v = variantesTelefono('whatsapp:+5491169315830');
    expect(v).toEqual(expect.arrayContaining(['+5491169315830', '5491169315830', '1169315830', '91169315830']));
    expect(v.some((x) => x.startsWith('whatsapp:'))).toBe(false);
  });

  it('variantesTelefono descarta valores que no parecen teléfono', () => {
    expect(variantesTelefono('123')).toEqual([]);
    expect(variantesTelefono(undefined)).toEqual([]);
  });

  it('validarFirmaTwilio acepta la firma correcta y rechaza token/firma inválidos', () => {
    const url = 'https://api.medplum.com.ar/webhooks/twilio-whatsapp';
    const params = { Body: 'Hola', From: 'whatsapp:+5491169315830', MessageSid: 'SM123' };
    const data = url + 'BodyHola' + 'Fromwhatsapp:+5491169315830' + 'MessageSidSM123';
    const firma = createHmac('sha1', 'token-secreto').update(data, 'utf8').digest('base64');
    expect(validarFirmaTwilio(url, params, firma, 'token-secreto')).toBe(true);
    expect(validarFirmaTwilio(url, params, firma, 'otro-token')).toBe(false);
    expect(validarFirmaTwilio(url, params, undefined, 'token-secreto')).toBe(false);
  });
});
