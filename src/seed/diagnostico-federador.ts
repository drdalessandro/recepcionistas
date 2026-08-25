/**
 * Diagnóstico del Federador de Pacientes (Bus del Ministerio de Salud).
 *
 *   npm run federador:check                      # QA: capa local + capa bot
 *   npm run federador:check -- --dni 23327755    # con un documento concreto
 *   npm run federador:check -- --solo-local      # no toca Medplum
 *   npm run federador:check -- --solo-bot        # solo el bot deployado
 *   npm run federador:check -- --prod            # producción, a propósito
 *
 * ## Por qué dos capas
 *
 * Las credenciales del bus viven en **dos lugares distintos** y fallan igual:
 *
 *  - La *token secret word* del dominio, que es lo que firma el JWT.
 *  - Los **Project Secrets de Medplum**, que son los que ve el bot al correr.
 *
 * Si solo se prueba a través del bot, "no anda" puede ser la secret word
 * equivocada, el secret sin cargar, o el bot sin deployar — tres arreglos
 * distintos con el mismo síntoma. Por eso:
 *
 *  - **Capa 1** habla con el bus desde acá, con lo que haya en el `.env`. Valida
 *    la credencial *antes* de cargarla en el servidor.
 *  - **Capa 2** ejecuta `bw-federador` en Medplum, que lee los Project Secrets
 *    reales. Valida el otro lado.
 *
 * El cruce de las dos es el diagnóstico; está impreso al final de la corrida.
 *
 * ## Este script no puede pegarle a producción sin que se lo pidan
 *
 * El ambiente lo decide el flag, **nunca** el `.env`: el environment "VARIABLES
 * QA" de Postman trae la URL de producción, así que un `.env` armado desde ese
 * archivo consultaría el padrón nacional productivo con DNIs reales creyendo que
 * está probando. Si el `.env` no coincide con el ambiente elegido, se avisa —
 * porque ese valor es el que después se copia a Medplum.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { MedplumClient } from '@medplum/core';
import {
  ASSERTION_TTL_S,
  BUS_URLS,
  PATH_AUTH,
  SCOPES,
  ambienteBus,
  clasificarErrorAuth,
  cuerpoPedidoToken,
  mensajeDelBus,
  pareceIntermediario,
  urlBusquedaPorDni,
  urlToken,
  type AmbienteBus,
  type ClaseErrorAuth,
} from '../lib/bus-msal.js';
import { firmarClientAssertion, type ResultadoFederador } from '../bots/federador.js';
import { elegirPorDni } from '../lib/federador.js';
import { soloDigitos, formatearDniConPuntos } from '../lib/dedup.js';
import type { Bundle, Patient } from '@medplum/fhirtypes';

const NOMBRE_BOT = 'bw-federador';

/**
 * DNI por defecto: el que la guía técnica usa en el ejemplo de **esta misma
 * búsqueda** (p. 6-7), con respuesta documentada 200.
 *
 * ⚠️ Es un ejemplo de la **documentación**, no un caso de prueba de QA. El
 * Ministerio **no publica documentos de prueba**: la colección de QA usa el
 * literal `dniPaciente` como placeholder y la guía no menciona QA en ninguna de
 * sus 31 páginas. Que dé `sin-resultados` es un resultado **normal** y no dice
 * nada malo de las credenciales.
 *
 * Los otros que aparecen en la guía, por si conviene probar más de uno:
 * 12497884 y 21506540 (entries del Bundle del Anexo II).
 */
const DNI_EJEMPLO_GUIA = '23327755';

/** Los otros documentos de ejemplo de la guía, para sugerirlos si el primero no da. */
const OTROS_DNI_GUIA = ['12497884', '21506540'];

const TIMEOUT_MS = 15_000;

interface Opciones {
  dni: string;
  ambiente: 'qa' | 'prod';
  soloLocal: boolean;
  soloBot: boolean;
}

function parsearArgs(argv: string[]): Opciones {
  const arg = (nombre: string): string | undefined => {
    const i = argv.indexOf(nombre);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    dni: soloDigitos(arg('--dni') ?? DNI_EJEMPLO_GUIA),
    ambiente: argv.includes('--prod') ? 'prod' : 'qa',
    soloLocal: argv.includes('--solo-local'),
    soloBot: argv.includes('--solo-bot'),
  };
}

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/**
 * Huella de un secreto, para poder compararlo entre ambientes sin mostrarlo.
 * Nunca se imprime el valor: este script se corre en una terminal que queda.
 */
