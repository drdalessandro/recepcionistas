/**
 * Bot · Cancelar un turno desde el portal del paciente.
 *
 * Es la puerta del PACIENTE a la misma cancelación que hace Recepción: la
 * lógica (R-14, saldo, lista de espera, salas) vive una sola vez en
 * `cancelarTurnoYLiberar`. Acá solo se agrega lo que el mostrador no necesita:
 * verificar que el turno sea SUYO, que todavía se pueda cancelar, y explicarle
 * en castellano qué pasó con su sesión.
 *
 * Contrato con el portal (`docs/handoff-portal-turnos.md`): la misma forma que
 * `bw-solicitar-turno`, `{ ok, mensaje?, motivo?, alternativas? }`.
 *
 * El mensaje lo escribe el BOT, no el portal: la regla la conoce el bot, así
 * que también la explicación. Si el portal anticipa un resultado distinto (su
 * espejo `consumeLaSesion`), manda lo que dice acá.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { CANCELACION } from '../config/reglas.js';
import { cancelarTurnoYLiberar, crearAlertaRecepcion, esTurnoDelPaciente, motivoNoAccionable } from './_shared.js';

export interface EntradaCancelarTurno {
  pacienteRef: string;
  appointmentId: string;
  /**
   * Urgencia médica: el paciente la DECLARA, no la decide. Se le cree (el sitio
   * lo publica así) y la sesión vuelve al plan aunque cancele sobre la hora —
   * pero queda registrada con su nombre Y le avisa a Recepción. Una excepción
   * que no deja rastro es la que después nadie puede explicar ni auditar.
   */
  urgenciaMedica?: boolean;
  /** Texto libre del paciente. Va al `cancelationReason` del Appointment. */
  motivo?: string;
}

export interface ResultadoCancelarTurno {
  ok: boolean;
  mensaje?: string;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaCancelarTurno>,
): Promise<ResultadoCancelarTurno> {
  const e = event.input;
  if (!e.pacienteRef || !e.appointmentId) {
    return { ok: false, mensaje: 'Faltan datos para cancelar el turno.' };
  }

  const appt = await medplum.readResource('Appointment', e.appointmentId).catch(() => undefined);
  // Mismo mensaje para "no existe" y "no es tuyo": responder distinto le
  // confirmaría a cualquiera si un id de turno existe o no.
  if (!appt || !esTurnoDelPaciente(appt, e.pacienteRef)) {
    return { ok: false, mensaje: 'No encontramos ese turno en tu cuenta.' };
  }

  const noAccionable = motivoNoAccionable(appt);
  if (noAccionable) {
    return { ok: false, mensaje: noAccionable };
  }

  const r = await cancelarTurnoYLiberar(medplum, appt, {
    ...(e.urgenciaMedica ? { fuerzaMayorMedica: true, declaradaPorRef: e.pacienteRef } : {}),
    ...(e.motivo ? { motivo: e.motivo } : {}),
  });

  // La urgencia declarada por el propio paciente saltea R-14: que no pase
  // desapercibida. Recepción decide si corresponde hablar con él.
  if (e.urgenciaMedica) {
    await crearAlertaRecepcion(medplum, {
      titulo: 'Cancelación por urgencia médica declarada desde el portal',
      detalle:
        `El paciente canceló "${appt.description ?? 'su turno'}" declarando urgencia médica` +
        `${r.horasAnticipacion !== undefined ? ` (${Math.max(0, Math.round(r.horasAnticipacion))} h de anticipación)` : ''}` +
        `${r.sesionDevuelta ? ' y la sesión volvió a su plan' : ''}.` +
        `${e.motivo ? ` Motivo: "${e.motivo.slice(0, 200)}".` : ''}`,
      pacienteRef: e.pacienteRef,
      focusRef: `Appointment/${appt.id}`,
      clave: `cancelacion-urgencia-${appt.id}`,
    }).catch(() => undefined);
  }

  return { ok: true, mensaje: mensajeResultado(r.sesionDevuelta, r.horasAnticipacion, Boolean(e.urgenciaMedica)) };
}

/** Qué se le dice al paciente. Explica la regla, no solo el resultado. */
function mensajeResultado(sesionDevuelta: boolean, horas: number | undefined, urgencia: boolean): string {
  const base = 'Cancelamos tu turno.';
  if (sesionDevuelta) {
    return urgencia
      ? `${base} Como declaraste una urgencia médica, la sesión vuelve a tu plan.`
      : `${base} Como avisaste con más de ${CANCELACION.minHoras} h, la sesión vuelve a tu plan.`;
  }
  if (horas !== undefined && horas < CANCELACION.minHoras) {
    return `${base} Faltaban menos de ${CANCELACION.minHoras} h, así que esta sesión se consume.`;
  }
  return base;
}
