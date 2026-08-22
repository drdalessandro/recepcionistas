/**
 * Bot · Estado del turno (check-in / check-out).
 *
 * Cambia el estado de un Appointment (llegó / en curso / completado / cancelado),
 * gestiona el Encounter de la visita (lo abre al llegar, lo cierra al completar) y,
 * al completar o cancelar, libera la sala (pone el Slot en 'free') para que pueda
 * reutilizarse (Documento de Requerimientos §6.7: "Check-out libera la sala").
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, Encounter } from '@medplum/fhirtypes';
import { cancelarTurnoYLiberar, cerrarEncounterDeTurno } from './_shared.js';

export type EstadoTurno = 'arrived' | 'checked-in' | 'fulfilled' | 'cancelled';

export interface EntradaEstado {
  appointmentId: string;
  estado: EstadoTurno;
  /**
   * R-14 · cancelación tardía perdonada por fuerza mayor médica: devuelve la
   * sesión aunque falten menos de 24 h. Queda registrada en el turno junto con
   * quién la declaró — la excepción sin rastro es la que después nadie explica.
   */
  fuerzaMayorMedica?: boolean;
  /** Quién declara la fuerza mayor (referencia; para la auditoría). */
  declaradaPorRef?: string;
}

/** Estados en los que la sala se libera (el turno terminó). */
export const ESTADOS_QUE_LIBERAN: ReadonlySet<EstadoTurno> = new Set(['fulfilled', 'cancelled']);

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaEstado>): Promise<Appointment> {
  const { appointmentId, estado } = event.input;

  const appt = await medplum.readResource('Appointment', appointmentId);
  const pacienteRef = appt.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;

  // Cancelar es un flujo entero (R-14, saldo, lista de espera, salas) y entra
  // también por el portal: vive UNA sola vez en `cancelarTurnoYLiberar`.
  if (estado === 'cancelled') {
    const r = await cancelarTurnoYLiberar(medplum, appt, {
      ...(event.input.fuerzaMayorMedica !== undefined ? { fuerzaMayorMedica: event.input.fuerzaMayorMedica } : {}),
      ...(event.input.declaradaPorRef ? { declaradaPorRef: event.input.declaradaPorRef } : {}),
    });
    return r.appointment;
  }

  const actualizado = await medplum.updateResource<Appointment>({ ...appt, status: estado });

  // Encounter de la visita.
  if (estado === 'arrived' || estado === 'checked-in') {
    await asegurarEncounter(medplum, appointmentId, pacienteRef);
  } else if (estado === 'fulfilled') {
    await cerrarEncounterDeTurno(medplum, appointmentId, 'finished');
  }

  // Liberar la(s) sala(s) al terminar.
  if (ESTADOS_QUE_LIBERAN.has(estado)) {
    for (const s of appt.slot ?? []) {
      const id = s.reference?.split('/')[1];
      if (!id) {
        continue;
      }
      const slot = await medplum.readResource('Slot', id);
      slot.status = 'free';
      await medplum.updateResource(slot);
    }
  }

  return actualizado;
}

async function asegurarEncounter(
  medplum: MedplumClient,
  appointmentId: string,
  pacienteRef: string | undefined,
): Promise<void> {
  const existente = await medplum.searchOne('Encounter', `appointment=Appointment/${appointmentId}`);
  if (existente) {
    return;
  }
  const encounter: Encounter = {
    resourceType: 'Encounter',
    status: 'in-progress',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    appointment: [{ reference: `Appointment/${appointmentId}` }],
    period: { start: new Date().toISOString() },
    ...(pacienteRef ? { subject: { reference: pacienteRef } } : {}),
  };
  await medplum.createResource(encounter);
}
