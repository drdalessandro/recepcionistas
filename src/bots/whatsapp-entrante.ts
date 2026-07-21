/**
 * Bot · WhatsApp entrante (Twilio) → bandeja de Mensajes.
 *
 * Twilio llama la URL pública (nginx `/webhooks/twilio-whatsapp`, que inyecta la
 * autenticación igual que el webhook de MercadoPago) cuando un paciente escribe
 * al número de WhatsApp de Biowellness. Patrón `inboundSmsActiveThreadLookup`
 * del ejemplo oficial de mensajería de Medplum:
 *
 *  1. Valida la firma X-Twilio-Signature (si TWILIO_WEBHOOK_URL está configurado).
 *  2. Resuelve el Patient por teléfono (variantes exactas del número argentino).
 *  3. Agrega el mensaje al hilo ACTIVO más reciente del paciente (o abre uno
 *     nuevo "WhatsApp") → aparece al instante en Recepción → Mensajes, con el
 *     badge verde y la campanita (el mensaje queda sender=Patient, sin received).
 *  4. Número desconocido → alerta a Recepción (Task) con el texto: no se pierde.
 *
 * Idempotente por MessageSid (Twilio reintenta). Nunca lanza: si algo falla,
 * responde ok:false y Twilio reintenta después.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Attachment, Communication, Patient } from '@medplum/fhirtypes';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { extensionDeMime, mediosTwilio, validarFirmaTwilio, variantesTelefono } from '../lib/whatsapp.js';
import { crearAlertaRecepcion } from './_shared.js';

interface EntradaTwilio {
  MessageSid?: string;
  From?: string;
  Body?: string;
  ProfileName?: string;
  NumMedia?: string;
}

export interface ResultadoWhatsAppEntrante {
  ok: boolean;
  motivo?: string;
  pacienteRef?: string;
  hiloId?: string;
  mensajeId?: string;
  adjuntos?: number;
}

/**
 * Descarga los adjuntos del mensaje (fotos, PDFs, audios) desde Twilio —sus
 * URLs requieren la autenticación Basic de la cuenta— y los guarda como Binary
 * en Medplum. Devuelve los Attachment listos para el payload (contentAttachment
 * con `url` canónica de Binary, que Medplum presigna en cada lectura).
 * Best-effort: el adjunto que falla se anota en el texto y no rompe el mensaje.
 */
