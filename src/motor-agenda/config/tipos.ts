/**
 * Forma de la configuración del motor de agenda.
 *
 * Todo lo que puede cambiar sin cambiar el modelo vive acá: cantidad de
 * unidades, tiempos, horarios, precios, ventanas de reserva. El código nunca
 * lleva una constante de negocio.
 */

import type { DiaSemana, RelojLocal } from '../dominio/tiempo.js';
import type {
  Combo,
  Membresia,
  Recurso,
  Servicio,
  VersionListaPrecios,
} from '../dominio/tipos.js';

/** Horario de atención de un día. Un día que no figura, está cerrado. */
export interface HorarioDia {
  readonly dia: DiaSemana;
  readonly aperturaMin: number;
  readonly cierreMin: number;
}

/**
 * La franja clínica: un programa separado, para pacientes con curso prescrito e
 * indicación diagnosticada, y para toda IV y toda Terapia Biológica sin
 * excepción.
 *
 * No restringe qué cámara puede usar un paciente: puede usar cualquiera de las
 * tres, multiplaza incluida, según criterio del equipo hiperbárico.
 */
export interface FranjaClinica {
  readonly dias: readonly DiaSemana[];
  readonly desdeMin: number;
  readonly hastaMin: number;
  /** Último inicio admitido (el turno tiene que terminar dentro de la franja). */
  readonly ultimoInicioMin: number;
  /**
   * ¿La franja clínica **excluye** al flujo normal en esa ventana?
   *
   * [NO RATIFICADO] El enunciado dice que la franja «sólo habilita reservas
   * clínicas dentro de esa ventana y las bloquea fuera», que es una afirmación
   * sobre las reservas clínicas, no sobre las de bienestar. Queda en `false`
   * hasta que se decida; ver `docs/motor-agenda-preguntas-abiertas.md`.
   */
  readonly bloqueaFlujoNormal: boolean;
}

/**
 * Anticipación **máxima** con la que cada categoría puede reservar, en horas.
 *
 * Es el mecanismo por el cual la franja de alta demanda se raciona sola, sin
 * restricciones horarias explícitas: el que reserva antes es el que más
 * anticipación tiene.
 */
export interface VentanasReservaHoras {
  readonly publico: number;
  readonly miembroStandard: number;
  readonly miembroIntensivo: number;
  readonly foundingMember: number;
}

/** Cómo se redondean las sesiones al aplicar una pausa proporcional. */
export type ModoRedondeo = 'abajo' | 'cercano' | 'arriba';

export interface ReglasPausa {
  readonly diasPorAnioCalendario: number;
  readonly bloqueMinimoDias: number;
  /** Meses (1-12) en cuyas ventanas se puede pausar. */
  readonly mesesVentana: readonly number[];
  readonly anticipacionMinimaDias: number;
  /** Base sobre la que se calcula la proporción (30 días = un mes comercial). */
  readonly baseProporcionalDias: number;
  /**
   * [NO RATIFICADO] Con 15 días sobre 30 el cálculo da exacto (8 → 4), pero con
   * un bloque de 20 días da 2,67 y hay que redondear. Nadie decidió para qué
   * lado. `'cercano'` es lo más parecido a «proporcional»; ver preguntas abiertas.
   */
  readonly redondeoSesiones: ModoRedondeo;
}

export interface ReglasCancelacion {
  /** Con esta anticipación o más, la sesión vuelve al saldo. */
  readonly horasParaDevolverSesion: number;
}

export interface ReglasMembresia {
  /**
   * Las sesiones no son acumulables: vencen el último día del mes o a los N días
   * de contratado, lo que ocurra primero.
   */
  readonly diasVigenciaCiclo: number;
}

export interface ConfigMotor {
  readonly reloj: RelojLocal;
  /** Grilla por defecto de inicio de turnos, en minutos. */
  readonly granularidadAgendaMin: number;
  readonly horario: readonly HorarioDia[];
  readonly franjaClinica: FranjaClinica;
  readonly ventanasReservaHoras: VentanasReservaHoras;
  readonly pausa: ReglasPausa;
  readonly cancelacion: ReglasCancelacion;
  readonly membresia: ReglasMembresia;
  readonly recursos: readonly Recurso[];
  readonly servicios: readonly Servicio[];
  readonly combos: readonly Combo[];
  readonly membresias: readonly Membresia[];
  /** Versiones de la lista de precios, de la más vieja a la más nueva. */
  readonly listasPrecios: readonly VersionListaPrecios[];
  /**
   * Si es `true`, arrancar con valores no ratificados es un error de
   * configuración en vez de una advertencia. Se prende el día que el Manual
   * cierre todos los pendientes.
   */
  readonly exigirRatificacion: boolean;
  /**
   * Si es `true`, que un servicio del catálogo no tenga precio en la lista
   * vigente es un error de configuración.
   *
   * Hoy está en `false`: de los precios de sesión suelta sólo están decididos
   * los de R-04 (biplaza) y R-06 (multiplaza). El resto se reporta como faltante
   * al arrancar, y cotizarlos devuelve `PRECIO_NO_DEFINIDO`. Prender esto cuando
   * la lista esté completa.
   */
  readonly exigirCatalogoDePreciosCompleto: boolean;
}

/** Un valor que el motor usa pero que todavía nadie ratificó. */
export interface NotaNoRatificada {
  /** Dónde vive: `'recurso:ihht.turnaroundMin'`, `'membresias.precios'`. */
  readonly ambito: string;
  readonly motivo: string;
}
