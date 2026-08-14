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
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { evaluarCancelacion } from '../lib/reglas-turno.js';
import { devolverSesionDePlan } from './_shared.js';

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
  const estadoPrevio = appt.status;
  appt.status = estado;
  // La excepción de R-14 se registra EN el turno: quién la declaró y cuándo, en
  // el mismo lugar que la decisión que habilita.
  if (estado === 'cancelled' && event.input.fuerzaMayorMedica) {
    appt.extension = [
      ...(appt.extension ?? []).filter(
        (x) => x.url !== EXT.cancelacionFuerzaMayor && x.url !== EXT.cancelacionDeclaradaPor,
      ),
      { url: EXT.cancelacionFuerzaMayor, valueBoolean: true },
      ...(event.input.declaradaPorRef
        ? [{ url: EXT.cancelacionDeclaradaPor, valueString: event.input.declaradaPorRef }]
        : []),
    ];
  }
  const actualizado = await medplum.updateResource(appt);

  const pacienteRef = appt.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;

  // Encounter de la visita.
  if (estado === 'arrived' || estado === 'checked-in') {
    await asegurarEncounter(medplum, appointmentId, pacienteRef);
  } else if (estado === 'fulfilled' || estado === 'cancelled') {
    await cerrarEncounter(medplum, appointmentId, estado === 'fulfilled' ? 'finished' : 'cancelled');
  }

  // Turno cancelado: el saldo pendiente (50% restante) no se debe más.
  // (La seña YA COBRADA no se toca: su devolución es plata y se decide a mano.)
  if (estado === 'cancelled') {
    const saldo = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|saldo-${appointmentId}`);
    if (saldo?.status === 'issued') {
      await medplum.updateResource({ ...saldo, status: 'cancelled' });
    }

    // R-14 · devolver la sesión al plan si canceló a tiempo.
    //
    // La regla estaba escrita y testeada desde siempre, pero NO la llamaba
    // nadie: quien cancelaba con la anticipación que pide la regla perdía igual
    // la sesión que había pagado. El error iba siempre en contra del paciente.
    //
    // Solo si el turno se pagó con un plan (`cobertura-usada`) y solo si venía
    // de un estado vivo: cancelar dos veces no devuelve dos sesiones.
    const coberturaRef = appt.extension?.find((x) => x.url === EXT.coberturaUsada)?.valueString;
    const yaEstabaCancelado = estadoPrevio === 'cancelled' || estadoPrevio === 'noshow' || estadoPrevio === 'entered-in-error';
    if (coberturaRef && !yaEstabaCancelado && appt.start) {
      const r = evaluarCancelacion(new Date(), new Date(appt.start), {
        fuerzaMayorMedica: event.input.fuerzaMayorMedica ?? false,
      });
      if (r.devuelveSaldo) {
        await devolverSesionDePlan(medplum, coberturaRef.split('/')[1] as string);
      }
    }
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

async function cerrarEncounter(
  medplum: MedplumClient,
  appointmentId: string,
  status: 'finished' | 'cancelled',
): Promise<void> {
  const enc = await medplum.searchOne('Encounter', `appointment=Appointment/${appointmentId}`);
  if (!enc) {
    return;
  }
  enc.status = status;
  enc.period = { ...(enc.period ?? {}), end: new Date().toISOString() };
  await medplum.updateResource(enc);
}
