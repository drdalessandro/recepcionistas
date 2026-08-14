/**
 * Bot · Estado de seguridad del paciente (SOLO LECTURA).
 *
 * Le contesta a Recepción la pregunta del banner: **¿este paciente puede recibir
 * atención?** Devuelve `{ estado, color, puedeAvanzar }` y nada más — nunca qué
 * contraindicación tiene ni qué contestó en el cuestionario. Mismo contrato de
 * privacidad que el banner de siempre (CLAUDE.md, principio 3) y que
 * `bw-estado-consentimiento`.
 *
 * Por qué un bot y no una lectura directa desde la app: para distinguir "apto" de
 * "nunca contestó nada" hay que mirar el **cuestionario de ingreso**, y la
 * AccessPolicy de recepción NO incluye `QuestionnaireResponse` — ni debe
 * incluirlo, porque eso le abriría la historia clínica entera. El bot corre con
 * identidad de proyecto, lee lo que necesita y entrega solo la señal.
 *
 * El problema que vino a arreglar (2026-08-14): el banner derivaba su color SOLO
 * de los `Flag` activos, así que un paciente recién creado en el mostrador —sin
 * screening, sin nada— salía verde y "apto para atención". Ausencia de datos no
 * es conocimiento. Ahora eso es `sin-screening`, y un error de lectura es
 * `no-verificable`: los dos **fallan cerrado**.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { INTAKE_QUESTIONNAIRE_URL, SYSTEM } from '../fhir/identifiers.js';
import {
  estadoSeguridad,
  type ColorSeguridad,
  type EstadoSeguridad,
} from '../lib/seguridad.js';

export interface EntradaSeguridadBot {
  /** "Patient/<id>". */
  pacienteRef: string;
}

export interface ResultadoSeguridadBot {
  ok: boolean;
  estado: EstadoSeguridad;
  color: ColorSeguridad;
  /** Solo 'apto' habilita seguir sin intervención. */
  puedeAvanzar: boolean;
  mensaje?: string;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaSeguridadBot>,
): Promise<ResultadoSeguridadBot> {
  const e = event.input;
  if (!e?.pacienteRef?.startsWith('Patient/')) {
    const r = estadoSeguridad({});
    return { ok: false, ...r, mensaje: 'Falta pacienteRef (Patient/<id>).' };
  }

  // 1) Contraindicaciones activas. `undefined` si la lectura falla: eso es
  //    'no-verificable', NUNCA "no tiene ninguna".
  let contraindicacionesActivas: string[] | undefined;
  try {
    const flags = await medplum.searchResources('Flag', {
      subject: e.pacienteRef,
      status: 'active',
      _count: 50,
    });
    contraindicacionesActivas = flags
      // El bloqueo administrativo por pago (R-11) NO es una contraindicación
      // clínica: tiene su propio aviso en Atender y no debe pintar el banner de
      // seguridad de rojo.
      .filter((f) => !f.code?.coding?.some((c) => c.system === SYSTEM.bloqueo))
      .flatMap((f) => (f.code?.coding ?? []).map((c) => c.code))
      .filter((c): c is string => Boolean(c));
  } catch {
    contraindicacionesActivas = undefined;
  }

  // 2) ¿Completó el cuestionario de ingreso? Es el que incluye el screening de
  //    contraindicaciones HBOT/IHHT. Solo se mira que EXISTA una respuesta
  //    completa: de acá no sale ni una sola respuesta suya.
  let screeningCompleto: boolean | undefined;
  try {
    const respuestas = await medplum.searchResources('QuestionnaireResponse', {
      subject: e.pacienteRef,
      questionnaire: INTAKE_QUESTIONNAIRE_URL,
      status: 'completed',
      _count: 1,
    });
    screeningCompleto = respuestas.length > 0;
  } catch {
    screeningCompleto = undefined;
  }

  return { ok: true, ...estadoSeguridad({ contraindicacionesActivas, screeningCompleto }) };
}
