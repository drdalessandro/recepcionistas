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
import type { Basic, ContactPoint, Patient, Provenance, Task } from '@medplum/fhirtypes';
import {
  EXT,
  EXT_CICLO_VIDA,
  EXT_LEAD_ORIGEN,
  ORIGENES_LEAD_LABELS,
  SYSTEM_CICLO_VIDA,
  SYSTEM_ETAPA_PIPELINE,
  TASK_INPUT_PROXIMA_ACCION,
  esOrigenLead,
  type CicloVida,
} from '../fhir/identifiers.js';
import { demandaABasic } from '../fhir/demanda.js';
import { busquedaPorDni, conIdentificadoresDni, identificadoresDni } from '../fhir/paciente.js';
import { validarPedido } from '../lib/demanda.js';
import { descripcionLead, fuenteDeLead, nombreDeLead, proximaAccionLead } from '../lib/lead.js';
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
  /**
   * Ciclo de vida (contrato del CRM): `lead` = todavía no es cliente, solo
   * preguntó. Sin esto, la ficha nace como `activo` (el comportamiento de
   * siempre). Un lead entra por ACÁ y no por un alta paralela para heredar la
   * deduplicación: si el curioso vuelve en un mes, se lo encuentra.
   */
  cicloVida?: CicloVida;
  /** Qué vino a preguntar. Va en la Task del pipeline; no es dato clínico. */
  interes?: string;
  /**
   * Caso 11: qué pidió, cuando pidió algo que NO ofrecemos. Deja su propio
   * registro (`Basic` con code `demanda`) además del texto de la tarjeta —
   * porque la tarjeta solo existe si el lead es nuevo, y el pedido vale igual
   * cuando lo hace alguien que ya tiene ficha.
   */
  pedido?: string;
  /** A quién acompañaba (nombre), si vino con un paciente. Solo texto de la tarjeta. */
  acompanaA?: string;
  /**
   * Quién lo registró (`Practitioner/…`), para el `agent` del Provenance del
   * CRM. Lo manda la app con el perfil logueado: el bot no sabe quién lo llamó.
   */
  registradoPorRef?: string;
}

export interface ResultadoAltaPaciente {
  ok: boolean;
  mensaje?: string;
  patientId?: string;
  /** true si se creó; false si se actualizó uno existente. */
  creado?: boolean;
  /** Task del pipeline del CRM, si se registró como lead. */
  taskPipelineId?: string;
  /** Registro de demanda no cubierta, si pidió algo que no ofrecemos. */
  demandaId?: string;
}

/**
 * Caso 11 · deja registrado que alguien pidió algo que no tenemos.
 *
 * Corre para pacientes nuevos Y existentes: el que ya tiene ficha no genera
 * tarjeta de lead, y si el pedido viviera solo en la tarjeta se perdería
 * justamente el de quien ya nos conoce y viene a preguntar por otra cosa.
 *
 * Best-effort: el alta no puede fallar por esto.
 */
async function registrarDemanda(
  medplum: MedplumClient,
  e: EntradaAltaPaciente,
  pacienteId: string | undefined,
  ahora: Date,
): Promise<string | undefined> {
  const v = validarPedido(e.pedido);
  if (!v.ok) {
    return undefined;
  }
  try {
    const basic = await medplum.createResource<Basic>(
      demandaABasic({
        texto: v.texto,
        clave: v.clave,
        pacienteRef: pacienteId ? `Patient/${pacienteId}` : undefined,
        registradoPorRef: e.registradoPorRef,
        fechaISO: ahora.toISOString(),
      }),
    );
    return basic.id;
  } catch {
    return undefined;
  }
}

