import { describe, it, expect } from 'vitest';
import {
  esCanalValido,
  validarEmail,
  linkSetPassword,
  partirNombre,
  mensajeInvitacion,
} from '../src/lib/onboarding.js';

describe('onboarding · canal y email', () => {
  it('canales válidos', () => {
    expect(esCanalValido('whatsapp')).toBe(true);
    expect(esCanalValido('email')).toBe(true);
    expect(esCanalValido('qr')).toBe(true);
    expect(esCanalValido('paloma')).toBe(false);
    expect(esCanalValido(undefined)).toBe(false);
  });

  it('valida emails', () => {
    expect(validarEmail('ana@bio.com')).toBe(true);
    expect(validarEmail('ana@bio')).toBe(false);
    expect(validarEmail('anabio.com')).toBe(false);
    expect(validarEmail('')).toBe(false);
    expect(validarEmail(undefined)).toBe(false);
  });
});

describe('onboarding · link y nombre', () => {
  it('arma el link de setpassword sin doble barra', () => {
    expect(linkSetPassword('https://recepcion.medplum.com.ar/', 'abc', 'xyz')).toBe(
      'https://recepcion.medplum.com.ar/setpassword/abc/xyz',
    );
    expect(linkSetPassword('https://recepcion.medplum.com.ar', 'abc', 'xyz')).toBe(
      'https://recepcion.medplum.com.ar/setpassword/abc/xyz',
    );
  });

  it('parte nombre y apellido', () => {
    expect(partirNombre('Ana Pérez')).toEqual({ firstName: 'Ana', lastName: 'Pérez' });
    expect(partirNombre('Ana María Pérez Gómez')).toEqual({ firstName: 'Ana María Pérez', lastName: 'Gómez' });
    expect(partirNombre('Madonna')).toEqual({ firstName: 'Madonna', lastName: '' });
  });

  it('el mensaje incluye el link', () => {
    const m = mensajeInvitacion('Ana', 'https://x/setpassword/a/b');
    expect(m.texto).toContain('https://x/setpassword/a/b');
    expect(m.texto).toContain('Ana');
    expect(m.asunto).toMatch(/Biowellness/);
  });
});
