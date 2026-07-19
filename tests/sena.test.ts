import { describe, it, expect } from 'vitest';
import { estadoSenaPendiente, isoArgentina, vencimientoSena } from '../src/lib/sena.js';
import { SENA } from '../src/config/reglas.js';

const HORA_MS = 3_600_000;

describe('Seña autoservicio (R-19) — vencimiento de la tentativa', () => {
  it('La tentativa vence a las 2 h de reservada (regla acordada)', () => {
    expect(SENA.vencimientoHoras).toBe(2);
    const reservado = new Date('2026-07-20T10:00:00-03:00');
    const inicio = new Date('2026-07-21T16:00:00-03:00');
    expect(vencimientoSena(reservado, inicio).getTime()).toBe(reservado.getTime() + 2 * HORA_MS);
  });

  it('Reservar a último momento no regala tiempo: nunca vence después del inicio del turno', () => {
    const reservado = new Date('2026-07-20T10:00:00-03:00');
    const turnoEn30min = new Date('2026-07-20T10:30:00-03:00');
    expect(vencimientoSena(reservado, turnoEn30min).getTime()).toBe(turnoEn30min.getTime());
    // Sin inicio conocido, aplica la regla plana.
    expect(vencimientoSena(reservado).getTime()).toBe(reservado.getTime() + 2 * HORA_MS);
  });

  it('estadoSenaPendiente: vigente → recordatorio (última hora) → vencida', () => {
    const vence = new Date('2026-07-20T12:00:00-03:00');
    expect(estadoSenaPendiente(vence, new Date('2026-07-20T10:15:00-03:00'))).toBe('vigente');
    // Dentro de la ventana de aviso (60 min antes).
    expect(estadoSenaPendiente(vence, new Date('2026-07-20T11:00:00-03:00'))).toBe('recordatorio');
    expect(estadoSenaPendiente(vence, new Date('2026-07-20T11:59:00-03:00'))).toBe('recordatorio');
    // Justo al vencimiento y después: vencida.
    expect(estadoSenaPendiente(vence, new Date('2026-07-20T12:00:00-03:00'))).toBe('vencida');
    expect(estadoSenaPendiente(vence, new Date('2026-07-20T13:00:00-03:00'))).toBe('vencida');
  });

  it('isoArgentina: formato con offset -03:00 (MercadoPago rechaza el sufijo Z)', () => {
    const d = new Date('2026-07-20T15:30:00.000Z');
    expect(isoArgentina(d)).toBe('2026-07-20T12:30:00.000-03:00');
    // Round-trip: representa el mismo instante.
    expect(new Date(isoArgentina(d)).getTime()).toBe(d.getTime());
  });
});
