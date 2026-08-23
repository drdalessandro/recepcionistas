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
 *  4. Número desconocido → aviso a Recepción (Task `aviso-recepcion`, tipo
 *     `whatsapp-desconocido`) con teléfono y texto en `input`: aparece en la
 *     vista **Avisos**, desde donde se le responde por WhatsApp o se le crea
 *     la ficha. El contacto no se pierde ni queda invisible.
 *  5. **Respuesta automática** (`src/lib/auto-respuesta.ts`): acuse de recibo
 *     con el horario real, o una respuesta concreta si la intención es clara
 *     (comprobante de pago, turno, precios, horario/ubicación). Sale como texto
 *     libre: contestar un entrante siempre cae dentro de la ventana de 24 h de
 *     Meta, así que no hace falta plantilla aprobada.
 *
 * Idempotente por MessageSid (Twilio reintenta). Nunca lanza: si algo falla,
 * responde ok:false y Twilio reintenta después. La auto-respuesta NUNCA rompe
 * el flujo: si falla, el mensaje ya quedó guardado, que es lo que importa.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Attachment, Communication, Patient, Task } from '@medplum/fhirtypes';
import { COD, EXT, SYSTEM, TIPO_AVISO } from '../fhir/identifiers.js';
import { extensionDeMime, mediosTwilio, validarFirmaTwilio, variantesTelefono } from '../lib/whatsapp.js';
import {
  armarAutoRespuesta,
  type DecisionAutoRespuesta,
  type Intencion,
} from '../lib/auto-respuesta.js';
import { MINUTOS_ENTRE_AUTO_RESPUESTAS, SEGUNDOS_ENTRE_MENSAJES } from '../config/auto-respuesta.js';
import { crearAlertaRecepcion, enviarWhatsApp, fechaTurnoNotif } from './_shared.js';

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
  /** Intención que se contestó automáticamente (ausente = no se contestó). */
  autoRespuesta?: Intencion;
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
      // El contacto NO se pierde: queda como aviso en la vista Avisos, con el
      // número y el texto en `datos` para poder responderle por WhatsApp o
      // crearle la ficha de un click (sin volver a la consola de Twilio).
      // Idempotente por MessageSid: si Twilio reintenta, no duplica el aviso.
      const telefono = (e.From ?? '').replace(/^whatsapp:/i, '').trim();
      // Antes de crear el aviso nuevo: ¿ya le contestamos hace poco? Sin hilo
      // donde dejar la marca, el rastro son los avisos previos del mismo número.
      const yaRespondido = await respondimosRecientemente(medplum, telefono);
      await crearAlertaRecepcion(medplum, {
        titulo: 'WhatsApp de número desconocido',
        clave: `wa-desconocido-${e.MessageSid}`,
        tipo: TIPO_AVISO.whatsappDesconocido,
        detalle: `${telefono}${e.ProfileName ? ` (${e.ProfileName})` : ''} escribió: "${texto.slice(0, 300)}"${
          conAdjunto ? ' [con adjunto: verlo en la consola de Twilio]' : ''
        }. El número no coincide con ninguna ficha.`,
        datos: { telefono, texto: texto.slice(0, 1000), perfil: e.ProfileName },
      });
      if (!yaRespondido) {
        await autoResponder(medplum, event.secrets, { texto, conAdjunto, telefono });
      }
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

    // Respuesta automática: lo último, y a prueba de fallas. El mensaje del
    // paciente ya está guardado — que la contestación falle no puede hacer que
    // Twilio reintente y lo duplique.
    const intencion = await autoResponder(medplum, event.secrets, {
      texto,
      conAdjunto,
      telefono: (e.From ?? '').replace(/^whatsapp:/i, '').trim(),
      paciente,
      topic,
    }).catch((err) => {
      console.log(`whatsapp-entrante: auto-respuesta falló: ${err instanceof Error ? err.message : err}`);
      return undefined;
    });

    return respuestaTwiml({
      ok: true,
      pacienteRef,
      hiloId: topic.id,
      mensajeId: mensaje.id,
      adjuntos: adjuntos.length,
      ...(intencion ? { autoRespuesta: intencion } : {}),
    });
  } catch (err) {
    return respuestaTwiml({ ok: false, motivo: err instanceof Error ? err.message : 'whatsapp-entrante falló' });
  }
}

