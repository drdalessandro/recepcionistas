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
    consentimientoFirmado: over.consentimientoFirmado ?? false,
    // R-20: por default el paciente está en regla (firmó y completó el ingreso),
    // para que estos casos prueben SU regla y no se choquen con la aptitud. Los
    // casos de R-20 propiamente dichos la pisan explícitamente.
    consentimientoGeneralFirmado: over.consentimientoGeneralFirmado ?? true,
    screeningCompleto: over.screeningCompleto ?? true,
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

  it('TB (péptidos) con prescripción pero SIN consentimiento firmado => bloqueo (R-03)', () => {
    const r = validarReserva(
      ctx({ servicioCodigo: 'PEPTIDOS_G1', recursoCodigo: 'R_SALA_TB', inicio: new Date('2026-06-22T09:00:00-03:00'), prescripcionActiva: true }),
    );
    expect(r.ok).toBe(false);
    expect(r.bloqueos.some((b) => b.regla === 'R-03' && b.mensaje.includes('consentimiento'))).toBe(true);
  });

  it('TB con prescripción + consentimiento firmado => ok', () => {
    const r = validarReserva(
      ctx({
        servicioCodigo: 'PEPTIDOS_G1',
        recursoCodigo: 'R_SALA_TB',
        inicio: new Date('2026-06-22T09:00:00-03:00'),
        prescripcionActiva: true,
        consentimientoFirmado: true,
      }),
    );
    expect(r.ok).toBe(true);
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

  // R-20 · el hallazgo del recorrido del walk-in (2026-08-14): el portal exigía
  // consentimiento y screening, y el mostrador no — y el walk-in ES el mostrador.
  // Sin override: decisión de Andrés.
  describe('R-20 · sin consentimiento general ni cuestionario de ingreso no se reserva', () => {
    const base = {
      servicioCodigo: 'HBOT_MONO',
      recursoCodigo: 'R_HBOT_MONO',
      inicio: new Date('2026-06-22T09:00:00-03:00'),
    };

    it('sin consentimiento general => bloqueo, aunque sea HBOT (no solo TB como R-03)', () => {
      const r = validarReserva(ctx({ ...base, consentimientoGeneralFirmado: false }));
      expect(r.ok).toBe(false);
      expect(r.bloqueos.some((b) => b.regla === 'R-20' && /no firmó/i.test(b.mensaje))).toBe(true);
    });

    it('sin cuestionario de ingreso => bloqueo', () => {
      const r = validarReserva(ctx({ ...base, screeningCompleto: false }));
      expect(r.ok).toBe(false);
      expect(r.bloqueos.some((b) => b.regla === 'R-20' && /cuestionario de ingreso/i.test(b.mensaje))).toBe(true);
    });

    it('FALLA CERRADO: si no se pudo verificar, bloquea igual que si faltara', () => {
      for (const campo of ['consentimientoGeneralFirmado', 'screeningCompleto'] as const) {
        // Se pisa DESPUÉS de ctx(): el helper usa `?? true` y no distingue
        // "no lo pasaron" de "vino undefined", que es justo lo que se prueba acá.
        const r = validarReserva({ ...ctx({ ...base }), [campo]: undefined });
        expect(r.ok).toBe(false);
        expect(r.bloqueos.some((b) => b.regla === 'R-20' && /no pudimos verificar/i.test(b.mensaje))).toBe(true);
      }
    });

    it('el walk-in recién creado (sin nada) junta los dos bloqueos', () => {
      const r = validarReserva(ctx({ ...base, consentimientoGeneralFirmado: false, screeningCompleto: false }));
      expect(r.ok).toBe(false);
      expect(r.bloqueos.filter((b) => b.regla === 'R-20')).toHaveLength(2);
    });

    it('NO hay override: la autorización médica levanta R-02 pero nunca R-20', () => {
      const r = validarReserva(
        ctx({
          ...base,
          consentimientoGeneralFirmado: false,
          screeningCompleto: false,
          autorizacionMedica: true,
          prescripcionActiva: true,
          consentimientoFirmado: true,
        }),
      );
      expect(r.ok).toBe(false);
      expect(r.bloqueos.some((b) => b.regla === 'R-20')).toBe(true);
    });

    it('con las dos cosas en regla, la reserva pasa', () => {
      const r = validarReserva(ctx({ ...base, consentimientoGeneralFirmado: true, screeningCompleto: true }));
      expect(r.ok).toBe(true);
    });
  });
});