async function ingresarAdjuntos(
  medplum: MedplumClient,
  params: Record<string, unknown>,
  messageSid: string,
  secrets: BotEvent['secrets'],
): Promise<{ adjuntos: Attachment[]; fallidos: number }> {
  const medios = mediosTwilio(params);
  const adjuntos: Attachment[] = [];
  let fallidos = 0;
  if (medios.length === 0) {
    return { adjuntos, fallidos };
  }
  const sid = secrets['TWILIO_ACCOUNT_SID']?.valueString;
  const token = secrets['TWILIO_AUTH_TOKEN']?.valueString;
  if (!sid || !token) {
    return { adjuntos, fallidos: medios.length };
  }
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  for (const [i, medio] of medios.entries()) {
    try {
      const resp = await fetch(medio.url, { headers: { Authorization: `Basic ${auth}` } });
      if (!resp.ok) {
        throw new Error(`Twilio media respondió ${resp.status}`);
      }
      const filename = `whatsapp-${messageSid.slice(-8)}-${i + 1}.${extensionDeMime(medio.contentType)}`;
      adjuntos.push(
        await medplum.createAttachment({
          data: new Uint8Array(await resp.arrayBuffer()),
          contentType: medio.contentType,
          filename,
        }),
      );
    } catch (err) {
      fallidos++;
      console.log(`whatsapp-entrante: adjunto ${i + 1} no se pudo guardar: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { adjuntos, fallidos };
}

/**
 * Twilio espera TwiML (XML) como respuesta del webhook — responderle JSON genera
 * el error 12300 en su Debugger. Medplum responde crudo con el contentType del
 * Binary devuelto (forceRawBinaryResponse), así que el bot contesta un TwiML
 * vacío (= "no responder nada al remitente") y el diagnóstico va al log
 * (AuditEvent del bot / CloudWatch).
 */
const TWIML_VACIO = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

function respuestaTwiml(resultado: ResultadoWhatsAppEntrante): unknown {
  console.log(`whatsapp-entrante: ${JSON.stringify(resultado)}`);
  return {
    resourceType: 'Binary',
    contentType: 'text/xml',
    data: Buffer.from(TWIML_VACIO, 'utf8').toString('base64'),
  };
}

export async function handler(medplum: MedplumClient, event: BotEvent): Promise<unknown> {
  try {
    // Twilio manda application/x-www-form-urlencoded; si el server lo entregara
    // como string crudo, se parsea igual.
    const raw = event.input;
    const e: EntradaTwilio =
      typeof raw === 'string' ? (Object.fromEntries(new URLSearchParams(raw)) as EntradaTwilio) : ((raw ?? {}) as EntradaTwilio);

    // Firma de Twilio (hardening): se valida solo si está configurada la URL
    // pública (el HMAC se calcula sobre ella). Sin config, no bloquea.
    const authToken = event.secrets['TWILIO_AUTH_TOKEN']?.valueString;
    const urlPublica = event.secrets['TWILIO_WEBHOOK_URL']?.valueString;
    if (authToken && urlPublica) {
      const firma = event.headers?.['x-twilio-signature'];
      if (!validarFirmaTwilio(urlPublica, e as Record<string, unknown>, typeof firma === 'string' ? firma : undefined, authToken)) {
        return respuestaTwiml({ ok: false, motivo: 'firma de Twilio inválida' });
      }
    }

    if (!e.MessageSid || !e.From) {
      return respuestaTwiml({ ok: true, motivo: 'sin MessageSid/From: ignorado' });
    }
    const texto = (e.Body ?? '').trim();
    const conAdjunto = Number(e.NumMedia ?? '0') > 0;
    if (!texto && !conAdjunto) {
      return respuestaTwiml({ ok: true, motivo: 'mensaje vacío: ignorado' });
    }

    // Idempotencia: Twilio reintenta si no respondemos a tiempo.
    const clave = `twilio-${e.MessageSid}`;
    const yaProcesado = await medplum.searchOne('Communication', `identifier=${SYSTEM.communication}|${clave}`);
    if (yaProcesado) {
      return respuestaTwiml({ ok: true, motivo: 'ya procesado', mensajeId: yaProcesado.id });
    }

    // Paciente por teléfono: variantes exactas (la búsqueda FHIR no normaliza).
    let paciente: Patient | undefined;
    for (const variante of variantesTelefono(e.From)) {
      const candidatos = await medplum.searchResources('Patient', `telecom=${encodeURIComponent(variante)}&_count=5`);
      paciente = candidatos.find((p) => p.active !== false && !p.link?.length);
      if (paciente) {
        break;
      }
    }

    if (!paciente?.id) {
      await crearAlertaRecepcion(medplum, {
        titulo: 'WhatsApp de número desconocido',
        detalle: `${e.From}${e.ProfileName ? ` (${e.ProfileName})` : ''} escribió: "${texto.slice(0, 300)}"${
          conAdjunto ? ' [con adjunto]' : ''
        }. El número no coincide con ninguna ficha: crear el paciente o responder desde Twilio.`,
      });
      return respuestaTwiml({ ok: true, motivo: 'número desconocido: alerta a Recepción creada' });
    }
    const pacienteRef = `Patient/${paciente.id}`;
    const ahora = new Date().toISOString();

    // Hilo activo más reciente del paciente, o uno nuevo (topic "WhatsApp").
    let topic = await medplum.searchOne(
      'Communication',
      `part-of:missing=true&status=in-progress&subject=${pacienteRef}&_sort=-_lastUpdated`,
    );
    if (!topic) {
      topic = await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: 'in-progress',
        sent: ahora,
        subject: { reference: pacienteRef },
        sender: { reference: pacienteRef },
        topic: { text: 'WhatsApp' },
        payload: [{ contentString: 'WhatsApp' }],
      });
    }

    // Adjuntos reales en el hilo (foto del estudio, PDF, audio): quedan como
    // Binary y el chat los muestra; el que falla se anota y no rompe el mensaje.
    const { adjuntos, fallidos } = conAdjunto
      ? await ingresarAdjuntos(medplum, e as Record<string, unknown>, e.MessageSid, event.secrets)
      : { adjuntos: [], fallidos: 0 };
    const cuerpo = [
      texto,
      fallidos > 0 ? `📎 [${fallidos} adjunto(s) no se pudieron guardar — verlos en la consola de Twilio]` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const mensaje = await medplum.createResource<Communication>({
      resourceType: 'Communication',
      status: 'in-progress',
      identifier: [{ system: SYSTEM.communication, value: clave }],
      sent: ahora,
      subject: { reference: pacienteRef },
      sender: { reference: pacienteRef },
      partOf: [{ reference: `Communication/${topic.id}` }],
      payload: [...(cuerpo ? [{ contentString: cuerpo }] : []), ...adjuntos.map((a) => ({ contentAttachment: a }))],
      extension: [{ url: EXT.canal, valueCode: 'whatsapp' }],
    });

    return respuestaTwiml({ ok: true, pacienteRef, hiloId: topic.id, mensajeId: mensaje.id, adjuntos: adjuntos.length });
  } catch (err) {
    return respuestaTwiml({ ok: false, motivo: err instanceof Error ? err.message : 'whatsapp-entrante falló' });
  }
}
