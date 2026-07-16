/**
 * Bot · Detección de fichas duplicadas.
 *
 * Disparado por Subscription sobre Patient (create y update: el autoregistro crea
 * la ficha solo con email; el DNI/teléfono llegan después con el wizard del portal).
 * Busca coincidencias por email / DNI / teléfono en OTRAS fichas y, si encuentra,
 * abre una Task `posible-duplicado` para que Recepción revise y fusione
 * (bw-fusionar-paciente + vista "Duplicados" — NUNCA fusión automática).
 *
 * Idempotente y silencioso: si ya hay una Task abierta para este paciente no crea
 * otra, y los candidatos que Recepción YA revisó (tarea descartada o completada)
 * no se reabren en cada update de la ficha — solo dispara ante candidatos nuevos.
 * Si la ficha está enlazada/inactiva, no hace nada. Nunca lanza.
 *
 * Complementa a bw-alta-paciente (que dedupea al CREAR desde Recepción): este bot
 * cubre el camino del autoregistro del portal, donde el server crea el Patient.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { getReferenceString } from '@medplum/core';
import type { Patient, Task } from '@medplum/fhirtypes';
import { COD, SYSTEM } from '../fhir/identifiers.js';
import { candidatosNuevos, normalizarEmail, variantesDni } from '../lib/dedup.js';

export async function handler(medplum: MedplumClient, event: BotEvent<Patient>): Promise<unknown> {
  try {
    const p = event.input;
    if (!p?.id || p.active === false || p.link?.length) {
      return { ok: true, motivo: 'ficha inactiva o ya enlazada' };
    }

    // Idempotencia: (a) una sola tarea abierta por ficha; (b) los candidatos ya
    // revisados en tareas anteriores (canceladas/completadas) no se reabren.
    const previas = await medplum.searchResources(
      'Task',
      `code=${COD.posibleDuplicado}&patient=${getReferenceString(p)}&_count=50`,
    );
    if (previas.some((t) => t.status === 'requested')) {
      return { ok: true, motivo: 'ya hay tarea abierta' };
    }
    const yaRevisados = new Set<string>(
      previas.flatMap((t) =>
        (t.input ?? [])
          .map((i) => i.valueReference?.reference)
          .filter((r): r is string => Boolean(r?.startsWith('Patient/')))
          .map((r) => r.slice('Patient/'.length)),
      ),
    );

    const emails = (p.telecom ?? []).filter((t) => t.system === 'email').map((t) => normalizarEmail(t.value));
    const documentos = (p.identifier ?? []).flatMap((i) => variantesDni(i.value));
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
    // La búsqueda token es EXACTA: se consultan las variantes del documento
    // (crudo / solo dígitos / con puntos) para cubrir cómo se cargó en cada lado.
    for (const doc of [...new Set(documentos)]) {
      for (const otro of await medplum.searchResources('Patient', `identifier=${encodeURIComponent(doc)}&_count=10`)) {
        agregar(otro, `DNI ${doc}`);
      }
    }
    // `telecom=` matchea cualquier system (phone y sms; acá los emails ya se
    // buscaron aparte y un valor de teléfono no colisiona con un email).
    for (const t of telefonos) {
      if (!t.value) {
        continue;
      }
      for (const otro of await medplum.searchResources('Patient', `telecom=${encodeURIComponent(t.value)}&_count=10`)) {
        agregar(otro, `teléfono ${t.value}`);
      }
    }

    const nuevos = candidatosNuevos(
      [...candidatos.entries()].map(([id, c]) => ({ id, ...c })),
      yaRevisados,
    );
    if (nuevos.length === 0) {
      return { ok: true, duplicados: 0, motivo: candidatos.size > 0 ? 'candidatos ya revisados' : undefined };
    }

    const detalle = nuevos
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
      input: nuevos.map((c) => ({
        type: { text: 'candidato' },
        valueReference: { reference: `Patient/${c.id}`, display: c.llaves.join(', ') },
      })),
    });

    return { ok: true, duplicados: nuevos.length, taskId: task.id };
  } catch (err) {
    // Bot de fondo: jamás rompe el alta/edición de la ficha que lo disparó.
    return { ok: false, mensaje: err instanceof Error ? err.message : 'dedup falló' };
  }
}