/**
 * ¿Ya le contestamos automáticamente a este número desconocido hace poco?
 *
 * Un desconocido no tiene hilo donde dejar la marca, así que el rastro son los
 * avisos previos del mismo teléfono. Sin esto, cinco mensajes seguidos de
 * alguien que está probando el número se llevan cinco respuestas iguales.
 */
async function respondimosRecientemente(medplum: MedplumClient, telefono: string): Promise<boolean> {
  const corte = Date.now() - MINUTOS_ENTRE_AUTO_RESPUESTAS * 60_000;
  const previos = await medplum
    .searchResources('Task', `code=${COD.avisoRecepcion}&_sort=-authored-on&_count=30`)
    .catch(() => [] as Task[]);
  return previos.some(
    (t) =>
      t.input?.some((i) => i.type?.text === 'tipo' && i.valueString === TIPO_AVISO.whatsappDesconocido) &&
      t.input?.some((i) => i.type?.text === 'telefono' && i.valueString === telefono) &&
      Boolean(t.authoredOn) &&
      new Date(t.authoredOn as string).getTime() > corte,
  );
}

/** Próximo turno del paciente, en palabras, para que el acuse no sea genérico. */
async function proximoTurno(medplum: MedplumClient, pacienteRef: string): Promise<string | undefined> {
  const appt = await medplum
    .searchOne(
      'Appointment',
      `patient=${pacienteRef}&status=booked,arrived&date=ge${new Date().toISOString()}&_sort=date&_count=1`,
    )
    .catch(() => undefined);
  if (!appt?.start) {
    return undefined;
  }
  return `el ${fechaTurnoNotif(appt.start)}${appt.description ? ` · ${appt.description}` : ''}`;
}

/**
 * Contesta el mensaje entrante si corresponde, y deja el trabajo que haga falta
 * en la bandeja de Recepción.
 *
 * Lo que se manda sale como **texto libre** (`sinPlantilla`): responder a un
 * entrante siempre cae dentro de la ventana de 24 h de Meta. La respuesta queda
 * en el hilo marcada con `EXT.autoRespuesta`, que cumple tres funciones: la
 * bandeja la muestra como automática, el propio bot sabe qué contestó la última
 * vez (para no repetirse) y los reportes no confunden bot con atención humana.
 *
 * Devuelve la intención contestada, o undefined si decidió callarse.
 */
