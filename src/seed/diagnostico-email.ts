/**
 * Diagnóstico de envío de email (Medplum → AWS SES).
 *
 *   npm run email:test -- destinatario@dominio.com
 *
 * Aísla la capa Medplum→SES: se conecta con las credenciales del .env (la misma
 * ClientApplication del seed/bots) y llama a `medplum.sendEmail()` igual que el bot
 * `bw-invitar-paciente`. Si SES falla, imprime el error COMPLETO (no lo traga,
 * como sí hace el bot a propósito) para ver la causa real:
 *   - identidad no verificada / región equivocada;
 *   - SES en sandbox (destinatario no verificado);
 *   - falta de permiso IAM del server Medplum;
 *   - `from`/supportEmail no configurado en el server.
 *
 * El `from` lo decide el server Medplum (su `supportEmail`, que debe ser una
 * identidad SES verificada). Este script no lo setea (igual que el bot).
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

async function main(): Promise<void> {
  const to = process.argv[2] ?? process.env.DIAG_EMAIL_TO;
  if (!to) {
    console.error('Uso: npm run email:test -- destinatario@dominio.com');
    process.exitCode = 1;
    return;
  }

  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log(`Conectado a ${process.env.MEDPLUM_BASE_URL}. Enviando email de prueba a: ${to}`);

  const asunto = `Biowellness · prueba de email (${new Date().toLocaleString('es-AR')})`;
  const cuerpo =
    'Este es un email de prueba del diagnóstico de recepción Biowellness.\n\n' +
    'Si lo recibiste, la cadena Medplum → SES funciona. 💚';

  // `from` opcional: por defecto lo decide el server (su supportEmail, p. ej.
  // hola@medplum.com.ar). Con SES_FROM_EMAIL probás un remitente explícito (útil
  // para ver si el server lo acepta o exige el supportEmail).
  const from = process.env.SES_FROM_EMAIL?.trim();
  console.log(`From: ${from ?? '(default del server: supportEmail)'}`);

  try {
    const r = await medplum.sendEmail({ to, subject: asunto, text: cuerpo, ...(from ? { from } : {}) });
    console.log('\n✓ medplum.sendEmail() OK. SES aceptó el mensaje.');
    if (r) {
      console.log('Respuesta:', JSON.stringify(r));
    }
    console.log('\nRevisá la casilla (y la carpeta de spam). Para deliverability: SPF/DKIM/DMARC en Route 53.');
  } catch (err) {
    console.error('\n✗ medplum.sendEmail() FALLÓ. Error completo:\n');
    console.error(err);
    console.error(
      '\nPistas según el mensaje:\n' +
        '  • "Forbidden" (OperationOutcome id "forbidden") → la membership que envía NO es admin.\n' +
        '    Medplum exige project.features incluya "email" Y ctx.membership.admin === true.\n' +
        '    Hacé admin a la ClientApplication del .env (o al bot que manda el email).\n' +
        '  • "Email address is not verified" → verificar la identidad (dominio o from) en SES, MISMA región del server.\n' +
        '  • "...not authorized to perform ses:SendEmail" → falta permiso IAM al rol del server Medplum (EC2).\n' +
        '  • Destinatario no llega y la cuenta está en sandbox → sacar SES del sandbox (o verificar el destinatario).\n' +
        '  • 400 "Missing from" / sender inválido → configurar supportEmail (identidad verificada) en el server Medplum.',
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Diagnóstico de email falló:', err);
  process.exitCode = 1;
});
