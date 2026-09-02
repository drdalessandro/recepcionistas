/**
 * Disponibilidad real para el portal (bot `bw-disponibilidad`).
 *
 * Lógica pura: dado el servicio, el perfil del paciente y la agenda ocupada,
 * produce los horarios reservables agrupados por día. Las reglas NO se duplican
 * en el portal: acá se aplican la ventana por tipo de cliente (R-13), la
 * capacidad por personas y el desfasaje Recovery (R-07) y el horario del centro.
 *
 * La reserva sigue siendo por SOLICITUD (`bw-solicitar-turno` → Recepción
 * confirma): esto solo pinta los chips de horarios del portal.
 */
import type { IntensidadMembresia, RecursoFisico, Servicio } from '../domain/types.js';
import { HORARIO_SEMANAL, SLOT_GRANULARIDAD_MIN, type HorarioDia } from '../config/horario.js';
import { getServicio } from '../config/catalogo.js';
import { compartenEquipo, recursosParaCategoria } from '../config/recursos.js';
import { VENTANA_RESERVA_HORAS, grillaTurnoMin, type PerfilReserva } from '../config/reglas.js';
import { generarSlots } from './slots.js';
import {
  personasEnFranja,
  validarCapacidadRecurso,
  validarDesfasajeRecovery,
  validarVentanaReserva,
  type ReservaRecurso,
} from './reglas-turno.js';

/** Único servicio que se vende por asiento en sesión grupal ("sumate"). */
const SERVICIO_GRUPAL = 'HBOT_MULTIPLAZA';

/**
 * Perfil de reserva del paciente (R-13). La derivación canónica del server:
 * `tag-fm` en la ficha → FM; si no, la intensidad de su membresía activa
 * (INTENSIVO > STANDARD); sin membresía → público. Un paquete NO cambia la
 * ventana (no es membresía).
 */
export function perfilDeReserva(tagFm: boolean, intensidades: IntensidadMembresia[]): PerfilReserva {
  if (tagFm) {
    return 'FM';
  }
  if (intensidades.includes('INTENSIVO')) {
    return 'INTENSIVO';
  }
  if (intensidades.length > 0) {
    return 'STANDARD';
  }
  return 'PUBLICO';
}

export interface HorarioDisponible {
  /** ISO con offset -03:00. */
  inicio: string;
  fin: string;
  /** Solo sesión grupal: asientos restantes (hasta la capacidad del recurso). */
  lugares?: number;
  /** Solo sesión grupal: personas ya anotadas en la franja. */
  ocupantes?: number;
}

/** Horario de la grilla que ya está tomado (el portal lo pinta tachado). */
export interface HorarioOcupado {
  /** ISO con offset -03:00 (mismo formato que HorarioDisponible). */
  inicio: string;
  fin: string;
}

export interface DiaDisponible {
  /** YYYY-MM-DD (fecha argentina). */
  fecha: string;
  horarios: HorarioDisponible[];
  /**
   * Horarios tomados del día (handoff portal 2026-08-12): arranques que SÍ son
   * parte de la grilla visible (a futuro, dentro de la ventana R-13 y del
   * horario del centro) pero no se ofrecen porque la agenda, una solicitud
   * pendiente o el cupo grupal los toman. Un hueco mudo no le dice nada al
   * paciente; un horario tachado explica por qué no está. Ausente si no hay.
   */
  ocupados?: HorarioOcupado[];
}

/**
 * Horas tras las cuales una solicitud sin responder DEJA de bloquear horarios
 * (un Task olvidado en la bandeja no puede matar un horario para siempre; si
 * quedan muchos horarios bloqueados, la palanca es bajar esto, no volver atrás).
 */
export const VENCIMIENTO_SOLICITUD_HORAS = 24;

/** Solicitud de turno pendiente (Task `solicitud-turno` sin resolver). */
export interface SolicitudPendiente {
  /** Horario exacto pedido (input `preferencia-inicio` del Task). */
  inicio: Date;
  /** Servicio pedido (input `terapia-codigo`). Sin código no se sabe si compite: no bloquea. */
  servicioCodigo?: string;
  /** Cuándo se pidió (authoredOn), para el vencimiento. */
  pedidaEn?: Date;
}

