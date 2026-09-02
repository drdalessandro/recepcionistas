/**
 * Propuesta de reserva para la cola de Solicitudes — lógica pura (sin FHIR, sin red).
 *
 * Nivel 4 de los asistentes de Recepción (ver `docs/agente-solicitudes.md`): el
 * sistema **propone** la reserva concreta para una solicitud del portal
 * (servicio, horario, personas); la recepcionista **confirma con un botón** y
 * la reserva la hace `bw-reservar-turno` con las reglas de siempre. El
 * asistente nunca escribe en la agenda.
 *
 * Acá vive todo lo que se testea sin llamar al modelo: qué se le muestra (la
 * ficha resumida, la solicitud y los horarios REALES entre los que puede
 * elegir), el esquema de lo que tiene que devolver, y —lo más importante— la
 * validación de esa respuesta contra la oferta: un horario que no está en la
 * lista no se propone, venga como venga. El bot `bw-proponer-reserva` solo
 * arma la oferta y hace la llamada.
 *
 * Mismas dos prohibiciones que el borrador (Nivel 3), por el mismo motivo:
 * **nada clínico** y **ningún precio inventado**. Y una tercera, propia: el
 * modelo no elige horarios, elige ENTRE horarios.
 */
import { textoContexto, type ContextoPaciente } from './borrador.js';
import type { DiaDisponible } from './disponibilidad.js';

/** Cuando el modelo decide que esto lo tiene que resolver una persona. */
export const SIN_PROPUESTA = 'SIN_PROPUESTA';

/** Largo máximo del motivo que se le muestra a Recepción. */
export const MAX_MOTIVO = 320;

/** La solicitud del portal, ya reducida a lo que el modelo necesita ver. */
export interface SolicitudResumida {
  /** Terapia tal como la vio el paciente ("Cámara hiperbárica (HBOT)"). */
  terapia: string;
  terapiaCodigo?: string;
  /** Horario exacto elegido de los chips, si lo eligió. ISO con -03:00. */
  preferenciaInicioISO?: string;
  /** Preferencia en texto libre ("jueves a la tarde, vengo con mi marido"). */
  preferenciaTexto?: string;
  nota?: string;
  /** Cuándo la pidió, ISO. */
  pedidaEnISO?: string;
}

/** Un servicio entre los que el modelo puede elegir, con sus horarios reales. */
export interface ServicioOfrecido {
  codigo: string;
  nombre: string;
  duracionMin: number;
  /** Personas máximas en UNA reserva (capacidad de la sala más grande de la categoría). */
  capacidadMax: number;
  /** Sesión grupal (Multiplaza): cada chip trae `lugares`. */
  grupal: boolean;
  /** Chips reales del portal para ESTE paciente (ventana R-13, R-07, R-22). */
  dias: DiaDisponible[];
}

/** Todo lo que se le muestra al modelo para una solicitud. */
export interface OfertaPropuesta {
  ahoraISO: string;
  paciente: ContextoPaciente;
  solicitud: SolicitudResumida;
  servicios: ServicioOfrecido[];
  /** Inicios (ISO) que Recepción ya descartó con "Otra opción". */
  excluir?: string[];
}

/** Lo que el modelo devuelve (estructurado; ver `SCHEMA_SALIDA`). */
export interface SalidaModelo {
  decision: 'propuesta' | 'sin_propuesta';
  servicioCodigo?: string;
  /** ISO exacto, copiado de la lista. */
  inicio?: string;
  ocupantes?: number;
  /** Para Recepción: qué pidió, qué se propone y por qué. 1–2 frases. */
  motivo: string;
  /** Hasta 2 inicios ISO más, también de la lista, por si el primero no sirve. */
  alternativas?: string[];
}

/** JSON Schema de la salida: el modelo no puede devolver otra forma. */
export const SCHEMA_SALIDA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'motivo'],
  properties: {
    decision: { type: 'string', enum: ['propuesta', 'sin_propuesta'] },
    servicioCodigo: { type: 'string' },
    inicio: { type: 'string' },
    ocupantes: { type: 'integer', minimum: 1, maximum: 6 },
    motivo: { type: 'string' },
    alternativas: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  },
} as const;

/** Propuesta que pasó la validación contra la oferta: lista para el botón Reservar. */
export interface PropuestaValidada {
  servicioCodigo: string;
  inicio: string;
  ocupantes: number;
  motivo: string;
  alternativas: string[];
}

export type ResultadoValidacionPropuesta = { ok: true; propuesta: PropuestaValidada } | { ok: false; motivo: string };

