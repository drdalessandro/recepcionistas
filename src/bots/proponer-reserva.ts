/**
 * Bot · Propuesta de reserva para una solicitud del portal (Nivel 4, solo lectura).
 *
 * Para un `Task` de solicitud de turno, arma la oferta real (ficha resumida del
 * paciente + lo que pidió + los horarios que el portal le ofrecería a ÉL, con
 * todas las reglas puestas) y le pide al modelo que elija ENTRE esos horarios.
 * Devuelve la propuesta concreta —servicio, sala, horario, personas, por qué—
 * para que la card de Solicitudes la muestre con un botón **Reservar**.
 *
 * Nunca reserva ni escribe nada: la reserva la hace `bw-reservar-turno` cuando
 * una persona toca el botón, con las mismas reglas que el mostrador. Y lo que
 * el modelo devuelve se valida contra la oferta (`validarSalida`): un horario
 * que no estaba en la lista no se propone, venga como venga.
 *
 * Lo que NO ve el modelo: nada clínico (misma ficha resumida que el borrador).
 * Lo que NO propone en esta primera rebanada: consultas médicas (agenda del
 * profesional), servicios con prescripción (IV/TB) y combos — para todo eso la
 * card manda a Atender, como siempre.
 *
 * Requiere el secret ANTHROPIC_API_KEY. Sin él devuelve un aviso claro y
 * Recepción sigue resolviendo a mano, como siempre.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Task } from '@medplum/fhirtypes';
import { SERVICIOS, SERVICIOS_POR_CODIGO } from '../config/catalogo.js';
import { getCombo } from '../config/combos.js';
import { COD } from '../fhir/identifiers.js';
import { candidatosPara, salaLibrePara } from '../lib/disponibilidad.js';
import {
  SCHEMA_SALIDA,
  diaLegible,
  horaLegible,
  parsearSalida,
  promptPropuesta,
  systemPropuesta,
  validarSalida,
  type OfertaPropuesta,
  type ServicioOfrecido,
  type SolicitudResumida,
} from '../lib/propuesta.js';
import type { Servicio } from '../domain/types.js';
import { cargarReservasDelDia, contextoPacienteResumido, disponibilidadDePaciente } from './_shared.js';

/** Mismo modelo y esfuerzo que el borrador: elegir entre una lista no necesita más. */
const MODELO = 'claude-opus-5';
const ESFUERZO = 'low';
/** Cuántos servicios distintos se le ofrecen como máximo (p. ej. mono y biplaza). */
const MAX_SERVICIOS = 3;

export interface EntradaPropuesta {
  /** La solicitud (Task `solicitud-turno`) a resolver. */
  taskId: string;
  /** Inicios (ISO) que Recepción ya descartó con "Otra opción". */
  excluir?: string[];
}

export interface PropuestaReserva {
  servicioCodigo: string;
  servicioNombre: string;
  recursoCodigo: string;
  recursoNombre: string;
  /** ISO con offset de Argentina, tal como lo espera `bw-reservar-turno`. */
  inicio: string;
  fin: string;
  ocupantes: number;
  /** "jueves 03/09 · 16:00", para la card. */
  cuando: string;
  /** Para Recepción: qué pidió, qué se propone y por qué. */
  motivo: string;
  alternativas: Array<{ inicio: string; cuando: string }>;
}

export interface ResultadoPropuesta {
  ok: boolean;
  pacienteRef?: string;
  propuesta?: PropuestaReserva;
  /** Por qué no hay propuesta (API apagada, tema para una persona, nada disponible…). */
  motivo?: string;
}

function inputDe(t: Task, tipo: string): { valueString?: string; valueDateTime?: string } | undefined {
  return t.input?.find((i) => i.type?.text === tipo);
}

/**
 * Qué servicios puede proponer para lo que pidió el paciente. Un código de
 * servicio concreto → ese; una categoría ("HBOT") → sus servicios individuales
 * (mono/biplaza: el modelo elige según cuántas personas vengan). Lo que esta
 * rebanada no maneja devuelve `motivo`.
 */
