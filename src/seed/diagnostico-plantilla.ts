/**
 * Diagnóstico de plantillas de WhatsApp (Twilio Content API).
 *
 *   npm run whatsapp:plantilla            → lista TODAS las plantillas de la cuenta
 *   npm run whatsapp:plantilla -- HXxxxx  → detalle de una sola
 *
 * Para cada plantilla muestra: SID, nombre, cuerpo, variables declaradas y estado
 * de aprobación de WhatsApp, y valida lo que rompe el envío con error 21656:
 * el cuerpo tiene que usar placeholders NUMÉRICOS con llaves dobles y sin
 * espacios ({{1}}, {{2}}…) — `{{ 1 }}`, `{{mensaje}}` o un body sin placeholder
 * no matchean nuestras ContentVariables {"1": "..."}.
 *
 * Usa TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN del .env (los mismos de whatsapp:test).
 */
import 'dotenv/config';

interface ContenidoTwilio {
  sid?: string;
  friendly_name?: string;
  language?: string;
  variables?: Record<string, string>;
  types?: Record<string, { body?: string }>;
}

function analizarCuerpo(body: string): string[] {
  const problemas: string[] = [];
  const placeholders = body.match(/\{\{[^}]*\}\}/g) ?? [];
  if (placeholders.length === 0) {
    problemas.push('el cuerpo NO tiene ningún placeholder {{1}} — con ContentVariables da 21656');
  }
  for (const p of placeholders) {
    const interior = p.slice(2, -2);
    if (interior !== interior.trim()) {
      problemas.push(`placeholder con espacios: "${p}" → tiene que ser "{{${interior.trim()}}}"`);
    } else if (!/^\d+$/.test(interior)) {
      problemas.push(`placeholder con nombre: "${p}" → nuestro sistema manda claves numéricas ("1", "2"…)`);
    }
  }
  if (/\{[^{]|[^}]\}/.test(body.replace(/\{\{[^}]*\}\}/g, ''))) {
    problemas.push('hay llaves sueltas ({ o }) fuera de los placeholders — revisar llaves incompletas');
  }
  const cuerpo = body.trim();
  if (/^\{\{[^}]*\}\}/.test(cuerpo) || /\{\{[^}]*\}\}$/.test(cuerpo)) {
    problemas.push('el cuerpo empieza o termina con una variable — Meta la rechaza (2388299): agregar texto fijo');
  }
  return problemas;
}

async function aprobacion(auth: string, sid: string): Promise<string> {
  try {
    const r = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!r.ok) {
      return 'sin datos';
    }
    const j = (await r.json()) as { whatsapp?: { status?: string; rejection_reason?: string } };
    const w = j.whatsapp;
    if (!w?.status) {
      return 'sin solicitud de aprobación';
    }
    return `${w.status}${w.rejection_reason ? ` (${w.rejection_reason})` : ''}`;
  } catch {
    return 'sin datos';
  }
}

async function main(): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.error('Faltan TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN en .env.');
    process.exitCode = 1;
    return;
  }
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const uno = process.argv[2];

  const url = uno ? `https://content.twilio.com/v1/Content/${uno}` : 'https://content.twilio.com/v1/Content?PageSize=50';
  const resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!resp.ok) {
    console.error(`Twilio Content API respondió ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }
  const data = (await resp.json()) as ContenidoTwilio & { contents?: ContenidoTwilio[] };
  const plantillas = uno ? [data] : (data.contents ?? []);
  if (plantillas.length === 0) {
    console.log('No hay plantillas en la cuenta. Crearlas en Messaging → Content Template Builder.');
    return;
  }

  console.log(`=== ${plantillas.length} plantilla(s) ===\n`);
  for (const p of plantillas) {
    const body = p.types?.['twilio/text']?.body ?? Object.values(p.types ?? {})[0]?.body ?? '(sin cuerpo de texto)';
    console.log(`• ${p.friendly_name ?? '(sin nombre)'} — ${p.sid} (${p.language ?? '?'})`);
    console.log(`    Cuerpo: ${body}`);
    if (p.variables && Object.keys(p.variables).length > 0) {
      console.log(`    Variables declaradas: ${JSON.stringify(p.variables)}`);
    }
    console.log(`    Aprobación WhatsApp: ${await aprobacion(auth, p.sid ?? '')}`);
    const problemas = analizarCuerpo(body);
    if (problemas.length === 0) {
      console.log('    ✓ Placeholders OK para nuestras ContentVariables numéricas.');
    } else {
      for (const prob of problemas) {
        console.log(`    ✗ ${prob}`);
      }
    }
    console.log('');
  }
  console.log('El SID de la plantilla usable va como Project Secret en Medplum');
  console.log('(TWILIO_CONTENT_SID_GENERICO o TWILIO_CONTENT_SID_MENSAJE_RECEPCION, etc.).');
}

main().catch((err) => {
  console.error('whatsapp:plantilla falló:', err);
  process.exitCode = 1;
});
