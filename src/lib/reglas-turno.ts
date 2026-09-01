/**
 * Motor de reglas de agenda / validación de turnos (Documento de Requerimientos §7).
 * Funciones puras: reciben datos planos y devuelven un resultado de validación.
 *
 * Reglas cubiertas:
 *  R-01 HBOT siempre primero            R-07 Desfasaje de recursos compartidos
 *  R-02 Contraindicaciones              R-10 Saldo de membresía
 *  R-03 Prescripción médica (IV/TB)     R-13 Ventana de reserva
 *                                       R-14 Cancelación / reagenda
 *                                       R-22 Grilla comercial (turnos en punto)
 */
import type { CategoriaServicio, Combo, Servicio } from '../domain/types.js';
import { getServicio } from '../config/catalogo.js';
import { CONTRAINDICACIONES_POR_CODIGO } from '../config/contraindicaciones.js';
import { RECURSOS_POR_CODIGO, compartenEquipo } from '../config/recursos.js';
import { CANCELACION, VENTANA_RESERVA_HORAS, grillaTurnoMin, type PerfilReserva } from '../config/reglas.js';

export type NivelValidacion = 'ok' | 'advertencia' | 'bloqueo';

export interface Issue {
  regla: string;
  nivel: 'advertencia' | 'bloqueo';
  mensaje: string;
}

export interface ResultadoValidacion {
  ok: boolean;
  bloqueos: Issue[];
  advertencias: Issue[];
}

function resultado(issues: Issue[]): ResultadoValidacion {
  const bloqueos = issues.filter((i) => i.nivel === 'bloqueo');
  const advertencias = issues.filter((i) => i.nivel === 'advertencia');
  return { ok: bloqueos.length === 0, bloqueos, advertencias };
}

const HORA_MS = 60 * 60 * 1000;

// --------------------------------------------------------------------------
// R-02 · Contraindicaciones y banner de seguridad
// --------------------------------------------------------------------------

export type ColorBanner = 'verde' | 'rojo';

/**
 * Banner de seguridad que ve la recepción: rojo si el paciente tiene alguna
 * contraindicación activa (de cualquier severidad), verde si no tiene ninguna.
 * La recepción NO ve el detalle clínico, solo el color.
 */
export function bannerSeguridad(contraindicacionesActivas: string[]): ColorBanner {
  return contraindicacionesActivas.length > 0 ? 'rojo' : 'verde';
}

/**
 * R-02: un turno con contraindicación ABSOLUTA activa para su categoría no se
 * confirma sin autorización médica explícita registrada. Las relativas advierten.
 */
export function validarContraindicaciones(
  categorias: CategoriaServicio[],
  contraindicacionesActivas: string[],
  opts: { autorizacionMedica?: boolean } = {},
): ResultadoValidacion {
  const issues: Issue[] = [];
  for (const codigo of contraindicacionesActivas) {
    const c = CONTRAINDICACIONES_POR_CODIGO.get(codigo);
    if (!c) {
      continue;
    }
    const afecta = c.aplicaA.some((cat) => categorias.includes(cat));
    if (!afecta) {
      continue;
    }
    if (c.severidad === 'absoluta' && !opts.autorizacionMedica) {
      issues.push({
        regla: 'R-02',
        nivel: 'bloqueo',
        mensaje: `Contraindicación absoluta activa (${c.codigo}). Requiere autorización médica explícita.`,
      });
    } else if (c.severidad === 'relativa') {
      issues.push({
        regla: 'R-02',
        nivel: 'advertencia',
        mensaje: `Contraindicación relativa activa (${c.codigo}). Revisar con el equipo médico.`,
      });
    }
  }
  return resultado(issues);
}

// --------------------------------------------------------------------------
// R-03 · Prescripción médica (IV / Terapias Biológicas)
// --------------------------------------------------------------------------

/** IV Therapy y Terapias Biológicas no se ejecutan sin prescripción activa. */
export function validarPrescripcion(servicio: Servicio, prescripcionActiva: boolean): ResultadoValidacion {
  if (servicio.requierePrescripcion && !prescripcionActiva) {
    return resultado([
      {
        regla: 'R-03',
        nivel: 'bloqueo',
        mensaje: `"${servicio.nombre}" requiere prescripción médica activa (Dalessandro / Dos Santos).`,
      },
    ]);
  }
  return resultado([]);
}

