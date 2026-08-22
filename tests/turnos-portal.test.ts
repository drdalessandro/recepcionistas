import { describe, expect, it } from 'vitest';
import type { Appointment } from '@medplum/fhirtypes';
import { esTurnoDelPaciente, motivoNoAccionable } from '../src/bots/_shared.js';
import { MOVIMIENTOS } from '../src/config/reglas.js';
import { EXT } from '../src/fhir/identifiers.js';

const enHoras = (h: number): string => new Date(Date.now() + h * 60 * 60_000).toISOString();

function turno(over: Partial<Appointment> = {}): Appointment {
  return {
    resourceType: 'Appointment',
    id: 'a1',
    status: 'booked',
    start: enHoras(48),
    participant: [{ actor: { reference: 'Patient/p1' }, status: 'accepted' }],
    ...over,
  } as Appointment;
}

describe('esTurnoDelPaciente — el portal manda el id que quiera', () => {
  it('acepta el turno propio y rechaza el ajeno', () => {
    expect(esTurnoDelPaciente(turno(), 'Patient/p1')).toBe(true);
    expect(esTurnoDelPaciente(turno(), 'Patient/otro')).toBe(false);
  });

  it('un turno sin participantes no es de nadie', () => {
    expect(esTurnoDelPaciente(turno({ participant: [] }), 'Patient/p1')).toBe(false);
  });

  it('reconoce al paciente aunque haya otros participantes (médico, sala)', () => {
    const conMedico = turno({
      participant: [
        { actor: { reference: 'Practitioner/m1' }, status: 'accepted' },
        { actor: { reference: 'Patient/p1' }, status: 'accepted' },
      ],
    });
    expect(esTurnoDelPaciente(conMedico, 'Patient/p1')).toBe(true);
  });
});

describe('motivoNoAccionable — última línea antes de escribir en la agenda', () => {
  it('deja pasar los estados accionables a futuro', () => {
    for (const status of ['proposed', 'pending', 'booked', 'waitlist'] as const) {
      expect(motivoNoAccionable(turno({ status }))).toBeUndefined();
    }
  });

  it('un turno ya cancelado lo dice con todas las letras', () => {
    expect(motivoNoAccionable(turno({ status: 'cancelled' }))).toContain('ya estaba cancelado');
  });

  it('un turno cumplido o no-show no se toca desde la app', () => {
    expect(motivoNoAccionable(turno({ status: 'fulfilled' }))).toBeTruthy();
    expect(motivoNoAccionable(turno({ status: 'noshow' }))).toBeTruthy();
  });

  it('un turno que ya pasó se rechaza aunque el estado sea accionable', () => {
    expect(motivoNoAccionable(turno({ status: 'booked', start: enHoras(-1) }))).toContain('ya pasó');
  });

  it('el borde es el arranque del turno: 1 minuto antes todavía se puede', () => {
    expect(motivoNoAccionable(turno({ start: enHoras(0.02) }))).toBeUndefined();
  });
});

describe('tope de movimientos (R-13 · autogestión)', () => {
  const usados = (a: Appointment): number =>
    a.extension?.find((x) => x.url === EXT.movimientos)?.valueInteger ?? 0;

  it('un turno sin la extensión cuenta como 0 movimientos', () => {
    // Contrato con el portal: sin la extensión NO se asume que llegó al tope.
    expect(usados(turno())).toBe(0);
    expect(usados(turno()) < MOVIMIENTOS.max).toBe(true);
  });

  it('con el tope alcanzado ya no quedan movimientos', () => {
    const topeado = turno({ extension: [{ url: EXT.movimientos, valueInteger: MOVIMIENTOS.max }] });
    expect(usados(topeado) >= MOVIMIENTOS.max).toBe(true);
  });

  it('el tope configurado es 3 (lo que publica el sitio)', () => {
    expect(MOVIMIENTOS.max).toBe(3);
  });
});