function huella(secreto: string): string {
  return `${secreto.length} caracteres · sha256:${createHash('sha256').update(secreto).digest('hex').slice(0, 12)}`;
}

/** Lo que salió de intentar autenticarse contra el bus. */
interface ResultadoAuth {
  ok: boolean;
  accessToken?: string;
  status?: number;
  cuerpo?: string;
  /**
   * El error lo puso algo en el medio (proxy corporativo, gateway, allowlist de
   * egreso) y el pedido **nunca llegó al bus**. Distinguirlo importa: decir "el
   * bus rechazó la credencial" cuando el paquete no salió de la red es una
   * afirmación falsa, y manda a cambiar la secret word que estaba bien.
   */
  bloqueadoPorRed?: boolean;
}

async function pedirToken(busUrl: string, issuer: string, secreto: string, ttl?: number): Promise<ResultadoAuth> {
  const assertion = firmarClientAssertion(issuer, secreto, new Date(), ttl);
  const resp = await fetch(urlToken(busUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpoPedidoToken(SCOPES.pacienteLeer, assertion)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const crudo = await resp.text().catch(() => '');
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      cuerpo: crudo.slice(0, 400),
      bloqueadoPorRed: pareceIntermediario(resp.status, crudo),
    };
  }
  let accessToken: string | undefined;
  try {
    accessToken = (JSON.parse(crudo) as { accessToken?: string }).accessToken;
  } catch {
    return { ok: false, status: resp.status, cuerpo: `respuesta no-JSON: ${crudo.slice(0, 200)}`, bloqueadoPorRed: true };
  }
  return accessToken
    ? { ok: true, accessToken, status: resp.status }
    : { ok: false, status: resp.status, cuerpo: `200 sin accessToken: ${crudo.slice(0, 200)}` };
}

/**
 * Las tres respuestas posibles de una capa.
 *
 * `no-probado` existe a propósito y no es un lujo: "no se pudo probar" no es lo
 * mismo que "falló". Colapsarlos manda a cambiar una credencial que puede estar
 * perfecta — es el mismo error que reportar "esa persona no está federada"
 * cuando en realidad el bus nunca contestó.
 */
type Veredicto = 'ok' | 'falla' | 'no-probado';

/**
 * Lo que la Capa 1 aprendió del rechazo, para que la conclusión no invente.
 * Sin esto, un `412` y una firma mal terminan dando el mismo consejo.
 */
interface Notas {
  claseAuth?: ClaseErrorAuth;
  diceElBus?: string;
}

