/**
 * Federador de Pacientes del Ministerio de Salud — lógica pura.
 *
 * Qué resuelve: hoy la recepcionista tipea nombre, apellido, fecha de nacimiento
 * y género. Cada uno de esos campos es una fuente de duplicados y de nombres mal
 * escritos — el caso 2 del walk-in fue exactamente eso. El Federador contesta
 * todo eso a partir del DNI, que es el dato que la persona **ya trae**.
 *
 * Acá vive solo lo que hay que DECIDIR con la respuesta: cuál de los resultados
 * es la persona, qué campos se autocompletan y cuáles no se tocan nunca. La
 * consulta HTTP y el token son del bot; el token del Bus depende de un documento
 * que todavía no tenemos (ver docs/handoff-federador-msal.md).
 *
 * Todo lo de este archivo está modelado contra el ejemplo real del Anexo II de
 * la guía técnica Patient/FEDERADOR (OCT2025), no contra una suposición.
 */
import type { Patient } from '@medplum/fhirtypes';
import { SYSTEM_RENAPER_DNI } from '../fhir/identifiers.js';
import { soloDigitos } from './dedup.js';

/** `identifier.system` del id nacional de la persona en el Federador. */
export const SYSTEM_FEDERADOR = 'https://federador.msal.gob.ar/patient-id';

/**
 * Extensiones estándar de HL7 con el apellido de cada rama, que el Federador sí
 * distingue (y nosotros, a partir de un nombre suelto, no sabemos deducir).
 *
 * ⚠️ Hay DOS grafías dando vueltas y por eso se leen las dos: las **respuestas**
 * del Federador y el perfil `Patient-ar-core` usan la forma estándar de HL7
 * (`…-fathers-family`), pero los **bodies de ejemplo de la colección oficial**
 * usan `…-fathersfamily`, sin el guion del medio. Leer solo una de las dos deja
 * el apellido paterno en `undefined` según de dónde venga el recurso.
 */
export const EXT_APELLIDO_PATERNO = 'http://hl7.org/fhir/StructureDefinition/humanname-fathers-family';
export const EXT_APELLIDO_MATERNO = 'http://hl7.org/fhir/StructureDefinition/humanname-mothers-family';
/** Variante sin guion que aparece en los ejemplos de la colección de Postman. */
export const EXT_APELLIDO_PATERNO_ALT = 'http://hl7.org/fhir/StructureDefinition/humanname-fathersfamily';
export const EXT_APELLIDO_MATERNO_ALT = 'http://hl7.org/fhir/StructureDefinition/humanname-mothersfamily';

/** Lo que el Federador sabe de una persona y a nosotros nos sirve. */
export interface DatosFederados {
  /** Id nacional (`Patient.id` del Federador), para poder volver a consultarlo. */
  idFederador?: string;
  dni?: string;
  /** Nombres de pila, en orden ("DANIEL SILVIO" → ['DANIEL','SILVIO']). */
  nombres: string[];
  /** Apellido completo tal como lo trae (puede ser compuesto: "VACCARO FALINO"). */
  apellido?: string;
  /** Apellido paterno, que el Federador distingue y nosotros no sabemos deducir. */
  apellidoPaterno?: string;
  apellidoMaterno?: string;
  /** `male | female | other | unknown` (el value set de FHIR). */
  genero?: string;
  /** YYYY-MM-DD. */
  fechaNacimiento?: string;
  /** ¿La persona figura como fallecida? Si es así, NO se autocompleta nada. */
  fallecido: boolean;
}

/**
 * Lee un `Patient` del Federador. Devuelve `undefined` si no trae ni nombre ni
 * documento: un resultado sin eso no sirve para autocompletar nada.
 *
 * El apellido paterno/materno viven en `_family.extension` (la extensión del
 * primitivo), que los tipos de Medplum no modelan — de ahí el acceso por índice.
 */
export function leerPacienteFederado(p: Patient | undefined): DatosFederados | undefined {
  if (!p) {
    return undefined;
  }
  const ident = p.identifier ?? [];
  const dni = ident.find((i) => i.system === SYSTEM_RENAPER_DNI)?.value;
  // El nombre legal es el `official`; si no viene marcado, el primero.
  const nombre = p.name?.find((n) => n.use === 'official') ?? p.name?.[0];
  const familyExt = (nombre as { _family?: { extension?: { url?: string; valueString?: string }[] } } | undefined)
    ?._family?.extension;
  const datos: DatosFederados = {
    idFederador: p.id ?? ident.find((i) => i.system === SYSTEM_FEDERADOR)?.value,
    dni: dni ? soloDigitos(dni) : undefined,
    nombres: (nombre?.given ?? []).filter(Boolean),
    apellido: nombre?.family,
    apellidoPaterno: valorExtension(familyExt, EXT_APELLIDO_PATERNO, EXT_APELLIDO_PATERNO_ALT),
    apellidoMaterno: valorExtension(familyExt, EXT_APELLIDO_MATERNO, EXT_APELLIDO_MATERNO_ALT),
    genero: p.gender,
    fechaNacimiento: p.birthDate,
    // `deceasedDateTime` o `deceasedBoolean`: cualquiera de los dos alcanza.
    fallecido: Boolean(p.deceasedBoolean || p.deceasedDateTime),
  };
  if (!datos.dni && datos.nombres.length === 0 && !datos.apellido) {
    return undefined;
  }
  return datos;
}

