/**
 * La ficha del profesional se comparte con el Dashboard, y el seed no puede
 * pisarla. El caso que justifica estos tests es uno: **la matrícula**. Sin ella
 * no se firman recetas, la carga el Dashboard, y con el upsert genérico del
 * seed (un PUT con el recurso del catálogo) se perdía sin ruido.
 */
import { describe, expect, it } from 'vitest';
import type { Practitioner } from '@medplum/fhirtypes';
import {
  claveNombre,
  datosNoRegenerables,
  fusionarPractitioner,
  nombreDePractitioner,
} from '../src/fhir/practitioner.js';
import { buildPractitioner } from '../src/seed/builders.js';
import { MEDICOS } from '../src/config/medicos.js';
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

describe('claveNombre — dos fichas de la misma persona tienen que matchear', () => {
  it('EL TÍTULO NO PUEDE SEPARAR A UNA PERSONA DE SÍ MISMA', () => {
    // El caso real (2026-09-17): nuestro catálogo lo publica con "Dr." en el
    // `text`; el Dashboard lo tiene estructurado y sin título. Con el título
    // adentro de la clave, el script daba "una sola ficha" y no veía el
    // duplicado que estaba buscando.
    expect(claveNombre("Dr. Alejandro D'Alessandro")).toBe(claveNombre("Alejandro D'Alessandro"));
    expect(claveNombre('Dra. Malena Albarellos')).toBe(claveNombre('Malena Albarellos'));
  });

  it('Tildes y puntuación no separan', () => {
    expect(claveNombre("D'Alessandro")).toBe(claveNombre('Dalessandro'));
    expect(claveNombre('Nicolás Carrieri')).toBe(claveNombre('Nicolas Carrieri'));
    expect(claveNombre('Dr. Conrado López Alonso')).toBe(claveNombre('conrado lopez alonso'));
  });

  it('Personas distintas siguen siendo distintas', () => {
    expect(claveNombre("Alejandro D'Alessandro")).not.toBe(claveNombre('Malena Albarellos'));
    // Y un apellido que EMPIEZA con un título no se mutila: la regex va por
    // palabra completa, así que "Drago" conserva su "Dr".
    expect(claveNombre('Ana Drago')).toBe('anadrago');
  });

  it('nombreDePractitioner lee las dos formas de nombre', () => {
    expect(nombreDePractitioner({ resourceType: 'Practitioner', name: [{ text: 'Dr. X' }] })).toBe('Dr. X');
    expect(
      nombreDePractitioner({ resourceType: 'Practitioner', name: [{ given: ['Ana'], family: 'Pérez' }] }),
    ).toBe('Ana Pérez');
    expect(nombreDePractitioner({ resourceType: 'Practitioner' })).toBe('');
  });
});

describe('datosNoRegenerables — qué ficha no se puede desactivar a ciegas', () => {
  it('La matrícula y los identifier de otros sistemas cuentan', () => {
    expect(
      datosNoRegenerables({
        resourceType: 'Practitioner',
        identifier: [{ system: MATRICULA, value: 'MN 12345' }],
        qualification: [{ code: { text: 'Cardiología' } }],
      }),
    ).toHaveLength(2);
  });

  it('Una ficha que solo tiene lo nuestro no tiene nada que perder', () => {
    // Es la que crea el seed: su único dato es el código, que se regenera solo.
    expect(datosNoRegenerables(buildPractitioner('MED_DALESSANDRO'))).toEqual([]);
  });

  it('El contacto NO cuenta: se vuelve a cargar en un minuto', () => {
    expect(
      datosNoRegenerables({
        resourceType: 'Practitioner',
        telecom: [{ system: 'phone', value: '+5491100000000' }],
      }),
    ).toEqual([]);
  });
});

describe('El nombre del catálogo y el del Dashboard son el mismo (Andrés, 2026-09-17)', () => {
  it('claveNombre los da por la misma persona, sin --canonico', () => {
    // Antes NO matcheaban —el catálogo tenía el nombre corto y el Dashboard el
    // completo— y `medicos:consolidar` daba las dos fichas del Dr. D'Alessandro
    // por dos personas distintas. Se unificó el catálogo. Si alguien vuelve a
    // acortarlo, el matcheo se rompe y el script vuelve a no ver el duplicado:
    // por eso la decisión queda fijada acá y no solo en un comentario.
    const delCatalogo = MEDICOS.find((m) => m.codigo === 'MED_DALESSANDRO')?.nombre ?? '';
    expect(claveNombre(delCatalogo)).toBe(claveNombre("Alejandro Sergio D'Alessandro"));
  });

  it('El seed NO le pisa el nombre estructurado al Dashboard', () => {
    // Coincidir el texto no significa sobrescribir: la ficha del Dashboard lo
    // tiene en `given`/`family` y eso es mejor dato que nuestro `text`.
    const delDashboard = {
      resourceType: 'Practitioner' as const,
      name: [{ given: ['Alejandro', 'Sergio'], family: "D'Alessandro" }],
    };
    const r = fusionarPractitioner(delDashboard, buildPractitioner('MED_DALESSANDRO'));
    expect(r.name?.[0]?.given).toEqual(['Alejandro', 'Sergio']);
    expect(r.name?.[0]?.text).toBeUndefined();
  });
});
