import { describe, it, expect } from 'vitest';
import { evaluarCancelacion } from '../src/lib/reglas-turno.js';

/**
 * R-14 al cancelar un turno pagado con plan.
 *
 * El bug que motivó estos casos (2026-08-14): `evaluarCancelacion` existía y
 * estaba testeada desde siempre, pero **no la llamaba nadie** — ni un bot ni una
 * pantalla. Así que quien cancelaba con la anticipación que pide la regla perdía
 * igual la sesión que había pagado.
 *
 * Lo importante es la ASIMETRÍA: el error iba siempre en contra del paciente y
 * nunca del centro. Cancelar tarde ya consumía la sesión (correcto por
 * accidente); cancelar a tiempo también (incorrecto, y silencioso).
 */

const INICIO = new Date('2026-08-20T15:00:00-03:00');

/** Horas antes del turno. */
function antes(horas: number): Date {
  return new Date(INICIO.getTime() - horas * 60 * 60 * 1000);
}

describe('R-14 · qué pasa con la sesión al cancelar', () => {
  it('con 48 h de anticipación la sesión VUELVE al plan', () => {
    const r = evaluarCancelacion(antes(48), INICIO);
    expect(r.devuelveSaldo).toBe(true);
    expect(r.consumeSesion).toBe(false);
  });

  it('justo en el límite de 24 h todavía devuelve', () => {
    const r = evaluarCancelacion(antes(24), INICIO);
    expect(r.devuelveSaldo).toBe(true);
  });

  it('con 23 h la sesión se consume: es el costo de avisar tarde', () => {
    const r = evaluarCancelacion(antes(23), INICIO);
    expect(r.consumeSesion).toBe(true);
    expect(r.devuelveSaldo).toBe(false);
  });

  it('cancelar DESPUÉS del horario del turno también consume', () => {
    const r = evaluarCancelacion(new Date(INICIO.getTime() + 60 * 60 * 1000), INICIO);
    expect(r.consumeSesion).toBe(true);
  });

  it('fuerza mayor médica devuelve la sesión aunque avise 1 h antes', () => {
    const r = evaluarCancelacion(antes(1), INICIO, { fuerzaMayorMedica: true });
    expect(r.devuelveSaldo).toBe(true);
    expect(r.consumeSesion).toBe(false);
  });

  it('la excepción NO es necesaria si ya cancelaba a tiempo (no cambia nada)', () => {
    const sin = evaluarCancelacion(antes(48), INICIO);
    const con = evaluarCancelacion(antes(48), INICIO, { fuerzaMayorMedica: true });
    expect(con).toEqual(sin);
  });

  it('consumir y devolver son excluyentes: nunca las dos ni ninguna', () => {
    for (const horas of [72, 25, 24, 23.9, 12, 0.5]) {
      for (const fuerzaMayorMedica of [true, false]) {
        const r = evaluarCancelacion(antes(horas), INICIO, { fuerzaMayorMedica });
        expect(r.consumeSesion).toBe(!r.devuelveSaldo);
      }
    }
  });
});
