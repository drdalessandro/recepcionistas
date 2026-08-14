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
import { COD_CONSENTIMIENTO, COD_LOINC_CONSENTIMIENTO, LOINC_CONSENTIMIENTO, SYSTEM } from '../fhir/identifiers.js';
import {
  estadoConsentimiento,
  type EstadoConsentimiento,
  type RegistroConsentimiento,
} from '../lib/consentimiento.js';

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

  let registros: RegistroConsentimiento[] | undefined;
  try {
    // 1) Consent (el registro legal). Se busca por PACIENTE, no por category:
    //    el portal usa la categoría estándar de HL7 (`v3-ActCode|IDSCL` en el
    //    de laboratorio, LOINC 59284-0 en el general) y pone el código de
    //    Biowellness en `policyRule`. Filtrar por category no traería nada.
    const consents = await medplum.searchResources('Consent', {
      patient: e.pacienteRef,
      _count: 50,
    });
    registros = consents.map((c) => ({
      estado: c.status,
      fechaISO: c.dateTime,
      // El código de BW vive en policyRule; se mira category de fallback por
      // si alguna vez se registra del otro modo.
      codigo:
        c.policyRule?.coding?.find((cod) => cod.system === SYSTEM.consentimiento)?.code ??
        c.category?.flatMap((cat) => cat.coding ?? []).find((cod) => cod.system === SYSTEM.consentimiento)?.code,
    }));

    // 2) Firmas HISTÓRICAS del consentimiento general: hasta que el portal
    //    empiece a crear el Consent, la única huella es el DocumentReference
    //    del documento firmado (LOINC 59284-0). Sin esto, todo el que ya firmó
    //    aparecería como "sin consentimiento" hasta que vuelva a firmar.
    //    Búsqueda ACOTADA a ese código: no se toca el resto de la historia
    //    documental, y de acá solo sale la fecha (nunca el contenido).
    const docs = await medplum
      .searchResources('DocumentReference', {
        subject: e.pacienteRef,
        type: `${LOINC_CONSENTIMIENTO}|${COD_LOINC_CONSENTIMIENTO}`,
        _count: 20,
      })
      .catch(() => []);
    for (const d of docs) {
      // `superseded`/`entered-in-error` no cuentan como firma vigente.
      registros.push({
        estado: d.status === 'current' ? 'active' : 'inactive',
        fechaISO: d.date,
        codigo: COD_CONSENTIMIENTO.atencion,
      });
    }
  } catch {
    // Falla CERRADO: 'no-verificable' ≠ 'no firmó'. La recepcionista ve que no
    // se pudo consultar y decide con el papel en la mano, en vez de creer que
    // el paciente no firmó (o peor, que sí).
    registros = undefined;
  }

  const r = estadoConsentimiento(registros, { codigo: e.codigo });
  return { ok: true, estado: r.estado, ...(r.fechaISO ? { fechaISO: r.fechaISO } : {}) };
}

/** Re-export para que el llamador tipe sin importar de dos lados. */
export { COD_CONSENTIMIENTO };