async function autoResponder(
  medplum: MedplumClient,
  secrets: BotEvent['secrets'],
  opts: {
    texto: string;
    conAdjunto: boolean;
    telefono: string;
    paciente?: Patient;
    topic?: Communication;
  },
): Promise<Intencion | undefined> {
  const pacienteRef = opts.paciente?.id ? `Patient/${opts.paciente.id}` : undefined;

  // Qué contestamos la última vez en este hilo, y si el paciente pidió silencio.
  let ultima: { intencion: Intencion; cuandoISO: string } | undefined;
  if (opts.topic?.id) {
    const previos = await medplum
      .searchResources('Communication', `part-of=Communication/${opts.topic.id}&_sort=-sent&_count=20`)
      .catch(() => [] as Communication[]);
    for (const c of previos) {
      const marca = c.extension?.find((x) => x.url === EXT.autoRespuesta)?.valueCode;
      if (marca && c.sent) {
        ultima = { intencion: marca as Intencion, cuandoISO: c.sent };
        break;
      }
    }
  }

  const decision = armarAutoRespuesta({
    ahora: new Date(),
    texto: opts.texto,
    conAdjunto: opts.conAdjunto,
    nombre: opts.paciente?.name?.[0]?.given?.[0],
    esConocido: Boolean(pacienteRef),
    ...(pacienteRef ? { proximoTurno: await proximoTurno(medplum, pacienteRef) } : {}),
    ...(ultima ? { ultima } : {}),
    ...(opts.topic?.extension?.find((x) => x.url === EXT.silencioAuto)?.valueDateTime
      ? { silencioDesdeISO: opts.topic.extension.find((x) => x.url === EXT.silencioAuto)?.valueDateTime }
      : {}),
  });
  if (!decision) {
    return undefined;
  }

  // La respuesta puede ser más de un globo (ver `mensajesSiguientes`). Van en
  // orden y con una pausa entre medio: pegados se leen como un solo mensaje
  // partido al medio. La pausa corre DENTRO del webhook de Twilio, por eso
  // SEGUNDOS_ENTRE_MENSAJES es chico y está en config.
  const mensajes = [decision.texto, ...(decision.mensajesSiguientes ?? [])];
  for (let i = 0; i < mensajes.length; i++) {
    const cuerpo = mensajes[i] as string;
    if (i > 0) {
      await esperar(SEGUNDOS_ENTRE_MENSAJES * 1000);
    }

    await enviarWhatsApp(medplum, secrets, {
      template: 'auto-respuesta',
      sinPlantilla: true,
      body: cuerpo,
      ...(pacienteRef ? { pacienteRef } : { to: opts.telefono }),
    });

    // La respuesta también va al hilo, para que Recepción vea la conversación
    // completa (incluido lo que contestó el sistema en su nombre).
    if (pacienteRef && opts.topic?.id) {
      await medplum
        .createResource<Communication>({
          resourceType: 'Communication',
          status: 'completed',
          sent: new Date().toISOString(),
          subject: { reference: pacienteRef },
          recipient: [{ reference: pacienteRef }],
          partOf: [{ reference: `Communication/${opts.topic.id}` }],
          payload: [{ contentString: cuerpo }],
          extension: [
            { url: EXT.canal, valueCode: 'whatsapp' },
            { url: EXT.autoRespuesta, valueCode: decision.intencion },
          ],
        })
        .catch(() => undefined);
    }
  }

  await aplicarExtras(medplum, decision, { ...opts, pacienteRef });
  return decision.intencion;
}

/** Pausa entre globos de una misma respuesta automática. */
function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lo que la decisión pide ADEMÁS de contestar: silencio, aviso, solicitud. */
async function aplicarExtras(
  medplum: MedplumClient,
  decision: DecisionAutoRespuesta,
  ctx: { texto: string; telefono: string; paciente?: Patient; topic?: Communication; pacienteRef?: string },
): Promise<void> {
  if (decision.activarSilencio && ctx.topic?.id) {
    await medplum
      .updateResource<Communication>({
        ...ctx.topic,
        extension: [
          ...(ctx.topic.extension ?? []).filter((x) => x.url !== EXT.silencioAuto),
          { url: EXT.silencioAuto, valueDateTime: new Date().toISOString() },
        ],
      })
      .catch(() => undefined);
  }

  if (decision.aviso) {
    await crearAlertaRecepcion(medplum, {
      titulo: decision.aviso.titulo,
      detalle: decision.aviso.detalle,
      ...(ctx.pacienteRef ? { pacienteRef: ctx.pacienteRef } : {}),
      ...(ctx.topic?.id ? { focusRef: `Communication/${ctx.topic.id}` } : {}),
      datos: { telefono: ctx.telefono, texto: ctx.texto.slice(0, 1000) },
    }).catch(() => undefined);
  }

  // Va a la bandeja de Solicitudes, donde Recepción ya resuelve los pedidos de
  // turno con los horarios libres: no se inventa una cola nueva para WhatsApp.
  if (decision.crearSolicitudTurno && ctx.pacienteRef) {
    await medplum
      .createResource<Task>({
        resourceType: 'Task',
        status: 'requested',
        intent: 'proposal',
        authoredOn: new Date().toISOString(),
        code: { coding: [{ system: SYSTEM.taskTipo, code: COD.solicitudTurno }], text: 'Solicitud de turno' },
        requester: { reference: ctx.pacienteRef },
        for: { reference: ctx.pacienteRef },
        description: `Pidió turno por WhatsApp: "${ctx.texto.slice(0, 200)}"`,
        input: [
          { type: { text: 'terapia' }, valueString: 'A definir (pedido por WhatsApp)' },
          { type: { text: 'preferencia-texto' }, valueString: ctx.texto.slice(0, 300) },
        ],
      })
      .catch(() => undefined);
  }
}
