import { describe, it, expect } from 'vitest';
import { getCombo } from '../src/config/combos.js';
import { planificarCombo } from '../src/bots/reservar-combo.js';
import type { ReservaRecurso } from '../src/lib/reglas-turno.js';

const INICIO = new Date('2026-06-22T14:00:00-03:00');

function reserva(recursoCodigo: string, desde: string, hasta: string): ReservaRecurso {
  return {
    recursoCodigo,
    inicio: new Date(`2026-06-22T${desde}:00-03:00`),
    fin: new Date(`2026-06-22T${hasta}:00-03:00`),
  };
}

describe('planificarCombo', () => {
  it('BIO LONGEVITY agenda HBOT -> IHHT -> Recovery, consecutivos y con sala', () => {
    const r = planificarCombo(getCombo('BIO_LONGEVITY'), INICIO, []);
    expect(r.ok).toBe(true);
    expect(r.plan.map((p) => p.servicioCodigo)).toEqual(['HBOT_MONO', 'IHHT', 'RECOVERY_PRO']);

    // HBOT 14:00-15:00, IHHT 15:00-15:30, Recovery 15:30-16:30.
    expect(r.plan[0]!.inicio.toISOString()).toBe(new Date('2026-06-22T14:00:00-03:00').toISOString());
    expect(r.plan[1]!.inicio.toISOString()).toBe(new Date('2026-06-22T15:00:00-03:00').toISOString());
    expect(r.plan[2]!.inicio.toISOString()).toBe(new Date('2026-06-22T15:30:00-03:00').toISOString());
    expect(r.plan[2]!.fin.toISOString()).toBe(new Date('2026-06-22T16:30:00-03:00').toISOString());

    // Salas asignadas (primer candidato libre de cada tipo).
    expect(r.plan[0]!.recursoCodigo).toBe('R_HBOT_MONO');
    expect(r.plan[1]!.recursoCodigo).toBe('R_IHHT_1');
    expect(r.plan[2]!.recursoCodigo).toBe('R_RECOVERY_G1');
  });

  it('Si el primer recurso HBOT está ocupado, usa otra cámara disponible', () => {
    const r = planificarCombo(getCombo('BIO_OXYGEN'), INICIO, [reserva('R_HBOT_MONO', '14:00', '15:00')]);
    expect(r.ok).toBe(true);
    expect(r.plan[0]!.recursoCodigo).not.toBe('R_HBOT_MONO'); // se va a biplaza/multiplaza
  });

  it('Si no hay ninguna sala del tipo, bloquea (R-07) y no completa el plan', () => {
    // Ambos gabinetes Recovery ocupados en la ventana del componente Recovery (15:30-16:30).
    const r = planificarCombo(getCombo('BIO_LONGEVITY'), INICIO, [
      reserva('R_RECOVERY_G1', '15:30', '16:30'),
      reserva('R_RECOVERY_G2', '15:30', '16:30'),
    ]);
    expect(r.ok).toBe(false);
    expect(r.bloqueos.some((b) => b.regla === 'R-07')).toBe(true);
    // HBOT e IHHT sí se ubicaron; Recovery no.
    expect(r.plan.length).toBe(2);
  });
});
