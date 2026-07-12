/**
 * Diagnóstico de envío de WhatsApp (Medplum Bot → Twilio).
 *
 *   npm run whatsapp:test -- +5491122334455
 *
 * Los secretos de Twilio NO viven en el .env: son **Project Secrets de Medplum** y
 * solo los ve el bot al ejecutarse (event.secrets). Por eso este diagnóstico se
 * conecta con las credenciales del .env y **ejecuta el bot `bw-enviar-whatsapp`**
 * en el servidor (que sí lee los secrets reales), y reporta el `status` de la
 * Communication que devuelve:
 *   - "completed"          → Twilio aceptó el mensaje (secrets OK). Revisá tu WhatsApp.
 *   - "preparation"        → falta algún secret de Twilio (o el destinatario).
 *   - "entered-in-error"   → secrets presentes, pero Twilio rechazó (número/sandbox/FROM).
 *
 * Para Twilio Sandbox: el número destino debe haber enviado el "join <code>" al
 * número del sandbox, y TWILIO_WHATSAPP_FROM debe ser el del sandbox.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

async function main(): Promise<void> {
  const to = process.argv[2] ?? process.env.DIAG_WHATSAPP_TO;
  if (!to) {
    console.error('Uso: npm run whatsapp:test -- +5491122334455');
    process.exitCode = 1;
    return;
  }

  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log(`Conectado a ${process.env.MEDPLUM_BASE_URL}. Probando WhatsApp a: ${to}`);

  const bot = await medplum.searchOne('Bot', 'name=bw-enviar-whatsapp');
  if (!bot?.id) {
    console.error('\n✗ No encontré el bot "bw-enviar-whatsapp". Deployalo: npm run deploy:bots');
    process.exitCode = 1;
    return;
  }

  const body = `BioWellness · prueba de WhatsApp (${new Date().toLocaleString('es-AR')}). Si lo recibiste, Twilio funciona. 💚`;
  const comm = (await medplum.executeBot(bot.id, { to, template: 'diagnostico', body })) as Communication;
  const status = comm?.status;
  console.log(`\nCommunication creada: ${comm?.id ?? '(sin id)'} · status = ${status ?? '(desconocido)'}`);

  if (status === 'completed') {
    console.log('\n✓ Twilio ACEPTÓ el mensaje (los Project Secrets de Twilio están cargados y son válidos).');
    console.log('  Revisá tu WhatsApp y, si no llega, el Twilio Console → Messaging logs (entrega/sandbox).');
  } else if (status === 'preparation') {
    console.error('\n✗ NO se envió: falta algún Project Secret de Twilio (o el destinatario).');
    console.error(
      '  Cargá en Medplum (Project → Secrets) estos tres y volvé a probar:\n' +
        '    • TWILIO_ACCOUNT_SID\n' +
        '    • TWILIO_AUTH_TOKEN\n' +
        '    • TWILIO_WHATSAPP_FROM  (ej. "whatsapp:+14155238886" del sandbox, o tu número WhatsApp Business)\n' +
        '  (para el aviso de solicitudes a Recepción, además: RECEPCION_WHATSAPP_TO).',
    );
    process.exitCode = 1;
  } else if (status === 'entered-in-error') {
    console.error('\n✗ Twilio RECHAZÓ el mensaje (los secrets están, pero algo no cierra).');
    console.error(
      '  Causas típicas:\n' +
        '    • Sandbox: el número destino no envió el "join <code>" al número del sandbox.\n' +
        '    • TWILIO_WHATSAPP_FROM mal (no es un sender de WhatsApp válido).\n' +
        '    • Número destino mal formado (usá E.164: +549...).\n' +
        '  Revisá el detalle en Twilio Console → Monitor → Logs → Messaging.',
    );
    process.exitCode = 1;
  } else {
    console.error('\n? Estado inesperado. Revisá el recurso Communication y los logs del bot (CloudWatch).');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Diagnóstico de WhatsApp falló:', err);
  process.exitCode = 1;
});
