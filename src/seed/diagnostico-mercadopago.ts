/**
 * Diagnóstico de MercadoPago: prueba la infraestructura de cobro de punta a punta
 * SIN tocar turnos ni planes reales.
 *
 *   npm run mp:test
 *
 * Paso 1 — Endpoint del webhook (no necesita credenciales):
 *   POST a MP_WEBHOOK_URL con una notificación falsa. Si responde 200 con el JSON
 *   del bot, quedó probado: nginx acepta la URL limpia, inyecta el Authorization
 *   de la ClientApplication, el bot ejecuta y tiene el access token cargado.
 *   (El resultado esperado es "pago inexistente…": eso ES éxito acá. Si el bot
 *   tiene cargada la clave de firma MERCADOPAGO_WEBHOOK_SECRET, la respuesta va
 *   a ser "firma x-signature inválida": también es éxito — la firma trabaja.)
 *
 * Paso 2 — ¿Qué token hay en el .env y cuál usan los BOTS?
 *   Verifica el token del .env contra /users/me (¿de prueba o PRODUCTIVO?) y,
 *   si hay credenciales de Medplum, lo compara con el Project Secret
 *   MERCADOPAGO_ACCESS_TOKEN: que difieran es la falla más silenciosa del
 *   pasaje a producción (el script prueba un token y los bots usan otro).
 *
 * Paso 3 — Preferencia de prueba (freno con credenciales productivas):
 *   Crea una preferencia de ARS 100 con external_reference
 *   `plan-prueba-diagnostico` (clave inexistente A PROPÓSITO: el webhook la
 *   procesa sin efectos) y expiración de 30 minutos. Con token PRODUCTIVO es un
 *   COBRO REAL: solo corre con `--cobro-real`, y el pago después se devuelve
 *   desde el panel de MP (Actividad → devolver dinero).
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import { isoArgentina } from '../lib/sena.js';

const WEBHOOK_URL = process.env.MP_WEBHOOK_URL ?? 'https://api.medplum.com.ar/webhooks/mercadopago';

interface UsuarioMP {
  nickname?: string;
  site_id?: string;
  tags?: string[];
}

/**
 * MP moderno: las credenciales de prueba son las "productivas" de una CUENTA de
 * prueba (usuario con tag test_user, nickname TESTUSER...). El prefijo TEST- es
 * el modelo viejo. Ambos son dinero ficticio.
 */
function esCredencialDePrueba(token: string, usuario: UsuarioMP): boolean {
  return token.startsWith('TEST-') || Boolean(usuario.tags?.includes('test_user')) || Boolean(usuario.nickname?.startsWith('TESTUSER'));
}

function mascara(token: string): string {
  return `…${token.slice(-6)}`;
}

