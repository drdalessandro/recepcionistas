/**
 * Bot · Estado de una teleconsulta para Recepción (SOLO LECTURA).
 *
 * Le contesta al mostrador lo operativo de una videollamada —quién está
 * conectado, cuánto hace que espera el paciente, cuántos documentos adjuntó—
 * y **nada más**. Nunca el contenido de esos documentos, ni el motivo de
 * consulta, ni nada clínico (CLAUDE.md, principio 3).
 *
 * Mismo molde que `bw-estado-seguridad` y `bw-estado-consentimiento`, y por el
 * mismo motivo: la AccessPolicy de recepción **no incluye `DocumentReference`**
 * y no debe incluirlo — abrirlo le daría la historia documental entera del
 * paciente. El bot corre con identidad de proyecto, cuenta los adjuntos y
 * devuelve un número. Recepción ya puede ejecutar bots, así que esto no obliga
 * a tocar su policy.
 *
 * "Adjuntó 2 documentos" es lo que Recepción necesita para saber que el
 * profesional tiene con qué trabajar. Qué dicen esos documentos es del
 * profesional, en el Dashboard.
 *
 * **Falla cerrado**: si no puede consultar, lo dice; no inventa un "todo bien".
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Encounter } from '@medplum/fhirtypes';
import { DOCUMENTOS_PACIENTE, EXT, SYSTEM } from '../fhir/identifiers.js';
import { esNombreSala, habilitaNoShow, minutosDeEspera } from '../lib/teleconsulta.js';

export interface EntradaEstadoTeleconsulta {
  appointmentId: string;
}

export interface ResultadoEstadoTeleconsulta {
  ok: boolean;
  /** ¿Es una videollamada? Si no, el resto no aplica. */
  esVirtual?: boolean;
  pacienteEnLinea?: boolean;
  profesionalEnLinea?: boolean;
  /** Minutos que el paciente lleva esperando solo. 0 si no espera. */
  esperaMin?: number;
  /** CUÁNTOS documentos asoció el paciente al turno. Nunca cuáles. */
  adjuntos?: number;
  /** ¿Recepción ya puede marcar no-show? Habilita; no ejecuta. */
  puedeMarcarNoShow?: boolean;
  mensaje?: string;
}

/**
 * Cuántos documentos le asoció el paciente a este turno.
 *
 * El vínculo vive **en el documento** (`context.related` → el turno) y no en
 * `Appointment.supportingInformation`: el paciente tiene el turno de solo
 * lectura en su AccessPolicy, así que no puede escribirlo. Contar por
 * `supportingInformation` daba 0 siempre — el número se veía bien y estaba
 * vacío, que es la peor forma de estar mal.
 *
 * **No cuenta el informe del profesional** (`informe-consulta`): la señal que
 * Recepción necesita es "el médico tiene con qué trabajar", y el informe que
 * el médico escribió después no es eso. Se piden solo las categorías con
 * `_elements` para no traerse los adjuntos: el bot no abre ninguno.
 */
async function contarAdjuntos(medplum: MedplumClient, appointmentId: string): Promise<number> {
  const docs = await medplum
    .searchResources('DocumentReference', `related=Appointment/${appointmentId}&_count=100&_elements=category`)
    .catch(() => []);
  return docs.filter(
    (d) =>
      !(d.category ?? []).some((c) =>
        (c.coding ?? []).some(
          (k) => k.system === SYSTEM.documentoPaciente && k.code === DOCUMENTOS_PACIENTE.informeConsulta,
        ),
      ),
  ).length;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaEstadoTeleconsulta>,
): Promise<ResultadoEstadoTeleconsulta> {
  const id = event.input?.appointmentId;
  if (!id) {
    return { ok: false, mensaje: 'Falta el turno.' };
  }

  try {
    const appt = await medplum.readResource('Appointment', id);
    const sala = appt.extension?.find((x) => x.url === EXT.teleconsultaSala)?.valueString;
    if (!esNombreSala(sala)) {
      return { ok: true, esVirtual: false };
    }

    const enc: Encounter | undefined = await medplum.searchOne('Encounter', `appointment=Appointment/${id}`);
    const pacienteEnLinea = Boolean(enc?.period?.start);
    const profesionalEnLinea = (enc?.participant ?? []).some((p) =>
      p.individual?.reference?.startsWith('Practitioner/'),
    );

    const adjuntos = await contarAdjuntos(medplum, id);

    const ahora = new Date();
    const inicio = appt.start ? new Date(appt.start) : undefined;
    const presencia = { pacienteEnLinea, profesionalEnLinea };

    return {
      ok: true,
      esVirtual: true,
      pacienteEnLinea,
      profesionalEnLinea,
      esperaMin: minutosDeEspera(enc?.period?.start ? new Date(enc.period.start) : undefined, profesionalEnLinea, ahora),
      adjuntos,
      puedeMarcarNoShow: inicio ? habilitaNoShow(inicio, presencia, ahora) : false,
    };
  } catch (err) {
    console.error('bw-estado-teleconsulta:', err instanceof Error ? err.message : err);
    return { ok: false, mensaje: 'No pudimos consultar el estado de la videollamada.' };
  }
}
