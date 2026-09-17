/**
 * Bot · Token de acceso a la sala de teleconsulta.
 *
 * **Es la puerta.** Todo lo que separa una consulta médica de cualquiera de
 * internet pasa por acá: sin un token firmado por este bot no se entra a
 * `meet.biowellness.ar` (Prosody está en `authentication = "token"`, ver
 * docs/teleconsulta-fase0.md §4).
 *
 * Por eso el bot no decide nada por su cuenta: las reglas —ventana de acceso,
 * forma de los claims, quién es moderador— viven en `src/lib/teleconsulta.ts`,
 * que es puro y está testeado en sus bordes. Acá queda lo que necesita el
 * servidor: leer el turno, verificar que quien pide sea parte de él, y firmar.
 *
 * La firma usa `node:crypto`, igual que `bw-federador`: en un bot no molesta,
 * pero **no puede entrar al bundle del navegador**, y por eso el armado de los
 * claims está del otro lado (en `lib`) y la firma de este.
 *
 * ⚠️ El `pacienteRef` / `practitionerRef` viene del input, así que —igual que en
 * `bw-cancelar-turno`— lo que protege de verdad es la verificación contra el
 * `participant` del turno, no el input. Conviene crear el Bot con `runAsUser`
 * en Medplum para que además el llamador no se pueda falsificar.
 *
 * Secrets: `JITSI_BASE_URL`, `JITSI_APP_ID`, `JITSI_JWT_SECRET`.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment } from '@medplum/fhirtypes';
import { createHmac } from 'node:crypto';
import { EXT } from '../fhir/identifiers.js';
import { claimsToken, dominioJitsi, esNombreSala, motivoSinAcceso, type RolSala } from '../lib/teleconsulta.js';

export interface EntradaToken {
  appointmentId: string;
  /** Con qué rol pide entrar. Determina si sale moderador o no. */
  rol: RolSala;
  /** "Patient/<id>" — obligatorio cuando `rol` es `paciente`. */
  pacienteRef?: string;
  /** "Practitioner/<id>" — obligatorio cuando `rol` es `profesional`. */
  practitionerRef?: string;
}

export interface ResultadoToken {
  ok: boolean;
  /** Dominio del servidor de video, para armar la URL o el iframe. */
  dominio?: string;
  sala?: string;
  /** JWT firmado, de vida corta. No se guarda en ningún recurso. */
  jwt?: string;
  /** ISO en que el token deja de servir (= fin de la ventana del turno). */
  venceISO?: string;
  mensaje?: string;
}

/** Nombre visible en la sala. El ELEGIDO de la ficha; nunca documento ni email. */
async function nombreVisible(medplum: MedplumClient, ref: string): Promise<string> {
  const [tipo, id] = ref.split('/');
  if (!tipo || !id) {
    return 'Participante';
  }
  try {
    const r = await medplum.readResource(tipo as 'Patient' | 'Practitioner', id);
    const n = r.name?.[0];
    const texto = n?.text ?? [n?.given?.join(' '), n?.family].filter(Boolean).join(' ');
    return texto?.trim() || 'Participante';
  } catch {
    // Sin nombre se entra igual: quedarse afuera de la consulta por no poder
    // leer la ficha sería el peor de los dos errores posibles.
    return 'Participante';
  }
}

/** La sala del turno, si es una teleconsulta bien formada. */
export function salaDelTurno(appt: Appointment): string | undefined {
  const sala = appt.extension?.find((x) => x.url === EXT.teleconsultaSala)?.valueString;
  return esNombreSala(sala) ? sala : undefined;
}

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaToken>): Promise<ResultadoToken> {
  const e = event.input;
  const quien = e?.rol === 'profesional' ? e.practitionerRef : e?.pacienteRef;
  if (!e?.appointmentId || !e.rol || !quien) {
    return { ok: false, mensaje: 'Faltan datos para entrar a la videollamada.' };
  }

  // `JITSI_BASE_URL` tiene nombre de URL y es el HOST (`meet.biowellness.ar`):
  // va al claim `sub`, que Prosody compara contra el VirtualHost. Se normaliza
  // en vez de exigir que quien carga el secret se acuerde (ver `dominioJitsi`).
  const dominio = dominioJitsi(event.secrets['JITSI_BASE_URL']?.valueString ?? '');
  const appId = event.secrets['JITSI_APP_ID']?.valueString;
  const secret = event.secrets['JITSI_JWT_SECRET']?.valueString;
  if (!dominio || !appId || !secret) {
    // Falla cerrado y lo dice: sin los tres secrets no se emite nada. El aviso
    // va al AuditEvent de la ejecución, que es el único lugar donde mirar.
    console.error('bw-teleconsulta-token: faltan JITSI_BASE_URL / JITSI_APP_ID / JITSI_JWT_SECRET.');
    return { ok: false, mensaje: 'La videollamada no está configurada. Avisá a Recepción.' };
  }

  const appt = await medplum.readResource('Appointment', e.appointmentId).catch(() => undefined);
  // Mismo mensaje para "no existe" y "no es tuyo": contestar distinto
  // confirmaría si un id de turno existe (misma defensa que bw-cancelar-turno).
  const esParticipante = (appt?.participant ?? []).some((p) => p.actor?.reference === quien);
  if (!appt || !esParticipante) {
    return { ok: false, mensaje: 'No encontramos esa videollamada en tu cuenta.' };
  }

  const sala = salaDelTurno(appt);
  if (!sala) {
    return { ok: false, mensaje: 'Ese turno no es una videollamada.' };
  }

  // `booked` = confirmado. Con cobro total anticipado eso significa pagado: una
  // tentativa impaga no entra a la consulta.
  if (appt.status !== 'booked' && appt.status !== 'arrived' && appt.status !== 'checked-in') {
    return { ok: false, mensaje: 'Esta videollamada no está confirmada. Escribinos y la resolvemos.' };
  }
  if (!appt.start || !appt.end) {
    return { ok: false, mensaje: 'El turno no tiene horario. Avisá a Recepción.' };
  }

  const inicio = new Date(appt.start);
  const fin = new Date(appt.end);
  const fueraDeVentana = motivoSinAcceso(inicio, fin, new Date());
  if (fueraDeVentana) {
    return { ok: false, mensaje: fueraDeVentana };
  }

  const claims = claimsToken({
    appId,
    dominio,
    sala,
    nombre: await nombreVisible(medplum, quien),
    rol: e.rol,
    inicio,
    fin,
  });

  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const cabecera = b64({ alg: 'HS256', typ: 'JWT' });
  const cuerpo = b64(claims);
  const firma = createHmac('sha256', secret).update(`${cabecera}.${cuerpo}`).digest('base64url');

  return {
    ok: true,
    dominio,
    sala,
    jwt: `${cabecera}.${cuerpo}.${firma}`,
    venceISO: new Date(claims.exp * 1000).toISOString(),
  };
}
