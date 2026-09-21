/**
 * Retención de la auditoría (`AuditEvent`) — lógica pura, sin FHIR ni red.
 *
 * Con `saveAuditEvents` activado, Medplum guarda un `AuditEvent` por cada
 * interacción **sobre un recurso concreto**, lecturas incluidas (`read`,
 * `vread`, `history`). Eso es exactamente lo que se quiere —"quién abrió el
 * consentimiento de esta paciente, cuándo y desde qué IP"— y también lo que
 * hace que la tabla crezca sin techo.
 *
 * Las BÚSQUEDAS no se guardan: la guarda del servidor es
 * `saveAuditEvents && isResource(resource)` (`fhir/repo.ts:2373`) y un `search`
 * no trae recurso. Verificado el 2026-09-21 contra producción — entre dos
 * corridas del diagnóstico, con la app abierta, solo aparecieron `read`. Es una
 * buena noticia para el volumen y conviene no olvidarla: el polling de Avisos
 * cada 30 segundos NO deja rastro, los `read` que dispara sí.
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

// ============================================================================
// Veredicto de la prueba de humo (`npm run auditoria:check`).
// ============================================================================

export type VeredictoIp =
  /** No hay eventos: el flag `saveAuditEvents` no está activo (o nadie tocó nada). */
  | 'sin-eventos'
  /** TODAS las direcciones son locales: la cadena del proxy está cortada. */
  | 'solo-local'
  /** Hay direcciones reales: la IP del cliente está llegando. */
  | 'ok'
  /** Hay eventos pero ninguno trae dirección. */
  | 'sin-direccion';

/** Direcciones que significan "no llegó la del cliente". */
const LOCALES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

export function esDireccionLocal(direccion: string | undefined): boolean {
  return direccion !== undefined && LOCALES.has(direccion.trim());
}

/**
 * Qué decir después de mirar las últimas direcciones registradas.
 *
 * `solo-local` es el caso que justifica el comando: detrás de nginx, sin
 * confianza en el proxy, TODOS los eventos guardan `127.0.0.1` y la auditoría
 * no sirve para lo único que se la quiere. Se detecta en un minuto y se
 * descubre tarde a los seis meses.
 *
 * Basta UNA dirección real para dar `ok`: los bots y los crons entran por
 * loopback legítimamente, así que convivir con locales es normal — lo que no
 * puede pasar es que no haya ninguna real.
 */
export function veredictoIp(direcciones: readonly (string | undefined)[]): VeredictoIp {
  if (direcciones.length === 0) {
    return 'sin-eventos';
  }
  const conDireccion = direcciones.filter((d): d is string => Boolean(d?.trim()));
  if (conDireccion.length === 0) {
    return 'sin-direccion';
  }
  return conDireccion.some((d) => !esDireccionLocal(d)) ? 'ok' : 'solo-local';
}

/**
 * Un agente del evento, reducido a lo que se mira. FHIR permite VARIOS: en la
 * ejecución de un bot vienen dos —la persona que la disparó (`requestor`) y el
 * bot— y el orden no está garantizado.
 */
export interface AgenteAuditoria {
  direccion?: string;
  nombre?: string;
  esRequestor?: boolean;
}

/**
 * La dirección del evento, buscando en TODOS los agentes.
 *
 * Mirar solo `agent[0]` es el error fácil: en un evento de ejecución de bot el
 * primero es la persona (sin `network`) y el segundo es el bot. Si algún día el
 * orden se invierte, leer el índice 0 reportaría "(sin dirección)" sobre un
 * evento que sí la tiene.
 */
export function direccionDe(agentes: readonly AgenteAuditoria[]): string | undefined {
  return agentes.find((a) => a.direccion?.trim())?.direccion;
}

/**
 * Quién lo hizo. El `requestor` manda: es la PERSONA que disparó la acción, y
 * en una ejecución de bot es lo único que dice quién estuvo detrás.
 */
export function requestorDe(agentes: readonly AgenteAuditoria[]): string | undefined {
  return (agentes.find((a) => a.esRequestor) ?? agentes[0])?.nombre;
}

/**
 * ¿Este evento todavía trae nombres propios?
 *
 * Con `redactAuditEvents` el servidor vacía el `display` de las tres
 * referencias del evento — `agent[].who`, `entity[].what` y `source.observer`
 * (`util/auditevent.ts`, `applyOptionalRedaction`) —, así que queda la
 * referencia (`Practitioner/074875f0…`), que es lo que prueba, sin el nombre.
 *
 * **La redacción NO es retroactiva**: se aplica al escribir. Los eventos
 * guardados antes del cambio conservan los nombres hasta que la purga los
 * levante. Por eso esto se mira sobre los eventos MÁS NUEVOS, no sobre el
 * total.
 */
export function traeNombres(displays: readonly (string | undefined)[]): boolean {
  return displays.some((d) => Boolean(d?.trim()));
}