/**
 * Terapias Biológicas (péptidos, PRP, exosomas…) además de la indicación
 * requieren CONSENTIMIENTO INFORMADO firmado antes de reservar (Andrés,
 * 2026-08-09): evidencia científica débil, se venden con mucho cuidado. El
 * responsable principal es el médico que indica; luego el Director Médico.
 * El documento firmado se archiva en la historia clínica (lado Panel Bio);
 * recepción solo declara que existe — nunca ve el contenido.
 */
/**
 * R-20 · Ninguna terapia se reserva sin **consentimiento general firmado** y
 * **cuestionario de ingreso completo**. Decisión de Andrés (2026-08-14), a raíz
 * del recorrido del walk-in: el portal ya bloqueaba las dos cosas, pero el
 * mostrador no las pedía — y el walk-in ES el mostrador.
 *
 * Es distinto de R-03, que exige consentimiento **específico de TB** y admite la
 * declaración de Recepción. R-20 aplica a TODAS las categorías y **no admite
 * override**: sin firma y sin screening no hay reserva.
 *
 * Falla CERRADO: `undefined` (no se pudo verificar) bloquea igual que `false`.
 * Los mensajes se distinguen a propósito — "todavía no lo hizo" manda a
 * completarlo; "no pudimos verificar" es un problema nuestro que hay que escalar.
 */
export function validarAptitudPaciente(opts: {
  /** ¿Firmó el consentimiento general de atención? `undefined` = no verificable. */
  consentimientoGeneralFirmado?: boolean;
  /** ¿Completó el cuestionario de ingreso (screening)? `undefined` = no verificable. */
  screeningCompleto?: boolean;
}): ResultadoValidacion {
  const bloqueos: Issue[] = [];

  if (opts.consentimientoGeneralFirmado === undefined) {
    bloqueos.push({
      regla: 'R-20',
      nivel: 'bloqueo',
      mensaje:
        'No pudimos verificar el consentimiento informado del paciente. No se reserva sin confirmarlo (escalá al equipo).',
    });
  } else if (!opts.consentimientoGeneralFirmado) {
    bloqueos.push({
      regla: 'R-20',
      nivel: 'bloqueo',
      mensaje:
        'El paciente todavía no firmó el consentimiento informado. Invitalo al portal desde "Invitar al portal" y que lo firme antes de reservar.',
    });
  }

  if (opts.screeningCompleto === undefined) {
    bloqueos.push({
      regla: 'R-20',
      nivel: 'bloqueo',
      mensaje:
        'No pudimos verificar el cuestionario de ingreso del paciente. No se reserva sin confirmarlo (escalá al equipo).',
    });
  } else if (!opts.screeningCompleto) {
    bloqueos.push({
      regla: 'R-20',
      nivel: 'bloqueo',
      mensaje:
        'El paciente todavía no completó el cuestionario de ingreso, así que no sabemos si puede recibir esta terapia. Que lo complete en el portal antes de reservar.',
    });
  }

  return resultado(bloqueos);
}

export function validarConsentimientoTB(servicio: Servicio, consentimientoFirmado: boolean): ResultadoValidacion {
  if (servicio.categoria === 'TERAPIA_BIOLOGICA' && !consentimientoFirmado) {
    return resultado([
      {
        regla: 'R-03',
        nivel: 'bloqueo',
        mensaje: `"${servicio.nombre}" requiere consentimiento informado firmado (responsable: el médico que indica; luego el Director Médico).`,
      },
    ]);
  }
  return resultado([]);
}

// --------------------------------------------------------------------------
// R-01 · HBOT siempre primero
// --------------------------------------------------------------------------

/**
 * En una secuencia de componentes (p. ej. un combo), si hay HBOT debe ir primero.
 * @param categoriasEnOrden categorías en el orden en que se ejecutan.
 */
export function validarOrdenHBOT(categoriasEnOrden: CategoriaServicio[]): ResultadoValidacion {
  const idx = categoriasEnOrden.indexOf('HBOT');
  if (idx > 0) {
    return resultado([
      {
        regla: 'R-01',
        nivel: 'bloqueo',
        mensaje: 'La sesión de HBOT debe agendarse primero en la secuencia.',
      },
    ]);
  }
  return resultado([]);
}

/**
 * Recomendación (no bloqueante) de HBOT previo a IV/TB. El Manual lo marca como
 * "altamente recomendable, no obligatorio"; por eso es advertencia, no bloqueo.
 */
