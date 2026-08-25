import { describe, it, expect } from 'vitest';
import type { Patient } from '@medplum/fhirtypes';
import {
  EXT_APELLIDO_MATERNO,
  EXT_APELLIDO_PATERNO,
  SYSTEM_FEDERADOR,
  elegirPorDni,
  haySugerencia,
  leerPacienteFederado,
  sugerenciaParaAlta,
} from '../src/lib/federador.js';
import { SYSTEM_RENAPER_DNI } from '../src/fhir/identifiers.js';

/**
 * Autocompletar el alta desde el Federador del Ministerio.
 *
 * Los fixtures son el ejemplo REAL del Anexo II de la guía técnica
 * Patient/FEDERADOR (OCT2025), copiado tal cual — incluido el detalle de que el
 * DNI de RENAPER viene con `use: "usual"` en producción, al revés de lo que fija
 * el perfil Patient-ar-core.
 */

/** Anexo II, primer entry del Bundle. */
const DANIEL: Patient = {
  resourceType: 'Patient',
  id: '5025175',
  identifier: [
    { use: 'official', system: SYSTEM_FEDERADOR, value: '5025175' },
    { use: 'usual', system: SYSTEM_RENAPER_DNI, value: '12497884' },
    { use: 'official', system: 'http://msgc.gcba.gob.ar', value: '3907557' },
  ],
  active: true,
  name: [
    {
      use: 'official',
      text: 'DANIEL SILVIO VACCARO',
      family: 'VACCARO',
      given: ['DANIEL', 'SILVIO'],
      // El apellido paterno viaja en la extensión del primitivo (`_family`),
      // que los tipos de Medplum no modelan.
      ...({ _family: { extension: [{ url: EXT_APELLIDO_PATERNO, valueString: 'VACCARO' }] } } as object),
    },
  ],
  gender: 'male',
  birthDate: '1956-04-26',
};

/** Anexo I: apellido COMPUESTO, con las dos ramas separadas. */
const ANTONIA: Patient = {
  resourceType: 'Patient',
  id: '540153',
  identifier: [{ use: 'usual', system: SYSTEM_RENAPER_DNI, value: '23327755' }],
  active: true,
  name: [
    {
      use: 'official',
      text: 'ANTONIA MARIA VACCARO FALINO',
      family: 'VACCARO FALINO',
      given: ['ANTONIA', 'MARIA'],
      ...({
        _family: {
          extension: [
            { url: EXT_APELLIDO_PATERNO, valueString: 'VACCARO' },
            { url: EXT_APELLIDO_MATERNO, valueString: 'FALINO' },
          ],
        },
      } as object),
    },
  ],
  gender: 'female',
  birthDate: '1973-06-12',
};

describe('leerPacienteFederado — lo que el Federador sabe', () => {
  it('lee el ejemplo real del anexo completo', () => {
    const d = leerPacienteFederado(DANIEL);
    expect(d).toMatchObject({
      idFederador: '5025175',
      dni: '12497884',
      nombres: ['DANIEL', 'SILVIO'],
      apellido: 'VACCARO',
      apellidoPaterno: 'VACCARO',
      genero: 'male',
      fechaNacimiento: '1956-04-26',
      fallecido: false,
    });
  });

  it('separa las dos ramas del apellido compuesto — el dato que nosotros NO sabemos deducir', () => {
    const d = leerPacienteFederado(ANTONIA);
    // De "VACCARO FALINO" sin más contexto es imposible saber dónde corta.
    expect(d?.apellido).toBe('VACCARO FALINO');
    expect(d?.apellidoPaterno).toBe('VACCARO');
    expect(d?.apellidoMaterno).toBe('FALINO');
  });

  it('normaliza el documento a dígitos', () => {
    const conPuntos: Patient = {
      ...DANIEL,
      identifier: [{ system: SYSTEM_RENAPER_DNI, value: '12.497.884' }],
    };
    expect(leerPacienteFederado(conPuntos)?.dni).toBe('12497884');
  });

  it('toma el nombre `official` aunque haya otros', () => {
    const conApodo: Patient = {
      ...DANIEL,
      name: [{ use: 'usual', given: ['Dani'] }, ...(DANIEL.name ?? [])],
    };
    expect(leerPacienteFederado(conApodo)?.nombres).toEqual(['DANIEL', 'SILVIO']);
  });

  it('marca al fallecido (el anexo trae deceasedDateTime)', () => {
    expect(leerPacienteFederado({ ...DANIEL, deceasedDateTime: '2018-12-01' })?.fallecido).toBe(true);
  });

  it('un resultado sin nombre ni documento no sirve para nada', () => {
    expect(leerPacienteFederado({ resourceType: 'Patient', active: true })).toBeUndefined();
    expect(leerPacienteFederado(undefined)).toBeUndefined();
  });
});

