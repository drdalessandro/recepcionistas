import { describe, it, expect } from 'vitest';
import {
  RESPUESTA_GENERICA,
  evaluarSiteverify,
  mensajeReset,
  validarEntradaReset,
} from '../src/lib/reset-password.js';
import { linkSetPassword } from '../src/lib/onboarding.js';

/**
 * Circuito PROPIO de reset del portal (Andrés, 2026-08-20). El nativo de
 * Medplum arma el link sobre el appBaseUrl del server — que es de la consola
 * de Admin y no se toca — y manda un email genérico en inglés. El bot
 * `bw-reset-password` arma el link sobre el portal y escribe el email él.
 */

describe('validarEntradaReset — solo el formato, nunca la existencia', () => {
  it('normaliza: trim y minúsculas (el email es case-insensitive al loguearse)', () => {
    const v = validarEntradaReset('  Ana.Perez@Gmail.com ');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.email).toBe('ana.perez@gmail.com');
    }
  });

  it('rechaza solo lo que no es un email (eso no revela nada de la cuenta)', () => {
    for (const e of [undefined, '', '   ', 'no-es-un-email', 'a@b']) {
      expect(validarEntradaReset(e).ok, String(e)).toBe(false);
    }
  });
});

describe('la respuesta genérica — el contrato anti-enumeración', () => {
  it('no menciona si la cuenta existe: dice "si existe" y nada más', () => {
    expect(RESPUESTA_GENERICA.ok).toBe(true);
    expect(RESPUESTA_GENERICA.mensaje).toMatch(/si existe/i);
    expect(RESPUESTA_GENERICA.mensaje).not.toMatch(/no encontramos|no existe|inválid/i);
  });
});

describe('evaluarSiteverify — la validación vive en el bot, no en el navegador', () => {
  it('acepta el caso normal de v3: success con score humano', () => {
    expect(evaluarSiteverify({ success: true, score: 0.9 }).valido).toBe(true);
  });

  it('rechaza success=false y conserva el motivo para el log', () => {
    const v = evaluarSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(v.valido).toBe(false);
    expect(v.motivo).toContain('timeout-or-duplicate');
  });

  it('el umbral es laxo A PROPÓSITO: 0.3 pasa (un falso positivo traba a un paciente real)', () => {
    expect(evaluarSiteverify({ success: true, score: 0.3 }).valido).toBe(true);
    expect(evaluarSiteverify({ success: true, score: 0.1 }).valido).toBe(false);
  });

  it('una respuesta sin score (v2 / rara) no rechaza: manda success', () => {
    expect(evaluarSiteverify({ success: true }).valido).toBe(true);
  });

  it('basura o vacío no pasan: fallar cerrado ante lo ilegible', () => {
    expect(evaluarSiteverify(undefined).valido).toBe(false);
    expect(evaluarSiteverify('texto').valido).toBe(false);
    expect(evaluarSiteverify(null).valido).toBe(false);
  });
});

describe('mensajeReset — el email en castellano, con el link del PORTAL', () => {
  const link = linkSetPassword('https://app.biowellness.ar', 'usr-1', 'secreto-1');

  it('el link es del portal, jamás de la consola de Medplum', () => {
    expect(link).toBe('https://app.biowellness.ar/setpassword/usr-1/secreto-1');
    expect(mensajeReset(link).texto).toContain(link);
    expect(mensajeReset(link).texto).not.toContain('medplum.com.ar');
  });

  it('tiene marca propia y habla castellano (no el "Medplum Password Reset" nativo)', () => {
    const m = mensajeReset(link);
    expect(m.asunto).toContain('Biowellness');
    expect(m.asunto).not.toMatch(/medplum/i);
    expect(m.texto).toMatch(/contraseña/);
  });

  it('avisa que es de un solo uso y qué hacer si no fue él', () => {
    const m = mensajeReset(link);
    expect(m.texto).toMatch(/un solo uso/i);
    expect(m.texto).toMatch(/si no fuiste vos/i);
  });
});
