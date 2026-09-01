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
import { SYSTEM } from '../fhir/identifiers.js';
import {
  estadoSeguridad,
  type ColorSeguridad,
  type EstadoSeguridad,
} from '../lib/seguridad.js';
import { leerScreening } from './_shared.js';

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

  // 2) El cuestionario de ingreso, LEÍDO Y EVALUADO (no solo "¿existe?"): una
  //    respuesta afirmativa a una pregunta de riesgo pinta el banner de rojo
  //    aunque nadie la haya cargado como Flag. La lectura la comparte con los
  //    bots de reserva (R-20/R-02) para que el banner y el bloqueo no diverjan.
  const screening = await leerScreening(medplum, e.pacienteRef);

  return {
    ok: true,
    ...estadoSeguridad({
      contraindicacionesActivas,
      screeningCompleto: screening?.completo,
      riesgosScreening: screening === undefined ? undefined : screening.riesgosDeclarados.length,
    }),
  };
}
