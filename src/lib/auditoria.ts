/**
 * Retención de la auditoría (`AuditEvent`) — lógica pura, sin FHIR ni red.
 *
 * Con `saveAuditEvents` activado, Medplum guarda un `AuditEvent` por CADA
 * interacción, lecturas incluidas (`read`, `vread`, `search`, `history`). Eso
 * es exactamente lo que se quiere —"quién abrió el consentimiento de esta
 * paciente, cuándo y desde qué IP"— y también lo que hace que la tabla crezca
 * sin techo: la app de Recepción sola relee Avisos cada 30 segundos.
 *
 * Por eso la purga se decidió **junto con la activación** y no después (Andrés,
 * 2026-09-21): un registro que nadie borra deja de ser una decisión y pasa a
 * ser una factura.
 *
 * DOS PLAZOS, y la diferencia importa:
 *
 *  - **La evidencia de una firma** es el evento de ESCRITURA sobre el `Consent`
 *    o el `DocumentReference`: dice quién la creó, cuándo y desde qué IP. Es lo
 *    que se muestra el día que alguien impugna una firma, y ese día puede caer
 *    años después. Se guarda el plazo largo.
 *  - **Todo lo demás**, incluidas las LECTURAS de esos mismos recursos, se
 *    guarda el plazo corto. No es un descuido: `bw-estado-consentimiento` lee
 *    el consentimiento en cada apertura de ficha y en cada reserva, así que
 *    guardar diez años de esas lecturas cuesta como guardar la evidencia mil
 *    veces y no prueba nada sobre la firma. Noventa días alcanzan para la
 *    pregunta que una lectura sí contesta: si alguien miró algo que no debía.
 *
 * Los dos plazos son constantes a propósito: cambiarlos es una línea y un
 * redeploy, no un rediseño.
 */

/** Plazo corto: lecturas y el movimiento del día a día. */
export const RETENCION_DIAS = 90;

/**
 * Plazo largo: la traza de quién firmó. Diez años, el mismo que la Ley 26.529
 * (art. 18) le pone a la historia clínica — el criterio es de Andrés y se
 * cambia acá, no en el bot.
 */
export const RETENCION_FIRMA_DIAS = 3653;

/** Los recursos cuya escritura ES la evidencia de una firma. */
export const TIPOS_EVIDENCIA = ['Consent', 'DocumentReference'] as const;

/**
 * Subtipos de `AuditEvent` que son una escritura. Salen de
 * `http://hl7.org/fhir/restful-interaction`, el mismo vocabulario que usa
 * Medplum al registrar la interacción.
 */
const ESCRITURAS = new Set(['create', 'update', 'delete', 'patch']);

/** Lo que la purga necesita saber de un `AuditEvent`. Nada más. */
export interface EventoAuditoria {
  /** `recorded`, o en su defecto `meta.lastUpdated`. */
  fechaISO?: string;
  /** Códigos de `subtype[].code`. */
  subtipos: readonly (string | undefined)[];
  /** Referencias de `entity[].what.reference` ("Consent/abc"). */
  entidades: readonly (string | undefined)[];
}

export type DecisionPurga = 'purgar' | 'conservar';

/** ¿Alguna de las entidades es un recurso de evidencia? */
export function tocaEvidencia(entidades: readonly (string | undefined)[]): boolean {
  return entidades.some((ref) => TIPOS_EVIDENCIA.some((t) => ref?.startsWith(`${t}/`)));
}

/** ¿Es una escritura? Una lectura de un `Consent` no prueba quién firmó. */
export function esEscritura(subtipos: readonly (string | undefined)[]): boolean {
  return subtipos.some((c) => c !== undefined && ESCRITURAS.has(c));
}

/** ¿Este evento es la traza de una firma, y va al plazo largo? */
export function esEvidenciaDeFirma(ev: EventoAuditoria): boolean {
  return esEscritura(ev.subtipos) && tocaEvidencia(ev.entidades);
}

/** El instante a partir del cual un evento es más viejo que `dias`. */
export function corteDeRetencion(ahora: Date, dias: number): string {
  return new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * ¿Se borra este evento?
 *
 * **Falla cerrado**: sin fecha, o con una fecha que no se puede parsear, se
 * CONSERVA. Un evento que no se sabe cuándo pasó no se puede declarar viejo, y
 * entre guardar de más y borrar evidencia, se guarda de más.
 */
export function decidirPurga(
  ev: EventoAuditoria,
  ahora: Date,
  opts: { retencionDias?: number; retencionFirmaDias?: number } = {},
): DecisionPurga {
  if (!ev.fechaISO) {
    return 'conservar';
  }
  const fecha = new Date(ev.fechaISO);
  if (Number.isNaN(fecha.getTime())) {
    return 'conservar';
  }
  const dias = esEvidenciaDeFirma(ev)
    ? (opts.retencionFirmaDias ?? RETENCION_FIRMA_DIAS)
    : (opts.retencionDias ?? RETENCION_DIAS);
  return fecha.toISOString() < corteDeRetencion(ahora, dias) ? 'purgar' : 'conservar';
}
