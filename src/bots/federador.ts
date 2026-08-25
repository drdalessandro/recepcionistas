/**
 * Bot · Federador de Pacientes del Ministerio de Salud (SOLO LECTURA).
 *
 * Busca a una persona por su **DNI** en el registro nacional y devuelve lo que
 * el alta puede completar sola: nombre, apellido —con las dos ramas separadas—,
 * fecha de nacimiento y género. Nunca escribe nada, ni acá ni allá.
 *
 * Por qué existe: hoy la recepcionista tipea todos esos campos, y cada uno es
 * una fuente de duplicados y de nombres mal escritos. El caso 2 del walk-in fue
 * exactamente eso. El DNI lo trae la persona; el resto lo sabe el Estado.
 *
 * ## Autenticación (Bus Auth v2)
 *
 * Tal como está en la colección de Postman oficial:
 *
 *  1. Se arma un JWT **HS256** firmado con la *token secret word* del dominio,
 *     con `iss` = la URL del dominio (para nosotros, `https://api.medplum.com.ar`).
 *  2. Ese JWT va como `clientAssertion` en un `POST {bus}/bus-auth/v2/auth`,
 *     con el **scope del servicio** — uno por servicio, nunca todos juntos.
 *  3. El `accessToken` que vuelve va como `Bearer` en la llamada FHIR.
 *
 * La firma usa `node:crypto`, que en un bot no molesta pero **no puede entrar al
 * bundle del navegador**: por eso vive acá y no en `src/lib` (mismo cuidado que
 * con la firma de Twilio). Lo puro —claims, body, URLs— está en
 * `src/lib/bus-msal.ts`.
 *
 * ## Corre con alguien esperando en el mostrador
 *
 * No es un cron: del otro lado hay una recepcionista con la persona enfrente.
 * Por eso los dos `fetch` van con **timeout corto** y el token se **reutiliza**
 * entre ejecuciones — sin eso, cada DNI tipeado son dos viajes al bus nacional.
 *
 * ## Falla abierta, nunca bloquea
 *
 * Sin credenciales, con el bus caído o con la persona no federada, devuelve un
 * motivo y listo: el alta sigue funcionando exactamente como hoy. Autocompletar
 * es una ayuda, no un requisito.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Bundle, Patient } from '@medplum/fhirtypes';
import { createHmac } from 'node:crypto';
import {
  SCOPES,
  ambienteBus,
  claimsClientAssertion,
  cuerpoPedidoToken,
  tokenSirve,
  urlBusquedaPorDni,
  urlToken,
  type AmbienteBus,
  type ScopeBus,
  type TokenCacheado,
} from '../lib/bus-msal.js';
import { elegirPorDni, sugerenciaParaAlta, type SugerenciaAlta } from '../lib/federador.js';
import { soloDigitos } from '../lib/dedup.js';

export interface EntradaFederador {
  /** Documento a buscar (con o sin puntos). */
  dni: string;
  /**
   * Lo que la recepcionista ya escribió: esos campos NO se sugieren. Ella tiene
   * a la persona enfrente; el registro tiene lo que había la última vez.
   */
  yaCargado?: { nombre?: string; apellido?: string; fechaNacimiento?: string; genero?: string };
}

export type MotivoSinDatos =
  /** Faltan los Project Secrets del bus: no se intentó nada. */
  | 'sin-credenciales'
  /** `BUS_MSAL_URL` no es ninguno de los dos buses conocidos: no se firma nada. */
  | 'bus-desconocido'
  /** DNI ilegible: no se consulta con basura. */
  | 'dni-invalido'
  /** El bus contestó mal (auth, red, timeout, 5xx, o un cuerpo que no es FHIR). */
  | 'bus-no-responde'
  /** El bus contestó bien y esa persona no está federada. */
  | 'sin-resultados'
  /** Más de una persona con ese mismo documento: no elegimos por el usuario. */
  | 'ambiguo';

export interface ResultadoFederador {
  ok: boolean;
  /** Datos que el alta puede completar (vacío si no hay nada que aportar). */
  sugerencia?: SugerenciaAlta;
  /** Id de la persona en el Federador, por si después se quiere volver a consultar. */
  idFederador?: string;
  motivo?: MotivoSinDatos;
  /**
   * Contra qué bus se consultó. Se informa SIEMPRE: el environment de QA de
   * Postman trae la URL de producción, así que "creí que estaba en QA" es un
   * error que hay que poder ver, no deducir.
   */
  ambiente?: AmbienteBus;
  /** Detalle para el log; nunca se muestra al paciente. */
  detalle?: string;
}

