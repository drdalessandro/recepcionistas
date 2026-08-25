/**
 * Identificadores del paciente sobre FHIR (transformaciones puras).
 *
 * El documento se guarda **dos veces**, con dos systems distintos y a propósito:
 *
 *  - `SYSTEM.dni` (nuestro) — el histórico. Guarda el valor **tal como se tipeó**
 *    ("30.123.456" o "30123456"). Las fichas existentes y sus búsquedas dependen
 *    de esa forma, así que no se re-normaliza: cambiarla sería una migración de
 *    datos para no ganar nada.
 *  - `SYSTEM_RENAPER_DNI` (canónico nacional) — el que entiende el resto del
 *    sistema de salud. Va **siempre normalizado a dígitos**, que es la forma con
 *    la que se consulta el Federador del Ministerio.
 *
 * Que convivan es la gracia: adentro seguimos encontrando lo de siempre, y
 * afuera la ficha es cruzable sin tabla de equivalencias. La búsqueda por token
 * de FHIR compara strings exactos, así que "30.123.456" y "30123456" son
 * documentos distintos para el servidor — por eso el canónico tiene una única
 * forma posible y el nuestro conserva la que ya está escrita.
 *
 * **Esto es lo que pide el perfil nacional**, no una invención nuestra:
 * `Patient-ar-core` (fhir.msal.gob.ar, v0.5.0) exige `identifier` **2..\*** con
 * dos slices obligatorios discriminados por `use` —`DocumentoUnico` (`use:
 * official`, system fijo `http://www.renaper.gob.ar/dni`) e
 * `IdentificadorDominio` (`use: usual`, system del dominio, o sea el nuestro)—.
 * O sea: guardar los dos no es solo compatible con el perfil, es su requisito.
 */
import type { HumanName, Identifier } from '@medplum/fhirtypes';
import { SYSTEM, SYSTEM_RENAPER_DNI } from './identifiers.js';
import { soloDigitos } from '../lib/dedup.js';

/** Mínimo de dígitos para tomarlo como documento (mismo criterio que el dedupe). */
const DNI_MIN_DIGITOS = 6;

/**
 * Los identifiers a escribir para un documento: el nuestro con el valor tal cual
 * y el canónico normalizado. Si lo que llega no tiene dígitos suficientes para
 * ser un documento, no devuelve nada — un identifier basura es peor que ninguno,
 * porque después matchea de más en el dedupe.
 */
export function identificadoresDni(dni: string | undefined): Identifier[] {
  const crudo = dni?.trim();
  if (!crudo) {
    return [];
  }
  const digitos = soloDigitos(crudo);
  if (digitos.length < DNI_MIN_DIGITOS) {
    return [];
  }
  return [
    // `use` sale del perfil nacional (ver el bloque de arriba): el documento del
    // dominio es `usual`, el de RENAPER es `official`. Es la dimensión por la
    // que el perfil slicea `identifier`, así que sin `use` la ficha no conforma
    // aunque tenga los dos systems correctos.
    { use: 'usual', system: SYSTEM.dni, value: crudo },
    { use: 'official', system: SYSTEM_RENAPER_DNI, value: digitos },
  ];
}

/**
 * El nombre legal como lo pide el perfil: `use: 'official'`.
 *
 * El perfil además exige el **apellido paterno** en una extensión sobre
 * `family` (`humanname-fathers-family`, 1..1) y admite el materno (0..1). Eso
 * NO se escribe todavía, por dos razones concretas:
 *
 *  - **No lo sabemos.** El alta recibe un nombre completo y lo parte en dos; de
 *    "Juan Pérez González" no se puede deducir si el apellido paterno es "Pérez"
 *    o si el apellido compuesto es "Pérez González". Inventarlo sería escribir
 *    en la ficha un dato de identidad que nadie afirmó — el mismo criterio por
 *    el que un lead sin nombre no recibe uno inventado.
 *  - **Va en `_family`**, la extensión del primitivo, que los tipos de Medplum
 *    no modelan. Hay que probar contra el servidor que la persista antes de
 *    escribirla a ciegas.
 *
 * Cuando el dato venga de una fuente que sí lo sabe —el Federador lo devuelve
 * separado— se escribe de ahí.
 */
export function nombreLegal(opts: { texto: string; given?: string; family?: string }): HumanName {
  return {
    use: 'official',
    text: opts.texto,
    ...(opts.given ? { given: [opts.given] } : {}),
    ...(opts.family ? { family: opts.family } : {}),
  };
}

/**
 * Suma a una lista de identifiers los que falten, sin pisar los que ya están.
 *
 * Se compara por **system**, no por valor: si la ficha ya tiene un documento
 * cargado con ese system, gana el que está. Corregir un documento mal tipeado es
 * una decisión de Recepción sobre la ficha, no un efecto colateral de un alta.
 */
export function conIdentificadoresDni(
  existentes: Identifier[] | undefined,
  dni: string | undefined,
): Identifier[] {
  const actuales = [...(existentes ?? [])];
  for (const nuevo of identificadoresDni(dni)) {
    if (!actuales.some((i) => i.system === nuevo.system)) {
      actuales.push(nuevo);
    }
  }
  return actuales;
}

/**
 * Búsqueda FHIR que encuentra la ficha por **cualquiera de los dos systems**.
 *
 * Sin esto, una ficha que solo tenga el identifier canónico —porque la creó otro
 * flujo, o porque se completó desde el Federador— sería invisible para el alta y
 * terminaría en un duplicado. Que es exactamente el problema del caso 2 del
 * walk-in, con otro disfraz.
 *
 * La coma es OR en el token search de FHIR. Se filtra por system (en vez de
 * buscar el valor suelto) para no matchear un identifier de otra cosa que
 * casualmente tenga el mismo número.
 */
export function busquedaPorDni(dni: string): string {
  const crudo = dni.trim();
  const digitos = soloDigitos(crudo);
  const claves = [...new Set([`${SYSTEM.dni}|${crudo}`, `${SYSTEM_RENAPER_DNI}|${digitos}`])];
  return `identifier=${claves.join(',')}`;
}
