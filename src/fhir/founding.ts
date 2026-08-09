/**
 * Founding Member sobre el recurso Patient (R-09).
 *
 * La marca vive en DOS lugares del mismo Patient, cada uno por un motivo:
 *  - extensión `tag-fm` (boolean): la señal funcional. La leen los bots
 *    (bw-disponibilidad → ventana de 7 días) y la ficha de recepción.
 *  - identifier `SYSTEM.fm` (value "1".."100"): el padrón. Los identifiers son
 *    buscables (`Patient?identifier=<system>|` trae todos los fundadores), así
 *    el cupo se cuenta sin SearchParameters custom, y el número ubica la
 *    cohorte (1–50 el 1 a 1, 51–100 la Web).
 *
 * Marcar/desmarcar escribe los dos juntos (transformaciones puras acá; el
 * update lo hace quien llama). Nunca editar uno solo a mano: quedan en drift.
 */
import type { Patient } from '@medplum/fhirtypes';
import { EXT, SYSTEM } from './identifiers.js';

/** ¿El paciente es Founding Member? (la señal funcional, no el padrón). */
export function esFm(p: Patient): boolean {
  return p.extension?.find((x) => x.url === EXT.tagFm)?.valueBoolean === true;
}

/** Número de fundador del paciente (1..100), o undefined si no está marcado. */
export function numeroFm(p: Patient): number | undefined {
  const v = p.identifier?.find((i) => i.system === SYSTEM.fm)?.value;
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Copia del Patient marcado como FM con el número dado (idempotente). */
export function conMarcaFm(p: Patient, numero: number): Patient {
  const extension = (p.extension ?? []).filter((x) => x.url !== EXT.tagFm);
  extension.push({ url: EXT.tagFm, valueBoolean: true });
  const identifier = (p.identifier ?? []).filter((i) => i.system !== SYSTEM.fm);
  identifier.push({ system: SYSTEM.fm, value: String(numero) });
  return { ...p, extension, identifier };
}

/** Copia del Patient sin la marca FM (extensión e identifier fuera). */
export function sinMarcaFm(p: Patient): Patient {
  const extension = (p.extension ?? []).filter((x) => x.url !== EXT.tagFm);
  const identifier = (p.identifier ?? []).filter((i) => i.system !== SYSTEM.fm);
  return {
    ...p,
    extension: extension.length ? extension : undefined,
    identifier: identifier.length ? identifier : undefined,
  };
}
