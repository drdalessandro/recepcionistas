/**
 * Bot · Presencia en la sala de teleconsulta.
 *
 * Es el "check-in" de la consulta virtual: registra que alguien entró a la
 * sala y, con eso, hace visible del lado de Recepción algo que hasta ahora solo
 * existía dentro del navegador del paciente.
 *
 * El caso que justifica el bot es uno: **el paciente entró y el profesional
 * todavía no.** Hay una persona real mirando una pantalla vacía, y nadie del
 * centro se enteraría. Acá el turno pasa a `arrived`, se abre el `Encounter` y
 * el aviso aparece en la vista **Avisos** con el badge en tiempo real, igual
 * que un paciente que llega al mostrador.
 *
 * Reusa el modelo del turno presencial a propósito: `arrived` = llegó,
 * `checked-in` = la consulta arrancó. Un estado nuevo obligaría a tocar todas
 * las pantallas, los reportes y el contrato con el Panel Bio para expresar algo
 * que FHIR ya expresa.
 *
 * **Detecta la ENTRADA, no la salida.** Lo dispara el evento del iframe
 * (`videoConferenceJoined`), que no llega si el navegador se cierra de golpe.
 * La salida real la va a dar el webhook de Jitsi en la Fase 2
 * (docs/teleconsulta-fase0.md). Mientras tanto, "en línea" significa "entró y
 * el turno sigue abierto", y alcanza para los avisos.
 *
 * Idempotente por (turno, quién): reconectarse tras un corte no duplica avisos
 * ni reabre nada.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, Encounter } from '@medplum/fhirtypes';
import { SYSTEM, TIPO_AVISO } from '../fhir/identifiers.js';
import { avisoProfesionalPacienteEnLinea, type RolSala } from '../lib/teleconsulta.js';
import { practitionerCodigoDeTurno } from '../fhir/appointment.js';
import { avisarProfesional, crearAlertaRecepcion, dashboardUrl, enviarWhatsApp, nombrePacienteParaAviso } from './_shared.js';
import { salaDelTurno } from './teleconsulta-token.js';

export interface EntradaPresencia {
  appointmentId: string;
  rol: RolSala;
  /** "Patient/<id>" — obligatorio cuando `rol` es `paciente`. */
  pacienteRef?: string;
  /** "Practitioner/<id>" — obligatorio cuando `rol` es `profesional`. */
  practitionerRef?: string;
}

export interface ResultadoPresencia {
  ok: boolean;
  /** Estado en que quedó el turno. */
  estado?: string;
  /** true si hay un aviso a Recepción por este turno (nuevo o ya existente). */
  avisada?: boolean;
  mensaje?: string;
}

/** El Encounter de la visita, o uno nuevo. Uno por turno, siempre. */
async function encounterDelTurno(
  medplum: MedplumClient,
  appointmentId: string,
  pacienteRef: string | undefined,
): Promise<Encounter> {
  const existente = await medplum.searchOne('Encounter', `appointment=Appointment/${appointmentId}`);
  if (existente) {
    return existente;
  }
  return medplum.createResource<Encounter>({
    resourceType: 'Encounter',
    status: 'in-progress',
    // `VR` (virtual) y no `AMB`: es el campo por el que el Panel Bio y los
    // reportes van a poder separar la consulta por video de la presencial sin
    // mirar extensiones nuestras.
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'VR', display: 'virtual' },
    appointment: [{ reference: `Appointment/${appointmentId}` }],
    period: { start: new Date().toISOString() },
    ...(pacienteRef ? { subject: { reference: pacienteRef } } : {}),
  });
}

