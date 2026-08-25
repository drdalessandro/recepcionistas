/**
 * Bus de Interoperabilidad del Ministerio de Salud — armado del pedido de token.
 *
 * Lógica pura: qué se manda. La FIRMA (HMAC) y el `fetch` viven en el bot, para
 * que `node:crypto` no entre nunca al bundle del navegador — mismo cuidado que
 * con la firma de Twilio (`src/lib/whatsapp.ts` vs `telefono.ts`).
 *
 * Todo lo de acá sale de la colección de Postman oficial del Federador
 * (PacientesPROD, OCT 2025), no de una suposición:
 *
 *  1. Se arma un **JWT firmado con HS256** usando la *token secret word* del
 *     dominio (`domainTokenSecret`), con `iss` = la URL del dominio.
 *  2. Ese JWT viaja como `clientAssertion` en un POST al endpoint de auth, junto
 *     con el **scope del servicio** que se va a consumir.
 *  3. La respuesta trae `accessToken`, que va como `Bearer` en cada llamada FHIR.
 *
 * El punto 2 es la parte que hay que respetar: **un token por servicio**. La
 * pantalla de credenciales lo dice explícitamente — si el dominio tiene varios
 * scopes habilitados, en el body va **únicamente** el del servicio que se usa.
 */
import { SYSTEM_RENAPER_DNI } from '../fhir/identifiers.js';

/**
 * Los dos buses, con nombre.
 *
 * ⚠️ **El environment "VARIABLES QA" de Postman miente en esto.** Dice
 * `busUrl: https://bus.msal.gob.ar` — que es **producción**— mientras que la
 * colección de QA tiene `bus-test.msal.gob.ar` **hardcodeado en las 10 requests**
 * y nunca lee esa variable. Configurar el bus copiando el valor del environment
 * de QA significa consultar el registro nacional productivo creyendo que se está
 * probando. De ahí que las dos URLs estén acá, con nombre, y que el bot informe
 * contra cuál habló.
 */
export const BUS_URLS = {
  qa: 'https://bus-test.msal.gob.ar',
  prod: 'https://bus.msal.gob.ar',
} as const;

export type AmbienteBus = 'qa' | 'prod' | 'desconocido';

/** Contra qué bus se está hablando. Se reporta en el resultado, no se adivina. */
export function ambienteBus(busUrl: string | undefined): AmbienteBus {
  const normal = (busUrl ?? '').replace(/\/+$/, '').toLowerCase();
  if (normal === BUS_URLS.qa) {
    return 'qa';
  }
  if (normal === BUS_URLS.prod) {
    return 'prod';
  }
  return 'desconocido';
}

/** Path del endpoint de autenticación (Bus Auth v2), relativo al `busUrl`. */
export const PATH_AUTH = '/bus-auth/v2/auth';

/**
 * Path del servicio del Federador de Pacientes.
 *
 * ⚠️ La documentación muestra los ejemplos con `/fhir/Patient`, pero **todas las
 * búsquedas de la colección oficial usan `/masterfile-federacion-service/fhir`**.
 * Ese es el que se usa acá.
 */
export const PATH_FEDERADOR = '/masterfile-federacion-service/fhir';

/** Scopes habilitados para el dominio Biowellness (pantalla de credenciales). */
export const SCOPES = {
  pacienteLeer: 'Patient/*.read',
  pacienteEscribir: 'Patient/*.write',
  profesionalLeer: 'Practitioner/*.read',
  organizacionLeer: 'Organization/*.read',
  ubicacionLeer: 'Location/*.read',
  inmunizacionLeer: 'Immunization/*.read',
} as const;

export type ScopeBus = (typeof SCOPES)[keyof typeof SCOPES];

/**
 * Vida del *client assertion* (el JWT que se manda para pedir el token).
 *
 * La colección oficial usa `iat + 6000000` (≈ 69 días), que para una aserción de
 * un solo uso es una eternidad. Acá se usan 5 minutos: es lo que corresponde a
 * un credential de un solo intercambio, y un `exp` más corto nunca es más
 * permisivo que el del ejemplo. Si el bus llegara a rechazarlo, esta constante
 * es la primera perilla a mover.
 */
export const ASSERTION_TTL_S = 300;

/** Header del JWT: la colección lo fija en HS256. */
export const HEADER_JWT = { typ: 'JWT', alg: 'HS256' } as const;

/**
 * Claims del JWT.
 *
 * `aud`, `sub`, `name`, `ident` y `role` van con esos **valores literales**
 * porque así están en la colección oficial: son relleno que el bus no valida.
 * Se replican tal cual a propósito — "mejorarlos" con valores que parezcan
 * sensatos sería inventar un contrato que nadie especificó.
 */
export function claimsClientAssertion(issuer: string, ahora: Date, ttlSegundos = ASSERTION_TTL_S): Record<string, string | number> {
  const iat = Math.floor(ahora.getTime() / 1000);
  return {
    iss: issuer,
    iat,
    exp: iat + ttlSegundos,
    aud: 'aud',
    sub: 'sub',
    name: 'name',
    ident: 'ident',
    role: 'role',
  };
}