export function recomendarHbotPrevio(categoria: CategoriaServicio, huboHbotPrevio: boolean): ResultadoValidacion {
  if ((categoria === 'IV_THERAPY' || categoria === 'TERAPIA_BIOLOGICA') && !huboHbotPrevio) {
    return resultado([
      {
        regla: 'R-01',
        nivel: 'advertencia',
        mensaje: 'Se recomienda una sesión de HBOT previa para máxima efectividad.',
      },
    ]);
  }
  return resultado([]);
}

// --------------------------------------------------------------------------
// R-07 · Capacidad por recurso y desfasaje de equipos compartidos
// --------------------------------------------------------------------------

export interface ReservaRecurso {
  recursoCodigo: string;
  inicio: Date;
  fin: Date;
  /** Personas que trae ESTA reserva (default 1). Multiplaza suma por personas. */
  ocupantes?: number;
  etiqueta?: string;
}

/**
 * Peso de una reserva contra la capacidad del recurso, en personas.
 * Se acota a la capacidad: una reserva nunca pesa más que el puesto entero
 * (p. ej. IHHT pareja —ocupantes 2— sobre un puesto de capacidad 1 lo llena).
 */
function pesoPersonas(r: ReservaRecurso, capacidad: number): number {
  return Math.min(Math.max(r.ocupantes ?? 1, 1), capacidad);
}

/** Máximo simultáneo (barrido), pesando cada reserva con `peso(r)`. */
function maxConcurrentes(reservas: ReservaRecurso[], peso: (r: ReservaRecurso) => number = () => 1): number {
  const eventos: Array<{ t: number; delta: number }> = [];
  for (const r of reservas) {
    const p = peso(r);
    eventos.push({ t: r.inicio.getTime(), delta: p });
    eventos.push({ t: r.fin.getTime(), delta: -p });
  }
  // Cierres antes que aperturas al mismo instante (un turno termina justo cuando otro arranca).
  eventos.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let actual = 0;
  let max = 0;
  for (const e of eventos) {
    actual += e.delta;
    if (actual > max) {
      max = actual;
    }
  }
  return max;
}

/**
 * No se puede exceder la capacidad de un recurso físico en una franja.
 * - Recursos de RESERVA EXCLUSIVA (Biplaza, gabinetes Recovery): una reserva
 *   toma el recurso completo; la segunda que solape bloquea, sin importar personas.
 * - Resto (Multiplaza cap 6): se suman las PERSONAS (`ocupantes`) de las
 *   reservas solapadas contra la capacidad.
 */
export function validarCapacidadRecurso(reservas: ReservaRecurso[]): ResultadoValidacion {
  const issues: Issue[] = [];
  const porRecurso = new Map<string, ReservaRecurso[]>();
  for (const r of reservas) {
    const arr = porRecurso.get(r.recursoCodigo) ?? [];
    arr.push(r);
    porRecurso.set(r.recursoCodigo, arr);
  }
  for (const [codigo, arr] of porRecurso) {
    const recurso = RECURSOS_POR_CODIGO.get(codigo);
    const capacidad = recurso?.capacidad ?? 1;
    if (recurso?.reservaExclusiva) {
      if (maxConcurrentes(arr) > 1) {
        issues.push({
          regla: 'R-07',
          nivel: 'bloqueo',
          mensaje: `${recurso.nombre} es de reserva exclusiva: ya hay una reserva en esa franja.`,
        });
      }
    } else if (maxConcurrentes(arr, (r) => pesoPersonas(r, capacidad)) > capacidad) {
      issues.push({
        regla: 'R-07',
        nivel: 'bloqueo',
        mensaje: `Se excede la capacidad del recurso ${codigo} (máx ${capacidad} personas).`,
      });
    }
  }
  return resultado(issues);
}

/**
 * Personas anotadas en un recurso dentro de una franja: suma de `ocupantes` de
 * las reservas que solapan, cada una acotada a la capacidad del recurso. Lo usan
 * el mínimo grupal (abajo) y la disponibilidad del portal (Multiplaza: "ya somos N").
 */
export function personasEnFranja(
  reservas: ReservaRecurso[],
  recursoCodigo: string,
  inicio: Date,
  fin: Date,
): number {
  const capacidad = RECURSOS_POR_CODIGO.get(recursoCodigo)?.capacidad ?? 1;
  return reservas
    .filter((r) => r.recursoCodigo === recursoCodigo && r.inicio < fin && inicio < r.fin)
    .reduce((acc, r) => acc + pesoPersonas(r, capacidad), 0);
}

/**
 * Mínimo operativo de una sesión grupal (Multiplaza: 3 personas, del Manual).
 * NO bloquea: advierte a la recepción que la sesión todavía no llega al mínimo,
 * contando las personas de todas las reservas que solapan la franja de `nueva`.
 */
