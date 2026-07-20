/**
 * Diagnóstico de ENTREGA de WhatsApp: qué pasó DESPUÉS de que Twilio aceptó.
 *
 *   npm run whatsapp:entregas                     → últimos 20 mensajes
 *   npm run whatsapp:entregas -- +5491169315830   → solo ese destino
 *
 * Un 201 de Twilio (Communication 'completed') solo significa "Twilio lo tomó":
 * la entrega la decide Meta DESPUÉS, en forma asíncrona, y el motivo del rechazo
 * queda en el `error_code` de cada mensaje — el dato que en el Console está
 * escondido detrás de cada fila "Undelivered". Este script lo trae para todos
 * y lo traduce a causa + qué hacer.
 *
 * Usa TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN del .env (los mismos de
 * whatsapp:plantilla).
 */
import 'dotenv/config';

interface MensajeTwilio {
  sid?: string;
  date_created?: string;
  from?: string;
  to?: string;
  direction?: string;
  status?: string;
  error_code?: number | null;
  error_message?: string | null;
  body?: string | null;
}

/** Códigos de error de WhatsApp vía Twilio: causa y acción, en criollo. */
const EXPLICACIONES: Record<number, { causa: string; accion: string }> = {
  63016: {
    causa: 'Texto libre FUERA de la ventana de 24 h (el destinatario no le escribió al negocio en las últimas 24 h).',
    accion:
      'Enviar con plantilla APROBADA por Meta: cargar su Content SID como Project Secret ' +
      '(TWILIO_CONTENT_SID_GENERICO o el específico) — ver npm run whatsapp:plantilla.',
  },
  63003: {
    causa: 'El canal no encuentra el destino: ese número no tiene WhatsApp (o está mal escrito).',
    accion: 'Verificar el número en la ficha del paciente (formato +54 9 11 …, celular real con WhatsApp).',
  },
  63005: {
    causa: 'Meta rechazó el CONTENIDO del mensaje (política de WhatsApp).',
    accion: 'Revisar el texto/plantilla (links acortados, contenido promocional, etc.).',
  },
  63007: {
    causa: 'El FROM no es un sender de WhatsApp habilitado en esta cuenta de Twilio.',
    accion: 'Twilio Console → Messaging → Senders → WhatsApp senders: el número debe figurar y estar Online.',
  },
  63013: {
    causa: 'Violación de política del canal según Meta.',
    accion: 'Revisar el contenido y el estado de la cuenta de WhatsApp Business en Meta Business Manager.',
  },
  63018: {
    causa: 'Límite de velocidad del canal excedido (demasiados mensajes seguidos).',
    accion: 'Esperar y reintentar; espaciar los envíos masivos.',
  },
  63049: {
    causa: 'Meta decidió NO entregar: límite de mensajes de MARKETING por usuario (la plantilla está categorizada como Marketing).',
    accion: 'Recategorizar la plantilla como UTILITY en Meta/Twilio Content y volver a aprobarla.',
  },
  63024: {
    causa: 'Destinatario inválido para el canal.',
    accion: 'Verificar el número (E.164, celular argentino con 9: +54 9 …).',
  },
  63050: {
    causa: 'El destinatario optó por NO recibir mensajes de marketing de este negocio.',
    accion: 'Solo puede recibir plantillas UTILITY/autenticación; no reintentar marketing.',
  },
  63051: {
    causa:
      'El sender o la cuenta de WhatsApp Business (WABA) está BLOQUEADA por Meta ' +
      '(violación de políticas, seguridad o 30 días sin tráfico). No es el mensaje: es la cuenta — ' +
      'TODO el tráfico saliente queda frenado (los entrantes siguen llegando).',
    accion:
      'Twilio Console → Messaging → Senders → WhatsApp senders: estado del número (re-registrar si está locked). ' +
      'Meta Business Manager → WhatsApp → salud de la cuenta: apelar la restricción si figura. ' +
      'Si persiste, ticket a Twilio Support citando el 63051 para que apelen ante Meta.',
  },
  21656: {
    causa: 'Las ContentVariables no matchean los placeholders de la plantilla ({{1}}, {{2}}… numéricos, sin espacios).',
    accion: 'npm run whatsapp:plantilla — valida el cuerpo de cada plantilla y marca el placeholder roto.',
  },
  30008: {
    causa: 'Error desconocido del canal (Meta no dio detalle).',
    accion: 'Reintentar; si persiste, revisar el estado del sender y de la cuenta en Meta.',
  },
};

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