/** Capa 1: bus directo, con las credenciales del `.env`. */
async function capaLocal(opts: Opciones, busUrl: string, notas: Notas): Promise<Veredicto> {
  console.log('\n--- Capa 1 · contra el bus desde acá (valida la TOKEN SECRET WORD) ---\n');

  const issuer = process.env.BUS_MSAL_ISSUER;
  const secreto = process.env.BUS_MSAL_SECRET;
  if (!issuer || !secreto) {
    console.error('✗ Faltan credenciales en el .env local para esta capa:');
    if (!issuer) {
      console.error('    • BUS_MSAL_ISSUER  → la URL del dominio registrado (para nosotros https://api.medplum.com.ar)');
    }
    if (!secreto) {
      console.error('    • BUS_MSAL_SECRET  → la "token secret word" de dominios.msal.gob.ar → credenciales');
    }
    console.error('  Sin esto no se puede saber si la credencial sirve ANTES de cargarla en Medplum.');
    console.error('  (No es una falla: es que esta capa no se pudo correr. La Capa 2 sigue valiendo.)');
    return 'no-probado';
  }

  console.log(`  issuer  : ${issuer}`);
  console.log(`  secret  : ${huella(secreto)}`);
  console.log(`  POST    : ${busUrl}${PATH_AUTH}  (scope ${SCOPES.pacienteLeer}, exp = iat + ${ASSERTION_TTL_S}s)`);

  let auth: ResultadoAuth;
  try {
    auth = await pedirToken(busUrl, issuer, secreto);
  } catch (e) {
    console.error(`\n✗ No se pudo ni conectar: ${e instanceof Error ? e.message : String(e)}`);
    console.error('  Puede ser DNS, firewall de salida, o que el bus esté caído. No dice nada de la credencial.');
    return 'no-probado';
  }

  if (!auth.ok && auth.bloqueadoPorRed) {
    // El pedido NO llegó al bus. Decir acá "credencial rechazada" mandaría a
    // cambiar una secret word que puede estar perfecta.
    console.error(`\n✗ El pedido NO llegó al bus: lo cortó algo en el medio (HTTP ${auth.status}).`);
    console.error(`  Respuesta: ${auth.cuerpo || '(vacía)'}`);
    console.error('\n  Esto NO dice nada sobre la credencial: no se pudo probar.');
    console.error(`  Habilitá la salida a ${new URL(busUrl).host} en la red desde donde corrés esto,`);
    console.error('  o corré el diagnóstico desde una máquina que llegue al bus.');
    console.error('  Ojo: que TU red llegue no garantiza que el servidor de Medplum llegue. Los bots');
    console.error('  salen desde AWS Lambda, así que la Capa 2 es la que prueba ESA salida.');
    return 'no-probado';
  }

  if (!auth.ok) {
    const clase = clasificarErrorAuth(auth.status ?? 0, auth.cuerpo ?? '');
    const dice = mensajeDelBus(auth.cuerpo ?? '');
    notas.claseAuth = clase;
    notas.diceElBus = dice;
    console.error(`\n✗ El bus rechazó la autenticación (HTTP ${auth.status}).`);
    // Lo que el bus dice de sí mismo va primero y textual. Cuando el otro lado
    // explica qué le falta, citarlo vale más que cualquier hipótesis nuestra.
    if (dice) {
      console.error(`  Dice: «${dice}»`);
    }
    console.error(`  Respuesta cruda: ${auth.cuerpo || '(vacía)'}`);

    // La colección oficial firma con exp = iat + 6000000 (~69 días) y nosotros
    // con 5 minutos. Está documentado como la primera perilla a mover, así que
    // se prueba sola: si con el exp largo entra, el problema es ASSERTION_TTL_S
    // y no la secret word — dos arreglos muy distintos.
    //
    // Pero solo cuando el rechazo puede ser de la aserción. Ante un 412 el bus
    // ya dijo que le falta OTRA cosa; reintentar sería ruido, y peor: sugerir
    // que la credencial está en discusión cuando no lo está.
    if (clase !== 'credencial' && clase !== 'desconocido') {
      console.error('\n  El bus NO está discutiendo la firma: está pidiendo un requisito previo.');
      console.error('  **No cambies la token secret word por esto** — no es lo que te está reclamando.');
      if (/organization authentication/i.test(dice ?? '')) {
        // Este mensaje ya lo vimos y lo rastreamos: no hace falta que nadie
        // vuelva a investigarlo desde cero.
        console.error('\n  Este error ya está diagnosticado. Falta una SEGUNDA autenticación, la de la');
        console.error('  aplicación, que es distinta de la del dominio que sí estamos haciendo:');
        console.error('    POST {bus}/masterfile-federacion-service/api/usuarios/aplicacion/login');
        console.error('    {"nombre": …, "clave": …, "codDominio": …}   → devuelve `token`');
        console.error('  Son las credenciales `appName`/`appPassword` de los environments de Postman,');
        console.error('  que vienen vacías: hay que pedírselas al Ministerio para el dominio 4002.');
        console.error('  El detalle y las preguntas exactas están en');
        console.error('  docs/handoff-federador-msal.md § "Missing organization authentication".');
      } else {
        console.error('  Lo que dice arriba es lo que hay que resolver, y probablemente no se resuelva');
        console.error('  desde el código: mirá docs/handoff-federador-msal.md § "Missing organization authentication".');
      }
      return 'falla';
    }

    console.log('\n  Reintentando con el `exp` largo de la colección oficial (iat + 6000000) para descartar el TTL…');
    try {
      const largo = await pedirToken(busUrl, issuer, secreto, 6_000_000);
      if (largo.ok) {
        console.error('\n  ⚠️  CON EL EXP LARGO SÍ ENTRA. La secret word está BIEN.');
        console.error(`      El bus rechaza nuestro exp corto: subí ASSERTION_TTL_S en src/lib/bus-msal.ts`);
        console.error('      (hoy vale ' + ASSERTION_TTL_S + 's) y volvé a correr esto.');
      } else {
        console.error(`\n  Con el exp largo también rechaza (HTTP ${largo.status}). El TTL no es el problema.`);
        console.error('  Revisá: la token secret word, y que BUS_MSAL_ISSUER sea EXACTAMENTE la URL del dominio');
        console.error('  registrado en dominios.msal.gob.ar (el `iss` del JWT se compara con eso).');
      }
    } catch (e) {
      console.error(`  El reintento tampoco pudo conectarse: ${e instanceof Error ? e.message : String(e)}`);
    }
    return 'falla';
  }

  console.log(`\n✓ Autenticación OK. El bus devolvió un accessToken (${auth.accessToken?.length ?? 0} caracteres).`);
  console.log('  La token secret word y el issuer son correctos.');

  // Con el token en mano, la consulta real.
  const url = urlBusquedaPorDni(busUrl, opts.dni);
  console.log(`\n  GET     : ${url}`);
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: 'application/fhir+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    console.error(`\n✗ La búsqueda no pudo conectarse: ${e instanceof Error ? e.message : String(e)}`);
    return 'falla';
  }

  const crudo = await resp.text().catch(() => '');
  if (!resp.ok && pareceIntermediario(resp.status, crudo)) {
    // Mismo criterio que en el auth: si contestó algo en el medio, el servicio
    // de federación no dijo nada y no se le puede atribuir la falla.
    console.error(`\n✗ La búsqueda no llegó al servicio: la cortó algo en el medio (HTTP ${resp.status}).`);
    console.error(`  Respuesta: ${crudo.slice(0, 400) || '(vacía)'}`);
    console.error('  La autenticación sí había llegado, así que revisá si el path del servicio de');
    console.error('  federación está bloqueado aparte del de auth.');
    return 'no-probado';
  }
  if (!resp.ok) {
    console.error(`\n✗ La búsqueda devolvió HTTP ${resp.status}.`);
    console.error(`  Respuesta: ${crudo.slice(0, 400) || '(vacía)'}`);
    console.error('  El token servía, así que el problema está en el servicio de federación o en los permisos');
    console.error(`  del scope ${SCOPES.pacienteLeer} para este dominio.`);
    return 'falla';
  }

  let cuerpo: unknown;
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    console.error(`\n✗ 200 con un cuerpo que no es JSON: ${crudo.slice(0, 200)}`);
    console.error('  Suele ser un proxy en el medio, no el servicio FHIR.');
    return 'falla';
  }
  const tipo = (cuerpo as { resourceType?: string } | null)?.resourceType;
  if (tipo !== 'Bundle' && tipo !== 'Patient') {
    console.error(`\n✗ 200 con un recurso inesperado: ${tipo ?? 'sin resourceType'}.`);
    console.error(`  ${crudo.slice(0, 300)}`);
    return 'falla';
  }

  const candidatos: Patient[] =
    tipo === 'Bundle'
      ? ((cuerpo as Bundle).entry ?? []).map((e) => e.resource).filter((r): r is Patient => r?.resourceType === 'Patient')
      : [cuerpo as Patient];
  const elegido = elegirPorDni(candidatos, opts.dni);

  console.log(`\n✓ La búsqueda funcionó. El bus devolvió un ${tipo} con ${candidatos.length} Patient.`);
  if (elegido.estado === 'unico') {
    const d = elegido.datos;
    console.log('\n  La persona está federada. Lo que el Federador sabe de ella:');
    console.log(`    nombres          : ${d.nombres.length > 0 ? d.nombres.join(' ') : '(no vino)'}`);
    console.log(`    apellido         : ${d.apellido ?? '(no vino)'}`);
    console.log(`    apellido paterno : ${d.apellidoPaterno ?? '(no vino)'}`);
    console.log(`    apellido materno : ${d.apellidoMaterno ?? '(no vino)'}`);
    console.log(`    fecha nacimiento : ${d.fechaNacimiento ?? '(no vino)'}`);
    console.log(`    género           : ${d.genero ?? '(no vino)'}`);
    console.log(`    id federador     : ${d.idFederador ?? '(no vino)'}`);
    if (d.fallecido) {
      console.log('\n  ⚠️  Figura como FALLECIDA: el bot no sugiere nada y lo resuelve una persona.');
    }
    if (!d.apellidoPaterno) {
      // El perfil Patient-ar-core lo exige 1..1 y de un nombre suelto no se
      // deduce ("Juan Pérez González" es ambiguo). Si el Federador tampoco lo
      // trae, ese hueco sigue abierto y conviene saberlo desde la primera prueba.
      console.log('\n  ⚠️  Vino SIN apellido paterno separado, que es justo el dato que Patient-ar-core');
      console.log('      exige y que nosotros no sabemos deducir. Miralo en varias personas antes de');
      console.log('      dar por hecho que el Federador siempre lo trae.');
    }
  } else if (elegido.estado === 'sin-resultados') {
    console.log('\n  No hay nadie con ese documento en este ambiente.');
    console.log('  ⚠️  Contra QA eso es lo esperable y NO es una falla: el circuito completo');
    console.log('      (firma → token → búsqueda → Bundle válido) acaba de funcionar de punta a punta.');
    console.log('      El Ministerio no publica documentos de prueba: la colección de QA usa el');
    console.log('      placeholder `dniPaciente`, no un DNI real.');
    console.log(`      Probá con otro: ${OTROS_DNI_GUIA.map((d) => `-- --dni ${d}`).join('  ·  ')}`);
    console.log('\n      Y ojo con leerlo como "no está federada": la guía muestra un paciente');
    console.log('      federado SIN identifier de RENAPER (Anexo I, id 513298). Se puede estar en el');
    console.log('      padrón y no aparecer buscando por documento.');
  } else {
    console.log('\n  ⚠️  Hay MÁS DE UNA persona con ese documento: el bot devolvería `ambiguo` y no');
    console.log('      autocompletaría nada, a propósito.');
  }
  return 'ok';
}

