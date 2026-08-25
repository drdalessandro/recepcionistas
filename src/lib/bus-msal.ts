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
  // El system va sin encodear (así está en la colección); el valor sí, por las dudas.
  return `${base}${PATH_FEDERADOR}/Patient?identifier=http://www.renaper.gob.ar/dni|${encodeURIComponent(dni)}`;
}

/** URL del endpoint de token. */
export function urlToken(busUrl: string): string {
  return `${busUrl.replace(/\/+$/, '')}${PATH_AUTH}`;
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
