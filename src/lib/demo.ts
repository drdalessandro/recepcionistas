/**
 * Datos demo — lógica pura de su vida útil (sin FHIR, sin red).
 *
 * Todo recurso demo lleva el tag `demo` (SYSTEM.demo). La limpieza automática
 * (`bw-limpiar-demo`, cron) borra lo que tiene más de 48 h. Para una demo que
 * tiene que durar más —p. ej. "ocupación hasta el 15/09"— el recurso lleva
 * además el tag `demo-hasta` con la fecha civil argentina hasta la que sigue
 * vigente: mientras esa fecha no pase, la limpieza de 48 h lo saltea. Cuando
 * pasa, se borra en la corrida siguiente, como cualquier dato demo.
 *
 * `--limpiar` (borrado explícito) no mira `demo-hasta`: borra todo.
 */
import type { Coding, Meta } from '@medplum/fhirtypes';
import { SYSTEM } from '../fhir/identifiers.js';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** `meta` de un recurso demo, con vigencia opcional hasta una fecha civil AR. */
export function metaDemo(hastaISO?: string): Meta {
  const tag: Coding[] = [{ system: SYSTEM.demo, code: 'demo' }];
  if (hastaISO) {
    if (!RE_FECHA.test(hastaISO)) {
      throw new Error(`demo-hasta tiene que ser una fecha "YYYY-MM-DD": ${hastaISO}`);
    }
    tag.push({ system: SYSTEM.demoHasta, code: hastaISO });
  }
  return { tag };
}

/** Fecha civil ("YYYY-MM-DD") hasta la que el recurso demo sigue vigente, si la declara. */
export function demoHastaDe(meta: Meta | undefined): string | undefined {
  const code = meta?.tag?.find((t) => t.system === SYSTEM.demoHasta)?.code;
  return code && RE_FECHA.test(code) ? code : undefined;
}

/**
 * ¿La limpieza automática tiene que RESPETAR este recurso hoy? Sí mientras
 * declare un `demo-hasta` igual o posterior a la fecha civil de hoy. Un recurso
 * sin `demo-hasta` no está vigente: se rige por las 48 h de siempre.
 */
export function demoVigente(meta: Meta | undefined, hoyISO: string): boolean {
  const hasta = demoHastaDe(meta);
  return hasta !== undefined && hasta >= hoyISO;
}