/**
 * De todos los resultados, cuál es la persona — o ninguno.
 *
 * La búsqueda por DNI "puede entregar un array" (dice la guía). Con un documento
 * exacto eso debería ser una sola persona; si vuelven varias con el MISMO
 * documento, algo está mal del otro lado y **no se elige por nosotros**:
 * autocompletar con la ficha equivocada es peor que no autocompletar, porque
 * queda un dato de identidad que nadie revisó.
 *
 * Los que no tienen ese documento exacto se descartan (una búsqueda por apellido
 * puede traer homónimos).
 */
export function elegirPorDni(
  candidatos: readonly Patient[],
  dni: string,
): { estado: 'unico'; datos: DatosFederados } | { estado: 'sin-resultados' | 'ambiguo' } {
  const buscado = soloDigitos(dni);
  const coinciden = candidatos
    .map(leerPacienteFederado)
    .filter((d): d is DatosFederados => Boolean(d) && d?.dni === buscado);
  if (coinciden.length === 0) {
    return { estado: 'sin-resultados' };
  }
  if (coinciden.length > 1) {
    return { estado: 'ambiguo' };
  }
  return { estado: 'unico', datos: coinciden[0] as DatosFederados };
}

/** Lo que el alta puede completar sola con lo que sabe el Federador. */
export interface SugerenciaAlta {
  nombre?: string;
  apellido?: string;
  apellidoPaterno?: string;
  apellidoMaterno?: string;
  fechaNacimiento?: string;
  genero?: string;
}

/**
 * Qué se autocompleta.
 *
 * Dos reglas, y las dos son deliberadas:
 *
 *  1. **Solo lo que falta.** Nunca pisa un dato que la recepcionista ya escribió:
 *    ella tiene a la persona enfrente y el Federador tiene lo que había la última
 *    vez que alguien lo actualizó. Mismo criterio que el merge del alta.
 *  2. **El teléfono NO se autocompleta**, aunque venga. Es el canal por el que le
 *    escribimos: un número desactualizado del registro nacional manda los
 *    recordatorios —y el consentimiento— a un desconocido. El teléfono lo dicta
 *    la persona en el mostrador, siempre.
 *
 * Si la persona figura como fallecida no se sugiere nada: que eso lo resuelva un
 * humano antes de abrir una ficha.
 */
export function sugerenciaParaAlta(
  datos: DatosFederados,
  yaCargado: { nombre?: string; apellido?: string; fechaNacimiento?: string; genero?: string } = {},
): SugerenciaAlta {
  if (datos.fallecido) {
    return {};
  }
  const sugerencia: SugerenciaAlta = {};
  if (!yaCargado.nombre?.trim() && datos.nombres.length > 0) {
    sugerencia.nombre = datos.nombres.join(' ');
  }
  if (!yaCargado.apellido?.trim() && datos.apellido) {
    sugerencia.apellido = datos.apellido;
    // Estos dos son el dato que nosotros NO sabemos deducir de un nombre suelto
    // y que el perfil nacional pide. Solo se propagan si el Federador los trajo.
    if (datos.apellidoPaterno) {
      sugerencia.apellidoPaterno = datos.apellidoPaterno;
    }
    if (datos.apellidoMaterno) {
      sugerencia.apellidoMaterno = datos.apellidoMaterno;
    }
  }
  if (!yaCargado.fechaNacimiento?.trim() && datos.fechaNacimiento) {
    sugerencia.fechaNacimiento = datos.fechaNacimiento;
  }
  if (!yaCargado.genero?.trim() && datos.genero) {
    sugerencia.genero = datos.genero;
  }
  return sugerencia;
}

/** ¿La sugerencia aporta algo? (Si no, no vale la pena mostrar nada en la UI.) */
export function haySugerencia(s: SugerenciaAlta): boolean {
  return Object.values(s).some((v) => Boolean(v));
}

/** Primer valor que aparezca de cualquiera de las grafías de la extensión. */
function valorExtension(
  extensiones: { url?: string; valueString?: string }[] | undefined,
  ...urls: string[]
): string | undefined {
  for (const url of urls) {
    const v = extensiones?.find((e) => e.url === url)?.valueString;
    if (v) {
      return v;
    }
  }
  return undefined;
}

