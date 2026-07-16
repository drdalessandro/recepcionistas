/**
 * Bot · Detección de fichas duplicadas.
 *
 * Disparado por Subscription sobre Patient (create y update: el autoregistro crea
 * la ficha solo con email; el DNI/teléfono llegan después con el wizard del portal).
 * Busca coincidencias por email / DNI / teléfono en OTRAS fichas y, si encuentra,
 * abre una Task `posible-duplicado` para que Recepción revise y fusione
 * (bw-fusionar-paciente + vista "Duplicados" — NUNCA fusión automática).
 *
 * Idempotente y silencioso: si ya hay una Task abierta para este paciente, o la
 * ficha ya está enlazada/inactiva, no hace nada. Nunca lanza.
 *
 * Complementa a bw-alta-paciente (que dedupea al CREAR desde Recepción): este bot
 * cubre el camino del autoregistro del portal, donde el server crea el Patient.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { getReferenceString } from '@medplum/core';
import type { Patient, Task } from '@medplum/fhirtypes';
import { COD, SYSTEM } from '../fhir/identifiers.js';

function normEmail(v?: string): string | undefined {
  const e = v?.trim().toLowerCase();
  return e || undefined;
}
function soloDigitos(v?: string): string {
  return (v ?? '').replace(/\D/g, '');
}

export async function handler(medplum: MedplumClient, event: BotEvent<Patient>): Promise<unknown> {
  try {
    const p = event.input;
    if (!p?.id || p.active === false || p.link?.length) {
      return { ok: true, motivo: 'ficha inactiva o ya enlazada' };
    }

    // Idempotencia: una sola tarea abierta por ficha.
    const yaAbierta = await medplum.searchOne(
      'Task',
      `code=${COD.posibleDuplicado}&status=requested&patient=${getReferenceString(p)}`,
    );
    if (yaAbierta) {
      return { ok: true, motivo: 'ya hay tarea abierta' };
    }

    const emails = (p.telecom ?? []).filter((t) => t.system === 'email').map((t) => normEmail(t.value));
    const dnis = (p.identifier ?? []).map((i) => soloDigitos(i.value)).filter((v) => v.length >= 6);
    const telefonos = (p.telecom ?? []).filter((t) => t.system === 'phone' || t.system === 'sms');

    const candidatos = new Map<string, { paciente: Patient; llaves: string[] }>();
    const agregar = (otro: Patient, llave: string): void => {
      if (!otro.id || otro.id === p.id || otro.active === false || otro.link?.length) {
        return;
      }
      const c = candidatos.get(otro.id) ?? { paciente: otro, llaves: [] };
      if (!c.llaves.includes(llave)) {
        c.llaves.push(llave);
      }
      candidatos.set(otro.id, c);
    };

    for (const email of emails) {
      if (!email) {
        continue;
      }
      for (const otro of await medplum.searchResources('Patient', `email=${encodeURIComponent(email)}&_count=10`)) {
        agregar(otro, `email ${email}`);
      }
    }
    for (const dni of dnis) {
      for (const otro of await medplum.searchResources('Patient', `identifier=${encodeURIComponent(dni)}&_count=10`)) {
        agregar(otro, `DNI ${dni}`);
      }
    }
    for (const t of telefonos) {
      if (!t.value) {
        continue;
      }
      for (const otro of await medplum.searchResources('Patient', `phone=${encodeURIComponent(t.value)}&_count=10`)) {
        agregar(otro, `teléfono ${t.value}`);
      }
    }

    if (candidatos.size === 0) {
      return { ok: true, duplicados: 0 };
    }

    const detalle = [...candidatos.values()]
      .map((c) => {
        const n = c.paciente.name?.[0];
        const nombre = [n?.given?.join(' '), n?.family].filter(Boolean).join(' ') || c.paciente.id;
        return `${nombre} (Patient/${c.paciente.id}) — coincide: ${c.llaves.join(', ')}`;
      })
      .join(' · ');

    const task = await medplum.createResource<Task>({
      resourceType: 'Task',
      status: 'requested',
      intent: 'order',
      priority: 'urgent',
      code: { coding: [{ system: SYSTEM.taskTipo, code: COD.posibleDuplicado }], text: 'Posible ficha duplicada' },
      for: { reference: getReferenceString(p) },
      authoredOn: new Date().toISOString(),
      description: `Posible duplicado al registrarse: ${detalle}`,
      input: [...candidatos.values()].map((c) => ({
        type: { text: 'candidato' },
        valueReference: { reference: `Patient/${c.paciente.id}`, display: c.llaves.join(', ') },
      })),
    });

    return { ok: true, duplicados: candidatos.size, taskId: task.id };
  } catch (err) {
    // Bot de fondo: jamás rompe el alta/edición de la ficha que lo disparó.
    return { ok: false, mensaje: err instanceof Error ? err.message : 'dedup falló' };
  }
}
