/**
 * Borrador de respuesta para Recepción — lógica pura (sin FHIR, sin red).
 *
 * Nivel 3 de las respuestas automáticas (ver `docs/whatsapp-auto-respuestas.md`):
 * el sistema **redacta**, la recepcionista **decide y envía**. Nada sale sin que
 * una persona toque Enviar.
 *
 * Acá vive todo lo que se puede testear sin llamar al modelo: cómo se arma el
 * contexto que se le manda, cómo se transcribe la conversación, y cómo se
 * valida lo que devuelve. El bot `bw-borrador-respuesta` solo hace la llamada.
 *
 * La regla de oro es la misma que en el Nivel 2 y por el mismo motivo: el
 * borrador **no responde nada clínico ni cotiza precios**. La diferencia es que
 * acá, además, hay una persona revisando — pero un borrador que propone algo
 * incorrecto igual es peligroso: se lee rápido y se manda.
 */
import { CENTRO_DIRECCION, LINKS_PRECIOS } from '../config/auto-respuesta.js';
import { SENA } from '../config/reglas.js';
import { textoHorarioSemanal } from './auto-respuesta.js';

/** Cuando el modelo decide que esto lo tiene que contestar una persona. */
export const SIN_BORRADOR = 'SIN_BORRADOR';

/** Un mensaje del hilo, ya reducido a lo que el modelo necesita ver. */
export interface MensajeHilo {
  de: 'paciente' | 'recepcion';
  texto: string;
  /** Fecha ISO, para que el modelo entienda los tiempos de la conversación. */
  cuandoISO?: string;
  /** true si lo escribió el sistema (auto-respuesta), no una persona. */
  automatico?: boolean;
}

/**
 * Lo que Recepción ve del paciente. **Nunca** historia clínica: el screening y
 * las contraindicaciones no pasan por el mostrador (CLAUDE.md, principio 3) y
 * mucho menos por un modelo que redacta mensajes.
 */
export interface ContextoPaciente {
  nombre?: string;
  /** Próximo turno en palabras ("el jueves, 03/09 15:00 · HBOT"). */
  proximoTurno?: string;
  /** Plan activo y sesiones que le quedan. */
  plan?: { nombre: string; sesionesRestantes?: number };
  /** Saldo pendiente en ARS (Invoice `issued`). */
  saldoARS?: number;
  /** ¿Firmó el consentimiento? Señal binaria, nunca el documento. */
  consentimientoFirmado?: boolean;
  /** Bloqueado para reservar por cuota impaga (R-11). */
  bloqueadoPorPago?: boolean;
}

/**
 * El system prompt. Se arma con los datos reales del centro para que el modelo
 * no invente horarios ni direcciones: si Andrés cambia el horario, el prompt
 * cambia solo.
 */
export function systemBorrador(): string {
  return [
    'Sos el asistente de la recepción de BIOWELLNESS, un centro de optimización biológica en San Isidro, Buenos Aires.',
    '',
    'Tu tarea: redactar el BORRADOR de la respuesta que la recepcionista le va a mandar al paciente por WhatsApp.',
    'NO sos vos quien contesta: una persona lee tu borrador, lo corrige si hace falta y lo envía.',
    '',
    '## Cómo escribir',
    '- Español rioplatense (vos, no tú), cálido y breve. Como escribe una recepcionista, no como un folleto.',
    '- 2 a 4 líneas. WhatsApp, no email.',
    '- Sin saludos protocolares largos ni "Estimado/a". Sin firma.',
    '- Devolvé SOLO el texto del mensaje, sin comillas ni encabezados.',
    '',
    '## Lo que NO podés hacer (importante)',
    '- NO des indicaciones médicas, ni opines sobre si una terapia le conviene, ni interpretes síntomas,',
    '  estudios o medicación. Eso lo resuelve el Director Médico, nunca el mostrador.',
    '- NO inventes precios. Si preguntan cuánto sale, mandá el link de la lista.',
    '- NO confirmes turnos, pagos ni excepciones que no estén en el contexto que te doy.',
    '- NO prometas plazos ("te lo resuelvo hoy") ni hables en nombre del médico.',
    '- Si no tenés el dato, decí que Recepción lo confirma. Es mejor que inventarlo.',
    '',
    `Si el mensaje necesita a una persona sí o sí —consulta clínica, reclamo, tema delicado, o no entendés qué piden—`,
    `respondé EXACTAMENTE con "${SIN_BORRADOR}: <motivo en pocas palabras>" y nada más.`,
    '',
    '## Datos del centro (los únicos que podés afirmar)',
    `- Dirección: ${CENTRO_DIRECCION}`,
    `- Horario: ${textoHorarioSemanal()}`,
    `- Lista de precios: ${LINKS_PRECIOS.map((l) => `${l.titulo} ${l.url}`).join(' · ')}`,
    '',
    '## Reglas del negocio que podés mencionar',
    `- Para confirmar un turno se paga una seña del 50%; el lugar se guarda ${SENA.vencimientoHoras} h y después se libera.`,
    '- El 50% restante se abona el día de la sesión.',
    '- Cancelando con 24 h o más de anticipación, la sesión vuelve al plan; sobre la hora se consume.',
    '- Para reservar por primera vez hay que tener el consentimiento firmado y el cuestionario de salud hecho.',
  ].join('\n');
}

