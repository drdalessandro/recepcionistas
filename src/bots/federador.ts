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
  type AmbienteBus,
  claimsClientAssertion,
  cuerpoPedidoToken,
  urlBusquedaPorDni,
  urlToken,
  type ScopeBus,
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
  /** DNI ilegible: no se consulta con basura. */
  | 'dni-invalido'
  /** El bus contestó mal (auth, red, 5xx). */
  | 'bus-no-responde'
  /** No está federada esa persona. */
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
  });
  if (!resp.ok) {
    // Queda en CloudWatch: es donde se ve si el problema es la secret word.
    console.log(`bw-federador: auth respondió ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`);
    return undefined;
  }
  const json = (await resp.json().catch(() => undefined)) as { accessToken?: string } | undefined;
  return json?.accessToken;
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

  try {
    const token = await pedirToken(busUrl, issuer, secreto, SCOPES.pacienteLeer);
    if (!token) {
      return { ok: false, ambiente, motivo: 'bus-no-responde', detalle: 'no se pudo obtener el accessToken' };
    }

    const resp = await fetch(urlBusquedaPorDni(busUrl, dni), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' },
    });
    if (!resp.ok) {
      console.log(`bw-federador: búsqueda respondió ${resp.status}`);
      return { ok: false, ambiente, motivo: 'bus-no-responde', detalle: `HTTP ${resp.status}` };
    }

    // La búsqueda devuelve un Bundle; un `Patient` suelto sería la búsqueda por id.
    const cuerpo = (await resp.json().catch(() => undefined)) as Bundle | Patient | undefined;
    const candidatos: Patient[] =
      cuerpo?.resourceType === 'Bundle'
        ? ((cuerpo.entry ?? [])
            .map((e) => e.resource)
            .filter((r): r is Patient => r?.resourceType === 'Patient'))
        : cuerpo?.resourceType === 'Patient'
          ? [cuerpo]
          : [];

    const elegido = elegirPorDni(candidatos, dni);
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
    console.log(`bw-federador: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, ambiente, motivo: 'bus-no-responde' };
  }
}
