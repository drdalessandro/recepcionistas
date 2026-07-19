/**
 * Bot · Enviar WhatsApp.
 *
 * Envía un mensaje por la WhatsApp Business API (Twilio) y registra la
 * comunicación como recurso Communication (trazabilidad en la ficha,
 * Documento de Requerimientos §6.6). La lógica vive en `_shared.enviarWhatsApp`,
 * que también usan los bots de reserva y de seña.
 *
 * Si se pasa `mensajeId` (espejo de la bandeja de Mensajes), el bot lee esa
 * Communication y espeja también sus adjuntos: al leerla, Medplum reescribe las
 * URLs `Binary/...` de los contentAttachment a URLs presignadas temporales, que
 * Twilio puede descargar sin autenticación (salen como MediaUrl).
 *
 * Los secretos de Twilio se leen de event.secrets (Project Secrets de Medplum):
 * TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { enviarWhatsApp } from './_shared.js';

export interface EntradaWhatsApp {
  /** Destinatario en formato E.164 (si no se pasa, se toma del paciente). */
  to?: string;
  /** Nombre del template aprobado por Meta. */
  template: string;
  /** Texto ya resuelto del mensaje (puede ser vacío si solo van adjuntos). */
  body: string;
  /** Referencia FHIR del paciente, ej. "Patient/123". */
  pacienteRef?: string;
  /** Communication de la bandeja a espejar (texto + adjuntos). */
  mensajeId?: string;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaWhatsApp>,
): Promise<Communication> {
  const { to, template, body, pacienteRef, mensajeId } = event.input;

  let mediaUrls: string[] | undefined;
  if (mensajeId) {
    const mensaje = await medplum.readResource('Communication', mensajeId).catch(() => undefined);
    mediaUrls = mensaje?.payload
      ?.map((p) => p.contentAttachment?.url)
      .filter((u): u is string => Boolean(u && /^https?:\/\//i.test(u)));
  }

  return enviarWhatsApp(medplum, event.secrets, {
    template,
    body,
    pacienteRef,
    to,
    mediaUrls,
    ...(mensajeId ? { about: `Communication/${mensajeId}` } : {}),
  });
}
