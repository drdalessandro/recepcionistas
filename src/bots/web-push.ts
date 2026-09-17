/**
 * Bot · Web Push al paciente.
 *
 * Lo dispara una Subscription al crearse una `Communication`-notificación (la
 * misma que enciende la campanita del portal: `notificarPortal` en `_shared`).
 * Lee las suscripciones de la ficha del paciente y manda el aviso a cada
 * dispositivo, para que llegue **con la app cerrada**.
 *
 * Implementa `portal/docs/fase4-web-push-handoff.md`. El lado del portal ya
 * estaba: es PWA, la paciente activa los avisos desde la campanita y la
 * suscripción del dispositivo se guarda en su `Patient` como extensión
 * repetible. Lo que faltaba era el emisor, y no estaba en ningún repo — el doc
 * del portal decía que vivía acá y el de acá decía que vivía en el portal.
 *
 * NUNCA lanza. Un push que falla no debe reintentar la Subscription ni
 * ensuciar la bandeja: la notificación ya está creada y la paciente la ve en la
 * campanita igual. El push es el extra.
 *
 * Los endpoints que el navegador dio de baja (404/410) se sacan de la ficha:
 * sin esa higiene la lista crece con dispositivos muertos y cada notificación
 * gasta un intento en cada uno.
 *
 * Secretos (Project Secrets de Medplum): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY y
 * VAPID_SUBJECT. La privada no vive en este repo ni en ningún lado del código.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication, Extension, Patient } from '@medplum/fhirtypes';
import webpush from 'web-push';
import { NOTIFICACION_SYSTEM, type TipoNotificacionPortal } from './_shared.js';
import { rutaTeleconsulta } from '../lib/teleconsulta.js';

/** Extensión repetible en `Patient`, una por dispositivo. Contrato del portal. */
export const WEB_PUSH_EXT = 'https://biowellness.ar/fhir/StructureDefinition/web-push';

/** Qué título muestra el sistema operativo. Uno por tipo del CodeSystem. */
const TITULOS: Record<TipoNotificacionPortal, string> = {
  'reserva-confirmada': 'Reserva confirmada',
  'reserva-vencida': 'Se liberó tu lugar',
  'pago-recibido': 'Pago recibido',
  recordatorio: 'Recordatorio de turno',
  'teleconsulta-lista': 'Tu videollamada',
  // Sin decir QUÉ documento: el título lo lee cualquiera que mire la pantalla
  // bloqueada del teléfono. "Tu laboratorio" ya sería contarle a esa persona
  // algo de la salud del paciente (principio 3).
  'documento-nuevo': 'Novedades de tu consulta',
  general: 'Biowellness',
};

/** Un día: más allá de eso el aviso ya no le sirve a nadie. */
const TTL_SEGUNDOS = 24 * 60 * 60;

export function tipoDe(comm: Communication): string {
  return (comm.category ?? []).flatMap((c) => c.coding ?? []).find((k) => k.system === NOTIFICACION_SYSTEM)?.code ?? '';
}

/**
 * A dónde lleva el tap. Mismo criterio que la campanita del portal: manda el
 * recurso del que habla la notificación, y sólo si no dice nada se cae al tipo.
 */
export function urlDestino(comm: Communication, tipo: string): string {
  const about = comm.about?.[0]?.reference ?? '';
  // Antes que la regla general de Appointment: el aviso de la videollamada
  // lleva a la sala, no a la ficha del turno. Es el único tap del que depende
  // que el paciente llegue a tiempo a una consulta médica.
  if (tipo === 'teleconsulta-lista' && about.startsWith('Appointment/')) {
    return rutaTeleconsulta(about.slice('Appointment/'.length));
  }
  if (about.startsWith('Appointment/') || about.startsWith('Invoice/')) {
    return '/account/membership';
  }
  if (about.startsWith('CarePlan/')) {
    return '/care-plan';
  }
  return tipo === 'reserva-confirmada' || tipo === 'pago-recibido' ? '/account/membership' : '/';
}

