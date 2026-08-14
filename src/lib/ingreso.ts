/**
 * Ingreso presencial (kiosco del mostrador) — lógica pura.
 *
 * Decide qué firma es válida y qué consentimientos se dan de baja al refirmar.
 * Vive separado del bot para poder testearlo sin FHIR: es lo que decide si un
 * documento legal queda registrado o no.
 */
import type { Consent } from '@medplum/fhirtypes';
import { SYSTEM } from '../fhir/identifiers.js';
import { COD_CONSENTIMIENTO } from '../fhir/identifiers.js';

export interface EntradaFirma {
  pacienteRef?: string;
  nombreFirma?: string;
  dni?: string;
}

export type ResultadoFirma = { ok: true } | { ok: false; error: string };

/** Largo mínimo del nombre firmado: dos letras no son una firma. */
const MIN_NOMBRE = 3;
/** DNI argentino: 7 u 8 dígitos (se aceptan puntos y espacios al tipear). */
const DNI_RE = /^\d{7,8}$/;

/**
 * ¿La firma alcanza para registrar el consentimiento?
 *
 * La firma electrónica es el nombre tipeado por el paciente (misma evidencia que
 * el portal). Se valida que haya **algo verificable**: sin nombre y sin DNI el
 * documento no identifica a nadie y no sirve como prueba. No se valida que el
 * nombre coincida con la ficha a propósito — puede firmar con su nombre legal
 * completo aunque la ficha diga "Juan", y el documento guarda lo que él escribió.
 */
export function validarFirmaPresencial(e: EntradaFirma | undefined): ResultadoFirma {
  if (!e?.pacienteRef?.startsWith('Patient/')) {
    return { ok: false, error: 'Falta pacienteRef (Patient/<id>).' };
  }
  const nombre = e.nombreFirma?.trim() ?? '';
  if (nombre.length < MIN_NOMBRE) {
    return { ok: false, error: 'Falta el nombre completo con el que firma el paciente.' };
  }
  const dni = (e.dni ?? '').replace(/[.\s]/g, '');
  if (!DNI_RE.test(dni)) {
    return { ok: false, error: 'El DNI tiene que ser de 7 u 8 dígitos.' };
  }
  return { ok: true };
}

/**
 * Cuáles de los consentimientos vigentes se dan de baja al firmar de nuevo: solo
 * los de ATENCIÓN, y nunca el recién creado. **No toca los de laboratorio**
 * (`procesamiento-datos-salud`): son otra autorización, con su propio policyRule.
 *
 * Es la misma regla que aplica el portal; acá vive para el camino del mostrador.
 */
export function consentimientosARevocar(previos: readonly Consent[], nuevoId: string | undefined): Consent[] {
  return previos.filter(
    (c) =>
      c.status === 'active' &&
      c.id !== nuevoId &&
      c.policyRule?.coding?.some(
        (cod) => cod.system === SYSTEM.consentimiento && cod.code === COD_CONSENTIMIENTO.atencion,
      ),
  );
}