export function validarMinimoGrupal(reservas: ReservaRecurso[], nueva: ReservaRecurso): ResultadoValidacion {
  const recurso = RECURSOS_POR_CODIGO.get(nueva.recursoCodigo);
  const minimo = recurso?.minimoPersonas;
  if (!recurso || !minimo) {
    return resultado([]);
  }
  const personas = personasEnFranja(reservas, nueva.recursoCodigo, nueva.inicio, nueva.fin);
  if (personas < minimo) {
    return resultado([
      {
        regla: 'R-07',
        nivel: 'advertencia',
        mensaje: `${recurso.nombre}: la sesión necesita mínimo ${minimo} personas y por ahora hay ${personas}. Se reserva igual; confirmar el aforo antes de la sesión.`,
      },
    ]);
  }
  return resultado([]);
}

/** Offset mínimo de inicio entre gabinetes que comparten tumbonas (Recovery Pro). */
export const DESFASAJE_RECOVERY_MIN = 30;

/**
 * R-07 (AC-05): dos reservas en recursos que comparten equipo (los gabinetes
 * Recovery Pro comparten las 2 tumbonas Red Light) NO pueden arrancar a la misma
 * hora; deben desfasarse al menos `DESFASAJE_RECOVERY_MIN` minutos. No alcanza con
 * no solaparse: el cuello de botella es la sub-fase de Red Light.
 * Ej.: G1 09:00 y G2 09:00 => bloqueo; G1 09:00 y G2 09:30 => OK.
 */
export function validarDesfasajeRecovery(reservas: ReservaRecurso[]): ResultadoValidacion {
  const issues: Issue[] = [];
  const offsetMs = DESFASAJE_RECOVERY_MIN * 60 * 1000;
  for (let i = 0; i < reservas.length; i++) {
    for (let j = i + 1; j < reservas.length; j++) {
      const a = reservas[i]!;
      const b = reservas[j]!;
      // Mismo recurso => lo cubre validarCapacidadRecurso. Acá: distintos recursos que comparten equipo.
      if (a.recursoCodigo === b.recursoCodigo || !compartenEquipo(a.recursoCodigo, b.recursoCodigo)) {
        continue;
      }
      const diff = Math.abs(a.inicio.getTime() - b.inicio.getTime());
      if (diff < offsetMs) {
        issues.push({
          regla: 'R-07',
          nivel: 'bloqueo',
          mensaje: `${a.recursoCodigo} y ${b.recursoCodigo} comparten equipo: deben desfasarse al menos ${DESFASAJE_RECOVERY_MIN} min.`,
        });
      }
    }
  }
  return resultado(issues);
}

/** Valida capacidad + desfasaje de equipos compartidos en un solo paso. */
export function validarRecursos(reservas: ReservaRecurso[]): ResultadoValidacion {
  return combinar(validarCapacidadRecurso(reservas), validarDesfasajeRecovery(reservas));
}

// --------------------------------------------------------------------------
// R-13 · Ventana de reserva (anticipación máxima)
// --------------------------------------------------------------------------

export function validarVentanaReserva(
  perfil: PerfilReserva,
  ahora: Date,
  inicioTurno: Date,
): ResultadoValidacion {
  const anticipacionHoras = (inicioTurno.getTime() - ahora.getTime()) / HORA_MS;
  if (anticipacionHoras < 0) {
    return resultado([{ regla: 'R-13', nivel: 'bloqueo', mensaje: 'El turno está en el pasado.' }]);
  }
  const maxHoras = VENTANA_RESERVA_HORAS[perfil];
  if (anticipacionHoras > maxHoras) {
    return resultado([
      {
        regla: 'R-13',
        nivel: 'bloqueo',
        mensaje: `Excede la ventana de reserva de ${maxHoras} h para el perfil ${perfil}.`,
      },
    ]);
  }
  return resultado([]);
}

// --------------------------------------------------------------------------
// R-22 · Grilla comercial de inicio (turnos por hora, en punto)
// --------------------------------------------------------------------------

/**
 * R-22: todos los turnos arrancan a la hora en punto; Recovery Pro es la única
 * excepción (en punto o a la media, por el desfasaje de gabinetes de R-07).
 * Para un combo se valida con el servicio del PRIMER componente: la grilla es
 * del inicio del turno, los tramos internos siguen encadenándose cada 30.
 */