export interface OpcionesDisponibilidad {
  servicio: Servicio;
  perfil: PerfilReserva;
  ahora: Date;
  /** Agenda ocupada (Slots busy → ReservaRecurso) de todo el rango a evaluar. */
  reservas: ReservaRecurso[];
  /**
   * Solicitudes pendientes del portal (decisión 2026-07-26): entre que un
   * paciente pide un horario y Recepción confirma, ese horario deja de
   * ofrecerse a los demás — preferimos ofrecer de menos a rechazar gente.
   */
  solicitudes?: SolicitudPendiente[];
  /** Horario del centro (default: HORARIO_SEMANAL). */
  horario?: HorarioDia[];
}

export interface Disponibilidad {
  ventanaHoras: number;
  grupal: boolean;
  dias: DiaDisponible[];
  /** Horarios que se dejaron de ofrecer SOLO por solicitudes pendientes. */
  excluidosPorSolicitudes: number;
}

/** Los recursos donde el portal puede ofrecer el servicio. */
export function candidatosPara(servicio: Servicio): RecursoFisico[] {
  const delTipo = recursosParaCategoria(servicio.categoria);
  if (servicio.codigo === SERVICIO_GRUPAL) {
    // La sesión grupal vive SOLO en la Multiplaza (asientos individuales).
    return delTipo.filter((r) => (r.minimoPersonas ?? 0) > 0);
  }
  // Un servicio individual jamás pisa la cámara grupal (esos asientos son de
  // la sesión "sumate"); el resto de las salas de la categoría valen todas,
  // igual que cuando Recepción elige sala a mano.
  return delTipo.filter((r) => (r.minimoPersonas ?? 0) === 0);
}

/**
 * Horarios reservables para el paciente, agrupados por día.
 *
 * Un horario se ofrece si existe AL MENOS un recurso de la categoría donde el
 * turno completo (duración del servicio) cabe dentro del horario del centro y
 * pasa capacidad (R-07) + desfasaje Recovery + ventana del perfil (R-13). La
 * sala concreta la decide Recepción al confirmar, como siempre.
 *
 * Sesión grupal (Multiplaza): el horario se ofrece mientras queden asientos
 * (`lugares` ≥ 1) y suma `ocupantes` ("ya somos N"). El mínimo operativo de 3
 * es advertencia, no bloqueo: el horario se devuelve igual.
 *
 * Los horarios de la grilla que NO pasan (agenda llena, solicitud pendiente o
 * cupo grupal agotado) no se pierden: van en `ocupados` del día, para que el
 * portal los tache en vez de dejar un hueco mudo (handoff 2026-08-12).
 */
