/**
 * Bot · Vigilante de teleconsultas (cron).
 *
 * Mira las videollamadas del momento y avisa cuando falta alguien. Existe
 * porque el bot de presencia solo se entera de lo que PASA —alguien entró—, y
 * lo que hay que detectar acá es lo que NO pasa: que el profesional no se
 * conectó, o que el paciente nunca apareció.
 *
 * La decisión de cuándo avisar es pura y está testeada (`avisoDue` en
 * `src/lib/teleconsulta.ts`), con ventanas "hacia arriba" igual que los
 * recordatorios de turno: si una corrida del cron se saltea, el siguiente tick
 * lo detecta igual. La idempotencia la da la clave del aviso.
 *
 * **Avisa, no actúa.** No cancela, no marca no-show y no le escribe al
 * paciente: deja la tarjeta en **Avisos** con el turno adentro y decide una
 * persona. Marcar no-show tiene consecuencia sobre plata ya cobrada, y quien
 * está en el mostrador puede haber hablado con el paciente dos minutos antes.
 *
 * **Corre cada 10 minutos, no cada 5**, aunque el umbral del profesional
 * ausente sea de 5. No es una contradicción: el aviso de que el paciente entró
 * lo da `bw-teleconsulta-presencia` en el instante, así que Recepción ya sabe
 * que hay alguien en la sala. Lo que agrega el vigilante es la escalada y la
 * ausencia, y eso tolera un tick de retraso. El tope de 10 minutos es el de
 * `tests/cron.test.ts`: el bus de Medplum se paga por uso.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, Encounter } from '@medplum/fhirtypes';
import { EXT, TIPO_AVISO } from '../fhir/identifiers.js';
import { TELECONSULTA, avisoDue, esNombreSala, type PresenciaSala } from '../lib/teleconsulta.js';
import { crearAlertaRecepcion } from './_shared.js';

export interface EntradaVigilante {
  /** Fecha de referencia ISO (default: ahora). Para pruebas y reprocesos. */
  ahora?: string;
}

export interface ResultadoVigilante {
  ok: boolean;
  revisados: number;
  avisosProfesional: number;
  avisosPaciente: number;
}

const HORA_MS = 3_600_000;

/** Presencia deducida del Encounter. Ver la nota de bw-teleconsulta-presencia. */
function presenciaDe(enc: Encounter | undefined): PresenciaSala {
  if (!enc) {
    return { pacienteEnLinea: false, profesionalEnLinea: false };
  }
  return {
    pacienteEnLinea: Boolean(enc.period?.start),
    profesionalEnLinea: (enc.participant ?? []).some((p) => p.individual?.reference?.startsWith('Practitioner/')),
  };
}

const TEXTO = {
  'profesional-ausente': {
    titulo: 'El profesional no se conectó a la videollamada',
    detalle: (d: string) =>
      `${d}. El paciente está esperando solo hace más de ${TELECONSULTA.avisoProfesionalAusenteMin} minutos. Llamá al profesional.`,
    tipo: TIPO_AVISO.profesionalAusente,
  },
  'paciente-ausente': {
    titulo: 'El paciente no entró a su videollamada',
    detalle: (d: string) =>
      `${d}. Pasaron más de ${TELECONSULTA.avisoPacienteAusenteMin} minutos de la hora y no se conectó. Escribile o llamalo antes de darlo por ausente.`,
    tipo: TIPO_AVISO.pacienteAusente,
  },
} as const;

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaVigilante>,
): Promise<ResultadoVigilante> {
  const ahora = event.input?.ahora ? new Date(event.input.ahora) : new Date();

  // Ventana chica a propósito: una teleconsulta dura una hora y el vigilante
  // corre cada pocos minutos. Mirar el día entero sería pasear por turnos que
  // ya terminaron o que todavía no empezaron.
  const desde = new Date(ahora.getTime() - 2 * HORA_MS);
  const hasta = new Date(ahora.getTime() + HORA_MS);
  const turnos = await medplum.searchResources(
    'Appointment',
    `status=booked,arrived&date=ge${desde.toISOString()}&date=le${hasta.toISOString()}&_count=200`,
  );

  let revisados = 0;
  let avisosProfesional = 0;
  let avisosPaciente = 0;

  for (const appt of turnos) {
    const sala = appt.extension?.find((x) => x.url === EXT.teleconsultaSala)?.valueString;
    if (!esNombreSala(sala) || !appt.start || !appt.id) {
      continue; // no es una videollamada
    }
    revisados++;

    const enc = await medplum.searchOne('Encounter', `appointment=Appointment/${appt.id}`);
    const aviso = avisoDue(new Date(appt.start), presenciaDe(enc), ahora);
    if (!aviso) {
      continue;
    }

    const t = TEXTO[aviso];
    const pacienteRef = appt.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    await crearAlertaRecepcion(medplum, {
      titulo: t.titulo,
      detalle: t.detalle(appt.description ?? 'Videollamada'),
      clave: `teleconsulta-${aviso}-${appt.id}`,
      tipo: t.tipo,
      ...(pacienteRef ? { pacienteRef } : {}),
      focusRef: `Appointment/${appt.id}`,
      datos: { appointmentId: appt.id },
    });

    if (aviso === 'profesional-ausente') {
      avisosProfesional++;
    } else {
      avisosPaciente++;
    }
  }

  return { ok: true, revisados, avisosProfesional, avisosPaciente };
}