function serviciosPara(terapiaCodigo: string | undefined): { servicios: Servicio[] } | { motivo: string } {
  if (!terapiaCodigo) {
    return { motivo: 'La solicitud no trae el código de la terapia: resolvela desde Atender.' };
  }
  let combo = false;
  try {
    getCombo(terapiaCodigo);
    combo = true;
  } catch {
    // no es un combo
  }
  if (combo) {
    return { motivo: 'Es un combo: por ahora el asistente propone solo sesiones sueltas. Resolvela desde Atender.' };
  }
  const directo = SERVICIOS_POR_CODIGO.get(terapiaCodigo);
  const base = directo ? [directo] : SERVICIOS.filter((s) => s.categoria === terapiaCodigo);
  if (base.length === 0) {
    return { motivo: `No reconozco la terapia pedida (${terapiaCodigo}): resolvela desde Atender.` };
  }
  if (base.some((s) => s.practitionerCodigo)) {
    return { motivo: 'Es una consulta médica (agenda del profesional): resolvela desde Atender.' };
  }
  if (base.every((s) => s.requierePrescripcion)) {
    return { motivo: 'Requiere prescripción médica (R-03): resolvela desde Atender, declarando la prescripción.' };
  }
  const servicios = base.filter((s) => !s.requierePrescripcion && candidatosPara(s).length > 0).slice(0, MAX_SERVICIOS);
  return servicios.length > 0 ? { servicios } : { motivo: 'No hay salas para esa terapia: resolvela desde Atender.' };
}

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaPropuesta>): Promise<ResultadoPropuesta> {
  const apiKey = event.secrets['ANTHROPIC_API_KEY']?.valueString;
  if (!apiKey) {
    return { ok: false, motivo: 'Falta el secret ANTHROPIC_API_KEY en Medplum: la propuesta automática está desactivada.' };
  }
  if (!event.input?.taskId) {
    return { ok: false, motivo: 'Falta taskId.' };
  }

  const task = await medplum.readResource('Task', event.input.taskId).catch(() => undefined);
  const esSolicitud = task?.code?.coding?.some((c) => c.code === COD.solicitudTurno) ?? false;
  const pacienteRef = task?.for?.reference ?? task?.requester?.reference;
  if (!task || !esSolicitud || !pacienteRef?.startsWith('Patient/')) {
    return { ok: false, motivo: 'No encontré la solicitud (o no está asociada a un paciente).' };
  }
  if (task.status !== 'requested') {
    return { ok: false, pacienteRef, motivo: 'La solicitud ya no está pendiente.' };
  }

  const terapiaCodigo = inputDe(task, 'terapia-codigo')?.valueString;
  const resolucion = serviciosPara(terapiaCodigo);
  if ('motivo' in resolucion) {
    return { ok: false, pacienteRef, motivo: resolucion.motivo };
  }

  const ahora = new Date();
  const [paciente, ofertas] = await Promise.all([
    contextoPacienteResumido(medplum, pacienteRef),
    Promise.all(
      resolucion.servicios.map(async (s): Promise<ServicioOfrecido> => {
        const { disp } = await disponibilidadDePaciente(medplum, pacienteRef, s, ahora);
        return {
          codigo: s.codigo,
          nombre: s.nombre,
          duracionMin: s.duracionMin,
          capacidadMax: Math.max(1, ...candidatosPara(s).map((r) => r.capacidad)),
          grupal: disp.grupal,
          dias: disp.dias,
        };
      }),
    ),
  ]);
  if (ofertas.every((o) => o.dias.every((d) => d.horarios.length === 0))) {
    return { ok: false, pacienteRef, motivo: 'No hay horarios disponibles dentro de su ventana de reserva: resolvela desde Atender.' };
  }

  const solicitud: SolicitudResumida = {
    terapia: inputDe(task, 'terapia')?.valueString ?? terapiaCodigo ?? 'terapia',
    ...(terapiaCodigo ? { terapiaCodigo } : {}),
    ...(inputDe(task, 'preferencia-inicio')?.valueDateTime
      ? { preferenciaInicioISO: inputDe(task, 'preferencia-inicio')!.valueDateTime! }
      : {}),
    ...(inputDe(task, 'preferencia-texto')?.valueString ? { preferenciaTexto: inputDe(task, 'preferencia-texto')!.valueString! } : {}),
    ...(inputDe(task, 'nota')?.valueString ? { nota: inputDe(task, 'nota')!.valueString! } : {}),
    ...(task.authoredOn ? { pedidaEnISO: task.authoredOn } : {}),
  };
  const oferta: OfertaPropuesta = {
    ahoraISO: ahora.toISOString(),
    paciente,
    solicitud,
    servicios: ofertas,
    ...(event.input.excluir?.length ? { excluir: event.input.excluir } : {}),
  };

  let salida: unknown;
  try {
    const anthropic = new Anthropic({ apiKey });
    const respuesta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 2048,
      output_config: { effort: ESFUERZO, format: { type: 'json_schema', schema: SCHEMA_SALIDA } },
      system: systemPropuesta(),
      messages: [{ role: 'user', content: promptPropuesta(oferta) }],
    });
    if (respuesta.stop_reason === 'refusal') {
      return { ok: false, pacienteRef, motivo: 'El asistente no propuso nada para esta solicitud. Resolvela vos.' };
    }
    salida = parsearSalida(
      respuesta.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    );
  } catch (err) {
    console.log(`proponer-reserva: la API falló: ${err instanceof Error ? err.message : err}`);
    return { ok: false, pacienteRef, motivo: 'No pude armar la propuesta ahora. Resolvela desde Atender.' };
  }

  const validada = validarSalida(salida, oferta);
  if (!validada.ok) {
    return { ok: false, pacienteRef, motivo: validada.motivo };
  }
  const { propuesta } = validada;
  const servicio = SERVICIOS_POR_CODIGO.get(propuesta.servicioCodigo)!;
  const inicio = new Date(propuesta.inicio);

  // La sala la elige el sistema con el MISMO criterio con que ofreció el
  // horario (R-07); si entre la oferta y ahora se ocupó, no hay propuesta.
  const reservas = await cargarReservasDelDia(medplum, inicio);
  const sala = salaLibrePara(servicio, inicio, propuesta.ocupantes, reservas);
  if (!sala) {
    return { ok: false, pacienteRef, motivo: 'El horario que iba a proponer se acaba de ocupar. Probá de nuevo o resolvela desde Atender.' };
  }
  const cuando = (iso: string): string => `${diaLegible(iso.slice(0, 10))} · ${horaLegible(iso)}`;
  return {
    ok: true,
    pacienteRef,
    propuesta: {
      servicioCodigo: servicio.codigo,
      servicioNombre: servicio.nombre,
      recursoCodigo: sala.codigo,
      recursoNombre: sala.nombre,
      inicio: propuesta.inicio,
      fin: new Date(inicio.getTime() + servicio.duracionMin * 60_000).toISOString(),
      ocupantes: propuesta.ocupantes,
      cuando: cuando(propuesta.inicio),
      motivo: propuesta.motivo,
      alternativas: propuesta.alternativas.map((a) => ({ inicio: a, cuando: cuando(a) })),
    },
  };
}