export function validarGrillaTurno(servicio: Pick<Servicio, 'nombre' | 'categoria'>, inicio: Date): ResultadoValidacion {
  const grilla = grillaTurnoMin(servicio.categoria);
  // Minuto del día en hora de Argentina (UTC-3 fijo, sin DST).
  const local = new Date(inicio.getTime() - 3 * HORA_MS);
  const minutoDelDia = local.getUTCHours() * 60 + local.getUTCMinutes();
  const desalineado =
    local.getUTCSeconds() !== 0 || local.getUTCMilliseconds() !== 0 || minutoDelDia % grilla !== 0;
  if (desalineado) {
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const mm = String(local.getUTCMinutes()).padStart(2, '0');
    return resultado([
      {
        regla: 'R-22',
        nivel: 'bloqueo',
        mensaje:
          grilla === 60
            ? `${servicio.nombre} arranca a la hora en punto: ${hh}:${mm} no es un inicio válido.`
            : `${servicio.nombre} arranca en punto o a la media: ${hh}:${mm} no es un inicio válido.`,
      },
    ]);
  }
  return resultado([]);
}

/** Grilla de inicio de un combo (R-22): la de su primer componente. */
export function grillaTurnoDeCombo(combo: Combo): number {
  const primero = combo.componentes[0];
  return grillaTurnoMin(primero ? getServicio(primero.servicioCodigo).categoria : '');
}

/** R-22 para un combo: se valida el inicio del turno con el mensaje a nombre del combo. */
export function validarGrillaCombo(combo: Combo, inicio: Date): ResultadoValidacion {
  const primero = combo.componentes[0];
  const categoria = primero ? getServicio(primero.servicioCodigo).categoria : ('HBOT' as CategoriaServicio);
  return validarGrillaTurno({ nombre: combo.nombre, categoria }, inicio);
}

// --------------------------------------------------------------------------
// R-14 · Cancelación / reagenda
// --------------------------------------------------------------------------

export interface ResultadoCancelacion {
  /** Horas que faltan para el turno. */
  horasRestantes: number;
  /** Con menos de 24 h, la sesión se considera consumida. */
  consumeSesion: boolean;
  /** Con 24 h o más, se devuelve el saldo. */
  devuelveSaldo: boolean;
}

/**
 * Evalúa una cancelación. Con < 24 h la sesión se consume, salvo fuerza mayor
 * médica documentada (autorizable por un médico).
 */
export function evaluarCancelacion(
  ahora: Date,
  inicioTurno: Date,
  opts: { fuerzaMayorMedica?: boolean } = {},
): ResultadoCancelacion {
  const horasRestantes = (inicioTurno.getTime() - ahora.getTime()) / HORA_MS;
  const dentroDeVentana = horasRestantes >= CANCELACION.minHoras;
  const consumeSesion = !dentroDeVentana && !opts.fuerzaMayorMedica;
  return {
    horasRestantes,
    consumeSesion,
    devuelveSaldo: !consumeSesion,
  };
}

// --------------------------------------------------------------------------
// R-10 · Saldo de membresía
// --------------------------------------------------------------------------

export function validarSaldoMembresia(sesionesUsadas: number, sesionesMes: number): ResultadoValidacion {
  if (sesionesUsadas >= sesionesMes) {
    return resultado([
      {
        regla: 'R-10',
        nivel: 'bloqueo',
        mensaje: `Saldo de membresía agotado (${sesionesUsadas}/${sesionesMes} sesiones del mes).`,
      },
    ]);
  }
  return resultado([]);
}

// --------------------------------------------------------------------------
// R-11 · Bloqueo administrativo por pago rechazado (membresía impaga)
// --------------------------------------------------------------------------

/**
 * Si el paciente tiene un bloqueo administrativo activo (Flag del system
 * `bloqueo`, p. ej. por rechazo del cobro de su membresía), NO puede hacer
 * nuevas reservas hasta regularizar el pago (R-11).
 */
export function validarBloqueoAdministrativo(bloqueado: boolean): ResultadoValidacion {
  if (bloqueado) {
    return resultado([
      {
        regla: 'R-11',
        nivel: 'bloqueo',
        mensaje: 'Pagos pendientes de regularizar: el último cobro de la membresía fue rechazado. Regularizar antes de reservar.',
      },
    ]);
  }
  return resultado([]);
}

/** Combina varios resultados en uno solo. */
export function combinar(...resultados: ResultadoValidacion[]): ResultadoValidacion {
  return resultado(resultados.flatMap((r) => [...r.bloqueos, ...r.advertencias]));
}