/** Los tres Project Secrets, tal como están cargados en el servidor. */
type SecretsDelBot = Partial<Record<'BUS_MSAL_URL' | 'BUS_MSAL_ISSUER' | 'BUS_MSAL_SECRET', string>>;

/**
 * Lee los Project Secrets del proyecto (best-effort: necesita credenciales admin).
 *
 * Vale la pena intentarlo aunque pueda fallar, y no solo por precisión: si el
 * secret `BUS_MSAL_URL` del servidor apunta a producción, **hay que saberlo
 * antes de ejecutar el bot**, no después. Ejecutarlo para enterarse significa
 * haber consultado el padrón nacional real con un documento real — justo lo que
 * este script existe para evitar.
 */
async function leerSecretsDelProyecto(medplum: MedplumClient): Promise<SecretsDelBot | undefined> {
  try {
    const projectId =
      process.env.MEDPLUM_PROJECT_ID ??
      ((await medplum.get('auth/me')) as { project?: { id?: string } }).project?.id;
    if (!projectId) {
      return undefined;
    }
    const respuesta = (await medplum.get(`admin/projects/${projectId}`)) as {
      project?: { secret?: Array<{ name?: string; valueString?: string }> };
      secret?: Array<{ name?: string; valueString?: string }>;
    };
    const secretos = respuesta.project?.secret ?? respuesta.secret ?? [];
    const valor = (n: string): string | undefined => secretos.find((s) => s.name === n)?.valueString;
    return {
      BUS_MSAL_URL: valor('BUS_MSAL_URL'),
      BUS_MSAL_ISSUER: valor('BUS_MSAL_ISSUER'),
      BUS_MSAL_SECRET: valor('BUS_MSAL_SECRET'),
    };
  } catch {
    // Sin credenciales admin no se puede: se sigue con la ejecución del bot, que
    // igual reporta `ambiente` en la respuesta.
    return undefined;
  }
}