const fmtHora = new Intl.DateTimeFormat('es-AR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});
const fmtFechaLarga = new Intl.DateTimeFormat('es-AR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/**
 * "jueves 03/09" a partir de "YYYY-MM-DD" (fecha argentina). A mano y no con
 * Intl: el separador de fecha de es-AR cambia según la ICU del runtime
 * ("03/09" o "03-09"), y este texto lo lee el modelo y lo ve Recepción.
 */
export function diaLegible(fechaISO: string): string {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const dia = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return `${DIAS[dia]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

/** "16:00" a partir de un ISO. */
export function horaLegible(iso: string): string {
  return fmtHora.format(new Date(iso));
}

/**
 * El system prompt. Igual que el del borrador, trae las reglas que el modelo
 * tiene que respetar y la salida de escape para lo que decide una persona.
 */
export function systemPropuesta(): string {
  return [
    'Sos el asistente de la recepción de BIOWELLNESS, un centro de optimización biológica en San Isidro, Buenos Aires.',
    'Tu única tarea: para una SOLICITUD de turno que un paciente hizo desde el portal, proponerle a la recepcionista la reserva concreta (servicio, horario y cantidad de personas), eligiendo ENTRE los horarios disponibles que te damos. La recepcionista decide y confirma con un botón; vos nunca reservás.',
    '',
    'REGLAS DURAS:',
    '- Elegí SOLO un horario de la lista de disponibles, copiando su ISO exacto en `inicio`. NO inventes horarios ni los calcules: si un horario no está listado, no existe.',
    '- Elegí el servicio SOLO entre los ofrecidos (`servicioCodigo` exacto).',
    '- NO des indicaciones médicas ni opines sobre nada clínico. Si la solicitud menciona un tema de salud (medicación, embarazo, cirugía, marcapasos, síntomas…), no propongas: devolvé `sin_propuesta` y decí que lo vea una persona.',
    '- NO inventes precios, descuentos ni condiciones. No hables de plata.',
    '- NO prometas nada al paciente: tu texto lo lee la recepcionista, no el paciente.',
    '',
    'CÓMO ELEGIR:',
    '- Si el paciente eligió un horario exacto y está en la lista, ese. Si no está, el más cercano del mismo día; si el día no tiene nada, el más cercano en un día próximo, y decilo.',
    '- Si pidió en texto libre ("jueves a la tarde"): mañana = 08:00 a 12:00, tarde = 13:00 a 19:00, noche = 19:00 en adelante. Elegí el primer horario libre de esa franja; si esa franja no tiene nada, la más cercana y decilo.',
    '- Personas: "con mi pareja/marido/mujer/amigo" = 2 personas. Respetá el máximo de personas de cada servicio; si son 2 y hay un servicio para 2 (biplaza), ese.',
    '- Sesión grupal (`lugares`): proponé solo si quedan lugares para las personas pedidas.',
    '- Si el paciente ya tiene un turno agendado de lo mismo el mismo día, no propongas otro: `sin_propuesta`.',
    '- Si la solicitud no se entiende, pide otra cosa que no está ofrecida, o no hay ningún horario que tenga sentido con lo que pidió, devolvé `sin_propuesta` con el motivo en una frase.',
    '',
    'SALIDA:',
    '- `motivo`: 1 o 2 frases en castellano rioplatense, dirigidas a la recepcionista, en tercera persona sobre el paciente: qué pidió, qué proponés y por qué (ej. "Pidió jueves a la tarde con su marido: el jueves 03/09 a las 16:00 está libre la Biplaza."). Máximo 300 caracteres.',
    '- `alternativas`: hasta 2 horarios más de la lista, por si el primero no le sirve a Recepción. Pueden ir vacías.',
    `- Si no proponés nada, \`decision\` = "sin_propuesta" y el motivo explica por qué (${SIN_PROPUESTA}).`,
  ].join('\n');
}

/** La solicitud, en palabras. */
export function textoSolicitud(s: SolicitudResumida): string {
  const lineas = [`Terapia pedida: ${s.terapia}${s.terapiaCodigo ? ` (${s.terapiaCodigo})` : ''}`];
  if (s.preferenciaInicioISO) {
    lineas.push(`Horario elegido en el portal: ${diaLegible(s.preferenciaInicioISO.slice(0, 10))} ${horaLegible(s.preferenciaInicioISO)} (${s.preferenciaInicioISO})`);
  }
  if (s.preferenciaTexto) {
    lineas.push(`Preferencia en sus palabras: "${s.preferenciaTexto}"`);
  }
  if (s.nota) {
    lineas.push(`Nota del paciente: "${s.nota}"`);
  }
  if (!s.preferenciaInicioISO && !s.preferenciaTexto) {
    lineas.push('No indicó horario: cualquiera de los disponibles, el más próximo.');
  }
  if (s.pedidaEnISO) {
    lineas.push(`Pedida el ${fmtFechaLarga.format(new Date(s.pedidaEnISO))}.`);
  }
  return lineas.join('\n');
}

/** Los horarios reales, por servicio y por día, con el ISO exacto de cada uno. */
export function textoOferta(servicios: ServicioOfrecido[], excluir: string[] = []): string {
  const fuera = new Set(excluir);
  const bloques: string[] = [];
  for (const s of servicios) {
    const cab = `${s.codigo} — ${s.nombre} (${s.duracionMin} min, hasta ${s.capacidadMax} persona${s.capacidadMax === 1 ? '' : 's'}${s.grupal ? ', sesión grupal por asiento' : ''})`;
    const dias: string[] = [];
    for (const d of s.dias) {
      const chips = d.horarios.filter((h) => !fuera.has(h.inicio));
      if (chips.length === 0) {
        continue;
      }
      const lista = chips
        .map((h) => `${horaLegible(h.inicio)} → ${h.inicio}${h.lugares !== undefined ? ` (${h.lugares} lugares)` : ''}`)
        .join(' · ');
      dias.push(`  ${diaLegible(d.fecha)}: ${lista}`);
    }
    bloques.push(dias.length > 0 ? `${cab}\n${dias.join('\n')}` : `${cab}\n  (sin horarios disponibles en su ventana de reserva)`);
  }
  return bloques.join('\n\n');
}

/** El prompt de usuario: contexto real + solicitud + oferta. */
export function promptPropuesta(oferta: OfertaPropuesta): string {
  return [
    `Hoy es ${fmtFechaLarga.format(new Date(oferta.ahoraISO))} (hora de Argentina).`,
    '',
    'FICHA DEL PACIENTE (lo que Recepción ve en pantalla):',
    textoContexto(oferta.paciente),
    '',
    'SOLICITUD:',
    textoSolicitud(oferta.solicitud),
    '',
    'HORARIOS DISPONIBLES PARA ESTE PACIENTE (únicos válidos; copiá el ISO exacto):',
    textoOferta(oferta.servicios, oferta.excluir),
    ...(oferta.excluir?.length
      ? ['', `Recepción ya descartó estos inicios, no los vuelvas a proponer: ${oferta.excluir.join(', ')}`]
      : []),
    '',
    'Devolvé la propuesta.',
  ].join('\n');
}

function chipsDe(servicio: ServicioOfrecido): Map<string, { lugares?: number }> {
  const m = new Map<string, { lugares?: number }>();
  for (const d of servicio.dias) {
    for (const h of d.horarios) {
      m.set(h.inicio, { ...(h.lugares !== undefined ? { lugares: h.lugares } : {}) });
    }
  }
  return m;
}

function recortarMotivo(motivo: unknown, fallback: string): string {
  const t = typeof motivo === 'string' ? motivo.trim().replace(/\s+/g, ' ') : '';
  const base = t || fallback;
  return base.length > MAX_MOTIVO ? `${base.slice(0, MAX_MOTIVO - 1)}…` : base;
}

/**
 * Valida lo que devolvió el modelo CONTRA la oferta. Falla cerrado: un
 * servicio no ofrecido, un horario que no está en la lista (o que Recepción
 * excluyó), más personas de las que entran, o un JSON raro, y no hay
 * propuesta — se le dice a Recepción que la resuelva a mano. Las alternativas
 * se filtran con el mismo criterio en vez de rechazar todo.
 */
export function validarSalida(salida: unknown, oferta: OfertaPropuesta): ResultadoValidacionPropuesta {
  const aMano = 'El asistente propuso algo que no está disponible: resolvela a mano.';
  if (!salida || typeof salida !== 'object') {
    return { ok: false, motivo: aMano };
  }
  const s = salida as Partial<SalidaModelo>;
  if (s.decision === 'sin_propuesta') {
    return { ok: false, motivo: recortarMotivo(s.motivo, 'El asistente prefirió no proponer: mejor resolvela vos.') };
  }
  if (s.decision !== 'propuesta' || typeof s.servicioCodigo !== 'string' || typeof s.inicio !== 'string') {
    return { ok: false, motivo: aMano };
  }
  const servicio = oferta.servicios.find((x) => x.codigo === s.servicioCodigo);
  if (!servicio) {
    return { ok: false, motivo: aMano };
  }
  const fuera = new Set(oferta.excluir ?? []);
  const chips = chipsDe(servicio);
  const chip = chips.get(s.inicio);
  if (!chip || fuera.has(s.inicio)) {
    return { ok: false, motivo: aMano };
  }
  const ocupantes = s.ocupantes === undefined ? 1 : s.ocupantes;
  if (!Number.isInteger(ocupantes) || ocupantes < 1 || ocupantes > servicio.capacidadMax) {
    return { ok: false, motivo: aMano };
  }
  if (servicio.grupal && chip.lugares !== undefined && ocupantes > chip.lugares) {
    return { ok: false, motivo: aMano };
  }
  const alternativas = [...new Set(Array.isArray(s.alternativas) ? s.alternativas : [])]
    .filter((a): a is string => typeof a === 'string' && a !== s.inicio && chips.has(a) && !fuera.has(a))
    .slice(0, 2);
  return {
    ok: true,
    propuesta: {
      servicioCodigo: servicio.codigo,
      inicio: s.inicio,
      ocupantes,
      motivo: recortarMotivo(s.motivo, `Propuesta: ${servicio.nombre}, ${diaLegible(s.inicio.slice(0, 10))} ${horaLegible(s.inicio)}.`),
      alternativas,
    },
  };
}

/** Parsea el texto del modelo como JSON; `undefined` si no es JSON. */
export function parsearSalida(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return undefined;
  }
}
