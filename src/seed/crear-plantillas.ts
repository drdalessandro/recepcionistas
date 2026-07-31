/**
 * Crea las plantillas de WhatsApp por API (Twilio Content API) CON los valores
 * de ejemplo que Meta exige, y las manda a aprobación. Evita el error de Meta
 * `2388043: BODY is missing expected field(s) (example)` que rechazó las
 * creadas a mano sin ejemplos.
 *
 *   npm run whatsapp:crear-plantillas
 *
 * Idempotente: si ya existe una plantilla con el mismo nombre, no la recrea
 * (solo reintenta la aprobación si nunca se pidió). Las rechazadas viejas se
 * reemplazan por versiones nuevas (el contenido en Twilio es inmutable y el
 * nombre rechazado queda tomado en Meta).
 *
 * Reglas de Meta que ya nos rechazaron plantillas (validadas acá antes de crear):
 *  - `2388043`: cada variable necesita un valor de EJEMPLO (`variables`).
 *  - `2388299`: el cuerpo no puede EMPEZAR ni TERMINAR con una variable —
 *    por eso las genéricas llevan un cierre de texto fijo después de {{1}}.
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
  /**
   * Categoría de WhatsApp. Default UTILITY; MARKETING solo cuando el
   * clasificador de Meta rechazó UTILITY en versiones sucesivas (la
   * reserva_tentativa cayó 4 veces: v3/v5/v6/v7). MARKETING implica
   * conversación más cara y límites por usuario (63049/63050) — aceptado.
   */
  categoria?: 'UTILITY' | 'MARKETING';
}

// Decisión 2026-07-29 (Andrés): los mensajes NO empiezan con la marca y NO
// llevan emojis (👋/ fuera) —
// WhatsApp ya muestra "Biowellness | San Isidro" como remitente en cada
// mensaje y el prefijo era redundante. Nombres versionados: el contenido en
// Twilio es inmutable y los nombres ya usados/rechazados quedan quemados.
const PLANTILLAS: DefPlantilla[] = [
  {
    nombre: 'biowellness_generico_v4',
    secret: 'TWILIO_CONTENT_SID_GENERICO',
    body: 'Hola: {{1}} Cualquier duda, escribinos por acá.',
    ejemplos: { '1': 'Te esperamos mañana a las 16:00 para tu sesión de Cámara Hiperbárica.' },
  },
  {
    nombre: 'biowellness_mensaje_recepcion_v4',
    secret: 'TWILIO_CONTENT_SID_MENSAJE_RECEPCION',
    body: 'Hola: {{1}} Podés responder por acá.',
    ejemplos: { '1': 'Sí, tu turno de mañana sigue confirmado a las 16:00.' },
  },
  {
    // v8 como MARKETING: la v3/v5/v6/v7 cayeron TODAS con INCORRECT_CATEGORY
    // (la v7 ya era transaccional pura): el clasificador de Meta considera
    // este contenido marketing y sin allow_category_change no hay apelación
    // automática. Decisión: aceptar la categoría. ⚠️ Antes de crear esta,
    // BORRAR en el Console las rechazadas v5/v6/v7 (cuerpo similar =>
    // riesgo de rechazo por "identical content").
    nombre: 'biowellness_reserva_tentativa_v8',
    secret: 'TWILIO_CONTENT_SID_RESERVA_TENTATIVA',
    categoria: 'MARKETING',
    body: 'Registramos tu reserva de {{1}} para el {{2}}. Para confirmarla, aboná la seña de {{3}} en este enlace: {{4}}. Si el pago no se acredita antes de las {{5}}, la reserva se libera automáticamente.',
    ejemplos: {
      '1': 'Cámara Hiperbárica (HBOT) — Monoplaza',
      '2': '31/07 16:00',
      '3': '$119.708',
      '4': 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=202607-2ab3cd4',
      '5': '14:30',
    },
  },
  {
    nombre: 'biowellness_sena_recordatorio_v3',
    secret: 'TWILIO_CONTENT_SID_SENA_RECORDATORIO',
    body: '¡Último aviso! Tu reserva de {{1}} ({{2}}) se libera a las {{3}} si no abonás la seña de {{4}}. Pagala acá: {{5}} y quedás confirmado.',
    ejemplos: {
      '1': 'Cámara Hiperbárica (HBOT) — Monoplaza',
      '2': '31/07 16:00',
      '3': '14:30',
      '4': '$119.708',
      '5': 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=202607-2ab3cd4',
    },
  },
  {
    nombre: 'biowellness_plan_link_pago_v3',
    secret: 'TWILIO_CONTENT_SID_PLAN_LINK_PAGO',
    body: '¡Reservamos tu {{1}}! Para activarla aboná {{2}} en este enlace: {{3}} — cuando se acredite el pago te confirmamos por acá.',
    ejemplos: {
      '1': 'Membresía HEALTHSPAN STANDARD INDIVIDUAL',
      '2': '$3.556.850',
      '3': 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=202607-2ab3cd4',
    },
  },
  {
    nombre: 'biowellness_tentativa_vencida_v3',
    secret: 'TWILIO_CONTENT_SID_TENTATIVA_VENCIDA',
    body: 'Tu reserva de {{1}} del {{2}} se liberó porque no llegó la seña a tiempo. Si todavía querés venir, escribinos por acá y buscamos otro horario.',
    ejemplos: { '1': 'Cámara Hiperbárica (HBOT) — Monoplaza', '2': '31/07 16:00' },
  },
  {
    nombre: 'biowellness_reserva_plan_v4',
    secret: 'TWILIO_CONTENT_SID_RESERVA_PLAN',
    body: '¡Tu turno de {{1}} quedó confirmado con tu plan para el {{2}}! Te quedan {{3}} sesiones. ¡Te esperamos!',
    ejemplos: { '1': 'BIO LONGEVITY', '2': '31/07 16:00', '3': '7' },
  },
  {
    nombre: 'biowellness_turno_confirmado_v4',
    secret: 'TWILIO_CONTENT_SID_TURNO_CONFIRMADO',
    body: '¡Tu turno quedó confirmado! {{1}}. Recibimos la seña de {{2}}. Saldo restante: {{3}}. ¡Te esperamos!',
    ejemplos: { '1': 'Cámara Hiperbárica (HBOT) — Monoplaza', '2': '$119.708', '3': '$119.707 (se abona el día de la sesión)' },
  },
  {
    nombre: 'biowellness_recordatorio_48h_v4',
    secret: 'TWILIO_CONTENT_SID_RECORDATORIO_48H',
    body: 'Te recordamos tu turno de {{1}} el {{2}}. ¡Te esperamos!',
    ejemplos: { '1': 'Cámara Hiperbárica (HBOT) — Monoplaza', '2': '31/07 16:00' },
  },
  {
    nombre: 'biowellness_recordatorio_2h_v4',
    secret: 'TWILIO_CONTENT_SID_RECORDATORIO_2H',
    body: '¡Tu turno de {{1}} es hoy a las {{2}}! Te esperamos en un rato.',
    ejemplos: { '1': 'Cámara Hiperbárica (HBOT) — Monoplaza', '2': '16:00' },
  },
];

