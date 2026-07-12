/**
 * Bot · Solicitar turno (desde el portal del paciente).
 *
 * Modelo de "solicitud": el paciente pide un turno (terapia + preferencia) y este
 * bot crea un `Task` (cola de solicitudes que ve Recepción) y avisa a Recepción por
 * WhatsApp. El bot NO reserva: la confirmación la hace Recepción con los bots de
 * reserva (que aplican las reglas). Toda la decisión vive en recepción.
 *
 * Seguridad: el paciente solo puede ejecutar ESTE bot (su AccessPolicy acota
 * `Bot?name=bw-solicitar-turno`) y solo puede leer sus propios `Task`. Para que el
 * `requester` no se pueda falsificar, conviene crear el Bot con `runAsUser` en
 * Medplum; mientras tanto, Recepción verifica la solicitud contra el paciente real
 * antes de reservar.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Task, TaskInput } from '@medplum/fhirtypes';
import { COD, SYSTEM } from '../fhir/identifiers.js';
import { mensajeWhatsAppRecepcion, resumenSolicitud, validarSolicitud, type SolicitudTurno } from '../lib/solicitudes.js';
import { enviarWhatsApp } from './_shared.js';

export interface ResultadoSolicitud {
  ok: boolean;
  mensaje?: string;
  taskId?: string;
  /** true si el WhatsApp de aviso a Recepción salió de verdad. */
  avisada?: boolean;
}

export async function handler(medplum: MedplumClient, event: BotEvent<SolicitudTurno>): Promise<ResultadoSolicitud> {
  const e = event.input;
  const v = validarSolicitud(e);
  if (!v.ok) {
    return { ok: false, mensaje: v.error };
  }

  // Nombre del paciente (best-effort, para el aviso a Recepción).
  let nombre = '';
  try {
    const id = e.pacienteRef.split('/')[1];
    if (id) {
      const p = await medplum.readResource('Patient', id);
      nombre = p.name?.[0]?.text ?? [p.name?.[0]?.given?.join(' '), p.name?.[0]?.family].filter(Boolean).join(' ');
    }
  } catch {
    // sin nombre; seguimos
  }

  const input: TaskInput[] = [
    { type: { text: 'terapia' }, valueString: e.terapia.trim() },
    ...(e.terapiaCodigo ? [{ type: { text: 'terapia-codigo' }, valueString: e.terapiaCodigo }] : []),
    ...(e.preferenciaInicio ? [{ type: { text: 'preferencia-inicio' }, valueDateTime: e.preferenciaInicio }] : []),
    ...(e.preferenciaTexto?.trim() ? [{ type: { text: 'preferencia-texto' }, valueString: e.preferenciaTexto.trim() }] : []),
    ...(e.nota?.trim() ? [{ type: { text: 'nota' }, valueString: e.nota.trim() }] : []),
  ];

  const task = await medplum.createResource<Task>({
    resourceType: 'Task',
    status: 'requested',
    intent: 'proposal',
    authoredOn: new Date().toISOString(),
    code: { coding: [{ system: SYSTEM.taskTipo, code: COD.solicitudTurno }], text: 'Solicitud de turno' },
    requester: { reference: e.pacienteRef },
    for: { reference: e.pacienteRef },
    description: resumenSolicitud(e),
    input,
  });

  // Aviso a Recepción (a un número configurado por Project Secret).
  let avisada = false;
  const to = event.secrets['RECEPCION_WHATSAPP_TO']?.valueString;
  if (to) {
    const comm = await enviarWhatsApp(medplum, event.secrets, {
      template: 'solicitud-turno',
      to,
      about: `Task/${task.id}`,
      body: mensajeWhatsAppRecepcion(e, nombre),
    });
    avisada = comm.status === 'completed';
  }

  return { ok: true, taskId: task.id, avisada };
}