async function probarWebhook(): Promise<void> {
  console.log(`\n[1/3] Probando el endpoint del webhook: ${WEBHOOK_URL}`);
  try {
    const resp = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'payment', data: { id: '0' } }),
    });
    const texto = await resp.text();
    console.log(`  HTTP ${resp.status} · ${texto.slice(0, 300)}`);
    if (resp.status === 200) {
      console.log('  ✓ Endpoint OK: nginx autentica, el bot ejecuta y respondió.');
      console.log('    ("pago inexistente" o "firma x-signature inválida" es lo esperado con un id falso.)');
    } else if (resp.status === 401 || resp.status === 403) {
      console.log('  ✗ Autenticación: revisar el BASIC_BASE64 del bloque nginx (ClientApplication).');
    } else if (resp.status === 404) {
      console.log('  ✗ No encontrado: revisar BOT_ID_WEBHOOK_MP en el bloque nginx (¿id de bw-webhook-mercadopago?).');
    } else if (resp.status === 502) {
      console.log('  ✗ 502: el proceso Medplum (pm2) no está respondiendo en 8103.');
    } else if (resp.status === 400) {
      console.log('  ⚠ 400: el bot LANZÓ. Si el mensaje dice que falta MERCADOPAGO_ACCESS_TOKEN, cargarlo en');
      console.log('    Project Secrets (para MP ese "error" es correcto: reintenta hasta que el secret esté).');
    }
  } catch (err) {
    console.log(`  ✗ No se pudo conectar: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * El token del .env lo usan LOS SCRIPTS; los bots usan el Project Secret. Si
 * difieren, `mp:test` aprueba un token que los bots no tienen: el peor bug del
 * cutover. Comparación best-effort (necesita credenciales admin de Medplum).
 */
async function compararConProjectSecrets(tokenEnv: string): Promise<void> {
  const { MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET } = process.env;
  if (!MEDPLUM_BASE_URL || !MEDPLUM_CLIENT_ID || !MEDPLUM_CLIENT_SECRET) {
    console.log('  (Sin credenciales de Medplum en .env: no se puede comparar con Project Secrets.)');
    return;
  }
  try {
    const medplum = new MedplumClient({ baseUrl: MEDPLUM_BASE_URL, fetch });
    await medplum.startClientLogin(MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET);
    const projectId =
      process.env.MEDPLUM_PROJECT_ID ??
      ((await medplum.get('auth/me')) as { project?: { id?: string } }).project?.id;
    if (!projectId) {
      console.log('  (No se pudo determinar el Project ID: setear MEDPLUM_PROJECT_ID en .env para comparar.)');
      return;
    }
    const respuesta = (await medplum.get(`admin/projects/${projectId}`)) as {
      project?: { secret?: Array<{ name?: string; valueString?: string }> };
      secret?: Array<{ name?: string; valueString?: string }>;
    };
    const secretos = respuesta.project?.secret ?? respuesta.secret;
    const delBot = secretos?.find((s) => s.name === 'MERCADOPAGO_ACCESS_TOKEN')?.valueString;
    if (!delBot) {
      console.log('  ✗ Project Secret MERCADOPAGO_ACCESS_TOKEN NO está cargado: los bots no pueden cobrar ni verificar pagos.');
      return;
    }
    if (delBot === tokenEnv) {
      console.log(`  ✓ El token del .env (${mascara(tokenEnv)}) es EL MISMO que usan los bots (Project Secret).`);
    } else {
      console.log(`  ✗ DIVERGENCIA: el .env tiene ${mascara(tokenEnv)} pero los bots usan ${mascara(delBot)} (Project Secret).`);
      console.log('    Lo que pruebe este script NO representa a los bots. Alinear los dos antes de seguir.');
    }
  } catch (err) {
    console.log(`  (No se pudo leer Project Secrets: ${err instanceof Error ? err.message.slice(0, 120) : err})`);
  }
}

async function probarPreferencia(): Promise<void> {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) {
    console.log('\n[2/3] MERCADOPAGO_ACCESS_TOKEN no está en .env: salteo la verificación del token.');
    console.log('      (El circuito igual se puede probar desde la app con "Link MercadoPago".)');
    return;
  }

  console.log('\n[2/3] Verificando el access token del .env contra MercadoPago…');
  const me = await fetch('https://api.mercadopago.com/users/me', { headers: { Authorization: `Bearer ${token}` } });
  if (!me.ok) {
    console.log(`  ✗ MP rechazó el token (${me.status}). ¿Está vencido o mal copiado?`);
    return;
  }
  const usuario = (await me.json()) as UsuarioMP;
  const esTest = esCredencialDePrueba(token, usuario);
  console.log(
    `  ✓ Token válido: ${usuario.nickname ?? '?'} (${usuario.site_id ?? '?'}) · ${esTest ? 'cuenta de PRUEBA (dinero ficticio)' : '⚠️ credenciales PRODUCTIVAS (los pagos son reales)'}`,
  );
  await compararConProjectSecrets(token);

  console.log('\n[3/3] Preferencia de prueba (viaje completo pago→webhook→bot)…');
  if (!esTest && !process.argv.includes('--cobro-real')) {
    console.log('  ⛔ FRENO: el token es PRODUCTIVO y esto crearía un link de COBRO REAL de ARS 100.');
    console.log('     Si es lo que querés (prueba de humo de producción), corré:');
    console.log('       npm run mp:test -- --cobro-real');
    console.log('     y después DEVOLVÉ el pago desde el panel de MP (Actividad → devolver dinero).');
    return;
  }

  const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ title: 'Prueba de circuito Biowellness (diagnóstico)', quantity: 1, unit_price: 100, currency_id: 'ARS' }],
      external_reference: 'plan-prueba-diagnostico',
      statement_descriptor: 'BIOWELLNESS',
      notification_url: WEBHOOK_URL,
      // Que un link de diagnóstico no quede cobrable por tiempo indefinido.
      expires: true,
      expiration_date_to: isoArgentina(new Date(Date.now() + 30 * 60_000)),
    }),
  });
  if (!resp.ok) {
    console.log(`  ✗ No se pudo crear la preferencia: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    return;
  }
  const pref = (await resp.json()) as { init_point?: string; sandbox_init_point?: string };
  console.log('  ✓ Preferencia de ARS 100 creada (vence en 30 min). Pagala para probar pago→webhook→bot:');
  console.log(`    ${pref.init_point ?? pref.sandbox_init_point}`);
  if (esTest) {
    console.log('    Tarjeta de prueba (con credenciales TEST): Mastercard 5031 7557 3453 0604 · CVV 123 ·');
    console.log('    vencimiento 11/30 · titular APRO · DNI 12345678. Con titular OTHE simula un rechazo.');
  } else {
    console.log('    ⚠️ COBRO REAL: pagalo con un medio propio y devolvélo después desde el panel de MP');
    console.log('    (Actividad → ese pago → devolver dinero). La devolución también prueba la alerta del webhook.');
  }
  console.log('    Al pagar, el webhook va a responder "No existe Invoice con clave plan-prueba-diagnostico":');
  console.log('    eso es lo esperado (clave inexistente a propósito) y confirma el circuito completo.');
}

async function main(): Promise<void> {
  console.log('=== Diagnóstico MercadoPago ===');
  await probarWebhook();
  await probarPreferencia();
  console.log('\nListo. La prueba de negocio real (seña de turno) se hace desde la app: ver docs/bots.md.');
}

main().catch((err) => {
  console.error('mp:test falló:', err);
  process.exitCode = 1;
});
