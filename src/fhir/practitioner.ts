/**
 * La ficha del profesional es **compartida**, y por eso se fusiona en vez de
 * reemplazarse.
 *
 * Todo lo demás que publica el seed —servicios, combos, policies— es nuestro de
 * punta a punta: el seed lo reemplaza entero y eso es lo correcto (un cambio a
 * mano en el admin se pierde en la próxima corrida, y está documentado así).
 * El `Practitioner` **no**: el mismo recurso lo usan el Dashboard clínico —que
 * le carga la **matrícula**, sin la cual no se pueden firmar recetas— y este
 * repo, que solo necesita poder encontrarlo por su código de negocio para
 * armar turnos y agendas.
 *
 * Con el upsert genérico (`updateResource({ ...recurso, id })`, un PUT) la
 * primera corrida del seed le borraría la matrícula al médico: el builder
 * devuelve `identifier` con un solo elemento, el nuestro. El dato se pierde sin
 * ruido y se descubre el día que alguien no puede recetar.
 *
 * Por eso acá se fija qué es nuestro y qué no:
 *  - **Nuestro** (se asegura): el `identifier` del código de médico, la
 *    extensión `tipo-contrato`, y que esté `active`.
 *  - **Ajeno** (se preserva): absolutamente todo el resto —matrícula
 *    (`qualification`), `telecom`, `photo`, `gender`, y los identifier de
 *    otros sistemas.
 *
 * Contrato con el Dashboard: `docs/handoff-dashboard-teleconsulta.md` §1.
 */
import type { HumanName, Identifier, Practitioner } from '@medplum/fhirtypes';
import type { Extension } from '@medplum/fhirtypes';
import { SYSTEM } from './identifiers.js';

/** Los identifier ajenos, más el nuestro (uno solo, el que manda el catálogo). */
function fusionarIdentifiers(existentes: Identifier[] | undefined, nuestros: Identifier[] | undefined): Identifier[] {
  const ajenos = (existentes ?? []).filter((i) => i.system !== SYSTEM.medico);
  return [...ajenos, ...(nuestros ?? [])];
}

/** Las extensiones ajenas, más las nuestras (las nuestras ganan por `url`). */
function fusionarExtensiones(existentes: Extension[] | undefined, nuestras: Extension[] | undefined): Extension[] {
  const urls = new Set((nuestras ?? []).map((e) => e.url));
  const ajenas = (existentes ?? []).filter((e) => !urls.has(e.url));
  return [...ajenas, ...(nuestras ?? [])];
}

/**
 * La ficha a escribir: lo que ya había en el servidor, con lo nuestro asegurado.
 *
 * Sin `existente` (el médico todavía no está) devuelve la nuestra tal cual, que
 * es el caso de una instalación nueva.
 *
 * **El nombre no se pisa si ya hay uno.** El Dashboard puede tenerlo
 * estructurado (`given` / `family`) y nosotros lo publicamos como `text`:
 * reemplazarlo sería degradar el dato para ganar nada.
 */
export function fusionarPractitioner(existente: Practitioner | undefined, nuestro: Practitioner): Practitioner {
  if (!existente) {
    return nuestro;
  }
  return {
    ...existente,
    active: true,
    name: existente.name?.length ? existente.name : nuestro.name,
    identifier: fusionarIdentifiers(existente.identifier, nuestro.identifier),
    extension: fusionarExtensiones(existente.extension, nuestro.extension),
  };
}

/** El nombre de una ficha, venga como `text` o estructurado. */
export function nombreDePractitioner(p: Practitioner): string {
  const n: HumanName | undefined = p.name?.[0];
  return n?.text ?? [n?.given?.join(' '), n?.family].filter(Boolean).join(' ');
}

/**
 * Clave para decidir si dos fichas son de la MISMA persona.
 *
 * Ignora tildes, puntuación y —lo que importa— **el título**. No es cosmético:
 * este repo publica el nombre del catálogo como un `text` que lo incluye
 * ("Dr. Alejandro D'Alessandro") y otros repos lo cargan estructurado, con el
 * "Dr." en `prefix` (que no entra en `nombreDePractitioner`) o sin título.
 * Comparando con el título adentro, `dralejandrodalessandro` no matchea
 * `alejandrodalessandro`: **dos fichas de la misma persona quedaban como dos
 * personas**, que es justo lo que el matcheo tiene que detectar.
 */
export function claveNombre(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\b(dr|dra|lic|prof|md)\b/g, '')
    .replace(/\s/g, '');
}

/**
 * Señales de que una ficha tiene datos que **este repo no puede regenerar**.
 *
 * Existe para una decisión concreta: al consolidar duplicados, desactivar la
 * ficha equivocada tira la matrícula del profesional. El script no puede saber
 * cuál es la buena —la matrícula la carga el Dashboard y acá no se modela—,
 * pero sí puede **mostrar cuál la tiene** y negarse a elegir a ciegas.
 *
 * `telecom` no cuenta: es contacto, se vuelve a cargar en un minuto. Cuentan la
 * matrícula (`qualification`) y los identifier de otros sistemas, que son los
 * que representan algo emitido por un tercero.
 */
export function datosNoRegenerables(p: Practitioner): string[] {
  const señales: string[] = [];
  const ajenos = (p.identifier ?? []).filter((i) => i.system !== SYSTEM.medico);
  if (ajenos.length > 0) {
    señales.push(`${ajenos.length} identifier de otro sistema`);
  }
  if ((p.qualification ?? []).length > 0) {
    señales.push(`${p.qualification!.length} qualification (matrícula/título)`);
  }
  return señales;
}
