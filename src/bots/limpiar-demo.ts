/**
 * Bot · Limpieza de datos demo (cron).
 *
 * Borra los recursos etiquetados `demo` que ya cumplieron 48 h
 * (`_lastUpdated` anterior al corte). Pensado para correr por `cronString`
 * (p. ej. cada hora). Idempotente y acotado: nunca toca datos sin el tag demo.
 *
 * La generación de datos demo se hace con `npm run datos-demo` (no por bot).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { borrarRecursosDemo } from './_shared.js';

export interface EntradaLimpiarDemo {
  /** Fecha de referencia ISO (default: ahora). Para pruebas. */
  ahora?: string;
  /** Horas de vida de los datos demo (default 48). */
  horas?: number;
}

export interface ResultadoLimpiarDemo {
  ok: boolean;
  borrados: number;
  porTipo: Record<string, number>;
  corte: string;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaLimpiarDemo>,
): Promise<ResultadoLimpiarDemo> {
  const ahora = event.input?.ahora ? new Date(event.input.ahora) : new Date();
  const horas = event.input?.horas ?? 48;
  const corte = new Date(ahora.getTime() - horas * 60 * 60 * 1000).toISOString();

  const { borrados, porTipo } = await borrarRecursosDemo(medplum, { antesDe: corte });
  return { ok: true, borrados, porTipo, corte };
}