function extensionAlta(tipoCliente?: string, origen?: string, fechaAlta?: string, cicloVida?: CicloVida): Patient['extension'] {
  const ext = [
    ...(tipoCliente ? [{ url: EXT.tipoCliente, valueCode: tipoCliente }] : []),
    ...(origen ? [{ url: EXT.origenLead, valueString: origen }] : []),
    ...(fechaAlta ? [{ url: EXT.fechaAlta, valueDate: fechaAlta }] : []),
    ...(cicloVida ? [{ url: EXT_CICLO_VIDA, valueCode: cicloVida }] : []),
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
    // Por los DOS systems del documento (el nuestro y el canónico de RENAPER):
    // una ficha que solo tenga el canónico sería invisible acá y terminaría en
    // un duplicado — el caso 2 del walk-in con otro disfraz.
    const p = await medplum.searchOne('Patient', busquedaPorDni(e.dni));
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

    // Un LEAD puede no tener nombre: el curioso del mostrador muchas veces no lo
    // deja, y el registro igual sirve para medir. Se le pone una etiqueta
    // descriptiva con la fecha (nunca un nombre inventado, que quedaría en la
    // ficha como si fuera el suyo). Para un alta normal el nombre sigue siendo
    // obligatorio.
    const esLead = e.cicloVida === 'lead';
    if (!firstName && !lastName && !esLead) {
      return { ok: false, mensaje: 'Falta el nombre del paciente.' };
    }
    if (e.email && !validarEmail(e.email)) {
      return { ok: false, mensaje: 'El email no es válido.' };
    }

    const ahora = new Date();
    const nombreText =
      [firstName, lastName].filter(Boolean).join(' ') ||
      nombreDeLead({ nombre: undefined, telefono: e.telefono, interes: e.interes }, ahora);
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
      // Suma el documento con los dos systems si falta alguno; nunca pisa uno
      // ya cargado (corregir un documento es una decisión sobre la ficha).
      const identifier = conIdentificadoresDni(existente.identifier, e.dni);
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
      const demandaId = await registrarDemanda(medplum, e, actualizado.id, ahora);
      return { ok: true, patientId: actualizado.id, creado: false, ...(demandaId ? { demandaId } : {}) };
    }

    const documento = identificadoresDni(e.dni);
    const creado = await medplum.createResource<Patient>({
      resourceType: 'Patient',
      active: true,
      // Ciclo de vida del CRM: extensión + espejo en meta.tag (así lo lee su
      // pipeline). Sin `cicloVida` la ficha nace como siempre, sin la marca.
      ...(e.cicloVida
        ? {
            meta: { tag: [{ system: SYSTEM_CICLO_VIDA, code: e.cicloVida }] },
          }
        : {}),
      name: [{ text: nombreText, given: [firstName], family: lastName }],
      // El documento con los dos systems: el nuestro tal como se tipeó y el
      // canónico de RENAPER normalizado (ver src/fhir/paciente.ts).
      ...(documento.length ? { identifier: documento } : {}),
      telecom: telecom(e.telefono, e.email),
      // fecha-alta: cohortes mensuales del CRM. Solo al CREAR (las fichas
      // viejas quedan sin fecha, decisión 2026-07: no se retro-etiqueta).
      extension: extensionAlta(e.tipoCliente, origen, ahora.toISOString().slice(0, 10), e.cicloVida),
    });

    // Tarjeta en el kanban del CRM (etapa 'nuevo'). Es lo que hace que el lead
    // exista para alguien: sin esto queda una ficha que nadie mira. Best-effort:
    // si falla, el lead igual quedó registrado y medible.
    let taskPipelineId: string | undefined;
    if (esLead) {
      try {
        const tarea = await medplum.createResource<Task>({
          resourceType: 'Task',
          status: 'requested',
          intent: 'order',
          businessStatus: { coding: [{ system: SYSTEM_ETAPA_PIPELINE, code: 'nuevo' }] },
          code: { text: 'Lead' },
          description: descripcionLead({
            nombre: nombreText,
            telefono: e.telefono,
            interes: e.interes,
            pedido: e.pedido,
            acompanaA: e.acompanaA,
          }),
          // La tarjeta del kanban NO muestra `description`: muestra este input.
          // Sin él, quien trabaja el lead ve un nombre suelto y no sabe a qué vino.
          input: [
            {
              type: { text: TASK_INPUT_PROXIMA_ACCION },
              valueString: proximaAccionLead({
                telefono: e.telefono,
                interes: e.interes,
                pedido: e.pedido,
                acompanaA: e.acompanaA,
              }),
            },
          ],
          for: { reference: `Patient/${creado.id}` },
          authoredOn: ahora.toISOString(),
        });
        taskPipelineId = tarea.id;
      } catch {
        // el CRM puede tomarlo igual desde la ficha (ciclo-vida = lead)
      }

      // Provenance de atribución: el chip de fuente en la tarjeta del kanban.
      // Administración confirmó que es OPCIONAL —para métricas manda nuestro
      // `origen-lead`— así que es best-effort y su forma es la que ellos leen
      // (`fuenteDe` en su PipelinePage). `agent.who` es obligatorio en FHIR y
      // solo acepta ciertos tipos: sin un Practitioner válido no se escribe,
      // porque un Provenance inválido sería peor que ninguno.
      const fuente = fuenteDeLead(origen, ORIGENES_LEAD_LABELS);
      if (fuente && e.registradoPorRef?.startsWith('Practitioner/')) {
        try {
          await medplum.createResource<Provenance>({
            resourceType: 'Provenance',
            target: [{ reference: `Patient/${creado.id}` }],
            recorded: ahora.toISOString(),
            agent: [{ who: { reference: e.registradoPorRef } }],
            extension: [
              { url: EXT_LEAD_ORIGEN, extension: [{ url: 'fuente', valueString: fuente }] },
            ],
          });
        } catch {
          // sin chip de fuente en la tarjeta; el lead ya quedó registrado
        }
      }
    }
    const demandaId = await registrarDemanda(medplum, e, creado.id, ahora);
    return {
      ok: true,
      patientId: creado.id,
      creado: true,
      ...(taskPipelineId ? { taskPipelineId } : {}),
      ...(demandaId ? { demandaId } : {}),
    };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : 'No se pudo dar de alta el paciente.' };
  }
}
