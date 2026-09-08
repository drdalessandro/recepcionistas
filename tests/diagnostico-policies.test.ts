import { describe, expect, it } from 'vitest';
import type { AccessPolicy } from '@medplum/fhirtypes';
import { claveRegla, compararPolicy } from '../src/seed/diagnostico-policies.js';
import { ACCESS_POLICIES } from '../src/fhir/access-policies.js';

/**
 * `npm run policy:check` mira los permisos del paciente: si su comparación
 * miente, el chequeo da confianza falsa sobre quién puede leer o escribir qué.
 * Por eso la lógica se testea, aunque el comando en sí sea solo lectura.
 *
 * El caso que lo motivó (2026-09-08): las seis entradas del PB100D se cargaron
 * a mano en el admin sobre las que el seed YA había escrito, y quedaron
 * duplicadas (42 reglas donde el código define 36).
 */

const policy = (reglas: AccessPolicy['resource']): AccessPolicy => ({
  resourceType: 'AccessPolicy',
  name: 'Paciente — Portal',
  resource: reglas,
});

const GOAL = { resourceType: 'Goal' as const, readonly: true, criteria: 'Goal?subject=%patient' };
const TASK_RO = { resourceType: 'Task' as const, readonly: true, criteria: 'Task?patient=%patient' };
const TASK_RW = { resourceType: 'Task' as const, criteria: 'Task?patient=%patient&code=x|' };

describe('claveRegla — dos reglas son la misma solo si conceden lo mismo', () => {
  it('el orden de los campos no cambia la clave', () => {
    expect(claveRegla({ resourceType: 'Goal', readonly: true, criteria: 'Goal?subject=%patient' })).toBe(
      claveRegla({ criteria: 'Goal?subject=%patient', readonly: true, resourceType: 'Goal' } as never),
    );
  });

  it('MISMO tipo pero distinto criteria: reglas DISTINTAS', () => {
    // El par readonly-amplia + escritura-acotada de Task, Coverage, Consent y
    // ServiceRequest depende de esto: colapsarlas escondería un permiso.
    expect(claveRegla(TASK_RO)).not.toBe(claveRegla(TASK_RW));
  });

  it('mismo criteria pero distinto readonly: reglas DISTINTAS', () => {
    const ro = { resourceType: 'Task' as const, readonly: true, criteria: 'Task?patient=%patient' };
    const rw = { resourceType: 'Task' as const, criteria: 'Task?patient=%patient' };
    expect(claveRegla(ro)).not.toBe(claveRegla(rw));
  });

  it('distingue campos que no son criteria ni readonly (readonlyFields)', () => {
    const sin = { resourceType: 'Patient' as const, criteria: 'Patient?_id=%patient.id' };
    const con = { ...sin, readonlyFields: ['Patient.identifier'] };
    expect(claveRegla(sin)).not.toBe(claveRegla(con));
  });

  it('un array con el mismo contenido en otro orden es la MISMA regla', () => {
    const a = { resourceType: 'Patient' as const, readonlyFields: ['Patient.identifier', 'Patient.extension'] };
    const b = { resourceType: 'Patient' as const, readonlyFields: ['Patient.extension', 'Patient.identifier'] };
    expect(claveRegla(a)).toBe(claveRegla(b));
  });
});

describe('compararPolicy — las tres derivas', () => {
  it('sin deriva: código y servidor iguales', () => {
    const d = compararPolicy(policy([GOAL, TASK_RO]), policy([TASK_RO, GOAL]));
    expect(d.faltan).toHaveLength(0);
    expect(d.sobran).toHaveLength(0);
    expect(d.duplicadas).toHaveLength(0);
    expect(d.ausente).toBe(false);
  });

  it('FALTA: está en el código y no en el servidor (nunca se seedeó)', () => {
    const d = compararPolicy(policy([GOAL, TASK_RO]), policy([TASK_RO]));
    expect(d.faltan.map((r) => r.resourceType)).toEqual(['Goal']);
    expect(d.sobran).toHaveLength(0);
  });

  it('SOBRA: está en el servidor y no en el código (cargada a mano)', () => {
    const d = compararPolicy(policy([TASK_RO]), policy([TASK_RO, GOAL]));
    expect(d.sobran.map((r) => r.resourceType)).toEqual(['Goal']);
    expect(d.faltan).toHaveLength(0);
  });

  it('EL CASO REAL: la regla existe en el código y está DUPLICADA en el servidor', () => {
    // No es "sobra" (está en el código) ni "falta" (está en el servidor): es la
    // misma regla dos veces. Sin este caso, el chequeo la daría por correcta.
    const d = compararPolicy(policy([GOAL]), policy([GOAL, GOAL]));
    expect(d.faltan).toHaveLength(0);
    expect(d.sobran).toHaveLength(0);
    expect(d.duplicadas).toHaveLength(1);
    expect(d.duplicadas[0]!.veces).toBe(2);
    expect(d.duplicadas[0]!.regla.resourceType).toBe('Goal');
  });

  it('la policy no existe en el servidor: todo el contenido cuenta como faltante', () => {
    const d = compararPolicy(policy([GOAL, TASK_RO]), undefined);
    expect(d.ausente).toBe(true);
    expect(d.faltan).toHaveLength(2);
  });
});

describe('contra las policies reales del repo', () => {
  it('ninguna policy del código tiene reglas duplicadas entre sí', () => {
    // Si el código duplicara, el chequeo nunca podría dar verde: la deriva
    // sería estructural y el comando dejaría de servir para detectar la real.
    for (const p of ACCESS_POLICIES) {
      const d = compararPolicy(p, p);
      expect(d.duplicadas, `${p.name} tiene reglas repetidas en el código`).toHaveLength(0);
    }
  });

  it('una policy comparada contra sí misma no reporta deriva', () => {
    for (const p of ACCESS_POLICIES) {
      const d = compararPolicy(p, p);
      expect(d.faltan, `${p.name}`).toHaveLength(0);
      expect(d.sobran, `${p.name}`).toHaveLength(0);
    }
  });
});