/**
 * Presupuesto de espera. Corto a propósito: esto corre con una persona parada en
 * el mostrador, no en un cron. Sin `signal`, un bus que acepta la conexión y no
 * contesta deja la pantalla girando hasta que corte el runtime del bot.
 */
const TIMEOUT_AUTH_MS = 5_000;
const TIMEOUT_BUSQUEDA_MS = 8_000;

/**
 * Vida que le asignamos al `accessToken`. El bus **no documenta** cuánto dura, y
 * `tokenSirve` ya deja margen: si el servidor lo invalida antes, la búsqueda da
 * 401 y se reintenta UNA vez con uno nuevo.
 */
const TOKEN_TTL_MS = 5 * 60_000;

/**
 * Token vivo entre ejecuciones. En Lambda el módulo sobrevive entre
 * invocaciones tibias, así que acá es donde corresponde: cuatro personas en la
 * cola dejan de ser ocho viajes al bus nacional.
 */
let cacheToken: TokenCacheado | undefined;

/** Base64url de un Buffer o string (sin padding, con - y _). */
function base64url(v: Buffer | string): string {
  return Buffer.from(v).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * JWT HS256 firmado con la secret word del dominio. Es el `clientAssertion` del
 * pedido de token — de un solo uso y de vida corta.
 */
export function firmarClientAssertion(issuer: string, secreto: string, ahora: Date): string {
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'HS256' }));
  const payload = base64url(JSON.stringify(claimsClientAssertion(issuer, ahora)));
  const firma = base64url(createHmac('sha256', secreto).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${firma}`;
}

/** Pide un accessToken para UN scope. */
async function pedirToken(
  busUrl: string,
  issuer: string,
  secreto: string,
  scope: ScopeBus,
): Promise<string | undefined> {
  const assertion = firmarClientAssertion(issuer, secreto, new Date());
  const resp = await fetch(urlToken(busUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpoPedidoToken(scope, assertion)),
    signal: AbortSignal.timeout(TIMEOUT_AUTH_MS),
  });
  if (!resp.ok) {
    // Queda en CloudWatch: es donde se ve si el problema es la secret word.
    console.log(`bw-federador: auth respondió ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`);
    return undefined;
  }
  const json = (await resp.json().catch(() => undefined)) as { accessToken?: string } | undefined;
  return json?.accessToken;
}

/** El token del cache si sirve; si no, uno nuevo (y lo guarda). */
async function tokenParaBuscar(
  busUrl: string,
  issuer: string,
  secreto: string,
  forzarNuevo = false,
): Promise<string | undefined> {
  const ahora = new Date();
  if (!forzarNuevo && tokenSirve(cacheToken, SCOPES.pacienteLeer, ahora)) {
    return cacheToken?.accessToken;
  }
  const accessToken = await pedirToken(busUrl, issuer, secreto, SCOPES.pacienteLeer);
  cacheToken = accessToken
    ? { scope: SCOPES.pacienteLeer, accessToken, venceEn: new Date(ahora.getTime() + TOKEN_TTL_MS) }
    : undefined;
  return accessToken;
}

export async function handler(
  _medplum: MedplumClient,
  event: BotEvent<EntradaFederador>,
): Promise<ResultadoFederador> {
  const dni = soloDigitos(event.input?.dni ?? '');
  if (dni.length < 6) {
    return { ok: false, motivo: 'dni-invalido' };
  }

  const secrets = event.secrets ?? {};
  const busUrl = secrets.BUS_MSAL_URL?.valueString;
  const issuer = secrets.BUS_MSAL_ISSUER?.valueString;
  const secreto = secrets.BUS_MSAL_SECRET?.valueString;
  if (!busUrl || !issuer || !secreto) {
    // Sin credenciales no se intenta nada: no es un error, es que no está
    // configurado. El alta sigue igual que siempre.
    return { ok: false, motivo: 'sin-credenciales' };
  }

  const ambiente = ambienteBus(busUrl);
  if (ambiente === 'desconocido') {
    // Antes de firmar nada. Un `http://` por error de tipeo mandaría el JWT
    // —y después el accessToken y el DNI— en claro; un host equivocado se los
    // mandaría a un tercero. La lista blanca de los dos buses es la defensa.
    console.log(`bw-federador: BUS_MSAL_URL no es ninguno de los buses conocidos (${busUrl})`);
    return { ok: false, ambiente, motivo: 'bus-desconocido' };
  }

  try {
    let token = await tokenParaBuscar(busUrl, issuer, secreto);
    if (!token) {
      return { ok: false, ambiente, motivo: 'bus-no-responde', detalle: 'no se pudo obtener el accessToken' };
    }

    const buscar = async (bearer: string): Promise<Response> =>
      fetch(urlBusquedaPorDni(busUrl, dni), {
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/fhir+json' },
        signal: AbortSignal.timeout(TIMEOUT_BUSQUEDA_MS),
      });

    let resp = await buscar(token);
    if (resp.status === 401 || resp.status === 403) {
      // El cache tenía un token que el servidor ya invalidó: UN reintento con
      // uno nuevo. Sin esto, cachear cambiaría un problema por otro.
      token = await tokenParaBuscar(busUrl, issuer, secreto, true);
      if (!token) {
        return { ok: false, ambiente, motivo: 'bus-no-responde', detalle: 'no se pudo renovar el accessToken' };
      }
      resp = await buscar(token);
    }
    if (!resp.ok) {
      console.log(`bw-federador: búsqueda respondió ${resp.status}`);
      return { ok: false, ambiente, motivo: 'bus-no-responde', detalle: `HTTP ${resp.status}` };
    }

    // Un 200 NO garantiza un Bundle: un gateway puede devolver HTML, y el
    // servidor FHIR un OperationOutcome. Colapsar eso a "no está federada"
    // sería afirmar algo falso sobre el registro nacional, así que se separa.
    const crudo = await resp.text();
    // Se parsea como `unknown` a propósito: es entrada de un tercero, no un
    // Bundle hasta que se compruebe. Castearlo antes de mirarlo sería la misma
    // mentira que hacía que un OperationOutcome pasara por "no está federada".
    let cuerpo: unknown;
    try {
      cuerpo = JSON.parse(crudo);
    } catch {
      console.log(`bw-federador: respuesta no-JSON (${crudo.slice(0, 200)})`);
      return { ok: false, ambiente, motivo: 'bus-no-responde', detalle: 'respuesta no-JSON' };
    }
    const tipo = (cuerpo as { resourceType?: string } | null)?.resourceType;
    if (tipo !== 'Bundle' && tipo !== 'Patient') {
      const recibido = tipo ?? 'sin resourceType';
      console.log(`bw-federador: se esperaba Bundle y llegó ${recibido}`);
      return { ok: false, ambiente, motivo: 'bus-no-responde', detalle: `se esperaba Bundle, llegó ${recibido}` };
    }

    const candidatos: Patient[] =
      tipo === 'Bundle'
        ? ((cuerpo as Bundle).entry ?? [])
            .map((e) => e.resource)
            .filter((r): r is Patient => r?.resourceType === 'Patient')
        : [cuerpo as Patient];

    const elegido = elegirPorDni(candidatos, dni);
    // Consultar el padrón nacional con el documento de una persona es un
    // tratamiento de datos: queda registrado quién se buscó y con qué resultado.
    // Va al log de la ejecución (AuditEvent / CloudWatch), que la policy de
    // Recepción no incluye — no lo ve el mostrador.
    console.log(`bw-federador: dni=${dni} ambiente=${ambiente} resultado=${elegido.estado}`);
    if (elegido.estado !== 'unico') {
      return { ok: false, ambiente, motivo: elegido.estado };
    }
    return {
      ok: true,
      ambiente,
      sugerencia: sugerenciaParaAlta(elegido.datos, event.input?.yaCargado),
      ...(elegido.datos.idFederador ? { idFederador: elegido.datos.idFederador } : {}),
    };
  } catch (e) {
    // Incluye el AbortError del timeout: el bus tardó más de lo que se puede
    // esperar con alguien en el mostrador.
    console.log(`bw-federador: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, ambiente, motivo: 'bus-no-responde' };
  }
}