export function calcularDisponibilidad(opts: OpcionesDisponibilidad): Disponibilidad {
  const { servicio, perfil, ahora } = opts;
  const horario = opts.horario ?? HORARIO_SEMANAL;
  const ventanaHoras = VENTANA_RESERVA_HORAS[perfil];
  const grupal = servicio.codigo === SERVICIO_GRUPAL;
  const candidatos = candidatosPara(servicio);
  if (candidatos.length === 0 || servicio.duracionMin <= 0) {
    return { ventanaHoras, grupal, dias: [], excluidosPorSolicitudes: 0 };
  }

  // Solicitudes pendientes que COMPITEN por estas salas: ya vencidas, pasadas,
  // sin código de servicio o de salas ajenas no bloquean nada.
  const codigosCandidatos = new Set(candidatos.map((r) => r.codigo));
  const pendientes: Array<{ desde: number; hasta: number }> = [];
  for (const sol of opts.solicitudes ?? []) {
    if (sol.inicio.getTime() <= ahora.getTime() || !sol.servicioCodigo) {
      continue;
    }
    if (sol.pedidaEn && ahora.getTime() - sol.pedidaEn.getTime() > VENCIMIENTO_SOLICITUD_HORAS * 3_600_000) {
      continue;
    }
    let pedido: Servicio;
    try {
      pedido = getServicio(sol.servicioCodigo);
    } catch {
      continue;
    }
    if (!candidatosPara(pedido).some((r) => codigosCandidatos.has(r.codigo))) {
      continue;
    }
    pendientes.push({ desde: sol.inicio.getTime(), hasta: sol.inicio.getTime() + pedido.duracionMin * 60_000 });
  }
  let excluidosPorSolicitudes = 0;

  // Grilla de arranques posibles por recurso, cubriendo toda la ventana.
  // `generarSlots` ya respeta el horario semanal del centro; sale cada 30'
  // (sub-slots de ocupación) y R-22 filtra después qué arranques se OFRECEN
  // para este servicio: cada 60 en punto, salvo Recovery Pro (cada 30).
  const nDias = Math.ceil(ventanaHoras / 24) + 1;
  const grilla = generarSlots(candidatos, horario, { desde: ahora, dias: nDias });
  const slotsPorRecurso = new Map<string, Set<string>>();
  const arranques = new Set<string>();
  for (const s of grilla) {
    const set = slotsPorRecurso.get(s.recursoCodigo) ?? new Set<string>();
    set.add(s.inicio);
    slotsPorRecurso.set(s.recursoCodigo, set);
    arranques.add(s.inicio);
  }

  const gran = SLOT_GRANULARIDAD_MIN;
  const subSlots = Math.ceil(servicio.duracionMin / gran);
  const porDia = new Map<string, HorarioDisponible[]>();
  const ocupadosPorDia = new Map<string, HorarioOcupado[]>();

  // R-22 · grilla comercial del servicio. Un arranque desalineado no es parte
  // de la grilla visible: ni libre ni ocupado (igual que los pegados al cierre).
  const grillaServicioMin = grillaTurnoMin(servicio.categoria);

  for (const inicioISO of [...arranques].sort()) {
    const inicio = new Date(inicioISO);
    if (inicio.getTime() <= ahora.getTime()) {
      continue; // solo a futuro
    }
    const minutoDelDia = Number(inicioISO.slice(11, 13)) * 60 + Number(inicioISO.slice(14, 16));
    if (minutoDelDia % grillaServicioMin !== 0) {
      continue; // fuera de la grilla comercial del servicio (R-22)
    }
    if (!validarVentanaReserva(perfil, ahora, inicio).ok) {
      continue; // fuera de la ventana del perfil (R-13)
    }
    const fin = new Date(inicio.getTime() + servicio.duracionMin * 60_000);

    // Salas donde el turno completo cabe dentro del horario del centro: todos
    // los sub-slots de la duración deben existir en la grilla del recurso. Si
    // no cabe en ninguna (p. ej. arranques pegados al cierre), el horario no es
    // parte de la grilla visible: ni libre ni ocupado.
    const salas = candidatos.filter((recurso) => {
      const set = slotsPorRecurso.get(recurso.codigo);
      if (!set) {
        return false;
      }
      for (let k = 0; k < subSlots; k++) {
        if (!set.has(isoArgentina(new Date(inicio.getTime() + k * gran * 60_000)))) {
          return false;
        }
      }
      return true;
    });
    if (salas.length === 0) {
      continue;
    }
    const marcarOcupado = (): void => {
      const fecha = inicioISO.slice(0, 10);
      const arr = ocupadosPorDia.get(fecha) ?? [];
      arr.push({ inicio: inicioISO, fin: isoArgentina(fin) });
      ocupadosPorDia.set(fecha, arr);
    };

    // Solicitudes pendientes que solapan esta franja.
    const pendientesSolapadas = pendientes.filter((p) => p.desde < fin.getTime() && inicio.getTime() < p.hasta).length;
    if (!grupal && pendientesSolapadas > 0) {
      // Individual: el horario ya está pedido — no se ofrece, como si estuviera
      // ocupado (aunque otra sala de la categoría siga libre: ofrecer de menos).
      excluidosPorSolicitudes++;
      marcarOcupado();
      continue;
    }

    let horarioOfrecible: HorarioDisponible | undefined;
    for (const recurso of salas) {
      // R-07 sobre la agenda real: capacidad del recurso + desfasaje Recovery.
      // Solo las reservas de ESTE recurso y de los que comparten equipo (el
      // gabinete Recovery hermano): un problema preexistente en otra sala no
      // debe envenenar los horarios de esta.
      const candidata: ReservaRecurso = { recursoCodigo: recurso.codigo, inicio, fin, ocupantes: 1 };
      const relevantes = opts.reservas.filter(
        (r) => r.recursoCodigo === recurso.codigo || compartenEquipo(r.recursoCodigo, recurso.codigo),
      );
      const conCandidata = [...relevantes, candidata];
      if (!validarCapacidadRecurso(conCandidata).ok || !validarDesfasajeRecovery(conCandidata).ok) {
        continue;
      }

      if (grupal) {
        // Grupal: cada solicitud pendiente resta un asiento del cupo, pero
        // `ocupantes` sigue contando solo confirmados ("ya somos N").
        const ocupantes = personasEnFranja(opts.reservas, recurso.codigo, inicio, fin);
        const lugares = Math.max(recurso.capacidad - ocupantes - pendientesSolapadas, 0);
        if (lugares <= 0) {
          excluidosPorSolicitudes++;
          continue;
        }
        horarioOfrecible = {
          inicio: inicioISO,
          fin: isoArgentina(fin),
          lugares,
          ocupantes,
        };
      } else {
        horarioOfrecible = { inicio: inicioISO, fin: isoArgentina(fin) };
      }
      break; // con un recurso alcanza: la sala la elige Recepción
    }

    if (horarioOfrecible) {
      const fecha = inicioISO.slice(0, 10);
      const arr = porDia.get(fecha) ?? [];
      arr.push(horarioOfrecible);
      porDia.set(fecha, arr);
    } else {
      // Cabía en el horario del centro pero todas las salas están tomadas (o el
      // cupo grupal se llenó): tachado en el portal, no elegible.
      marcarOcupado();
    }
  }

  // Un día entra si tiene ALGO que mostrar: horarios libres u ocupados (un día
  // completamente tomado se muestra todo tachado, no desaparece).
  const dias: DiaDisponible[] = [...new Set([...porDia.keys(), ...ocupadosPorDia.keys()])].sort().map((fecha) => {
    const ocupados = ocupadosPorDia.get(fecha);
    return { fecha, horarios: porDia.get(fecha) ?? [], ...(ocupados?.length ? { ocupados } : {}) };
  });
  return { ventanaHoras, grupal, dias, excluidosPorSolicitudes };
}