/** Body del POST de autenticación. */
export function cuerpoPedidoToken(scope: ScopeBus, clientAssertion: string): Record<string, string> {
  return {
    grantType: 'client_credentials',
    scope,
    clientAssertionType: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    clientAssertion,
  };
}

/** Búsqueda de un paciente por DNI en el Federador (path + query completos). */
export function urlBusquedaPorDni(busUrl: string, dni: string): string {
  const base = busUrl.replace(/\/+$/, '');
  // El system sale de `identifiers.ts` y no hardcodeado: se busca por el mismo
  // con el que después se filtra la respuesta (`src/lib/federador.ts`). Si
  // divergieran, la búsqueda traería a alguien que el filtro descarta.
  // Va sin encodear (así está en la colección); el valor sí, por las dudas.
  return `${base}${PATH_FEDERADOR}/Patient?identifier=${SYSTEM_RENAPER_DNI}|${encodeURIComponent(dni)}`;
}

/** URL del endpoint de token. */
export function urlToken(busUrl: string): string {
  return `${busUrl.replace(/\/+$/, '')}${PATH_AUTH}`;
}

/**
 * ¿El error lo puso el bus, o algo en el medio?
 *
 * Importa distinguirlo. Un proxy corporativo, un gateway o una allowlist de
 * egreso cortan el pedido **antes de que llegue**, y reportar eso como "el bus
 * rechazó la credencial" manda a cambiar una secret word que puede estar
 * perfecta. Es la misma clase de mentira que decir "esa persona no está
 * federada" cuando el registro nacional nunca contestó.
 *
 * El criterio: el bus contesta **JSON siempre** (así está en la colección
 * oficial), así que un error con cuerpo de texto plano es casi con seguridad un
 * intermediario. El 407 es de proxy por definición.
 *
 * Es una heurística, y como tal se equivoca hacia el lado prudente: ante la duda
 * dice "no se pudo probar" en vez de acusar a la credencial.
 */
export function pareceIntermediario(status: number, cuerpo: string): boolean {
  if (status === 407) {
    return true;
  }
  const texto = cuerpo.trim();
  if (texto && !texto.startsWith('{') && !texto.startsWith('[')) {
    return true;
  }
  return /allowlist|egress|proxy|forbidden by|blocked/i.test(texto);
}

/**
 * El mensaje que el bus da de sí mismo, si lo da.
 *
 * Contesta en al menos dos formas: su envoltorio propio (`{"message": …}`, como
 * el 412) y `OperationOutcome` de FHIR (`issue[].diagnostics`, como el 400 y el
 * 404 de la guía). Vale la pena leerlo antes de opinar: cuando el otro lado
 * explica qué le falta, adivinar es peor que citarlo.
 */
export function mensajeDelBus(cuerpo: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(cuerpo);
  } catch {
    return undefined;
  }
  const o = json as {
    message?: string;
    error_description?: string;
    issue?: Array<{ diagnostics?: string }>;
  } | null;
  const diagnostics = o?.issue?.map((i) => i?.diagnostics).filter(Boolean).join(' · ');
  return o?.message || o?.error_description || diagnostics || undefined;
}

/** Qué clase de rechazo es el del endpoint de auth. */
export type ClaseErrorAuth = 'credencial' | 'precondicion' | 'desconocido';

/**
 * ¿El bus está discutiendo nuestra **firma**, o pidiendo otra cosa?
 *
 * La diferencia decide qué se toca. Un `412 Missing organization authentication`
 * no dice nada de la *token secret word*: dice que falta un requisito previo. Y
 * mandar a cambiar la credencial por eso hace perder horas cambiando algo que
 * está bien — el mismo error de siempre, adivinar en vez de leer lo que el otro
 * lado dijo.
 */
export function clasificarErrorAuth(status: number, cuerpo: string): ClaseErrorAuth {
  if (status === 412) {
    return 'precondicion';
  }
  if (status === 401 || status === 403) {
    return 'credencial';
  }
  const mensaje = mensajeDelBus(cuerpo) ?? cuerpo;
  if (/invalid[_ ]?(client|token|signature|assertion|grant)|signature|unauthorized/i.test(mensaje)) {
    return 'credencial';
  }
  return 'desconocido';
}

/** Un token vivo, por scope. */
export interface TokenCacheado {
  scope: ScopeBus;
  accessToken: string;
  /** Momento a partir del cual conviene pedir uno nuevo. */
  venceEn: Date;
}

/**
 * ¿Sirve el token que tengo?
 *
 * Con margen: un token que vence en 30 segundos no alcanza para la llamada que
 * sigue. El bus no documenta la duración del `accessToken`, así que la vida útil
 * la fija quien lo guarda; acá solo se decide si el que hay todavía sirve.
 */
export function tokenSirve(cache: TokenCacheado | undefined, scope: ScopeBus, ahora: Date, margenS = 30): boolean {
  if (!cache || cache.scope !== scope || !cache.accessToken) {
    return false;
  }
  return cache.venceEn.getTime() - ahora.getTime() > margenS * 1000;
}