/** ¿El profesional ya figura en la visita? */
function profesionalEnEncounter(enc: Encounter): boolean {
  return (enc.participant ?? []).some((p) => p.individual?.reference?.startsWith('Practitioner/'));
}

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaPresencia>): Promise<ResultadoPresencia> {
  const e = event.input;
  const quien = e?.rol === 'profesional' ? e.practitionerRef : e?.pacienteRef;
  if (!e?.appointmentId || !e.rol || !quien) {
    return { ok: false, mensaje: 'Faltan datos para registrar la presencia.' };
  }

  const appt = await medplum.readResource('Appointment', e.appointmentId).catch(() => undefined);
  const esParticipante = (appt?.participant ?? []).some((p) => p.actor?.reference === quien);
  if (!appt || !esParticipante || !salaDelTurno(appt)) {
    return { ok: false, mensaje: 'No encontramos esa videollamada en tu cuenta.' };
  }
  if (appt.status === 'cancelled' || appt.status === 'fulfilled') {
    return { ok: false, mensaje: 'Esta videollamada ya terminó.' };
  }

  const pacienteRef = appt.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
  const enc = await encounterDelTurno(medplum, e.appointmentId, pacienteRef);

  if (e.rol === 'profesional') {
    // El profesional entró: la consulta arrancó. Se suma a la visita (una vez)
    // y el turno pasa a `checked-in`, que es lo mismo que el mostrador marca
    // cuando el paciente entra al box.
    if (!profesionalEnEncounter(enc)) {
      await medplum.updateResource<Encounter>({
        ...enc,
        participant: [...(enc.participant ?? []), { individual: { reference: quien } }],
      });
    }
    const actualizado =
      appt.status === 'checked-in' ? appt : await medplum.updateResource<Appointment>({ ...appt, status: 'checked-in' });
    return { ok: true, estado: actualizado.status };
  }

  // El paciente entró. Si el turno ya venía `checked-in` (el profesional estaba
  // primero), no lo hacemos retroceder a `arrived`.
  const actualizado =
    appt.status === 'booked' ? await medplum.updateResource<Appointment>({ ...appt, status: 'arrived' }) : appt;

  // Aviso a Recepción, idempotente por turno: reconectarse no lo duplica. Solo
  // cuando el profesional TODAVÍA no entró — si ya está adentro, no hay nada
  // que avisar y el aviso sería ruido en una bandeja que se mira a las apuradas.
  let avisada = false;
  if (!profesionalEnEncounter(enc)) {
    const nombre = appt.description ?? 'Videollamada';
    await crearAlertaRecepcion(medplum, {
      titulo: 'El paciente entró a su videollamada',
      detalle: `${nombre}. Está esperando en la sala. Si el profesional no se conecta, llamalo.`,
      clave: `teleconsulta-en-linea-${e.appointmentId}`,
      tipo: TIPO_AVISO.pacienteEnLinea,
      ...(pacienteRef ? { pacienteRef } : {}),
      focusRef: `Appointment/${e.appointmentId}`,
      datos: { appointmentId: e.appointmentId },
    });
    avisada = true;

    // Y un WhatsApp al profesional, si Recepción configuró el número. Es
    // best-effort: que falle el aviso nunca puede impedir que el paciente entre.
    const to = event.secrets['RECEPCION_WHATSAPP_TO']?.valueString;
    if (to) {
      await enviarWhatsApp(medplum, event.secrets, {
        template: 'teleconsulta-paciente-en-linea',
        to,
        about: `Appointment/${e.appointmentId}`,
        identifier: { system: SYSTEM.communication, value: `tc-en-linea-${e.appointmentId}` },
        body: `Biowellness · Tu paciente entró a la videollamada de ${nombre} y está esperando en la sala.`,
      }).catch(() => undefined);
    }

    // Y al PROFESIONAL mismo, si cargó su contacto (Andrés, 2026-09-20). Es el
    // aviso con más apuro de todos: hay una persona mirando una sala vacía.
    // Idempotente por turno, como el de Recepción; best-effort, como todo acá.
    const practitionerCodigo = practitionerCodigoDeTurno(appt);
    if (practitionerCodigo) {
      await avisarProfesional(medplum, event.secrets, {
        practitionerCodigo,
        clave: `tc-en-linea-prof-${e.appointmentId}`,
        template: 'profesional-paciente-en-linea',
        about: `Appointment/${e.appointmentId}`,
        aviso: avisoProfesionalPacienteEnLinea({
          paciente: await nombrePacienteParaAviso(medplum, pacienteRef),
          link: dashboardUrl(event.secrets),
        }),
      }).catch(() => undefined);
    }
  }

  return { ok: true, estado: actualizado.status, avisada };
}
