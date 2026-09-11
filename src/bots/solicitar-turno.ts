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
import { getServicio } from '../config/catalogo.js';
import { COD, SYSTEM } from '../fhir/identifiers.js';
import type { DiaDisponible } from '../lib/disponibilidad.js';
import { mensajeWhatsAppRecepcion, resumenSolicitud, validarSolicitud, type SolicitudTurno } from '../lib/solicitudes.js';
import { chequearHorarioDisponible, enviarWhatsApp } from './_shared.js';

export interface ResultadoSolicitud {
  ok: boolean;
  mensaje?: string;
  taskId?: string;
  /** true si el WhatsApp de aviso a Recepción salió de verdad. */
  avisada?: boolean;
  /** 'horario-ocupado' cuando el horario pedido ya no está disponible. */
  motivo?: 'horario-ocupado';
  /** Chips frescos para re-elegir (mismo formato que bw-disponibilidad). */
  alternativas?: DiaDisponible[];
}

export async function handler(medplum: MedplumClient, event: BotEvent<SolicitudTurno>): Promise<ResultadoSolicitud> {
  const e = event.input;
  const v = validarSolicitud(e);
  if (!v.ok) {
    return { ok: false, mensaje: v.error };
  }

  // Defensa en profundidad (feedback de recepción 2026-08-12): si la solicitud
  // trae horario exacto y un código de SERVICIO resoluble, se verifica que el
  // horario siga estando. Un horario tomado se rechaza acá aunque el portal lo
  // haya mostrado libre.
  //
  // El chequeo pregunta a la fuente que corresponde según el servicio
  // (`chequearHorarioDisponible`): la grilla de salas para las terapias, la
  // agenda publicada del profesional para las consultas. Validar una consulta
  // contra la grilla de terapias las rechazaba TODAS — le aplicaba la ventana
  // R-13 a un turno que el médico publicó con semanas de anticipación.
  //
  // Best-effort: si el chequeo falla o el código es una categoría ("HBOT"),
  // la solicitud pasa como siempre — la última palabra la tiene Recepción.
  if (e.preferenciaInicio && e.terapiaCodigo) {
    let servicio;
    try {
      servicio = getServicio(e.terapiaCodigo);
    } catch {
      servicio = undefined; // categoría o código desconocido: sin chequeo
    }
    if (servicio) {
      try {
        const chequeo = await chequearHorarioDisponible(
          medplum,
          e.pacienteRef,
          servicio,
          new Date(e.preferenciaInicio),
        );
        if (!chequeo.ok) {
          return {
            ok: false,
            motivo: 'horario-ocupado',
            mensaje: 'Ese horario acaba de ocuparse o ya no está disponible. Elegí otro de los horarios libres.',
            ...(chequeo.alternativas ? { alternativas: chequeo.alternativas } : {}),
          };
        }
      } catch (err) {
        // Chequeo caído: NO bloqueamos al paciente por un error nuestro (la
        // última palabra la tiene Recepción igual). Pero que no sea mudo: este
        // es el único camino por el que una solicitud entra SIN verificar que
        // el horario esté libre, y un `catch {}` vacío lo haría invisible.
        // Queda en el AuditEvent de la ejecución del bot.
        console.error(
          `bw-solicitar-turno: no se pudo verificar el horario ${e.preferenciaInicio} de ${e.terapiaCodigo}; ` +
            `la solicitud pasa sin chequeo. Causa: ${(err as Error).message}`,
        );
      }
    }
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
