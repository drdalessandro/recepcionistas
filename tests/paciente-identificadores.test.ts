import { describe, it, expect } from 'vitest';
import { busquedaPorDni, conIdentificadoresDni, identificadoresDni, nombreLegal, conNombreElegido, nombreElegido, nombresPaciente } from '../src/fhir/paciente.js';
import { getDisplayString } from '@medplum/core';
import { SYSTEM, SYSTEM_RENAPER_DNI } from '../src/fhir/identifiers.js';
import { variantesDni } from '../src/lib/dedup.js';

/**
 * El documento del paciente se guarda con DOS systems: el nuestro (histórico,
 * tal como se tipeó) y el canónico nacional de RENAPER (normalizado), que es con
 * el que habla el resto del sistema de salud argentino.
 *
 * Lo que se prueba acá es que convivan sin pisarse y que la búsqueda encuentre
 * la ficha por cualquiera de los dos — si no, la ficha creada por un flujo
 * aparece duplicada en el otro.
 */

describe('identificadoresDni — los dos systems, cada uno con su forma', () => {
  it('el nuestro conserva el valor tal como se tipeó; el canónico va en dígitos', () => {
    expect(identificadoresDni('30.123.456')).toEqual([
      { use: 'usual', system: SYSTEM.dni, value: '30.123.456' },
      { use: 'official', system: SYSTEM_RENAPER_DNI, value: '30123456' },
    ]);
  });

  it('sin puntos, los dos coinciden en el valor pero NO en el system', () => {
    const ids = identificadoresDni('30123456');
    expect(ids.map((i) => i.value)).toEqual(['30123456', '30123456']);
    expect(new Set(ids.map((i) => i.system)).size).toBe(2);
  });

  it('el system canónico es el publicado por el Federador, con http y sin barra final', () => {
    // Un token search compara el string exacto: "corregirlo" a https rompe el match.
    expect(SYSTEM_RENAPER_DNI).toBe('http://www.renaper.gob.ar/dni');
  });

  it('espacios de más no generan un documento distinto', () => {
    expect(identificadoresDni('  30123456 ')?.[1]?.value).toBe('30123456');
  });

  it('lo que no es un documento no se guarda: un identifier basura matchea de más', () => {
    expect(identificadoresDni(undefined)).toEqual([]);
    expect(identificadoresDni('')).toEqual([]);
    expect(identificadoresDni('   ')).toEqual([]);
    expect(identificadoresDni('12345')).toEqual([]); // menos de 6 dígitos
    expect(identificadoresDni('sin numeros')).toEqual([]);
  });
});

describe('conIdentificadoresDni — suma sin pisar', () => {
  it('a una ficha sin identifiers le pone los dos', () => {
    expect(conIdentificadoresDni(undefined, '30123456')).toHaveLength(2);
  });

  it('a una ficha vieja (solo el nuestro) le agrega el canónico y NO toca el existente', () => {
    const viejo = [{ system: SYSTEM.dni, value: '30.123.456' }];
    const r = conIdentificadoresDni(viejo, '30123456');
    expect(r).toHaveLength(2);
    // El valor viejo queda intacto aunque el alta lo haya tipeado distinto.
    expect(r.find((i) => i.system === SYSTEM.dni)?.value).toBe('30.123.456');
    expect(r.find((i) => i.system === SYSTEM_RENAPER_DNI)?.value).toBe('30123456');
  });

  it('correr el alta dos veces no duplica identifiers', () => {
    const una = conIdentificadoresDni(undefined, '30123456');
    expect(conIdentificadoresDni(una, '30123456')).toEqual(una);
  });

  it('no pisa un documento ya cargado con otro valor (corregirlo es decisión de la ficha)', () => {
    const cargado = [{ system: SYSTEM.dni, value: '30123456' }];
    const r = conIdentificadoresDni(cargado, '99999999');
    expect(r.find((i) => i.system === SYSTEM.dni)?.value).toBe('30123456');
  });

  it('respeta los identifiers que no son documento (Founding Member, por ejemplo)', () => {
    const fm = [{ system: SYSTEM.fm, value: '42' }];
    const r = conIdentificadoresDni(fm, '30123456');
    expect(r).toHaveLength(3);
    expect(r.find((i) => i.system === SYSTEM.fm)?.value).toBe('42');
  });
});

describe('busquedaPorDni — encontrar la ficha por cualquiera de los dos', () => {
  it('consulta los dos systems en una sola búsqueda (la coma es OR)', () => {
    const q = busquedaPorDni('30.123.456');
    expect(q).toBe(`identifier=${SYSTEM.dni}|30.123.456,${SYSTEM_RENAPER_DNI}|30123456`);
  });

  it('filtra por system: no matchea un identifier de otra cosa con el mismo número', () => {
    // Sin el system, "42" encontraría al Founding Member 42.
    expect(busquedaPorDni('30123456')).toContain(`${SYSTEM.dni}|`);
    expect(busquedaPorDni('30123456')).toContain(`${SYSTEM_RENAPER_DNI}|`);
  });

  it('si el tipeo ya venía en dígitos no repite la misma clave dos veces', () => {
    const q = busquedaPorDni('30123456');
    expect(q.split(',')).toHaveLength(2);
  });
});