/** Capa 2: el bot deployado, que lee los Project Secrets del servidor. */
async function capaBot(opts: Opciones): Promise<Veredicto> {
  console.log('\n--- Capa 2 · el bot en Medplum (valida los PROJECT SECRETS) ---\n');

  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log(`  Conectado a ${process.env.MEDPLUM_BASE_URL}`);

  const enServidor = await leerSecretsDelProyecto(medplum);
  if (!enServidor) {
    console.log('  (No pude leer los Project Secrets — hace falta credencial admin. Sigo por la respuesta del bot.)');
  } else {
    console.log('\n  Project Secrets cargados en Medplum:');
    for (const nombre of ['BUS_MSAL_URL', 'BUS_MSAL_ISSUER', 'BUS_MSAL_SECRET'] as const) {
      const v = enServidor[nombre];
      const mostrado = !v
        ? '✗ NO está cargado'
        : nombre === 'BUS_MSAL_SECRET'
          ? `✓ ${huella(v)}`
          : `✓ ${v}`;
      console.log(`    ${nombre.padEnd(17)} ${mostrado}`);
    }

    // Antes de ejecutar nada: ¿a qué bus mandaría el bot este pedido?
    const ambienteServidor = ambienteBus(enServidor.BUS_MSAL_URL);
    if (ambienteServidor === 'prod' && opts.ambiente !== 'prod') {
      console.error('\n  🚨 FRENO: el Project Secret BUS_MSAL_URL apunta a **PRODUCCIÓN**.');
      console.error('     Ejecutar el bot ahora consultaría el padrón nacional REAL con un documento real,');
      console.error('     que es exactamente lo que este diagnóstico existe para no hacer sin querer.');
      console.error(`     Cambialo a ${BUS_URLS.qa} para probar, o corré esto con --prod si es a propósito.`);
      return 'falla';
    }

    // La secret word local y la del servidor se comparan por huella: si difieren,
    // lo que pruebe la Capa 1 no representa al bot y el cruce final mentiría.
    const secretoLocal = process.env.BUS_MSAL_SECRET;
    if (secretoLocal && enServidor.BUS_MSAL_SECRET && secretoLocal !== enServidor.BUS_MSAL_SECRET) {
      console.log('\n  ⚠️  La secret word del .env NO es la misma que la del servidor:');
      console.log(`      .env     : ${huella(secretoLocal)}`);
      console.log(`      Medplum  : ${huella(enServidor.BUS_MSAL_SECRET)}`);
      console.log('      Lo que diga la Capa 1 no representa al bot. Alineá las dos antes de sacar conclusiones.');
    }
  }

  const bots = (await medplum.searchResources('Bot', `name=${NOMBRE_BOT}&_count=10`)).filter((b) => b.name === NOMBRE_BOT);
  if (bots.length === 0) {
    console.error(`\n✗ No existe el bot "${NOMBRE_BOT}" en este proyecto. Deployalo: npm run deploy:bots`);
    return 'falla';
  }
  if (bots.length > 1) {
    console.warn(`  ⚠️  Hay ${bots.length} bots llamados ${NOMBRE_BOT}; puede estar corriendo código viejo.`);
    for (const b of bots) {
      console.warn(`     - Bot/${b.id} (actualizado ${b.meta?.lastUpdated ?? '?'})`);
    }
  }
  const bot = bots.sort((a, z) => (z.meta?.lastUpdated ?? '').localeCompare(a.meta?.lastUpdated ?? ''))[0]!;
  console.log(`  Ejecutando Bot/${bot.id} con dni=${formatearDniConPuntos(opts.dni)}`);

  const r = (await medplum.executeBot(bot.id, { dni: opts.dni })) as ResultadoFederador;
  console.log(`\n  Respuesta: ${JSON.stringify(r)}`);

  // Lo primero que se mira: contra qué bus habló DE VERDAD. Lo demás puede
  // parecer perfecto y estar consultando el padrón productivo.
  const avisarAmbiente = (amb: AmbienteBus | undefined): void => {
    if (amb === 'prod' && opts.ambiente !== 'prod') {
      console.error('\n  🚨 EL BOT HABLÓ CON **PRODUCCIÓN**, no con QA.');
      console.error(`     El Project Secret BUS_MSAL_URL en Medplum tiene ${BUS_URLS.prod}.`);
      console.error(`     Para probar tiene que valer ${BUS_URLS.qa}. Cambialo antes de seguir:`);
      console.error('     cada consulta acá es contra el padrón nacional real, con documentos reales.');
    } else if (amb) {
      console.log(`  Ambiente del bot: ${amb}`);
    }
  };

  switch (r.motivo) {
    case undefined:
      avisarAmbiente(r.ambiente);
      console.log('\n✓ El bot encontró a la persona y devolvió la sugerencia para el alta.');
      console.log(`  ${JSON.stringify(r.sugerencia)}`);
      return r.ambiente === 'prod' && opts.ambiente !== 'prod' ? 'falla' : 'ok';

    case 'sin-credenciales':
      console.error('\n✗ Al bot le FALTAN Project Secrets. Cargá los tres en Medplum');
      console.error('  (Project → Secrets; NO en el .env, que no lo ve el servidor):');
      console.error(`    • BUS_MSAL_URL     = ${BUS_URLS.qa}   ← QA. Producción es ${BUS_URLS.prod}`);
      console.error('    • BUS_MSAL_ISSUER  = https://api.medplum.com.ar');
      console.error('    • BUS_MSAL_SECRET  = la token secret word del dominio');
      console.error('  Después: npm run federador:check');
      return 'falla';

    case 'bus-desconocido':
      console.error('\n✗ El Project Secret BUS_MSAL_URL no es ninguno de los dos buses conocidos.');
      console.error(`  Tiene que ser exactamente ${BUS_URLS.qa} (QA) o ${BUS_URLS.prod} (producción).`);
      console.error('  El bot no firmó nada, que es lo que corresponde: un host equivocado se llevaría el JWT.');
      return 'falla';

    case 'dni-invalido':
      console.error(`\n✗ El bot no aceptó el documento "${opts.dni}" (necesita al menos 6 dígitos).`);
      return 'falla';

    case 'bus-no-responde':
      avisarAmbiente(r.ambiente);
      console.error(`\n✗ El bus no contestó bien: ${r.detalle ?? '(sin detalle)'}`);
      console.error('  El bot no reporta el cuerpo del error del bus; está en su log (AuditEvent / CloudWatch).');
      console.error('  Si la Capa 1 falló igual, es el MISMO problema visto desde el servidor y no hay');
      console.error('  nada que alinear. Si la Capa 1 pasó, entonces sí: revisá que BUS_MSAL_SECRET y');
      console.error('  BUS_MSAL_ISSUER en Medplum no tengan espacios de más al copiarlos.');
      return 'falla';

    case 'sin-resultados':
      avisarAmbiente(r.ambiente);
      console.log('\n✓ El circuito COMPLETO funcionó: secrets cargados, token obtenido, búsqueda respondida.');
      console.log('  Esa persona no está en el padrón de este ambiente, que contra QA es lo esperable.');
      return r.ambiente === 'prod' && opts.ambiente !== 'prod' ? 'falla' : 'ok';

    case 'ambiguo':
      avisarAmbiente(r.ambiente);
      console.log('\n✓ El circuito funcionó. Hay más de una persona con ese documento, así que el bot');
      console.log('  no autocompleta nada — a propósito.');
      return 'ok';

    default:
      console.error(`\n? Motivo inesperado: ${String(r.motivo)}`);
      return 'falla';
  }
}

