/**
 * Consentimiento informado: la señal que el portal le da a Recepción.
 * Lo que se testea acá es sobre todo que FALLE CERRADO — un error de lectura
 * jamás puede parecerse a "el paciente firmó" (R-03, responsabilidad
 * médico-legal).
 */
import { describe, expect, it } from 'vitest';
import {
  cumpleR03,
  estadoConsentimiento,
  textoConsentimiento,
  type RegistroConsentimiento,
} from '../src/lib/consentimiento.js';
import { COD_CONSENTIMIENTO } from '../src/fhir/identifiers.js';

const AHORA = new Date('2026-08-13T12:00:00-03:00');
const firmado = (fechaISO: string, codigo: string = COD_CONSENTIMIENTO.terapiaBiologica): RegistroConsentimiento => ({
  estado: 'active',
  fechaISO,
  codigo,
});

describe('estadoConsentimiento — los tres estados', () => {
  it('undefined (no se pudo consultar) => no-verificable, NUNCA no-registrado', () => {
    // La distinción es el punto del módulo: con `?? false` un 403 se leería
    // como "no firmó" y nadie entendería por qué la reserva está bloqueada.
    expect(estadoConsentimiento(undefined).estado).toBe('no-verificable');
  });

  it('lista vacía (se consultó, no hay nada) => no-registrado', () => {
    expect(estadoConsentimiento([], { ahora: AHORA }).estado).toBe('no-registrado');
  });

  it('con uno activo => firmado + la fecha', () => {
    const r = estadoConsentimiento([firmado('2026-08-01T10:00:00-03:00')], { ahora: AHORA });
    expect(r.estado).toBe('firmado');
    expect(r.fechaISO).toBe('2026-08-01T10:00:00-03:00');
  });

  it('un consentimiento REVOCADO o inactivo no cuenta como firmado', () => {
    const revocado: RegistroConsentimiento = { estado: 'inactive', fechaISO: '2026-08-01T10:00:00-03:00' };
    expect(estadoConsentimiento([revocado], { ahora: AHORA }).estado).toBe('no-registrado');
  });

  it('con varios activos, muestra la firma MÁS RECIENTE', () => {
    const r = estadoConsentimiento(
      [firmado('2026-06-01T10:00:00-03:00'), firmado('2026-08-05T09:00:00-03:00'), firmado('2026-07-01T10:00:00-03:00')],
      { ahora: AHORA },
    );
    expect(r.fechaISO).toBe('2026-08-05T09:00:00-03:00');
  });
});

describe('estadoConsentimiento — categoría', () => {
  it('el consentimiento general de atención NO cubre el de Terapias Biológicas', () => {
    const soloAtencion = [firmado('2026-08-01T10:00:00-03:00', COD_CONSENTIMIENTO.atencion)];
    expect(estadoConsentimiento(soloAtencion, { ahora: AHORA, codigo: COD_CONSENTIMIENTO.terapiaBiologica }).estado).toBe(
      'no-registrado',
    );
    expect(estadoConsentimiento(soloAtencion, { ahora: AHORA, codigo: COD_CONSENTIMIENTO.atencion }).estado).toBe(
      'firmado',
    );
  });

  it('sin filtro de categoría, cualquiera activo alcanza', () => {
    expect(estadoConsentimiento([firmado('2026-08-01T10:00:00-03:00', 'atencion')], { ahora: AHORA }).estado).toBe(
      'firmado',
    );
  });
});

describe('estadoConsentimiento — vigencia', () => {
  it('sin vigenciaMeses no vence nunca (default hasta que se defina)', () => {
    expect(estadoConsentimiento([firmado('2020-01-01T10:00:00-03:00')], { ahora: AHORA }).estado).toBe('firmado');
  });

  it('con vigencia de 12 meses, uno de hace 2 años deja de contar', () => {
    const viejo = [firmado('2024-01-01T10:00:00-03:00')];
    expect(estadoConsentimiento(viejo, { ahora: AHORA, vigenciaMeses: 12 }).estado).toBe('no-registrado');
    const reciente = [firmado('2026-05-01T10:00:00-03:00')];
    expect(estadoConsentimiento(reciente, { ahora: AHORA, vigenciaMeses: 12 }).estado).toBe('firmado');
  });

  it('con vigencia definida, uno SIN fecha no se puede validar => no cuenta', () => {
    expect(estadoConsentimiento([{ estado: 'active' }], { ahora: AHORA, vigenciaMeses: 12 }).estado).toBe(
      'no-registrado',
    );
  });
});

describe('cumpleR03 — solo "firmado" destraba la regla', () => {
  it('no-verificable NO alcanza: ante la duda, que lo declare la recepcionista', () => {
    expect(cumpleR03('firmado')).toBe(true);
    expect(cumpleR03('no-registrado')).toBe(false);
    expect(cumpleR03('no-verificable')).toBe(false);
  });
});

describe('textoConsentimiento — lo que lee la recepcionista', () => {
  it('firmado muestra la fecha en formato argentino', () => {
    expect(textoConsentimiento({ estado: 'firmado', fechaISO: '2026-08-05T09:00:00-03:00' })).toBe(
      'Firmado desde el portal el 05/08/2026',
    );
  });

  it('los otros dos estados se distinguen en el texto (no dicen lo mismo)', () => {
    const sin = textoConsentimiento({ estado: 'no-registrado' });
    const error = textoConsentimiento({ estado: 'no-verificable' });
    expect(sin).toBe('Sin consentimiento firmado en el portal');
    expect(error).toBe('No se pudo verificar contra el portal');
    expect(sin).not.toBe(error);
  });
});
