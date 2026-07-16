/**
 * Bot · Fusionar fichas duplicadas (requiere decisión humana previa).
 *
 * Input: { duplicadoId, canonicoId, taskId? }
 *  1. Valida estados: la canónica debe estar activa y sin link; el duplicado no
 *     puede estar ya fusionado. (Protege contra tareas viejas/espejo.)
 *  2. PRIMERO marca el duplicado: active=false + link[replaced-by → canónico].
 *     El orden importa: los updates de Patient re-disparan bw-dedup-paciente
 *     (Subscription); con el duplicado ya inactivo/enlazado, el update posterior
 *     de la canónica no puede generar una tarea espuria invertida.
 *  3. Copia a la ficha canónica los telecom/identifier que el duplicado tenga y
 *     la canónica no (NO pisa los existentes).
 *  4. Reapunta el LOGIN: la ProjectMembership cuyo profile es el duplicado pasa a
 *     apuntar a la ficha canónica (el paciente sigue entrando con su usuario y ve
 *     su historia real). Requiere que el bot sea admin del proyecto.
 *  5. Reasigna al canónico lo creado en el interín, PAGINANDO hasta agotar:
 *     QuestionnaireResponse / Observation / DocumentReference / Communication
 *     (subject y, en Communication, también recipient) y las Task del paciente
 *     (solicitudes de turno: for/requester) — salvo las de dedup, que son el
 *     registro auditable de la fusión.
 *  6. Cierra la Task de revisión (si vino taskId) y CANCELA las demás tareas
 *     `posible-duplicado` abiertas de cualquiera de las dos fichas (espejos).
 *
 * La fusión no borra nada: el duplicado queda inactivo y enlazado (auditable).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication, Patient, ProjectMembership, Task } from '@medplum/fhirtypes';
import { COD } from '../fhir/identifiers.js';

export interface EntradaFusion {
  duplicadoId: string;
  canonicoId: string;
  taskId?: string;
}

const TIPOS_REASIGNAR = ['QuestionnaireResponse', 'Observation', 'DocumentReference', 'Communication'] as const;
/** Tope de páginas por tipo (100 c/u): backstop contra loops, no un límite real. */
const MAX_PAGINAS = 50;

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaFusion>): Promise<unknown> {
  const { duplicadoId, canonicoId, taskId } = event.input;
  if (!duplicadoId || !canonicoId || duplicadoId === canonicoId) {
    return { ok: false, mensaje: 'IDs inválidos.' };
  }
  try {
    const dup = await medplum.readResource('Patient', duplicadoId);
    const canon = await medplum.readResource('Patient', canonicoId);

    // 1. Validar estados (tareas viejas o espejo no pueden invertir una fusión).
    if (canon.active === false || canon.link?.length) {
      return { ok: false, mensaje: 'La ficha canónica elegida está inactiva o ya enlazada: revisá la dirección de la fusión.' };
    }
    if (dup.link?.some((l) => l.type === 'replaced-by')) {
      return { ok: false, mensaje: 'Esa ficha ya fue fusionada antes (tiene link replaced-by).' };
    }

    // 2. Marcar el duplicado ANTES de tocar la canónica (evita la tarea espuria).
    await medplum.updateResource<Patient>({
      ...dup,
      active: false,
      link: [{ other: { reference: `Patient/${canonicoId}` }, type: 'replaced-by' }],
    });

    // 3. Completar datos faltantes en la canónica (sin pisar).
    const telecomNuevos = (dup.telecom ?? []).filter(
      (t) => !(canon.telecom ?? []).some((c) => c.system === t.system && c.value === t.value),
    );
    const identNuevos = (dup.identifier ?? []).filter((i) => !(canon.identifier ?? []).some((c) => c.value === i.value));
    if (telecomNuevos.length || identNuevos.length) {
      await medplum.updateResource<Patient>({
        ...canon,
        telecom: [...(canon.telecom ?? []), ...telecomNuevos],
        identifier: [...(canon.identifier ?? []), ...identNuevos],
      });
    }

    // 4. Reapuntar el login (memberships del duplicado → canónico), hasta agotar.
    let loginsReapuntados = 0;
    for (let i = 0; i < MAX_PAGINAS; i++) {
      const memberships = await medplum.searchResources('ProjectMembership', `profile=Patient/${duplicadoId}&_count=100`);
      if (memberships.length === 0) {
        break;
      }
      for (const m of memberships) {
        await medplum.updateResource<ProjectMembership>({ ...m, profile: { reference: `Patient/${canonicoId}` } });
        loginsReapuntados++;
      }
    }

    // 5. Reasignar recursos del interín (paginado: al reasignar salen del filtro).
    const refCanon = { reference: `Patient/${canonicoId}` };
    const refDup = `Patient/${duplicadoId}`;
    let reasignados = 0;
    for (const tipo of TIPOS_REASIGNAR) {
      for (let i = 0; i < MAX_PAGINAS; i++) {
        const recursos = await medplum.searchResources(tipo, `subject=${refDup}&_count=100`);
        if (recursos.length === 0) {
          break;
        }
        for (const r of recursos) {
          if (tipo === 'Communication') {
            const c = r as Communication;
            await medplum.updateResource<Communication>({
              ...c,
              subject: refCanon,
              recipient: c.recipient?.map((x) => (x.reference === refDup ? refCanon : x)),
            });
          } else {
            await medplum.updateResource({ ...r, subject: refCanon });
          }
          reasignados++;
        }
      }
    }
    // Tasks del interín (p. ej. solicitudes de turno del portal). Las de dedup NO
    // se reapuntan: son el registro auditable de qué ficha se fusionó.
    for (let i = 0; i < MAX_PAGINAS; i++) {
      const tareas = (await medplum.searchResources('Task', `patient=${refDup}&_count=100`)).filter(
        (t) => t.code?.coding?.[0]?.code !== COD.posibleDuplicado,
      );
      if (tareas.length === 0) {
        break;
      }
      for (const t of tareas) {
        await medplum.updateResource<Task>({
          ...t,
          for: refCanon,
          ...(t.requester?.reference === refDup ? { requester: refCanon } : {}),
        });
        reasignados++;
      }
    }

    // 6. Cerrar la tarea de esta revisión y cancelar las espejo que sigan abiertas.
    if (taskId) {
      const task = await medplum.readResource('Task', taskId).catch(() => undefined);
      if (task) {
        await medplum.updateResource<Task>({ ...task, status: 'completed' });
      }
    }
    for (const pacienteId of [duplicadoId, canonicoId]) {
      const abiertas = await medplum.searchResources(
        'Task',
        `code=${COD.posibleDuplicado}&status=requested&patient=Patient/${pacienteId}&_count=50`,
      );
      for (const t of abiertas) {
        if (t.id !== taskId) {
          await medplum.updateResource<Task>({ ...t, status: 'cancelled' });
        }
      }
    }

    return { ok: true, loginsReapuntados, reasignados };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : 'No se pudo fusionar.' };
  }
}