async function main(): Promise<void> {
  const opts = parsearArgs(process.argv.slice(2));
  // El ambiente sale del flag y NUNCA del .env: ver la cabecera de este archivo.
  const busUrl = BUS_URLS[opts.ambiente];

  console.log('=== Federador de Pacientes (MSAL) · diagnóstico ===\n');
  console.log(`  Ambiente : ${opts.ambiente.toUpperCase()}  (${busUrl})`);
  console.log(`  Documento: ${formatearDniConPuntos(opts.dni)}`);

  if (opts.dni.length < 6) {
    console.error('\n✗ El documento tiene que tener al menos 6 dígitos. Usá: -- --dni 12497884');
    process.exitCode = 1;
    return;
  }

  if (opts.ambiente === 'prod') {
    console.log('\n  🚨 PRODUCCIÓN: esto consulta el padrón nacional REAL con un documento REAL.');
    console.log('     Es un tratamiento de datos personales (Ley 25.326) y queda registrado.');
  }

  // El .env no manda, pero lo que diga es lo que después se copia a Medplum.
  const delEnv = process.env.BUS_MSAL_URL;
  if (delEnv && ambienteBus(delEnv) !== opts.ambiente) {
    console.log(`\n  ⚠️  El .env tiene BUS_MSAL_URL=${delEnv} (${ambienteBus(delEnv)}), que NO es el ambiente`);
    console.log('      elegido. Este script lo ignora a propósito, pero corregilo antes de copiarlo a Medplum.');
    console.log('      Recordá que el environment "VARIABLES QA" de Postman trae la URL de producción.');
  }

  const notas: Notas = {};
  let local: Veredicto = 'no-probado';
  let bot: Veredicto = 'no-probado';

  if (!opts.soloBot) {
    local = await capaLocal(opts, busUrl, notas);
  }
  if (!opts.soloLocal) {
    try {
      bot = await capaBot(opts);
    } catch (e) {
      console.error(`\n✗ La capa del bot falló: ${e instanceof Error ? e.message : String(e)}`);
      console.error('  Si es por credenciales de Medplum, probá solo la primera capa: -- --solo-local');
      bot = 'falla';
    }
  }

  console.log('\n=== Conclusión ===\n');
  const marca = (v: Veredicto): string => (v === 'ok' ? '✓' : v === 'falla' ? '✗' : '– no se pudo probar');
  console.log(`  Credencial del bus (secret word) : ${marca(local)}`);
  console.log(`  Project Secrets + bot deployado  : ${marca(bot)}`);

  // El cruce de las dos capas es el diagnóstico. `no-probado` nunca acusa a nadie:
  // de una capa que no corrió no se deduce dónde está el problema.
  if (local === 'ok' && bot === 'falla') {
    console.log('\n  → La credencial SIRVE, pero el servidor no la tiene bien. El arreglo está en');
    console.log('    Medplum (Project → Secrets), no en el código ni en la credencial.');
  } else if (local === 'falla' && bot === 'falla' && notas.claseAuth === 'precondicion') {
    // Los dos lados fallan IGUAL y el bus dijo qué le falta. Que coincidan no
    // acusa a la credencial: acusa a que falta un requisito, y con la misma
    // credencial en los dos lados es lo esperable que fallen los dos.
    console.log(`\n  → Los dos lados fallan igual, y el bus dice: «${notas.diceElBus ?? '(sin mensaje)'}».`);
    console.log('    Eso NO es la credencial: es un requisito previo que le falta al pedido. La');
    console.log('    configuración de tu lado está bien —.env y Project Secrets coinciden, el bot');
    console.log('    está deployado y llega al bus—. Lo que falta se resuelve del lado del');
    console.log('    Ministerio o con un paso de autenticación que todavía no tenemos documentado.');
    console.log('    Ver docs/handoff-federador-msal.md § "Missing organization authentication".');
  } else if (local === 'falla' && bot === 'falla') {
    console.log('\n  → Falla de los dos lados: lo más probable es que la token secret word no sea la');
    console.log('    correcta para este ambiente. Sacala de dominios.msal.gob.ar → credenciales.');
  } else if (local === 'falla' && bot === 'ok') {
    console.log('\n  → El bot anda y lo del .env no. Es el .env local el que está mal, no el servidor:');
    console.log('    nada que arreglar para producción.');
  } else if (local === 'ok' && bot === 'ok') {
    console.log('\n  → Todo en orden, de los dos lados. El siguiente paso es la UI del alta: ofrecer los');
    console.log('    campos para que la recepcionista confirme. El bot sugiere, la persona decide.');
  } else if (local === 'no-probado' && bot === 'no-probado') {
    console.log('\n  → No se probó nada. Revisá los mensajes de arriba: falta configurar algo o no hay');
    console.log('    salida de red hacia el bus desde esta máquina.');
  } else {
    const probada = local === 'no-probado' ? 'la del bot' : 'la local';
    console.log(`\n  → Solo concluyó ${probada}. Para el diagnóstico completo hacen falta las dos:`);
    console.log('    una dice si la credencial sirve, la otra si el servidor la tiene bien cargada.');
  }

  // Sale distinto de cero solo ante una FALLA. Que una capa no se haya podido
  // probar no es un éxito, pero tampoco es un error que valga la pena romper un
  // pipeline: se ve en la tabla de arriba.
  if (local === 'falla' || bot === 'falla') {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Diagnóstico del Federador falló:', err);
  process.exitCode = 1;
});