async function main(): Promise<void> {
  const sid = requireEnv('TWILIO_ACCOUNT_SID');
  const token = requireEnv('TWILIO_AUTH_TOKEN');
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  const destino = process.argv[2];
  const filtro = destino ? `&To=${encodeURIComponent(`whatsapp:${destino}`)}` : '';
  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?PageSize=20${filtro}`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  if (!resp.ok) {
    throw new Error(`Twilio respondió ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = (await resp.json()) as { messages?: MensajeTwilio[] };
  const mensajes = data.messages ?? [];
  if (mensajes.length === 0) {
    console.log(destino ? `Sin mensajes hacia ${destino}.` : 'Sin mensajes en la cuenta.');
    return;
  }

  console.log(`Últimos ${mensajes.length} mensajes${destino ? ` hacia ${destino}` : ''}:\n`);
  let hayFallaEnVentana = false;
  const ventanasAbiertas = new Map<string, string>(); // número → fecha del último entrante

  // La API los devuelve del más nuevo al más viejo: recorrer al revés para
  // saber si al momento de cada saliente ya había un entrante (ventana abierta).
  for (const m of [...mensajes].reverse()) {
    const esEntrante = m.direction?.startsWith('inbound');
    if (esEntrante && m.from) {
      ventanasAbiertas.set(m.from, m.date_created ?? '');
      continue;
    }
    const fallo = m.status === 'undelivered' || m.status === 'failed';
    if (fallo && m.to && ventanasAbiertas.has(m.to)) {
      hayFallaEnVentana = true;
    }
  }

  for (const m of mensajes) {
    const esEntrante = m.direction?.startsWith('inbound');
    const icono = esEntrante ? '←' : m.status === 'delivered' || m.status === 'read' ? '✓' : m.status === 'undelivered' || m.status === 'failed' ? '✗' : '…';
    const fecha = m.date_created ? new Date(m.date_created).toLocaleString('es-AR') : '(sin fecha)';
    console.log(`${icono} ${fecha} · ${esEntrante ? `de ${m.from}` : `a ${m.to}`} · ${m.status?.toUpperCase()}`);
    if (m.body) {
      console.log(`    "${m.body.slice(0, 80).replace(/\s+/g, ' ')}${m.body.length > 80 ? '…' : ''}"`);
    }
    if (m.error_code) {
      const exp = EXPLICACIONES[m.error_code];
      console.log(`    ERROR ${m.error_code}: ${m.error_message ?? '(sin detalle de Twilio)'}`);
      if (exp) {
        console.log(`    Causa:  ${exp.causa}`);
        console.log(`    Acción: ${exp.accion}`);
      } else {
        console.log(`    Detalle: https://www.twilio.com/docs/api/errors/${m.error_code}`);
      }
    }
    console.log('');
  }

  if (hayFallaEnVentana) {
    console.log('⚠ Hay mensajes SALIENTES fallidos DESPUÉS de un entrante del mismo número (ventana de 24 h');
    console.log('  abierta): el problema NO es (solo) la plantilla. Revisar el estado del sender de WhatsApp:');
    console.log('  Twilio Console → Messaging → Senders → WhatsApp senders (debe estar "Online", con el');
    console.log('  display name aprobado) y la salud de la cuenta en Meta Business Manager.');
  }
}

main().catch((err) => {
  console.error('whatsapp:entregas falló:', err);
  process.exitCode = 1;
});