/** El contexto del paciente, en el formato que lee el modelo. */
export function textoContexto(ctx: ContextoPaciente): string {
  const lineas: string[] = [`Paciente: ${ctx.nombre ?? '(número no registrado en el sistema)'}`];
  if (ctx.proximoTurno) {
    lineas.push(`Próximo turno: ${ctx.proximoTurno}`);
  } else {
    lineas.push('Próximo turno: no tiene ninguno agendado.');
  }
  if (ctx.plan) {
    lineas.push(
      `Plan activo: ${ctx.plan.nombre}` +
        (ctx.plan.sesionesRestantes === undefined ? '' : ` · le quedan ${ctx.plan.sesionesRestantes} sesiones este ciclo`),
    );
  } else {
    lineas.push('Plan activo: ninguno.');
  }
  if (ctx.saldoARS && ctx.saldoARS > 0) {
    lineas.push(`Saldo pendiente: $${ctx.saldoARS.toLocaleString('es-AR')}.`);
  }
  if (ctx.consentimientoFirmado === false) {
    lineas.push('Consentimiento: NO firmado (no puede reservar hasta firmarlo).');
  }
  if (ctx.bloqueadoPorPago) {
    lineas.push('Atención: tiene una cuota impaga y está bloqueado para reservar hasta regularizar.');
  }
  return lineas.join('\n');
}

/** La conversación, de más vieja a más nueva. */
export function textoHilo(mensajes: MensajeHilo[]): string {
  return mensajes
    .map((m) => {
      const quien = m.de === 'paciente' ? 'PACIENTE' : m.automatico ? 'SISTEMA (automático)' : 'RECEPCIÓN';
      return `${quien}: ${m.texto}`;
    })
    .join('\n');
}

/** El mensaje de usuario completo: contexto + conversación + qué se pide. */
export function promptBorrador(ctx: ContextoPaciente, mensajes: MensajeHilo[]): string {
  return [
    '## Contexto del paciente',
    textoContexto(ctx),
    '',
    '## Conversación',
    textoHilo(mensajes),
    '',
    'Redactá el borrador de la próxima respuesta de Recepción.',
  ].join('\n');
}

export interface ResultadoBorrador {
  /** El texto sugerido. Vacío si el modelo decidió que lo conteste una persona. */
  borrador?: string;
  /** Por qué no hay borrador (para mostrárselo a la recepcionista). */
  motivo?: string;
}

/**
 * Limpia y valida lo que devolvió el modelo.
 *
 * Hace tres cosas: reconoce el caso "esto lo tiene que contestar una persona",
 * saca las comillas que a veces envuelven la respuesta, y corta un borrador
 * desmedido — en WhatsApp, un texto larguísimo se manda sin leer.
 */
export function limpiarBorrador(salida: string | undefined, maxCaracteres = 900): ResultadoBorrador {
  const texto = (salida ?? '').trim();
  if (!texto) {
    return { motivo: 'El asistente no devolvió nada.' };
  }
  if (texto.toUpperCase().startsWith(SIN_BORRADOR)) {
    const motivo = texto.slice(SIN_BORRADOR.length).replace(/^[:\s-]+/, '').trim();
    return { motivo: motivo || 'Conviene que lo conteste una persona.' };
  }
  // Algunos modelos envuelven la respuesta en comillas: quedarían en el WhatsApp.
  const sinComillas = texto.replace(/^["'«“]+/, '').replace(/["'»”]+$/, '').trim();
  return {
    borrador: sinComillas.length > maxCaracteres ? `${sinComillas.slice(0, maxCaracteres).trimEnd()}…` : sinComillas,
  };
}
