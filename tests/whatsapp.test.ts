import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  aE164Argentino,
  contentVariables,
  extensionDeMime,
  mediosTwilio,
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

  it('contentVariables aplana saltos de línea/tabs y nunca manda vacío (error 21656 de Twilio)', () => {
    expect(JSON.parse(contentVariables(['Buenos días!\n\nSoy Alejandro\tTest    de   espacios']))).toEqual({
      '1': 'Buenos días! Soy Alejandro Test de espacios',
    });
    expect(JSON.parse(contentVariables(['', '  \n  ']))).toEqual({ '1': '—', '2': '—' });
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

  it('mediosTwilio extrae los adjuntos MediaUrl0/MediaContentType0… según NumMedia', () => {
    expect(
      mediosTwilio({
        NumMedia: '2',
        MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1',
        MediaContentType0: 'image/jpeg',
        MediaUrl1: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME2',
        MediaContentType1: 'application/pdf',
        Body: 'hola',
      }),
    ).toEqual([
      { url: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1', contentType: 'image/jpeg' },
      { url: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME2', contentType: 'application/pdf' },
    ]);
  });

  it('mediosTwilio ignora URLs inválidas, respeta el máximo y tolera NumMedia ausente', () => {
    expect(mediosTwilio({ Body: 'sin media' })).toEqual([]);
    expect(mediosTwilio({ NumMedia: '1', MediaUrl0: 'javascript:alert(1)' })).toEqual([]);
    // NumMedia mayor al máximo: solo se procesan los primeros.
    const muchos: Record<string, string> = { NumMedia: '9' };
    for (let i = 0; i < 9; i++) {
      muchos[`MediaUrl${i}`] = `https://api.twilio.com/media/${i}`;
      muchos[`MediaContentType${i}`] = 'image/png';
    }
    expect(mediosTwilio(muchos, 5)).toHaveLength(5);
    // Sin content-type: cae al genérico binario.
    expect(mediosTwilio({ NumMedia: '1', MediaUrl0: 'https://x.com/a' })[0]?.contentType).toBe(
      'application/octet-stream',
    );
  });

  it('extensionDeMime mapea los tipos habituales de WhatsApp (y cae a bin)', () => {
    expect(extensionDeMime('image/jpeg')).toBe('jpg');
    expect(extensionDeMime('application/pdf')).toBe('pdf');
    expect(extensionDeMime('audio/ogg; codecs=opus')).toBe('ogg');
    expect(extensionDeMime('application/x-rareza')).toBe('bin');
    expect(extensionDeMime(undefined)).toBe('bin');
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

describe('WhatsApp — salida: normalización a E.164 (Twilio exige +549…)', () => {
  it('Cualquier forma argentina de la ficha termina en +549 + área + línea', () => {
    expect(aE164Argentino('1169315830')).toBe('+5491169315830');
    expect(aE164Argentino('11 6931-5830')).toBe('+5491169315830');
    expect(aE164Argentino('01169315830')).toBe('+5491169315830');
    expect(aE164Argentino('541169315830')).toBe('+5491169315830'); // sin el 9
    expect(aE164Argentino('5491169315830')).toBe('+5491169315830');
    expect(aE164Argentino('+5491169315830')).toBe('+5491169315830');
    expect(aE164Argentino('whatsapp:+5491169315830')).toBe('+5491169315830');
  });

  it('Internacionales con + pasan tal cual; valores cortos devuelven undefined', () => {
    expect(aE164Argentino('+14155238886')).toBe('+14155238886');
    expect(aE164Argentino('12345')).toBeUndefined();
    expect(aE164Argentino('')).toBeUndefined();
  });
});
