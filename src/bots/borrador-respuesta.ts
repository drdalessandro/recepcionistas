/**
 * Bot · Borrador de respuesta para Recepción (Nivel 3).
 *
 * Lee el hilo de Mensajes y el contexto del paciente, y devuelve el BORRADOR de
 * la próxima respuesta. La recepcionista lo lee, lo corrige si hace falta y lo
 * envía: **nada sale sin que una persona toque Enviar**.
 *
 * Por qué así y no un bot que conteste solo: en un centro de salud, un mensaje
 * equivocado sobre una terapia o un cobro se paga caro. Con la persona en el
 * medio, el sistema aporta velocidad y contexto sin poder hacer daño — y de
 * paso genera el dato que habilita (o no) automatizar más adelante: qué
 * porcentaje de borradores se manda sin editar.
 *
 * Solo lectura: no escribe nada en FHIR ni manda ningún mensaje.
 *
 * Requiere el secret ANTHROPIC_API_KEY. Sin él devuelve un aviso claro y
 * Recepción sigue escribiendo a mano, como siempre.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Coverage, Flag, Invoice, Patient } from '@medplum/fhirtypes';
import { EXT } from '../fhir/identifiers.js';
import { esPlanBW, estadoDeCoverage, planCodigoDeCoverage } from '../fhir/coverage.js';
import {
  limpiarBorrador,
  promptBorrador,
  systemBorrador,
  type ContextoPaciente,
  type MensajeHilo,
  type ResultadoBorrador,
} from '../lib/borrador.js';
import { fechaTurnoNotif, tieneBloqueoPago } from './_shared.js';

/** Modelo y esfuerzo: un borrador corto de atención al cliente no necesita más. */
const MODELO = 'claude-opus-5';
const ESFUERZO = 'low';
/** Cuántos mensajes del hilo mira. Alcanza para el contexto sin inflar el costo. */
const MENSAJES_CONTEXTO = 12;

export interface EntradaBorrador {
  /** Hilo (topic Communication) para el que se pide el borrador. */
  hiloId: string;
}

export async function handler(medplum: MedplumClient, event: BotEvent<EntradaBorrador>): Promise<ResultadoBorrador> {
  const apiKey = event.secrets['ANTHROPIC_API_KEY']?.valueString;
  if (!apiKey) {
    return { motivo: 'Falta el secret ANTHROPIC_API_KEY en Medplum: el borrador automático está desactivado.' };
  }

  const topic = await medplum.readResource('Communication', event.input.hiloId).catch(() => undefined);
  const pacienteRef = topic?.subject?.reference;
  if (!topic || !pacienteRef?.startsWith('Patient/')) {
    return { motivo: 'No encontré la conversación (o no está asociada a un paciente).' };
  }

  const hijos = await medplum.searchResources(
    'Communication',
    `part-of=Communication/${event.input.hiloId}&_sort=-sent&_count=${MENSAJES_CONTEXTO}`,
  );
  const mensajes: MensajeHilo[] = hijos
    .slice()
    .reverse()
    .map((c) => ({
      de: c.sender?.reference?.startsWith('Patient/') ? ('paciente' as const) : ('recepcion' as const),
      texto: c.payload?.find((p) => p.contentString)?.contentString ?? '[adjunto]',
      ...(c.sent ? { cuandoISO: c.sent } : {}),
      ...(c.extension?.some((x) => x.url === EXT.autoRespuesta) ? { automatico: true } : {}),
    }))
    .filter((m) => m.texto.trim().length > 0);

  if (mensajes.length === 0) {
    return { motivo: 'La conversación está vacía.' };
  }
  // Si el último que habló fue Recepción, no hay nada nuevo que contestar.
  if (mensajes[mensajes.length - 1]?.de !== 'paciente') {
    return { motivo: 'El último mensaje es de Recepción: no hay nada pendiente de responder.' };
  }

  const contexto = await armarContexto(medplum, pacienteRef);

  try {
    const anthropic = new Anthropic({ apiKey });
    const respuesta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 4096,
      output_config: { effort: ESFUERZO },
      system: systemBorrador(),
      messages: [{ role: 'user', content: promptBorrador(contexto, mensajes) }],
    });
    // Una negativa por seguridad no es un error: se le avisa a Recepción y listo.
    if (respuesta.stop_reason === 'refusal') {
      return { motivo: 'El asistente no redactó este mensaje. Contestalo vos.' };
    }
    const texto = respuesta.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return limpiarBorrador(texto);
  } catch (err) {
    console.log(`borrador-respuesta: la API falló: ${err instanceof Error ? err.message : err}`);
    return { motivo: 'No pude generar el borrador ahora. Escribí la respuesta a mano.' };
  }
}

/**
 * Lo que Recepción ya ve del paciente en pantalla, reunido en un solo lugar.
 *
 * Deliberadamente NO incluye nada clínico: ni screening, ni contraindicaciones,
 * ni documentos. Del consentimiento solo viaja la señal binaria, que es lo mismo
 * que ve el banner de Atender.
 */
async function armarContexto(medplum: MedplumClient, pacienteRef: string): Promise<ContextoPaciente> {
  const paciente = await medplum.readResource('Patient', pacienteRef.split('/')[1] as string).catch(() => undefined);

  const [appt, coberturas, saldos, flags] = await Promise.all([
    medplum
      .searchOne(
        'Appointment',
        `patient=${pacienteRef}&status=booked,arrived&date=ge${new Date().toISOString()}&_sort=date&_count=1`,
      )
      .catch(() => undefined),
    medplum.searchResources('Coverage', `beneficiary=${pacienteRef}&status=active&_count=10`).catch(() => [] as Coverage[]),
    medplum
      .searchResources('Invoice', `subject=${pacienteRef}&status=issued&_count=20`)
      .catch(() => [] as Invoice[]),
    medplum.searchResources('Flag', `subject=${pacienteRef}&status=active&_count=20`).catch(() => [] as Flag[]),
  ]);

  // `esPlanBW` primero: la obra social del paciente también es un Coverage
  // activo, y `estadoDeCoverage` la interpretaría como membresía.
  const plan = coberturas.find((c) => esPlanBW(c));
  const estado = plan ? estadoDeCoverage(plan) : undefined;
  const saldoARS = saldos.reduce((acc, i) => acc + (i.totalGross?.value ?? 0), 0);
  const nombre = nombreDe(paciente);

  return {
    ...(nombre ? { nombre } : {}),
    ...(appt?.start
      ? { proximoTurno: `el ${fechaTurnoNotif(appt.start)}${appt.description ? ` · ${appt.description}` : ''}` }
      : {}),
    ...(plan && estado
      ? {
          plan: {
            nombre: planCodigoDeCoverage(plan) ?? estado.tipo,
            sesionesRestantes: Math.max(0, estado.total - estado.usadas),
          },
        }
      : {}),
    ...(saldoARS > 0 ? { saldoARS } : {}),
    ...(tieneBloqueoPago(flags) ? { bloqueadoPorPago: true } : {}),
  };
}

function nombreDe(p: Patient | undefined): string | undefined {
  if (!p) {
    return undefined;
  }
  const armado = [p.name?.[0]?.given?.join(' '), p.name?.[0]?.family].filter(Boolean).join(' ');
  return p.name?.[0]?.text ?? (armado || undefined);
}