/**
 * ¿El horario pedido está entre los ofrecidos? Chequeo de membresía exacta
 * contra los chips (defensa en profundidad de `bw-solicitar-turno`, feedback
 * de recepción 2026-08-12): un horario ocupado, fuera de ventana R-13, fuera
 * del horario del centro o desalineado de la grilla NO está ofrecido. Los
 * `ocupados` del día tampoco cuentan: se muestran, pero no son elegibles.
 */
export function horarioOfrecido(dias: readonly DiaDisponible[], inicio: Date): boolean {
  const buscado = isoArgentina(inicio);
  return dias.some((d) => d.horarios.some((h) => h.inicio === buscado));
}

/**
 * ISO con offset fijo de Argentina, **sin milisegundos**: es el formato exacto
 * de los horarios que consume el portal (`bw-disponibilidad` → los chips).
 *
 * Se exporta para que TODO lo que devuelva horarios al portal use este mismo
 * formato. Ojo con `isoArgentina` de `lib/sena.ts`, que es parecido pero lleva
 * milisegundos (lo exige MercadoPago): mezclarlos hace que dos horarios iguales
 * no se reconozcan como el mismo y el portal deje de tachar el que corresponde.
 */
export function isoHorarioPortal(d: Date): string {
  const local = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return `${local.toISOString().slice(0, 19)}-03:00`;
}

/** Alias interno histórico. */
const isoArgentina = isoHorarioPortal;

/**
 * Primera sala de la categoría donde cabe un turno nuevo `[inicio, inicio+dur)`
 * con `ocupantes` personas, dado lo ya reservado ese día. Es el mismo criterio
 * con el que `calcularDisponibilidad` decide si ofrece un horario (R-07:
 * capacidad + desfasaje Recovery), separado para que quien tenga que ELEGIR la
 * sala —la propuesta de reserva de la cola de Solicitudes— use exactamente el
 * mismo y no otro. `undefined` si ninguna sala lo admite.
 */
export function salaLibrePara(
  servicio: Servicio,
  inicio: Date,
  ocupantes: number,
  reservas: ReservaRecurso[],
): RecursoFisico | undefined {
  const fin = new Date(inicio.getTime() + servicio.duracionMin * 60_000);
  for (const recurso of candidatosPara(servicio)) {
    if (ocupantes > recurso.capacidad) {
      continue;
    }
    const candidata: ReservaRecurso = { recursoCodigo: recurso.codigo, inicio, fin, ocupantes };
    const relevantes = reservas.filter(
      (r) => r.recursoCodigo === recurso.codigo || compartenEquipo(r.recursoCodigo, recurso.codigo),
    );
    const conCandidata = [...relevantes, candidata];
    if (validarCapacidadRecurso(conCandidata).ok && validarDesfasajeRecovery(conCandidata).ok) {
      return recurso;
    }
  }
  return undefined;
}
