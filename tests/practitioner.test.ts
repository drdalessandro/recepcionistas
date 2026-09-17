/**
 * La ficha del profesional se comparte con el Dashboard, y el seed no puede
 * pisarla. El caso que justifica estos tests es uno: **la matrícula**. Sin ella
 * no se firman recetas, la carga el Dashboard, y con el upsert genérico del
 * seed (un PUT con el recurso del catálogo) se perdía sin ruido.
 */
import { describe, expect, it } from 'vitest';
import type { Practitioner } from '@medplum/fhirtypes';
import { fusionarPractitioner } from '../src/fhir/practitioner.js';
import { buildPractitioner } from '../src/seed/builders.js';
import { EXT, SYSTEM } from '../src/fhir/identifiers.js';

const MATRICULA = 'https://biowellness.ar/fhir/CodeSystem/matricula';

/** La ficha como la tiene el Dashboard: con matrícula y sin nuestro código. */
function fichaDelDashboard(): Practitioner {
  return {
    resourceType: 'Practitioner',
    id: 'b5fd368b',
    name: [{ given: ['Alejandro'], family: "D'Alessandro", prefix: ['Dr.'] }],
    identifier: [{ system: MATRICULA, value: 'MN 12345' }],
    telecom: [{ system: 'email', value: 'cardio@ejemplo.ar' }],
    qualification: [{ code: { text: 'Cardiología' } }],
  };
}

describe('fusionarPractitioner — el seed no pisa la ficha clínica', () => {
  it('LA MATRÍCULA SOBREVIVE a una corrida del seed', () => {
    const r = fusionarPractitioner(fichaDelDashboard(), buildPractitioner('MED_DALESSANDRO'));
    expect(r.identifier).toContainEqual({ system: MATRICULA, value: 'MN 12345' });
    expect(r.qualification).toEqual([{ code: { text: 'Cardiología' } }]);
    expect(r.telecom).toEqual([{ system: 'email', value: 'cardio@ejemplo.ar' }]);
  });

  it('…y además queda nuestro código, que es lo que el seed necesita', () => {
    const r = fusionarPractitioner(fichaDelDashboard(), buildPractitioner('MED_DALESSANDRO'));
    const nuestros = (r.identifier ?? []).filter((i) => i.system === SYSTEM.medico);
    expect(nuestros).toEqual([{ system: SYSTEM.medico, value: 'MED_DALESSANDRO' }]);
  });

  it('Correrlo dos veces no duplica nuestro identifier', () => {
    const uno = fusionarPractitioner(fichaDelDashboard(), buildPractitioner('MED_DALESSANDRO'));
    const dos = fusionarPractitioner(uno, buildPractitioner('MED_DALESSANDRO'));
    expect((dos.identifier ?? []).filter((i) => i.system === SYSTEM.medico)).toHaveLength(1);
    expect((dos.identifier ?? []).filter((i) => i.system === MATRICULA)).toHaveLength(1);
  });

  it('El nombre estructurado del Dashboard no se degrada a texto plano', () => {
    const r = fusionarPractitioner(fichaDelDashboard(), buildPractitioner('MED_DALESSANDRO'));
    expect(r.name?.[0]?.family).toBe("D'Alessandro");
  });

  it('Sin ficha previa, escribe la nuestra tal cual (instalación nueva)', () => {
    const nuestro = buildPractitioner('MED_DALESSANDRO');
    expect(fusionarPractitioner(undefined, nuestro)).toBe(nuestro);
  });

  it('Una ficha desactivada a mano vuelve a activarse: el seed la necesita para los turnos', () => {
    const r = fusionarPractitioner({ ...fichaDelDashboard(), active: false }, buildPractitioner('MED_DALESSANDRO'));
    expect(r.active).toBe(true);
  });

  it('Las extensiones ajenas se preservan y la nuestra se actualiza', () => {
    const ajena = { url: 'https://otro.ar/StructureDefinition/lo-suyo', valueString: 'x' };
    const r = fusionarPractitioner(
      { ...fichaDelDashboard(), extension: [ajena, { url: EXT.tipoContrato, valueCode: 'viejo' }] },
      buildPractitioner('MED_DALESSANDRO'),
    );
    expect(r.extension).toContainEqual(ajena);
    expect((r.extension ?? []).filter((e) => e.url === EXT.tipoContrato)).toHaveLength(1);
    expect((r.extension ?? []).find((e) => e.url === EXT.tipoContrato)?.valueCode).not.toBe('viejo');
  });
});
