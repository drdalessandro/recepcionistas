/**
 * Crea las plantillas de WhatsApp por API (Twilio Content API) CON los valores
 * de ejemplo que Meta exige, y las manda a aprobación. Evita el error de Meta
 * `2388043: BODY is missing expected field(s) (example)` que rechazó las
 * creadas a mano sin ejemplos.
 *
 *   npm run whatsapp:crear-plantillas
 *
 * Idempotente: si ya existe una plantilla con el mismo nombre, no la recrea
 * (solo reintenta la aprobación si nunca se pidió). Las 5 rechazadas viejas se
 * reemplazan por versiones `_v2` (el contenido en Twilio es inmutable y el
 * nombre rechazado queda tomado en Meta).
 *
 * Al final imprime la tabla SID → Project Secret para cargar en Medplum.
 * Usa TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN del .env.
 */
import 'dotenv/config';

interface DefPlantilla {
  nombre: string;
  secret: string;
  body: string;
  /** Valores de EJEMPLO por variable (obligatorios para la aprobación de Meta). */
  ejemplos: Record<string, string>;
}

const PLANTILLAS: DefPlantilla[] = [
  {
    nombre: 'biowellness_generico',
    secret: 'TWILIO_CONTENT_SID_GENERICO',
    body: 'BioWellness San Isidro: {{1}}',
    ejemplos: { '1': 'Te esperamos mañana a las 16:00 para tu sesión de HBOT.' },
  },
  {
    nombre: 'biowellness_mensaje_recepcion',
    secret: 'TWILIO_CONTENT_SID_MENSAJE_RECEPCION',
    body: 'BioWellness San Isidro: {{1}}',
    ejemplos: { '1': 'Sí, tu turno de mañana sigue confirmado a las 16:00.' },
  },
  {
    nombre: 'biowellness_reserva_tentativa_v2',
    secret: 'TWILIO_CONTENT_SID_RESERVA_TENTATIVA',
    body: 'BioWellness: reservamos tu turno de {{1}} para el {{2}} (tentativo). Aboná la seña del 50% para confirmarlo. 💚',
    ejemplos: { '1': 'HBOT Monoplaza', '2': '21/07 16:00' },
  },
  {
    nombre: 'biowellness_reserva_plan_v2',
    secret: 'TWILIO_CONTENT_SID_RESERVA_PLAN',
    body: 'BioWellness: ¡tu turno de {{1}} quedó confirmado con tu plan para el {{2}}! Te quedan {{3}} sesiones. ¡Te esperamos! 💚',
    ejemplos: { '1': 'BIO LONGEVITY', '2': '21/07 16:00', '3': '7' },
  },
  {
    nombre: 'biowellness_turno_confirmado_v2',
    secret: 'TWILIO_CONTENT_SID_TURNO_CONFIRMADO',
    body: 'BioWellness: ¡tu turno quedó confirmado! {{1}}. Recibimos la seña de {{2}}. Saldo restante: {{3}}. ¡Te esperamos! 💚',
    ejemplos: { '1': 'HBOT Monoplaza', '2': '$119.708', '3': '$119.707 (se abona el día de la sesión)' },
  },
  {
    nombre: 'biowellness_recordatorio_48h_v2',
    secret: 'TWILIO_CONTENT_SID_RECORDATORIO_48H',
    body: 'BioWellness: te recordamos tu turno de {{1}} el {{2}}. ¡Te esperamos! 💚',
    ejemplos: { '1': 'HBOT Monoplaza', '2': '21/07 16:00' },
  },
  {
    nombre: 'biowellness_recordatorio_2h_v2',
    secret: 'TWILIO_CONTENT_SID_RECORDATORIO_2H',
    body: 'BioWellness: ¡tu turno de {{1}} es hoy a las {{2}}! Te esperamos en un rato. 💚',
    ejemplos: { '1': 'HBOT Monoplaza', '2': '16:00' },
  },
];

async function main(): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.error('Faltan TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN en .env.');
    process.exitCode = 1;
    return;
  }
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };

  // Existentes (para idempotencia por nombre).
  const lista = await fetch('https://content.twilio.com/v1/Content?PageSize=100', { headers });
  const existentes = new Map<string, string>(
    (((await lista.json()) as { contents?: Array<{ sid?: string; friendly_name?: string }> }).contents ?? [])
      .filter((c) => c.friendly_name && c.sid)
      .map((c) => [c.friendly_name as string, c.sid as string]),
  );

  const resumen: Array<{ secret: string; sid: string; nombre: string; estado: string }> = [];
  for (const p of PLANTILLAS) {
    let contentSid = existentes.get(p.nombre);
    if (contentSid) {
      console.log(`= ${p.nombre}: ya existe (${contentSid})`);
    } else {
      const resp = await fetch('https://content.twilio.com/v1/Content', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          friendly_name: p.nombre,
          language: 'es_AR',
          variables: p.ejemplos,
          types: { 'twilio/text': { body: p.body } },
        }),
      });
      if (!resp.ok) {
        console.log(`✗ ${p.nombre}: no se pudo crear (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
        continue;
      }
      contentSid = ((await resp.json()) as { sid?: string }).sid;
      console.log(`+ ${p.nombre}: creada (${contentSid})`);
    }
    if (!contentSid) {
      continue;
    }

    // Estado de aprobación; si nunca se pidió (o falló la creación anterior), pedirla.
    let estado = 'sin datos';
    const ar = await fetch(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests`, { headers });
    if (ar.ok) {
      estado = ((await ar.json()) as { whatsapp?: { status?: string } }).whatsapp?.status ?? 'unsubmitted';
    }
    if (estado === 'unsubmitted' || estado === 'draft') {
      const envio = await fetch(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests/whatsapp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: p.nombre, category: 'UTILITY' }),
      });
      estado = envio.ok
        ? 'enviada a aprobación de Meta'
        : `no se pudo enviar a aprobación (${envio.status}): ${(await envio.text()).slice(0, 200)}`;
    }
    console.log(`    Aprobación: ${estado}`);
    resumen.push({ secret: p.secret, sid: contentSid, nombre: p.nombre, estado });
  }

  console.log('\n=== Secrets para cargar en Medplum (Project → Secrets) ===');
  for (const r of resumen) {
    console.log(`${r.secret} = ${r.sid}   (${r.nombre} · ${r.estado})`);
  }
  console.log('\nLa aprobación de Meta demora de minutos a 48 h: re-chequear con `npm run whatsapp:plantilla`.');
  console.log('Mientras tanto el sistema cae solo a texto libre dentro de la ventana de 24 h.');
}

main().catch((err) => {
  console.error('whatsapp:crear-plantillas falló:', err);
  process.exitCode = 1;
});