describe('convivencia con el dedupe existente', () => {
  it('el dedupe indexa por VALOR, así que sigue viendo el documento con los dos systems', () => {
    const ids = identificadoresDni('30.123.456');
    const documentos = new Set(ids.flatMap((i) => variantesDni(i.value)));
    // Las tres formas de escribirlo quedan cubiertas por cualquiera de los dos.
    expect(documentos.has('30123456')).toBe(true);
    expect(documentos.has('30.123.456')).toBe(true);
  });
});

/**
 * Conformidad con `Patient-ar-core` (fhir.msal.gob.ar v0.5.0): el perfil exige
 * `identifier` 2..* con dos slices discriminados por `use`, y el nombre legal
 * con `use: official`.
 */
describe('Patient-ar-core — lo que el perfil nacional exige', () => {
  it('los dos identifiers que pide el perfil, con su `use` como discriminador', () => {
    const ids = identificadoresDni('30123456');
    // DocumentoUnico: use official + system fijo de RENAPER.
    const documentoUnico = ids.find((i) => i.system === SYSTEM_RENAPER_DNI);
    expect(documentoUnico?.use).toBe('official');
    // IdentificadorDominio: use usual + el system del dominio (el nuestro).
    const delDominio = ids.find((i) => i.system === SYSTEM.dni);
    expect(delDominio?.use).toBe('usual');
  });

  it('cumple la cardinalidad 2..* cuando hay documento', () => {
    expect(identificadoresDni('30123456').length).toBeGreaterThanOrEqual(2);
  });

  it('el nombre legal va con use official', () => {
    expect(nombreLegal({ texto: 'Juan Pérez', given: 'Juan', family: 'Pérez' })).toEqual({
      use: 'official',
      text: 'Juan Pérez',
      given: ['Juan'],
      family: 'Pérez',
    });
  });

  it('un lead sin nombre no inventa given/family vacíos', () => {
    const n = nombreLegal({ texto: 'Consulta en el mostrador · 14/08 15:30' });
    expect(n.given).toBeUndefined();
    expect(n.family).toBeUndefined();
    expect(n.text).toContain('Consulta en el mostrador');
  });
});


/**
 * El nombre elegido (Ley 26.743) — y el mecanismo por el que funciona.
 *
 * Todo el diseño se apoya en UNA cosa: que la primera entrada de `name` es la
 * que muestran las ~20 pantallas (`getDisplayString`) y los saludos de los bots
 * (`name[0]`). Con el elegido adelante, el sistema entero trata a la persona
 * por su nombre sin tocar ninguno de esos lugares. Por eso acá se fija ese
 * contrato contra la librería real: si Medplum cambiara cómo elige el nombre,
 * este test lo canta antes de que lo cante una persona en el mostrador.
 */
describe('el nombre elegido va primero, y por eso se muestra', () => {
  it('con elegido: [usual, official], en ese orden', () => {
    const names = nombresPaciente({
      legal: { texto: 'Carlos Pérez', given: 'Carlos', family: 'Pérez' },
      elegido: 'Caro Pérez',
    });
    expect(names).toHaveLength(2);
    expect(names[0]).toEqual({ use: 'usual', text: 'Caro Pérez' });
    expect(names[1]?.use).toBe('official');
  });

  it('getDisplayString muestra el elegido — el contrato del que depende todo', () => {
    const names = nombresPaciente({
      legal: { texto: 'Carlos Pérez', given: 'Carlos', family: 'Pérez' },
      elegido: 'Caro Pérez',
    });
    expect(getDisplayString({ resourceType: 'Patient', name: names })).toBe('Caro Pérez');
  });

  it('sin elegido, la ficha queda exactamente como siempre', () => {
    const names = nombresPaciente({ legal: { texto: 'Ana Gómez', given: 'Ana', family: 'Gómez' } });
    expect(names).toHaveLength(1);
    expect(names[0]?.use).toBe('official');
  });

  it('un elegido vacío o de espacios no ensucia la ficha', () => {
    expect(nombreElegido('')).toBeUndefined();
    expect(nombreElegido('   ')).toBeUndefined();
    expect(nombresPaciente({ legal: { texto: 'Ana Gómez' }, elegido: '  ' })).toHaveLength(1);
  });

  it('el legal sigue encontrable por use, que es como lo busca el Federador', () => {
    const names = nombresPaciente({
      legal: { texto: 'Carlos Pérez', given: 'Carlos', family: 'Pérez' },
      elegido: 'Caro Pérez',
    });
    // src/lib/federador.ts hace name.find(n => n.use === 'official').
    expect(names.find((n) => n.use === 'official')?.family).toBe('Pérez');
  });
});

describe('sumar el elegido a una ficha que ya existe', () => {
  it('lo pone adelante sin tocar lo demás', () => {
    const names = conNombreElegido([{ use: 'official' as const, text: 'Carlos Pérez' }], 'Caro');
    expect(names[0]?.text).toBe('Caro');
    expect(names).toHaveLength(2);
  });

  it('NO pisa un elegido que ya estaba: ese lo cargó alguien con la persona enfrente', () => {
    const existentes = [
      { use: 'usual' as const, text: 'Caro' },
      { use: 'official' as const, text: 'Carlos Pérez' },
    ];
    expect(conNombreElegido(existentes, 'Otro Nombre')).toEqual(existentes);
  });

  it('sin elegido nuevo, devuelve lo que había', () => {
    const existentes = [{ use: 'official' as const, text: 'Ana Gómez' }];
    expect(conNombreElegido(existentes, undefined)).toEqual(existentes);
    expect(conNombreElegido(undefined, undefined)).toEqual([]);
  });
});
