import { describe, expect, it } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import { cargarReservasEnRango } from '../src/bots/_shared.js';
import { EXT } from '../src/fhir/identifiers.js';

/**
 * La agenda ocupada que ve el portal sale de DOS fuentes: los Slots `busy` y
 * los Appointments vivos.
 *
 * Por qué las dos (2026-09-11, contra producción): había 285 Slots busy contra
 * 511 Appointments vivos —~2:1 en las catorce salas— y los turnos sin Slot eran
 * invisibles para la disponibilidad, así que el portal volvía a ofrecer horas
 * que recepción mostraba tomadas.
 *
 * Lo que este test protege es el DE-DUPLICADO, que es la parte peligrosa: si la
 * misma reserva se contara dos veces (una por su Slot y otra por su
 * Appointment), una sala de reserva exclusiva chocaría contra sí misma y la
 * disponibilidad devolvería todo ocupado. El síntoma sería el opuesto al bug
 * original y igual de malo.
 */

const INICIO = '2026-09-11T14:00:00.000Z';
const FIN = '2026-09-11T15:00:00.000Z';

interface Fuentes {
  slots?: Array<Record<string, unknown>>;
  citas?: Array<Record<string, unknown>>;
}

/** MedplumClient falso: una sola página por tipo, como devuelve el servidor. */
function fakeMedplum({ slots = [], citas = [] }: Fuentes): MedplumClient {
  return {
    searchResourcePages: async function* (tipo: string) {
      yield tipo === 'Slot' ? slots : citas;
    },
  } as unknown as MedplumClient;
}

function slot(id: string, recurso: string, ocupantes?: number): Record<string, unknown> {
  return {
    resourceType: 'Slot',
    id,
    status: 'busy',
    start: INICIO,
    end: FIN,
    extension: [
      { url: EXT.recursoFisico, valueString: recurso },
      ...(ocupantes === undefined ? [] : [{ url: EXT.ocupantes, valueInteger: ocupantes }]),
    ],
  };
}

function cita(
  id: string,
  recurso: string,
  opts: { status?: string; slotIds?: string[]; ocupantes?: number } = {},
): Record<string, unknown> {
  return {
    resourceType: 'Appointment',
    id,
    status: opts.status ?? 'booked',
    start: INICIO,
    end: FIN,
    ...(opts.slotIds ? { slot: opts.slotIds.map((s) => ({ reference: `Slot/${s}` })) } : {}),
    extension: [
      { url: EXT.recursoFisico, valueString: recurso },
      ...(opts.ocupantes === undefined ? [] : [{ url: EXT.ocupantes, valueInteger: opts.ocupantes }]),
    ],
  };
}

const DESDE = new Date('2026-09-11T00:00:00.000Z');
const HASTA = new Date('2026-09-18T00:00:00.000Z');

const cargar = (f: Fuentes) => cargarReservasEnRango(fakeMedplum(f), DESDE, HASTA);

describe('cargarReservasEnRango — Slots busy + Appointments vivos', () => {
  it('el turno con su Slot busy cuenta UNA sola vez', async () => {
    const r = await cargar({
      slots: [slot('s1', 'R_HBOT_MONO')],
      citas: [cita('a1', 'R_HBOT_MONO', { slotIds: ['s1'] })],
    });
    expect(r).toHaveLength(1);
    expect(r[0]?.recursoCodigo).toBe('R_HBOT_MONO');
  });

  it('el turno SIN Slot busy también ocupa la sala (el bug de 2026-09-11)', async () => {
    const r = await cargar({ slots: [], citas: [cita('a1', 'R_HBOT_MONO')] });
    expect(r).toHaveLength(1);
  });

  it('un Slot referenciado que ya NO está busy no tapa al turno vivo', async () => {
    // El Appointment apunta a s9, pero s9 no vino en la búsqueda de busy:
    // el turno sigue vivo, así que la sala sigue ocupada.
    const r = await cargar({ slots: [], citas: [cita('a1', 'R_IHHT_1', { slotIds: ['s9'] })] });
    expect(r).toHaveLength(1);
  });

  it('cancelado, waitlist y entered-in-error NO ocupan sala', async () => {
    for (const status of ['cancelled', 'waitlist', 'entered-in-error']) {
      expect(await cargar({ citas: [cita('a1', 'R_HBOT_MONO', { status })] })).toHaveLength(0);
    }
    // `noshow` sí: es la misma lista que oculta el timeline de recepción.
    expect(await cargar({ citas: [cita('a1', 'R_HBOT_MONO', { status: 'noshow' })] })).toHaveLength(1);
  });

  it('respeta los `ocupantes` de cada fuente; sin la extensión vale 1', async () => {
    const r = await cargar({
      slots: [slot('s1', 'R_HBOT_MULTIPLAZA', 3)],
      citas: [cita('a2', 'R_HBOT_MULTIPLAZA', { ocupantes: 2 }), cita('a3', 'R_HBOT_MULTIPLAZA')],
    });
    expect(r.map((x) => x.ocupantes).sort()).toEqual([1, 2, 3]);
  });

  it('ignora lo que no tenga recurso-fisico: sin sala no hay nada que bloquear', async () => {
    const r = await cargar({
      slots: [{ resourceType: 'Slot', id: 's1', status: 'busy', start: INICIO, end: FIN }],
      citas: [{ resourceType: 'Appointment', id: 'a1', status: 'booked', start: INICIO, end: FIN }],
    });
    expect(r).toHaveLength(0);
  });
});
