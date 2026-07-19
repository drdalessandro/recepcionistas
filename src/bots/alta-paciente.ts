/**
 * Bot · Alta de paciente (registrar cliente).
 *
 * Crea (o actualiza, sin duplicar) el recurso `Patient` con la demografía mínima:
 * nombre, DNI, teléfono y email. NO da acceso al portal — eso es un paso aparte
 * (`bw-invitar-paciente`). Deduplica por DNI y, si no hay, por email/teléfono.
 *
 * No requiere admin del proyecto: la recepción ya tiene permiso de escritura sobre
 * `Patient` por su AccessPolicy.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { ContactPoint, Patient } from '@medplum/fhirtypes';
import { EXT, SYSTEM, esOrigenLead } from '../fhir/identifiers.js';
import { partirNombre, validarEmail } from '../lib/onboarding.js';

export interface EntradaAltaPaciente {
  /** Nombre completo (se parte en nombre + apellido). Alternativa a firstName/lastName. */
  nombre?: string;
  firstName?: string;
  lastName?: string;
  dni?: string;
  email?: string;
  telefono?: string;
  /** Etiqueta comercial (p. ej. 'PUBLICO' | 'FM'). */
  tipoCliente?: string;
  /** Canal por el que llegó (lista cerrada ORIGENES_LEAD; otro valor → 'otro'). */
  origenLead?: string;
}

export interface ResultadoAltaPaciente {
  ok: boolean;
  mensaje?: string;
  patientId?: string;
  /** true si se creó; false si se actualizó uno existente. */
  creado?: boolean;
}

function extensionAlta(tipoCliente?: string, origen?: string): Patient['extension'] {
  const ext = [
    ...(tipoCliente ? [{ url: EXT.tipoCliente, valueCode: tipoCliente }] : []),
    ...(origen ? [{ url: EXT.origenLead, valueString: origen }] : []),
  ];
  return ext.length ? ext : undefined;
}

function telecom(telefono?: string, email?: string): ContactPoint[] {
  const t: ContactPoint[] = [];
  if (telefono) {
    t.push({ system: 'phone', value: telefono.trim(), use: 'mobile' });
  }
  if (email) {
    t.push({ system: 'email', value: email.trim() });
  }
  return t;
}

/** Busca un paciente existente por DNI, luego email, luego teléfono. */
async function buscarExistente(
  medplum: MedplumClient,
  e: EntradaAltaPaciente,
): Promise<Patient | undefined> {
  if (e.dni) {
    const p = await medplum.searchOne('Patient', `identifier=${SYSTEM.dni}|${e.dni.trim()}`);
    if (p) {
      return p;
    }
  }
  if (e.email) {
    const p = await medplum.searchOne('Patient', `email=${encodeURIComponent(e.email.trim())}`);
    if (p) {
      return p;
    }
  }
  if (e.telefono) {
    const p = await medplum.searchOne('Patient', `phone=${encodeURIComponent(e.telefono.trim())}`);
    if (p) {
      return p;
    }
  }
  return undefined;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaAltaPaciente>,
): Promise<ResultadoAltaPaciente> {
  const e = event.input;
  try {
    const { firstName, lastName } =
      e.firstName || e.lastName
        ? { firstName: e.firstName ?? '', lastName: e.lastName ?? '' }
        : partirNombre(e.nombre ?? '');

    if (!firstName && !lastName) {
      return { ok: false, mensaje: 'Falta el nombre del paciente.' };
    }
    if (e.email && !validarEmail(e.email)) {
      return { ok: false, mensaje: 'El email no es válido.' };
    }

    const nombreText = [firstName, lastName].filter(Boolean).join(' ');
    const existente = await buscarExistente(medplum, e);

    // Código canónico del canal (lista cerrada); un valor desconocido cae a 'otro'.
    const origen = e.origenLead ? (esOrigenLead(e.origenLead) ? e.origenLead : 'otro') : undefined;

    if (existente) {
      // Merge no destructivo: completa datos que falten, no pisa identifiers previos.
      const extension = [...(existente.extension ?? [])].filter((x) => x.url !== EXT.tipoCliente);
      if (e.tipoCliente) {
        extension.push({ url: EXT.tipoCliente, valueCode: e.tipoCliente });
      }
      // Atribución al PRIMER canal: si la ficha ya tiene origen, no se pisa.
      if (origen && !extension.some((x) => x.url === EXT.origenLead)) {
        extension.push({ url: EXT.origenLead, valueString: origen });
      }
      const identifier = [...(existente.identifier ?? [])];
      if (e.dni && !identifier.some((i) => i.system === SYSTEM.dni)) {
        identifier.push({ system: SYSTEM.dni, value: e.dni.trim() });
      }
      const nuevosTelecom = telecom(e.telefono, e.email).filter(
        (n) => !(existente.telecom ?? []).some((t) => t.system === n.system && t.value === n.value),
      );
      const actualizado = await medplum.updateResource<Patient>({
        ...existente,
        name: existente.name?.length ? existente.name : [{ text: nombreText, given: [firstName], family: lastName }],
        identifier,
        telecom: [...(existente.telecom ?? []), ...nuevosTelecom],
        extension: extension.length ? extension : undefined,
      });
      return { ok: true, patientId: actualizado.id, creado: false };
    }

    const creado = await medplum.createResource<Patient>({
      resourceType: 'Patient',
      active: true,
      name: [{ text: nombreText, given: [firstName], family: lastName }],
      identifier: e.dni ? [{ system: SYSTEM.dni, value: e.dni.trim() }] : undefined,
      telecom: telecom(e.telefono, e.email),
      extension: extensionAlta(e.tipoCliente, origen),
    });
    return { ok: true, patientId: creado.id, creado: true };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : 'No se pudo dar de alta el paciente.' };
  }
}
