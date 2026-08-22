/**
 * Configuración operativa del centro de San Isidro, armada.
 *
 * Este archivo no calcula nada: junta las piezas y les pone los parámetros de
 * operación (horario, franja clínica, ventanas de reserva, reglas de membresía).
 * Para levantar otro centro, o el mismo con otras cantidades, se arma otro
 * `ConfigMotor` — no se toca el código del motor.
 */

import type { RelojLocal } from '../dominio/tiempo.js';
import { COMBOS, SERVICIOS } from './catalogo.js';
import { LISTAS_PRECIOS, MEMBRESIAS } from './comercial.js';
import { CANTIDADES_SAN_ISIDRO, construirRecursos, type CantidadesRecursos } from './recursos.js';
import type { ConfigMotor } from './tipos.js';

/**
 * America/Argentina/Buenos_Aires. Sin horario de verano desde 2009, así que un
 * offset fijo alcanza y evita arrastrar una base de datos de husos.
 */
export const RELOJ_BUENOS_AIRES: RelojLocal = { offsetHorasUtc: -3 };

export interface OpcionesConfig {
  readonly cantidades?: CantidadesRecursos;
  readonly exigirRatificacion?: boolean;
  readonly exigirCatalogoDePreciosCompleto?: boolean;
}

export function configSanIsidro(opciones: OpcionesConfig = {}): ConfigMotor {
  return {
    reloj: RELOJ_BUENOS_AIRES,
    granularidadAgendaMin: 30,

    // Lunes a viernes 8:00-22:00, sábado 8:00-20:00. Domingo cerrado: no figura.
    horario: [
      { dia: 1, aperturaMin: 8 * 60, cierreMin: 22 * 60 },
      { dia: 2, aperturaMin: 8 * 60, cierreMin: 22 * 60 },
      { dia: 3, aperturaMin: 8 * 60, cierreMin: 22 * 60 },
      { dia: 4, aperturaMin: 8 * 60, cierreMin: 22 * 60 },
      { dia: 5, aperturaMin: 8 * 60, cierreMin: 22 * 60 },
      { dia: 6, aperturaMin: 8 * 60, cierreMin: 20 * 60 },
    ],

    franjaClinica: {
      dias: [1, 2, 3, 4, 5],
      desdeMin: 12 * 60,
      hastaMin: 17 * 60,
      ultimoInicioMin: 16 * 60,
      bloqueaFlujoNormal: false,
    },

    // Anticipación MÁXIMA con la que cada categoría puede reservar.
    ventanasReservaHoras: {
      publico: 48,
      miembroStandard: 72,
      miembroIntensivo: 96,
      foundingMember: 7 * 24,
    },

    pausa: {
      diasPorAnioCalendario: 30,
      bloqueMinimoDias: 15,
      mesesVentana: [1, 7],
      anticipacionMinimaDias: 30,
      baseProporcionalDias: 30,
      redondeoSesiones: 'cercano',
    },

    cancelacion: {
      horasParaDevolverSesion: 24,
    },

    membresia: {
      diasVigenciaCiclo: 30,
    },

    recursos: construirRecursos(opciones.cantidades ?? CANTIDADES_SAN_ISIDRO),
    servicios: SERVICIOS,
    combos: COMBOS,
    membresias: MEMBRESIAS,
    listasPrecios: LISTAS_PRECIOS,

    exigirRatificacion: opciones.exigirRatificacion ?? false,
    exigirCatalogoDePreciosCompleto: opciones.exigirCatalogoDePreciosCompleto ?? false,
  };
}

export { CANTIDADES_SAN_ISIDRO, construirRecursos } from './recursos.js';
export type { CantidadesRecursos } from './recursos.js';
export type * from './tipos.js';
