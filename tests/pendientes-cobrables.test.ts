import { describe, expect, it } from 'vitest';
import { esPendienteCobrable } from '../src/lib/cobros.js';

/**
 * "Pagos pendientes" de Atender: qué Invoice le pone Recepción un botón de
 * Cobrar. La trampa es `cancelled`, que en una cuota de plan es un rechazo de
 * MP (se debe) y en un saldo de turno es un turno cancelado (no se debe).
 */
describe('esPendienteCobrable — el panel de Pagos pendientes', () => {
  it('una cuota de plan pendiente o rechazada se cobra', () => {
    expect(esPendienteCobrable({ status: 'issued', claves: ['plan-abc-2026-09'] })).toBe(true);
    expect(esPendienteCobrable({ status: 'cancelled', claves: ['plan-abc-2026-09'] })).toBe(true);
  });

  it('un saldo de turno pendiente se cobra', () => {
    expect(esPendienteCobrable({ status: 'issued', claves: ['saldo-turno-1'] })).toBe(true);
  });

  it('un saldo de turno CANCELADO no se cobra: es un turno cancelado, no un rechazo', () => {
    // Visto el 2026-09-20: "Saldo 50% · Evaluación Biowellness · Rechazado
    // (R-11) · $60.000" con botón de Cobrar, sobre un turno que se había
    // cancelado. El webhook de MP nunca cancela un saldo (un rechazo lo deja
    // `issued`), así que `cancelled` en un saldo solo puede venir de
    // `cancelarTurno`. Cobrarlo es cobrar una sesión que no existe.
    expect(esPendienteCobrable({ status: 'cancelled', claves: ['saldo-turno-1'] })).toBe(false);
  });

  it('un Invoice ya pagado o de otra cosa no entra', () => {
    expect(esPendienteCobrable({ status: 'balanced', claves: ['saldo-turno-1'] })).toBe(false);
    expect(esPendienteCobrable({ status: 'balanced', claves: ['plan-abc'] })).toBe(false);
    expect(esPendienteCobrable({ status: 'issued', claves: ['sena-turno-1'] })).toBe(false);
    expect(esPendienteCobrable({ status: 'issued', claves: [] })).toBe(false);
    expect(esPendienteCobrable({ status: undefined, claves: ['plan-abc'] })).toBe(false);
  });

  it('la clave se busca entre TODOS los identifiers, no solo el primero', () => {
    // Un Invoice resuelto por MP suma `mp-{paymentId}` a sus identifiers.
    expect(esPendienteCobrable({ status: 'issued', claves: ['mp-123', 'plan-abc'] })).toBe(true);
  });
});
