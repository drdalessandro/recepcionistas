/**
 * Bot · Validar turno.
 *
 * Corre el motor de reglas de agenda sobre un turno propuesto y devuelve el
 * resultado (bloqueos + advertencias). La recepción no decide: el sistema valida
 * orden de protocolo, contraindicaciones, prescripción, capacidad/desfasaje de
 * recursos, ventana de reserva y saldo de membresía (R-01, R-02, R-03, R-07,
 * R-10, R-13).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { CategoriaServicio } from '../domain/types.js';
import { getServicio } from '../config/catalogo.js';
import type { PerfilReserva } from '../config/reglas.js';
import {
  combinar,
  recomendarHbotPrevio,
  validarContraindicaciones,
  validarConsentimientoTB,
  validarOrdenHBOT,
  validarPrescripcion,
  validarRecursos,
  validarSaldoMembresia,
  validarVentanaReserva,
  type ResultadoValidacion,
  type ReservaRecurso,
} from '../lib/reglas-turno.js';

export interface EntradaValidacion {
  /** Categorías en orden de ejecución (combo) — R-01. */
  secuenciaCategorias?: CategoriaServicio[];
  /** Reservas de recursos para validar capacidad/desfasaje — R-07. */
  reservas?: Array<{ recursoCodigo: string; inicio: string; fin: string }>;
  /** Ventana de reserva — R-13. */
  perfil?: PerfilReserva;
  ahora?: string;
  inicioTurno?: string;
  /** Contraindicaciones activas del paciente (códigos) — R-02. */
  contraindicacionesActivas?: string[];
  autorizacionMedica?: boolean;
  /** Servicio principal (para prescripción y recomendación HBOT) — R-03. */
  servicioCodigo?: string;
  prescripcionActiva?: boolean;
  /** TB: consentimiento informado firmado (R-03). */
  consentimientoFirmado?: boolean;
  huboHbotPrevio?: boolean;
  /** Saldo de membresía — R-10. */
  sesionesUsadas?: number;
  sesionesMes?: number;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function handler(
  _medplum: MedplumClient,
  event: BotEvent<EntradaValidacion>,
): Promise<ResultadoValidacion> {
  return validarEntrada(event.input);
}

/** Lógica pura del bot (separada para testear sin MedplumClient). */
export function validarEntrada(e: EntradaValidacion): ResultadoValidacion {
  const partes: ResultadoValidacion[] = [];

  if (e.secuenciaCategorias?.length) {
    partes.push(validarOrdenHBOT(e.secuenciaCategorias));
  }

  if (e.reservas?.length) {
    const reservas: ReservaRecurso[] = e.reservas.map((r) => ({
      recursoCodigo: r.recursoCodigo,
      inicio: new Date(r.inicio),
      fin: new Date(r.fin),
    }));
    partes.push(validarRecursos(reservas));
  }

  if (e.perfil && e.ahora && e.inicioTurno) {
    partes.push(validarVentanaReserva(e.perfil, new Date(e.ahora), new Date(e.inicioTurno)));
  }

  if (e.servicioCodigo) {
    const servicio = getServicio(e.servicioCodigo);
    partes.push(validarPrescripcion(servicio, e.prescripcionActiva ?? false));
    partes.push(validarConsentimientoTB(servicio, e.consentimientoFirmado ?? false));
    partes.push(recomendarHbotPrevio(servicio.categoria, e.huboHbotPrevio ?? false));
    if (e.contraindicacionesActivas?.length) {
      partes.push(
        validarContraindicaciones([servicio.categoria], e.contraindicacionesActivas, {
          autorizacionMedica: e.autorizacionMedica ?? false,
        }),
      );
    }
  } else if (e.secuenciaCategorias?.length && e.contraindicacionesActivas?.length) {
    partes.push(
      validarContraindicaciones(e.secuenciaCategorias, e.contraindicacionesActivas, {
        autorizacionMedica: e.autorizacionMedica ?? false,
      }),
    );
  }

  if (typeof e.sesionesUsadas === 'number' && typeof e.sesionesMes === 'number') {
    partes.push(validarSaldoMembresia(e.sesionesUsadas, e.sesionesMes));
  }

  return combinar(...partes);
}
