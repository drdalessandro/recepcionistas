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
 *   (El resultado esperado es ok:false por "pago inexistente": eso ES éxito acá.)
 *
 * Paso 2 — Preferencia de prueba (necesita MERCADOPAGO_ACCESS_TOKEN en .env):
 *   Verifica el token contra /users/me (¿TEST o productivo?) y crea una
 *   preferencia de ARS 100 con external_reference `plan-prueba-diagnostico`
 *   (clave inexistente A PROPÓSITO: el webhook la procesa sin efectos — responde
 *   "No existe Invoice…" — pero el viaje completo pago→webhook→bot queda probado).
 *   Imprime el link para pagarla con tarjeta de prueba.
 */
import 'dotenv/config';

const WEBHOOK_URL = process.env.MP_WEBHOOK_URL ?? 'https://api.medplum.com.ar/webhooks/mercadopago';

async function probarWebhook(): Promise<void> {
  console.log(`\n[1/2] Probando el endpoint del webhook: ${WEBHOOK_URL}`);
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
      console.log('    (El "ok:false / pago inexistente" es lo esperado con un id falso.)');
    } else if (resp.status === 401 || resp.status === 403) {
      console.log('  ✗ Autenticación: revisar el BASIC_BASE64 del bloque nginx (ClientApplication).');
    } else if (resp.status === 404) {
      console.log('  ✗ No encontrado: revisar BOT_ID_WEBHOOK_MP en el bloque nginx (¿id de bw-webhook-mercadopago?).');
    } else if (resp.status === 502) {
      console.log('  ✗ 502: el proceso Medplum (pm2) no está respondiendo en 8103.');
    }
  } catch (err) {
    console.log(`  ✗ No se pudo conectar: ${err instanceof Error ? err.message : err}`);
  }
}

async function probarPreferencia(): Promise<void> {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) {
    console.log('\n[2/2] MERCADOPAGO_ACCESS_TOKEN no está en .env: salteo la preferencia de prueba.');
    console.log('      (El circuito igual se puede probar desde la app con "Link MercadoPago".)');
    return;
  }

  console.log('\n[2/2] Verificando el access token contra MercadoPago…');
  const me = await fetch('https://api.mercadopago.com/users/me', { headers: { Authorization: `Bearer ${token}` } });
  if (!me.ok) {
    console.log(`  ✗ MP rechazó el token (${me.status}). ¿Está vencido o mal copiado?`);
    return;
  }
  const usuario = (await me.json()) as { nickname?: string; site_id?: string; tags?: string[] };
  // MP moderno: las credenciales de prueba son las "productivas" de una CUENTA de
  // prueba (usuario con tag test_user, nickname TESTUSER...). El prefijo TEST- es
  // el modelo viejo. Ambos son dinero ficticio.
  const esTest = token.startsWith('TEST-') || Boolean(usuario.tags?.includes('test_user')) || Boolean(usuario.nickname?.startsWith('TESTUSER'));
  console.log(`  ✓ Token válido: ${usuario.nickname ?? '?'} (${usuario.site_id ?? '?'}) · ${esTest ? 'cuenta de PRUEBA (dinero ficticio)' : '⚠️ credenciales PRODUCTIVAS (los pagos son reales)'}`);

  const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ title: 'Prueba de circuito BioWellness (diagnóstico)', quantity: 1, unit_price: 100, currency_id: 'ARS' }],
      external_reference: 'plan-prueba-diagnostico',
      notification_url: WEBHOOK_URL,
    }),
  });
  if (!resp.ok) {
    console.log(`  ✗ No se pudo crear la preferencia: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    return;
  }
  const pref = (await resp.json()) as { init_point?: string; sandbox_init_point?: string };
  console.log('  ✓ Preferencia de ARS 100 creada. Pagala para probar el viaje completo pago→webhook→bot:');
  console.log(`    ${pref.init_point ?? pref.sandbox_init_point}`);
  console.log('    Tarjeta de prueba (con credenciales TEST): Mastercard 5031 7557 3453 0604 · CVV 123 ·');
  console.log('    vencimiento 11/30 · titular APRO · DNI 12345678. Con titular OTHE simula un rechazo.');
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
