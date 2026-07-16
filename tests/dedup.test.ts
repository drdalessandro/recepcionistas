import { describe, it, expect } from 'vitest';
import {
  candidatosNuevos,
  formatearDniConPuntos,
  normalizarEmail,
  soloDigitos,
  variantesDni,
} from '../src/lib/dedup.js';

describe('Dedup — normalización de llaves', () => {
  it('normalizarEmail: trim + lowercase; vacío => undefined', () => {
    expect(normalizarEmail('  Ana@Test.COM ')).toBe('ana@test.com');
    expect(normalizarEmail('')).toBeUndefined();
    expect(normalizarEmail(undefined)).toBeUndefined();
  });

  it('soloDigitos saca puntos, guiones y espacios', () => {
    expect(soloDigitos('30.123.456')).toBe('30123456');
    expect(soloDigitos('+54 9 11 5555-5555')).toBe('5491155555555');
  });

  it('formatearDniConPuntos: 8 y 7 dígitos; otros largos quedan igual', () => {
    expect(formatearDniConPuntos('30123456')).toBe('30.123.456');
    expect(formatearDniConPuntos('9123456')).toBe('9.123.456');
    expect(formatearDniConPuntos('12345')).toBe('12345');
  });

  it('variantesDni cubre cómo se cargó en cada lado (crudo / dígitos / con puntos)', () => {
    expect(variantesDni('30.123.456')).toEqual(expect.arrayContaining(['30.123.456', '30123456']));
    expect(variantesDni('30123456')).toEqual(expect.arrayContaining(['30123456', '30.123.456']));
    // Sin duplicados cuando las variantes coinciden.
    expect(new Set(variantesDni('30123456')).size).toBe(variantesDni('30123456').length);
  });

  it('variantesDni descarta valores que no parecen documento (< 6 dígitos)', () => {
    expect(variantesDni('123')).toEqual([]);
    expect(variantesDni('')).toEqual([]);
    expect(variantesDni(undefined)).toEqual([]);
  });
});

describe('Dedup — descarte durable ("No es duplicado" no se reabre)', () => {
  const candidatos = [
    { id: 'a', llaves: ['email ana@test.com'] },
    { id: 'b', llaves: ['teléfono 1155555555'] },
  ];

  it('Los candidatos ya revisados (tarea cancelada/completada) no se reabren', () => {
    expect(candidatosNuevos(candidatos, new Set(['a']))).toEqual([candidatos[1]]);
    expect(candidatosNuevos(candidatos, new Set(['a', 'b']))).toEqual([]);
  });

  it('Un candidato genuinamente nuevo sí dispara', () => {
    expect(candidatosNuevos(candidatos, new Set())).toEqual(candidatos);
  });
});
