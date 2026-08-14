/**
 * Bot · Estado del consentimiento informado (SOLO LECTURA).
 *
 * Le contesta a Recepción una única pregunta: **¿este paciente firmó?** Devuelve
 * `{ estado, fechaISO }` y nada más — nunca el documento, ni quién lo indicó, ni
 * el contenido clínico. Es el mismo contrato de privacidad que el banner de
 * seguridad (CLAUDE.md, principio 3).
 *
 * Por qué un bot y no una lectura directa desde la app: la AccessPolicy de
 * recepción NO incluye `Consent` (ni `DocumentReference`, ni
 * `QuestionnaireResponse`) y no debe incluirlos —abrirlos daría toda la historia
 * documental del paciente—. El bot corre con identidad de proyecto, lee lo que
 * necesita y entrega solo la señal binaria. Recepción ya puede ejecutar bots, así
 * que esto NO requiere tocar su policy.
 *
 * Contrato acordado con Alejandro (MedTech) el 2026-08-14: el **`Consent`** es
 * el hecho legal (quién consintió, a qué, cuándo, vigente o revocado) y el
 * **`DocumentReference`** es la evidencia firmada, enlazados por
 * `sourceReference`. Ver docs/handoff-portal-consentimiento.md.
 *
 * Este bot lee LOS DOS a propósito: mientras el portal todavía no cree el
 * `Consent` del consentimiento general, la firma existente solo deja rastro en
 * el DocumentReference (LOINC 59284-0), y sin leerlo todos los que ya firmaron
 * aparecerían como "sin consentimiento". Cuando el portal cree el Consent, ese
 * gana y el DocumentReference queda de respaldo histórico.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { COD_CONSENTIMIENTO } from '../fhir/identifiers.js';
import { estadoConsentimiento, type EstadoConsentimiento } from '../lib/consentimiento.js';
import { leerRegistrosConsentimiento } from './_shared.js';

export interface EntradaConsentimiento {
  /** "Patient/<id>". */
  pacienteRef: string;
  /** Código de COD_CONSENTIMIENTO. Sin él, cuenta cualquier consentimiento BW. */
  codigo?: string;
}

export interface ResultadoConsentimientoBot {
  ok: boolean;
  estado: EstadoConsentimiento;
  /** Fecha de la firma más reciente (ISO), solo si está firmado. */
  fechaISO?: string;
  mensaje?: string;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaConsentimiento>,
): Promise<ResultadoConsentimientoBot> {
  const e = event.input;
  if (!e?.pacienteRef?.startsWith('Patient/')) {
    return { ok: false, estado: 'no-verificable', mensaje: 'Falta pacienteRef (Patient/<id>).' };
  }

  // La lectura vive en `_shared` y la comparten los bots de reserva (R-20): si
  // divergieran, el badge de Atender diría una cosa y la reserva otra.
  // `undefined` = no se pudo consultar → falla CERRADO ('no-verificable' ≠ 'no
  // firmó'): la recepcionista ve que no se pudo verificar y decide con el papel
  // en la mano, en vez de creer que el paciente no firmó (o peor, que sí).
  const registros = await leerRegistrosConsentimiento(medplum, e.pacienteRef);

  const r = estadoConsentimiento(registros, { codigo: e.codigo });
  return { ok: true, estado: r.estado, ...(r.fechaISO ? { fechaISO: r.fechaISO } : {}) };
}

/** Re-export para que el llamador tipe sin importar de dos lados. */
export { COD_CONSENTIMIENTO };
