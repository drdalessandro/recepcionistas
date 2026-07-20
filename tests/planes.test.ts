import { describe, it, expect } from 'vitest';
import type { Coverage } from '@medplum/fhirtypes';
import { saldoPlan, motivoNoDisponible, cicloMes, debeRenovarMembresia, parseClavePlan } from '../src/lib/planes.js';
import { esPlanBW } from '../src/fhir/coverage.js';
import { EXT } from '../src/fhir/identifiers.js';

const AHORA = new Date('2026-06-22T10:00:00-03:00');

describe('esPlanBW — los dos usos de Coverage (plan BW vs. obra social del portal)', () => {
  const base: Coverage = {
    resourceType: 'Coverage',
    status: 'active',
    beneficiary: { reference: 'Patient/p1' },
    payor: [{ reference: 'Patient/p1' }],
  };

  it('Membresía/paquete BW (con extensiones del alta) => es plan', () => {
    expect(
      esPlanBW({
        ...base,
        extension: [
          { url: EXT.tipoCobertura, valueCode: 'membresia' },
          { url: EXT.planCodigo, valueString: 'PRIME_INT_IND' },
          { url: EXT.sesionesMes, valueInteger: 8 },
        ],
      }),
    ).toBe(true);
  });

  it('Obra social del paciente (type ActCode HIP, sin extensiones BW) => NO es plan', () => {
    expect(
      esPlanBW({
        ...base,
        type: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'HIP' }],
        },
      }),
    ).toBe(false);
  });

  it('Coverage con extensiones ajenas (no BW) => NO es plan', () => {
    expect(esPlanBW({ ...base, extension: [{ url: 'https://otra.cosa/ext', valueString: 'x' }] })).toBe(false);
  });
});

describe('saldoPlan', () => {
  it('Membresía con saldo => disponible', () => {
    const s = saldoPlan({ tipo: 'membresia', total: 8, usadas: 3, activo: true }, AHORA);
    expect(s.restantes).toBe(5);
    expect(s.disponible).toBe(true);
  });

  it('Membresía agotada (8/8) => no disponible (R-10)', () => {
    const s = saldoPlan({ tipo: 'membresia', total: 8, usadas: 8, activo: true }, AHORA);
    expect(s.agotado).toBe(true);
    expect(s.disponible).toBe(false);
    expect(motivoNoDisponible(s, true)).toMatch(/R-10/);
  });

  it('Paquete vencido => no disponible', () => {
    const s = saldoPlan(
      { tipo: 'paquete', total: 10, usadas: 2, activo: true, vencimiento: '2026-06-01T00:00:00-03:00' },
      AHORA,
    );
    expect(s.vencido).toBe(true);
    expect(s.disponible).toBe(false);
    expect(motivoNoDisponible(s, true)).toMatch(/vencido/i);
  });

  it('Paquete vigente con saldo => disponible', () => {
    const s = saldoPlan(
      { tipo: 'paquete', total: 10, usadas: 2, activo: true, vencimiento: '2026-12-31T00:00:00-03:00' },
      AHORA,
    );
    expect(s.restantes).toBe(8);
    expect(s.disponible).toBe(true);
  });

  it('Plan inactivo => no disponible', () => {
    const s = saldoPlan({ tipo: 'membresia', total: 8, usadas: 0, activo: false }, AHORA);
    expect(s.disponible).toBe(false);
  });
});

describe('cicloMes / debeRenovarMembresia (R-11)', () => {
  it('cicloMes devuelve YYYY-MM en zona Argentina', () => {
    expect(cicloMes(new Date('2026-06-20T10:00:00-03:00'))).toBe('2026-06');
    // 23:30 ART del 31/12 sigue siendo diciembre (no salta de año por UTC).
    expect(cicloMes(new Date('2026-12-31T23:30:00-03:00'))).toBe('2026-12');
  });

  it('día 3 con ciclo previo => renueva', () => {
    expect(debeRenovarMembresia('2026-05', new Date('2026-06-03T09:00:00-03:00'))).toBe(true);
  });

  it('día 3 con ciclo actual ya facturado => no renueva (idempotente)', () => {
    expect(debeRenovarMembresia('2026-06', new Date('2026-06-03T09:00:00-03:00'))).toBe(false);
  });

  it('día 10 => fuera de ventana, no renueva', () => {
    expect(debeRenovarMembresia('2026-05', new Date('2026-06-10T09:00:00-03:00'))).toBe(false);
  });

  it('membresía nueva sin ciclo registrado en día 1 => renueva', () => {
    expect(debeRenovarMembresia(undefined, new Date('2026-06-01T09:00:00-03:00'))).toBe(true);
  });
});

describe('parseClavePlan — clave del Invoice de plan (enruta la plata del webhook)', () => {
  const UUID = '6c2d6f5c-e143-4364-b0ce-558ec413c0f2';

  it('Alta inicial / paquete: plan-{coverageId}', () => {
    expect(parseClavePlan(`plan-${UUID}`)).toEqual({ coverageId: UUID, ciclo: undefined });
  });

  it('Cuota mensual: plan-{coverageId}-{YYYY-MM}', () => {
    expect(parseClavePlan(`plan-${UUID}-2026-07`)).toEqual({ coverageId: UUID, ciclo: '2026-07' });
  });

  it('El sufijo de ciclo no se come pedazos del UUID (termina en 12 hex, nunca -dddd-dd)', () => {
    const conHexNumerico = '11111111-2222-3333-4444-555566667777';
    expect(parseClavePlan(`plan-${conHexNumerico}`)).toEqual({ coverageId: conHexNumerico, ciclo: undefined });
  });

  it('Claves que no son de plan devuelven undefined (señas, saldos, basura)', () => {
    expect(parseClavePlan(`sena-${UUID}`)).toBeUndefined();
    expect(parseClavePlan(`saldo-${UUID}`)).toBeUndefined();
    expect(parseClavePlan('plan-')).toBeUndefined();
    expect(parseClavePlan('')).toBeUndefined();
  });
});
