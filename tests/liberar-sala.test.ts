import { describe, expect, it } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import type { Appointment, Slot } from '@medplum/fhirtypes';
import { cancelarTurnoYLiberar, liberarSalasDeTurno } from '../src/bots/_shared.js';

/**
 * Cancelar un turno ES liberar la sala. Todo lo demás —cerrar el Encounter,
 * anular el saldo, devolver la sesión, avisar a la lista de espera— es
 * contabilidad y avisos: puede fallar y reintentarse.
 *
 * Antes la sala se liberaba ÚLTIMA, después de todo eso. Si algo del medio
 * fallaba, la función cortaba con el turno ya cancelado y la sala todavía
 * tomada, para siempre y sin que se note: recepción dibuja Appointments, así
 * que el turno cancelado desaparece de su pantalla, y del lado del portal queda
 * un horario que nunca se ofrece. Pasó en producción
 * (Slot/6407c4dc… · lun 15/09 13:00 · R_CAMILLA_MASAJES).
 *
 * Estos tests fijan el orden. Sin ellos, cualquiera puede volver a poner la
 * liberación al final y nada se queja.
 */

function turno(slotIds: string[]): Appointment {
  return {
    resourceType: 'Appointment',
    id: 'a1',
    status: 'booked',
    start: '2026-09-15T16:00:00.000Z',
    end: '2026-09-15T17:00:00.000Z',
    slot: slotIds.map((s) => ({ reference: `Slot/${s}` })),
    participant: [],
  } as Appointment;
}

/** Medplum falso que registra el orden de las escrituras y puede romperse. */
function fakeMedplum(opts: { rompeEn?: (tipo: string) => boolean; slotsFaltantes?: string[] } = {}) {
  const slots = new Map<string, Slot>();
  const orden: string[] = [];
  const libres = new Set<string>();
  return {
    orden,
    libres,
    registrarSlot(id: string) {
      slots.set(id, { resourceType: 'Slot', id, status: 'busy' } as Slot);
    },
    cliente: {
      readResource: async (tipo: string, id: string) => {
        if (tipo === 'Slot') {
          if (opts.slotsFaltantes?.includes(id)) {
            throw new Error('Not found');
          }
          const s = slots.get(id);
          if (!s) {
            throw new Error('Not found');
          }
          return s;
        }
        throw new Error(`readResource inesperado: ${tipo}`);
      },
      updateResource: async (r: { resourceType: string; id?: string; status?: string }) => {
        orden.push(r.resourceType);
        if (opts.rompeEn?.(r.resourceType)) {
          throw new Error(`falla simulada en ${r.resourceType}`);
        }
        if (r.resourceType === 'Slot' && r.status === 'free' && r.id) {
          libres.add(r.id);
        }
        return r;
      },
      // Saldo pendiente del turno: es uno de los pasos que corren DESPUÉS de la
      // baja, y el que se usa acá para simular que algo posterior falla.
      searchOne: async (tipo: string) =>
        tipo === 'Invoice' ? { resourceType: 'Invoice', id: 'inv1', status: 'issued' } : undefined,
      searchResources: async () => [],
      createResource: async (r: unknown) => r,
    } as unknown as MedplumClient,
  };
}

describe('liberarSalasDeTurno', () => {
  it('libera todas las salas de un combo', async () => {
    const m = fakeMedplum();
    ['s1', 's2', 's3'].forEach((id) => m.registrarSlot(id));
    expect(await liberarSalasDeTurno(m.cliente, turno(['s1', 's2', 's3']))).toEqual([]);
    expect([...m.libres].sort()).toEqual(['s1', 's2', 's3']);
  });

  it('si una sala del combo falla, las otras se liberan igual y el fallo se reporta', async () => {
    // Cada Slot va en su propio try: que la primera falle no puede dejar las
    // otras dos tomadas.
    let n = 0;
    const m = fakeMedplum({
      rompeEn: (tipo) => tipo === 'Slot' && ++n === 1,
    });
    ['s1', 's2', 's3'].forEach((id) => m.registrarSlot(id));
    const fallidos = await liberarSalasDeTurno(m.cliente, turno(['s1', 's2', 's3']));
    expect(fallidos).toHaveLength(1);
    expect([...m.libres].sort()).toEqual(['s2', 's3']);
  });

  it('un Slot que ya no existe no es un fallo: no hay sala tomada por él', async () => {
    const m = fakeMedplum({ slotsFaltantes: ['s-borrado'] });
    expect(await liberarSalasDeTurno(m.cliente, turno(['s-borrado']))).toEqual([]);
  });
});

describe('cancelarTurnoYLiberar — la sala se libera antes que la contabilidad', () => {
  it('libera la sala ANTES de cerrar el Encounter y avisar', async () => {
    const m = fakeMedplum();
    m.registrarSlot('s1');
    await cancelarTurnoYLiberar(m.cliente, turno(['s1']));
    // El Appointment se cancela primero y el Slot inmediatamente después.
    expect(m.orden.slice(0, 2)).toEqual(['Appointment', 'Slot']);
    expect(m.libres.has('s1')).toBe(true);
  });

  it('aunque falle un paso posterior, la sala YA quedó libre', async () => {
    // Ésta es la regresión: antes, un fallo acá dejaba la sala tomada para
    // siempre porque la liberación venía después.
    // Falla la anulación del saldo, que corre después de la baja del turno.
    const m = fakeMedplum({ rompeEn: (tipo) => tipo === 'Invoice' });
    m.registrarSlot('s1');
    await expect(cancelarTurnoYLiberar(m.cliente, turno(['s1']))).rejects.toThrow();
    expect(m.libres.has('s1')).toBe(true);
  });
});
