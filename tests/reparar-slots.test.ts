import { describe, expect, it } from 'vitest';
import type { Appointment, Slot } from '@medplum/fhirtypes';
import { planDeReparacion } from '../src/seed/reparar-slots.js';
import { EXT, SYSTEM } from '../src/fhir/identifiers.js';

/**
 * La reparación tiene que ser quirúrgica: crear un Slot de MÁS deja una sala
 * bloqueada sin turno detrás (un horario que nadie puede reservar y que nadie
 * va a usar), y crear uno de MENOS deja el horario ofreciéndose de nuevo.
 *
 * El emparejamiento es por REFERENCIA (`Appointment.slot`), nunca por horario:
 * en la Multiplaza conviven hasta 6 turnos legítimos en la misma sala y hora.
 */

const INICIO = '2026-09-11T14:00:00.000Z';
const FIN = '2026-09-11T15:00:00.000Z';

function cita(
  id: string,
  opts: { recurso?: string; status?: string; slotIds?: string[]; ocupantes?: number; tags?: boolean } = {},
): Appointment {
  const { recurso = 'R_HBOT_MONO', status = 'booked' } = opts;
  return {
    resourceType: 'Appointment',
    id,
    status,
    start: INICIO,
    end: FIN,
    ...(opts.tags ? { meta: { tag: [{ system: SYSTEM.demo, code: 'demo' }] } } : {}),
    ...(opts.slotIds ? { slot: opts.slotIds.map((s) => ({ reference: `Slot/${s}` })) } : {}),
    extension: [
      { url: EXT.recursoFisico, valueString: recurso },
      ...(opts.ocupantes === undefined ? [] : [{ url: EXT.ocupantes, valueInteger: opts.ocupantes }]),
    ],
  } as Appointment;
}

function slotBusy(id: string): Slot {
  return { resourceType: 'Slot', id, status: 'busy', start: INICIO, end: FIN } as Slot;
}

describe('planDeReparacion', () => {
  it('repara el turno que perdió su Slot', () => {
    const plan = planDeReparacion([cita('a1')], []);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.recursoCodigo).toBe('R_HBOT_MONO');
    expect(plan[0]?.inicio).toBe(INICIO);
    expect(plan[0]?.ocupantes).toBe(1);
  });

  it('NO toca el turno que ya tiene su Slot busy (idempotente)', () => {
    expect(planDeReparacion([cita('a1', { slotIds: ['s1'] })], [slotBusy('s1')])).toHaveLength(0);
  });

  it('repara el turno cuyo Slot referenciado ya no existe', () => {
    // Referencia colgada: el Slot se borró, así que el turno quedó sin ocupar sala.
    expect(planDeReparacion([cita('a1', { slotIds: ['s-borrado'] })], [slotBusy('s-otro')])).toHaveLength(1);
  });

  it('empareja por referencia, no por horario: 6 turnos grupales necesitan 6 Slots', () => {
    // Multiplaza: misma sala, misma hora, seis reservas distintas. Emparejar por
    // horario habría dado por reparados a los cinco restantes.
    const grupo = Array.from({ length: 6 }, (_, i) =>
      cita(`g${i}`, { recurso: 'R_HBOT_MULTIPLAZA', ...(i === 0 ? { slotIds: ['s1'] } : {}) }),
    );
    expect(planDeReparacion(grupo, [slotBusy('s1')])).toHaveLength(5);
  });

  it('ignora lo que no ocupa sala: cancelado, waitlist y entered-in-error', () => {
    for (const status of ['cancelled', 'waitlist', 'entered-in-error']) {
      expect(planDeReparacion([cita('a1', { status })], [])).toHaveLength(0);
    }
  });

  it('ignora el turno sin sala: no hay Slot que crear si no se sabe dónde', () => {
    const sinSala = { resourceType: 'Appointment', id: 'a1', status: 'booked', start: INICIO, end: FIN } as Appointment;
    expect(planDeReparacion([sinSala], [])).toHaveLength(0);
  });

  it('conserva los ocupantes del turno', () => {
    expect(planDeReparacion([cita('a1', { recurso: 'R_HBOT_BIPLAZA', ocupantes: 2 })], [])[0]?.ocupantes).toBe(2);
  });

  it('hereda el tag demo: si no, la limpieza borraría el turno y dejaría la sala bloqueada', () => {
    expect(planDeReparacion([cita('a1', { tags: true })], [])[0]?.tags).toEqual([
      { system: SYSTEM.demo, code: 'demo' },
    ]);
    expect(planDeReparacion([cita('a2')], [])[0]?.tags).toEqual([]);
  });
});
