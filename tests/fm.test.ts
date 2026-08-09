/**
 * Founding Members (R-09) — programa FM-100 en dos cohortes.
 * Decisión de Andrés (2026-08-09): 1–50 el 1 a 1 personal, 51–100 la Web
 * (founding.html). El cupo AVISA, nunca bloquea.
 */
import { describe, expect, it } from 'vitest';
import type { Patient } from '@medplum/fhirtypes';
import { avisoCupoFm, cohorteFm, proximoNumeroFm } from '../src/lib/fm.js';
import { conMarcaFm, esFm, numeroFm, sinMarcaFm } from '../src/fhir/founding.js';
import { EXT, SYSTEM } from '../src/fhir/identifiers.js';
import { FM } from '../src/config/reglas.js';

describe('cohorteFm — el número define la cohorte', () => {
  it('1 y 50 son del 1 a 1; 51 y 100 son de la Web', () => {
    expect(cohorteFm(1)).toBe('1a1');
    expect(cohorteFm(50)).toBe('1a1');
    expect(cohorteFm(51)).toBe('web');
    expect(cohorteFm(100)).toBe('web');
  });
});

describe('proximoNumeroFm — máximo + 1, sin rellenar huecos', () => {
  it('padrón vacío: arranca en 1', () => {
    expect(proximoNumeroFm([])).toBe(1);
  });

  it('sigue del máximo aunque haya huecos (el 7 desmarcado no se reusa)', () => {
    expect(proximoNumeroFm([1, 2, 3, 9])).toBe(10);
  });

  it('si se desmarcó al último, su número sí se reusa (max de los que quedan + 1)', () => {
    expect(proximoNumeroFm([1, 2, 3])).toBe(4);
  });

  it('ignora valores no finitos (padrón con un value corrupto)', () => {
    expect(proximoNumeroFm([5, Number.NaN])).toBe(6);
  });
});

describe('avisoCupoFm — avisa, nunca bloquea (R-09)', () => {
  it('números bajos: sin aviso', () => {
    expect(avisoCupoFm(1).nivel).toBe('ok');
    expect(avisoCupoFm(FM.alertaEnCupo - 1).nivel).toBe('ok');
  });

  it('desde 40: alerta de que el 1 a 1 se agota', () => {
    expect(avisoCupoFm(FM.alertaEnCupo).nivel).toBe('alerta');
    expect(avisoCupoFm(FM.cupos1a1).nivel).toBe('alerta');
  });

  it('51 a 100: entra en el cupo Web', () => {
    expect(avisoCupoFm(FM.cupos1a1 + 1).nivel).toBe('cupo-web');
    expect(avisoCupoFm(FM.cuposTotales).nivel).toBe('cupo-web');
  });

  it('101: el programa está completo — el aviso lo dice pero no hay bloqueo', () => {
    const aviso = avisoCupoFm(FM.cuposTotales + 1);
    expect(aviso.nivel).toBe('programa-completo');
    expect(aviso.mensaje).toContain('Andrés');
  });
});

describe('marca FM en el Patient — extensión + identifier, siempre juntos', () => {
  const base: Patient = {
    resourceType: 'Patient',
    identifier: [{ system: SYSTEM.dni, value: '22100263' }],
    extension: [{ url: EXT.tipoCliente, valueCode: 'PUBLICO' }],
  };

  it('conMarcaFm escribe los dos y numeroFm/esFm los leen', () => {
    const marcado = conMarcaFm(base, 23);
    expect(esFm(marcado)).toBe(true);
    expect(numeroFm(marcado)).toBe(23);
    // Lo que ya tenía el paciente no se toca.
    expect(marcado.identifier?.some((i) => i.system === SYSTEM.dni)).toBe(true);
    expect(marcado.extension?.some((x) => x.url === EXT.tipoCliente)).toBe(true);
  });

  it('es idempotente: re-marcar no duplica extensión ni identifier', () => {
    const dosVeces = conMarcaFm(conMarcaFm(base, 23), 23);
    expect(dosVeces.extension?.filter((x) => x.url === EXT.tagFm)).toHaveLength(1);
    expect(dosVeces.identifier?.filter((i) => i.system === SYSTEM.fm)).toHaveLength(1);
  });

  it('sinMarcaFm limpia los dos y deja el resto', () => {
    const limpio = sinMarcaFm(conMarcaFm(base, 23));
    expect(esFm(limpio)).toBe(false);
    expect(numeroFm(limpio)).toBeUndefined();
    expect(limpio.identifier?.some((i) => i.system === SYSTEM.dni)).toBe(true);
  });

  it('un Patient sin nada: esFm false, numeroFm undefined', () => {
    expect(esFm({ resourceType: 'Patient' })).toBe(false);
    expect(numeroFm({ resourceType: 'Patient' })).toBeUndefined();
  });

  it('numeroFm tolera un value corrupto (no numérico) como no-marcado', () => {
    const roto: Patient = { resourceType: 'Patient', identifier: [{ system: SYSTEM.fm, value: 'abc' }] };
    expect(numeroFm(roto)).toBeUndefined();
  });
});
