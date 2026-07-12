/**
 * Motor de reglas de agenda / validación de turnos (Documento de Requerimientos §7).
 * Funciones puras: reciben datos planos y devuelven un resultado de validación.
 *
 * Reglas cubiertas:
 *  R-01 HBOT siempre primero            R-07 Desfasaje de recursos compartidos
 *  R-02 Contraindicaciones              R-10 Saldo de membresía
 *  R-03 Prescripción médica (IV/TB)     R-13 Ventana de reserva
 *                                       R-14 Cancelación / reagenda
 */
import type { CategoriaServicio, Servicio } from '../domain/types.js';
import { CONTRAINDICACIONES_POR_CODIGO } from '../config/contraindicaciones.js';
import { RECURSOS_POR_CODIGO, compartenEquipo } from '../config/recursos.js';
import { CANCELACION, VENTANA_RESERVA_HORAS, type PerfilReserva } from '../config/reglas.js';

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
  etiqueta?: string;
}

/** Máximo de reservas simultáneas en un conjunto de intervalos (barrido). */
function maxConcurrentes(reservas: ReservaRecurso[]): number {
  const eventos: Array<{ t: number; delta: number }> = [];
  for (const r of reservas) {
    eventos.push({ t: r.inicio.getTime(), delta: 1 });
    eventos.push({ t: r.fin.getTime(), delta: -1 });
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
 * No se puede exceder la capacidad de un mismo recurso físico en una franja.
 * (HBOT multiplaza cap 6, biplaza 2, el resto 1.)
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
    const capacidad = RECURSOS_POR_CODIGO.get(codigo)?.capacidad ?? 1;
    if (maxConcurrentes(arr) > capacidad) {
      issues.push({
        regla: 'R-07',
        nivel: 'bloqueo',
        mensaje: `Se excede la capacidad del recurso ${codigo} (máx ${capacidad}).`,
      });
    }
  }
  return resultado(issues);
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