/**
 * Reglas de Meta que rechazan la plantilla recién en la aprobación (tarde y
 * quemando el nombre): se validan acá y la plantilla inválida NI se crea.
 */
function erroresDeMeta(p: DefPlantilla): string[] {
  const errores: string[] = [];
  const cuerpo = p.body.trim();
  if (/^\{\{\d+\}\}/.test(cuerpo) || /\{\{\d+\}\}$/.test(cuerpo)) {
    errores.push('el cuerpo no puede empezar ni terminar con una variable (Meta 2388299) — agregar texto fijo');
  }
  const usadas = new Set((cuerpo.match(/\{\{(\d+)\}\}/g) ?? []).map((m) => m.slice(2, -2)));
  for (const v of usadas) {
    if (!p.ejemplos[v]?.trim()) {
      errores.push(`falta el ejemplo de la variable {{${v}}} (Meta 2388043)`);
    }
  }
  return errores;
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
    const invalida = erroresDeMeta(p);
    if (invalida.length > 0) {
      for (const e of invalida) {
        console.log(`✗ ${p.nombre}: ${e}`);
      }
      continue;
    }
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
      // ⚠️ Historia de INCORRECT_CATEGORY (reserva_tentativa v3 y v5): Meta
      // ELIMINÓ el soporte de allow_category_change, así que si su clasificador
      // decide que el contenido no es UTILITY, rechaza y quema el nombre. Las
      // defensas reales son (a) redacción estrictamente transaccional (sin
      // urgencia promocional) y (b) si insiste, re-enviar esa plantilla como
      // MARKETING asumiendo sus límites (63049/63050) — decisión de negocio.
      const envio = await fetch(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests/whatsapp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: p.nombre, category: p.categoria ?? 'UTILITY' }),
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
