import { describe, it, expect } from 'vitest';
import { contentVariables, nombreSecretContentSid, SECRET_CONTENT_SID_GENERICO } from '../src/lib/whatsapp.js';

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