describe('elegirPorDni — cuál es la persona, o ninguna', () => {
  it('con el documento exacto, esa', () => {
    const r = elegirPorDni([DANIEL, ANTONIA], '12497884');
    expect(r.estado).toBe('unico');
    expect(r.estado === 'unico' && r.datos.nombres).toEqual(['DANIEL', 'SILVIO']);
  });

  it('descarta a los que no tienen ESE documento (homónimos de una búsqueda por apellido)', () => {
    expect(elegirPorDni([ANTONIA], '12497884').estado).toBe('sin-resultados');
  });

  it('con puntos encuentra igual', () => {
    expect(elegirPorDni([DANIEL], '12.497.884').estado).toBe('unico');
  });

  it('dos personas con el MISMO documento no se resuelven por nosotros', () => {
    // Autocompletar con la ficha equivocada deja un dato de identidad que nadie
    // revisó: peor que no autocompletar.
    const clon: Patient = { ...ANTONIA, id: '999', identifier: DANIEL.identifier };
    expect(elegirPorDni([DANIEL, clon], '12497884').estado).toBe('ambiguo');
  });

  it('sin candidatos, sin resultados', () => {
    expect(elegirPorDni([], '12497884').estado).toBe('sin-resultados');
  });
});

describe('sugerenciaParaAlta — qué se completa y qué no se toca', () => {
  it('con el formulario vacío, propone todo lo que sabe', () => {
    const s = sugerenciaParaAlta(leerPacienteFederado(ANTONIA)!);
    expect(s).toEqual({
      nombre: 'ANTONIA MARIA',
      apellido: 'VACCARO FALINO',
      apellidoPaterno: 'VACCARO',
      apellidoMaterno: 'FALINO',
      fechaNacimiento: '1973-06-12',
      genero: 'female',
    });
  });

  it('NUNCA pisa lo que la recepcionista ya escribió', () => {
    const s = sugerenciaParaAlta(leerPacienteFederado(ANTONIA)!, {
      nombre: 'Antonia',
      apellido: 'Vaccaro',
    });
    expect(s.nombre).toBeUndefined();
    expect(s.apellido).toBeUndefined();
    // Los apellidos separados van con el apellido: si no se sugiere el apellido,
    // tampoco sus ramas (serían de un apellido que no es el que quedó cargado).
    expect(s.apellidoPaterno).toBeUndefined();
    // Lo que falta sí se completa.
    expect(s.fechaNacimiento).toBe('1973-06-12');
  });

  it('de una persona fallecida no sugiere nada: que lo mire un humano', () => {
    const d = leerPacienteFederado({ ...DANIEL, deceasedDateTime: '2018-12-01' })!;
    expect(sugerenciaParaAlta(d)).toEqual({});
    expect(haySugerencia(sugerenciaParaAlta(d))).toBe(false);
  });

  it('el teléfono NO se autocompleta aunque el Federador lo traiga', () => {
    const conTelefono: Patient = {
      ...DANIEL,
      telecom: [{ system: 'phone', value: '+5491100000000' }],
    };
    const s = sugerenciaParaAlta(leerPacienteFederado(conTelefono)!) as Record<string, unknown>;
    // Es el canal por el que le escribimos: un número viejo del registro
    // nacional manda los recordatorios a un desconocido.
    expect(s.telefono).toBeUndefined();
    expect(Object.keys(s)).not.toContain('telefono');
  });

  it('sin nada nuevo que aportar, no hay sugerencia que mostrar', () => {
    const d = leerPacienteFederado(DANIEL)!;
    const s = sugerenciaParaAlta(d, {
      nombre: 'Daniel Silvio',
      apellido: 'Vaccaro',
      fechaNacimiento: '1956-04-26',
      genero: 'male',
    });
    expect(haySugerencia(s)).toBe(false);
  });
});
