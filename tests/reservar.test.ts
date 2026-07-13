import { describe, it, expect } from 'vitest';
import { getServicio } from '../src/config/catalogo.js';
import { validarReserva, type ContextoReserva } from '../src/bots/reservar-turno.js';
import type { ReservaRecurso } from '../src/lib/reglas-turno.js';

const AHORA = new Date('2026-06-22T08:00:00-03:00');

function ctx(over: Partial<ContextoReserva> & { servicioCodigo: string; recursoCodigo: string; inicio: Date }): ContextoReserva {
  const servicio = getServicio(over.servicioCodigo);
  const inicio = over.inicio;
  const fin = new Date(inicio.getTime() + servicio.duracionMin * 60_000);
  return {
    servicio,
    inicio,
    fin,
    recursoCodigo: over.recursoCodigo,
    ocupantes: over.ocupantes,
    contraindicacionesActivas: over.contraindicacionesActivas ?? [],
    prescripcionActiva: over.prescripcionActiva ?? false,
    autorizacionMedica: over.autorizacionMedica ?? false,
    reservasExistentes: over.reservasExistentes ?? [],
    perfil: over.perfil,
    ahora: over.ahora ?? AHORA,
  };
}

function reserva(recursoCodigo: string, desde: string, hasta: string): ReservaRecurso {
  return {
    recursoCodigo,
    inicio: new Date(`2026-06-22T${desde}:00-03:00`),
    fin: new Date(`2026-06-22T${hasta}:00-03:00`),
  };
}

describe('validarReserva', () => {
  it('Turno válido (HBOT mono, sala libre, futuro) => ok', () => {
    const r = validarReserva(ctx({ servicioCodigo: 'HBOT_MONO', recursoCodigo: 'R_HBOT_MONO', inicio: new Date('2026-06-22T09:00:00-03:00') }));
    expect(r.ok).toBe(true);
    expect(r.bloqueos).toHaveLength(0);
  });

  it('Turno en el pasado => bloqueo', () => {
    const r = validarReserva(ctx({ servicioCodigo: 'HBOT_MONO', recursoCodigo: 'R_HBOT_MONO', inicio: new Date('2026-06-22T07:00:00-03:00') }));
    expect(r.ok).toBe(false);
  });

  it('Misma sala (cap 1) ya ocupada => bloqueo (R-07)', () => {
    const r = validarReserva(
      ctx({
        servicioCodigo: 'HBOT_MONO',
        recursoCodigo: 'R_HBOT_MONO',
        inicio: new Date('2026-06-22T09:00:00-03:00'),
        reservasExistentes: [reserva('R_HBOT_MONO', '09:00', '10:00')],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.bloqueos.some((b) => b.regla === 'R-07')).toBe(true);
  });

  it('Recovery G2 a la misma hora que G1 => bloqueo por desfasaje (R-07)', () => {
    const r = validarReserva(
      ctx({
        servicioCodigo: 'RECOVERY_PRO',
        recursoCodigo: 'R_RECOVERY_G2',
        inicio: new Date('2026-06-22T09:00:00-03:00'),
        reservasExistentes: [reserva('R_RECOVERY_G1', '09:00', '10:00')],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('Recovery G2 con 30 min de desfasaje => ok', () => {
    const r = validarReserva(
      ctx({
        servicioCodigo: 'RECOVERY_PRO',
        recursoCodigo: 'R_RECOVERY_G2',
        inicio: new Date('2026-06-22T09:30:00-03:00'),
        reservasExistentes: [reserva('R_RECOVERY_G1', '09:00', '10:00')],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('IV NAD+ sin prescripción => bloqueo (R-03)', () => {
    const r = validarReserva(ctx({ servicioCodigo: 'IV_NAD', recursoCodigo: 'R_SALA_TB', inicio: new Date('2026-06-22T09:00:00-03:00') }));
    expect(r.ok).toBe(false);
    expect(r.bloqueos.some((b) => b.regla === 'R-03')).toBe(true);
  });

  it('IV NAD+ con prescripción => ok (con advertencia de HBOT previo)', () => {
    const r = validarReserva(ctx({ servicioCodigo: 'IV_NAD', recursoCodigo: 'R_SALA_TB', inicio: new Date('2026-06-22T09:00:00-03:00'), prescripcionActiva: true }));
    expect(r.ok).toBe(true);
    expect(r.advertencias.length).toBeGreaterThanOrEqual(1);
  });

  it('Dos consultas en el consultorio a la misma hora => bloqueo (R-07, un solo consultorio)', () => {
    const r = validarReserva(
      ctx({
        servicioCodigo: 'CONSULTA_MED_DALESSANDRO',
        recursoCodigo: 'R_CONSULTORIO',
        inicio: new Date('2026-06-22T09:00:00-03:00'),
        reservasExistentes: [reserva('R_CONSULTORIO', '09:00', '10:00')],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.bloqueos.some((b) => b.regla === 'R-07')).toBe(true);
  });

  it('Biplaza ya reservada (aunque sea 1 persona) => bloqueo: reserva exclusiva', () => {
    const r = validarReserva(
      ctx({
        servicioCodigo: 'HBOT_BIPLAZA',
        recursoCodigo: 'R_HBOT_BIPLAZA',
        inicio: new Date('2026-06-22T09:00:00-03:00'),
        ocupantes: 2,
        reservasExistentes: [{ ...reserva('R_HBOT_BIPLAZA', '09:00', '10:00'), ocupantes: 1 }],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.bloqueos.some((b) => b.mensaje.includes('exclusiva'))).toBe(true);
  });

  it('Multiplaza con lugar => ok, con ADVERTENCIA de mínimo 3 si no llega', () => {
    const r = validarReserva(
      ctx({
        servicioCodigo: 'HBOT_MULTIPLAZA',
        recursoCodigo: 'R_HBOT_MULTIPLAZA',
        inicio: new Date('2026-06-22T09:00:00-03:00'),
        ocupantes: 2,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.advertencias.some((a) => a.mensaje.includes('mínimo 3'))).toBe(true);
  });

  it('Multiplaza llena por personas (4 + 3 > 6) => bloqueo (R-07)', () => {
    const r = validarReserva(
      ctx({
        servicioCodigo: 'HBOT_MULTIPLAZA',
        recursoCodigo: 'R_HBOT_MULTIPLAZA',
        inicio: new Date('2026-06-22T09:00:00-03:00'),
        ocupantes: 3,
        reservasExistentes: [{ ...reserva('R_HBOT_MULTIPLAZA', '09:00', '10:00'), ocupantes: 4 }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('Más personas que la capacidad del recurso => bloqueo', () => {
    const r = validarReserva(
      ctx({
        servicioCodigo: 'HBOT_MULTIPLAZA',
        recursoCodigo: 'R_HBOT_MULTIPLAZA',
        inicio: new Date('2026-06-22T09:00:00-03:00'),
        ocupantes: 7,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.bloqueos.some((b) => b.mensaje.includes('hasta 6 personas'))).toBe(true);
  });

  it('Contraindicación absoluta activa => bloqueo (R-02)', () => {
    const r = validarReserva(
      ctx({
        servicioCodigo: 'HBOT_MONO',
        recursoCodigo: 'R_HBOT_MONO',
        inicio: new Date('2026-06-22T09:00:00-03:00'),
        contraindicacionesActivas: ['HBOT_NEUMOTORAX_NO_TRATADO'],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.bloqueos.some((b) => b.regla === 'R-02')).toBe(true);
  });
});
