/**
 * Bot · Fusionar fichas duplicadas (requiere decisión humana previa).
 *
 * Input: { duplicadoId, canonicoId, taskId? }
 *  1. Copia a la ficha canónica los telecom/identifier que el duplicado tenga y
 *     la canónica no (NO pisa los existentes).
 *  2. Reapunta el LOGIN: la ProjectMembership cuyo profile es el duplicado pasa a
 *     apuntar a la ficha canónica (el paciente sigue entrando con su usuario y ve
 *     su historia real). Requiere que el bot sea admin del proyecto.
 *  3. Marca el duplicado: active=false + link[replaced-by → canónico].
 *  4. Reasigna al canónico los recursos clínicos creados en el interín
 *     (QuestionnaireResponse / Observation / DocumentReference / Communication
 *     con subject=duplicado).
 *  5. Cierra la Task de revisión (si vino taskId).
 *
 * La fusión no borra nada: el duplicado queda inactivo y enlazado (auditable).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Patient, ProjectMembership, Task } from '@medplum/fhirtypes';

export interface EntradaFusion {
  duplicadoId: string;
  canonicoId: string;
  taskId?: string;
}

const TIPOS_REASIGNAR = ['QuestionnaireResponse', 'Observation', 'DocumentReference', 'Communication'] as const;

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaFusion>): Promise<unknown> {
  const { duplicadoId, canonicoId, taskId } = event.input;
  if (!duplicadoId || !canonicoId || duplicadoId === canonicoId) {
    return { ok: false, mensaje: 'IDs inválidos.' };
  }
  try {
    const dup = await medplum.readResource('Patient', duplicadoId);
    const canon = await medplum.readResource('Patient', canonicoId);

    // 1. Completar datos faltantes en la canónica (sin pisar).
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

    // 2. Reapuntar el login (membership del duplicado → canónico).
    let loginsReapuntados = 0;
    const memberships = await medplum.searchResources('ProjectMembership', `profile=Patient/${duplicadoId}&_count=10`);
    for (const m of memberships) {
      await medplum.updateResource<ProjectMembership>({
        ...m,
        profile: { reference: `Patient/${canonicoId}` },
      });
      loginsReapuntados++;
    }

    // 3. Marcar el duplicado.
    await medplum.updateResource<Patient>({
      ...dup,
      active: false,
      link: [{ other: { reference: `Patient/${canonicoId}` }, type: 'replaced-by' }],
    });

    // 4. Reasignar recursos clínicos del interín.
    let reasignados = 0;
    for (const tipo of TIPOS_REASIGNAR) {
      const recursos = await medplum.searchResources(tipo, `subject=Patient/${duplicadoId}&_count=100`);
      for (const r of recursos) {
        await medplum.updateResource({ ...r, subject: { reference: `Patient/${canonicoId}` } });
        reasignados++;
      }
    }

    // 5. Cerrar la tarea.
    if (taskId) {
      const task = await medplum.readResource('Task', taskId).catch(() => undefined);
      if (task) {
        await medplum.updateResource<Task>({ ...task, status: 'completed' });
      }
    }

    return { ok: true, loginsReapuntados, reasignados };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : 'No se pudo fusionar.' };
  }
}