/** El JSON que espera el service worker del portal. Contrato del handoff. */
export function payloadDe(comm: Communication, tipo: string): string {
  return JSON.stringify({
    title: TITULOS[tipo as TipoNotificacionPortal] ?? 'Biowellness',
    body: comm.payload?.find((p) => p.contentString)?.contentString ?? 'Tenés una novedad en tu portal.',
    url: urlDestino(comm, tipo),
    tag: `bw-${comm.id}`,
  });
}

/** Una suscripción de dispositivo, si la extensión trae las tres partes. */
export function suscripcionDe(dispositivo: Extension): { endpoint: string; keys: { p256dh: string; auth: string } } | undefined {
  const get = (u: string): Extension | undefined => dispositivo.extension?.find((s) => s.url === u);
  const endpoint = get('endpoint')?.valueUrl;
  const p256dh = get('p256dh')?.valueString;
  const auth = get('auth')?.valueString;
  return endpoint && p256dh && auth ? { endpoint, keys: { p256dh, auth } } : undefined;
}

export async function handler(medplum: MedplumClient, event: BotEvent<Communication>): Promise<unknown> {
  const comm = event.input;
  const tipo = tipoDe(comm);
  if (!tipo) {
    return { ok: true, motivo: 'no es una notificación del portal' };
  }
  const pacienteRef = comm.recipient?.find((r) => r.reference?.startsWith('Patient/'))?.reference;
  if (!pacienteRef) {
    return { ok: true, motivo: 'sin paciente destinatario' };
  }

  const pub = event.secrets['VAPID_PUBLIC_KEY']?.valueString;
  const priv = event.secrets['VAPID_PRIVATE_KEY']?.valueString;
  const subject = event.secrets['VAPID_SUBJECT']?.valueString ?? 'mailto:info@biowellness.ar';
  if (!pub || !priv) {
    // Sin claves no se puede firmar. Se avisa y se sigue: la notificación ya
    // existe y la campanita la muestra.
    console.warn('bw-web-push: faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en los Project Secrets.');
    return { ok: false, motivo: 'sin claves VAPID' };
  }
  try {
    webpush.setVapidDetails(subject, pub, priv);
  } catch (err) {
    // `setVapidDetails` LANZA si la clave está mal formada (por ejemplo, pegada
    // a medias en los Project Secrets). Sin este catch, el bot rompía su propia
    // promesa de no lanzar nunca: la Subscription reintentaría en cada
    // notificación y el error no diría qué hacer. Lo encontró un test.
    console.warn('bw-web-push: las claves VAPID no son válidas:', (err as Error).message);
    return { ok: false, motivo: 'claves VAPID inválidas' };
  }

  const patient = await medplum.readResource('Patient', pacienteRef.split('/')[1] as string);
  const dispositivos = (patient.extension ?? []).filter((e) => e.url === WEB_PUSH_EXT);
  if (dispositivos.length === 0) {
    return { ok: true, enviados: 0, motivo: 'la paciente no activó los avisos en ningún dispositivo' };
  }

  const payload = payloadDe(comm, tipo);
  let enviados = 0;
  const vencidos: string[] = [];

  for (const dispositivo of dispositivos) {
    const suscripcion = suscripcionDe(dispositivo);
    if (!suscripcion) {
      continue;
    }
    try {
      await webpush.sendNotification(suscripcion, payload, { TTL: TTL_SEGUNDOS });
      enviados++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        vencidos.push(suscripcion.endpoint);
      } else {
        // El endpoint se recorta: es una URL con secreto del navegador.
        console.warn('bw-web-push: fallo al enviar', status, suscripcion.endpoint.slice(0, 60));
      }
    }
  }

  if (vencidos.length > 0) {
    await medplum.updateResource<Patient>({
      ...patient,
      extension: sinLosVencidos(patient.extension ?? [], vencidos),
    });
  }

  return { ok: true, enviados, bajas: vencidos.length };
}

/** Saca de la ficha los dispositivos que el navegador dio de baja. */
export function sinLosVencidos(extensiones: readonly Extension[], vencidos: readonly string[]): Extension[] {
  return extensiones.filter((e) => {
    if (e.url !== WEB_PUSH_EXT) {
      return true;
    }
    const endpoint = e.extension?.find((s) => s.url === 'endpoint')?.valueUrl;
    return !endpoint || !vencidos.includes(endpoint);
  });
}
