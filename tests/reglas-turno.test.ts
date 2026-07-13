import { describe, it, expect } from 'vitest';
import { getServicio } from '../src/config/catalogo.js';
import {
  validarOrdenHBOT,
  recomendarHbotPrevio,
  validarCapacidadRecurso,
  validarMinimoGrupal,
  validarDesfasajeRecovery,
  validarVentanaReserva,
  evaluarCancelacion,
  validarSaldoMembresia,
  validarContraindicaciones,
  validarPrescripcion,
  bannerSeguridad,
  type ReservaRecurso,
} from '../src/lib/reglas-turno.js';

/** Helper: arma un Date a partir de "HH:mm" del 2026-06-22 (lunes). */
function h(hhmm: string): Date {
  return new Date(`2026-06-22T${hhmm}:00-03:00`);
}

function reserva(recursoCodigo: string, desde: string, hasta: string, ocupantes?: number): ReservaRecurso {
  return { recursoCodigo, inicio: h(desde), fin: h(hasta), ocupantes };
}

describe('R-01 · HBOT siempre primero', () => {
  it('AC-02: BIO LONGEVITY = HBOT -> IHHT -> Recovery Pro es válido', () => {
    const r = validarOrdenHBOT(['HBOT', 'IHHT', 'RECOVERY_PRO']);
    expect(r.ok).toBe(true);
  });

  it('Si HBOT no va primero => bloqueo', () => {
    const r = validarOrdenHBOT(['IHHT', 'HBOT']);
    expect(r.ok).toBe(false);
    expect(r.bloqueos[0]?.regla).toBe('R-01');
  });

  it('IV/TB sin HBOT previo => advertencia (recomendado, no obligatorio)', () => {
    const r = recomendarHbotPrevio('IV_THERAPY', false);
    expect(r.ok).toBe(true);
    expect(r.advertencias).toHaveLength(1);
  });
});

describe('R-07 · Capacidad y desfasaje', () => {
  it('AC-05: G1 09:00-10:00 y G2 09:00-10:00 => bloqueo (mismo arranque)', () => {
    const r = validarDesfasajeRecovery([
      reserva('R_RECOVERY_G1', '09:00', '10:00'),
      reserva('R_RECOVERY_G2', '09:00', '10:00'),
    ]);
    expect(r.ok).toBe(false);
    expect(r.bloqueos[0]?.regla).toBe('R-07');
  });

  it('AC-05: G1 09:00-10:00 y G2 09:30-10:30 => OK (desfasaje de 30 min)', () => {
    const r = validarDesfasajeRecovery([
      reserva('R_RECOVERY_G1', '09:00', '10:00'),
      reserva('R_RECOVERY_G2', '09:30', '10:30'),
    ]);
    expect(r.ok).toBe(true);
  });

  it('Mismo recurso (cap 1) solapado => excede capacidad', () => {
    const r = validarCapacidadRecurso([
      reserva('R_HBOT_MONO', '09:00', '10:00'),
      reserva('R_HBOT_MONO', '09:30', '10:30'),
    ]);
    expect(r.ok).toBe(false);
  });

  it('Recurso multiplaza (cap 6) admite varias reservas simultáneas', () => {
    const r = validarCapacidadRecurso([
      reserva('R_HBOT_MULTIPLAZA', '09:00', '10:00'),
      reserva('R_HBOT_MULTIPLAZA', '09:00', '10:00'),
      reserva('R_HBOT_MULTIPLAZA', '09:00', '10:00'),
    ]);
    expect(r.ok).toBe(true);
  });

  it('Multiplaza suma PERSONAS: 4 + 2 = 6 => OK; 4 + 3 = 7 => bloqueo', () => {
    const cuatro = reserva('R_HBOT_MULTIPLAZA', '09:00', '10:00', 4);
    expect(validarCapacidadRecurso([cuatro, reserva('R_HBOT_MULTIPLAZA', '09:00', '10:00', 2)]).ok).toBe(true);
    const r = validarCapacidadRecurso([cuatro, reserva('R_HBOT_MULTIPLAZA', '09:00', '10:00', 3)]);
    expect(r.ok).toBe(false);
    expect(r.bloqueos[0]?.mensaje).toContain('personas');
  });

  it('Biplaza es de reserva EXCLUSIVA: una pareja la toma completa', () => {
    const r = validarCapacidadRecurso([
      reserva('R_HBOT_BIPLAZA', '09:00', '10:00', 2),
      reserva('R_HBOT_BIPLAZA', '09:00', '10:00', 1),
    ]);
    expect(r.ok).toBe(false);
    expect(r.bloqueos[0]?.mensaje).toContain('exclusiva');
  });

  it('Biplaza: 1 persona sola también la toma completa (nunca comparten desconocidos)', () => {
    const r = validarCapacidadRecurso([
      reserva('R_HBOT_BIPLAZA', '09:00', '10:00', 1),
      reserva('R_HBOT_BIPLAZA', '09:30', '10:30', 1),
    ]);
    expect(r.ok).toBe(false);
  });

  it('Gabinete Recovery también es exclusivo (privado, USD 200 indivisible)', () => {
    const r = validarCapacidadRecurso([
      reserva('R_RECOVERY_G1', '09:00', '10:00', 2),
      reserva('R_RECOVERY_G1', '09:00', '10:00', 1),
    ]);
    expect(r.ok).toBe(false);
  });

  it('Mínimo grupal Multiplaza (3): reservar con menos ADVIERTE, no bloquea', () => {
    const nueva = reserva('R_HBOT_MULTIPLAZA', '09:00', '10:00', 2);
    const r = validarMinimoGrupal([nueva], nueva);
    expect(r.ok).toBe(true);
    expect(r.advertencias).toHaveLength(1);
    expect(r.advertencias[0]?.mensaje).toContain('mínimo 3');
  });

  it('Mínimo grupal: al llegar a 3 personas en la franja no advierte', () => {
    const nueva = reserva('R_HBOT_MULTIPLAZA', '09:00', '10:00', 1);
    const r = validarMinimoGrupal([reserva('R_HBOT_MULTIPLAZA', '09:00', '10:00', 2), nueva], nueva);
    expect(r.advertencias).toHaveLength(0);
  });

  it('Mínimo grupal: no aplica a recursos sin mínimo (mono)', () => {
    const nueva = reserva('R_HBOT_MONO', '09:00', '10:00', 1);
    expect(validarMinimoGrupal([nueva], nueva).advertencias).toHaveLength(0);
  });

  it('Turnos contiguos en el mismo recurso (uno termina cuando arranca el otro) => OK', () => {
    const r = validarCapacidadRecurso([
      reserva('R_HBOT_MONO', '09:00', '10:00'),
      reserva('R_HBOT_MONO', '10:00', '11:00'),
    ]);
    expect(r.ok).toBe(true);
  });
});

describe('R-13 · Ventana de reserva', () => {
  it('Público: 48 h máximo', () => {
    const ahora = h('09:00');
    const dentro = new Date(ahora.getTime() + 47 * 3600 * 1000);
    const fuera = new Date(ahora.getTime() + 49 * 3600 * 1000);
    expect(validarVentanaReserva('PUBLICO', ahora, dentro).ok).toBe(true);
    expect(validarVentanaReserva('PUBLICO', ahora, fuera).ok).toBe(false);
  });

  it('FM: 7 días', () => {
    const ahora = h('09:00');
    const a6dias = new Date(ahora.getTime() + 6 * 24 * 3600 * 1000);
    expect(validarVentanaReserva('FM', ahora, a6dias).ok).toBe(true);
  });
});

describe('R-14 · Cancelación', () => {
  it('Menos de 24 h => sesión consumida', () => {
    const ahora = h('09:00');
    const turno = new Date(ahora.getTime() + 12 * 3600 * 1000);
    const r = evaluarCancelacion(ahora, turno);
    expect(r.consumeSesion).toBe(true);
    expect(r.devuelveSaldo).toBe(false);
  });

  it('24 h o más => devuelve saldo', () => {
    const ahora = h('09:00');
    const turno = new Date(ahora.getTime() + 48 * 3600 * 1000);
    const r = evaluarCancelacion(ahora, turno);
    expect(r.devuelveSaldo).toBe(true);
  });

  it('Fuerza mayor médica con < 24 h => no consume', () => {
    const ahora = h('09:00');
    const turno = new Date(ahora.getTime() + 2 * 3600 * 1000);
    const r = evaluarCancelacion(ahora, turno, { fuerzaMayorMedica: true });
    expect(r.consumeSesion).toBe(false);
  });
});

describe('R-10 · Saldo de membresía', () => {
  it('AC-09: 8 consumidas de 8 => 9.ª bloqueada', () => {
    expect(validarSaldoMembresia(8, 8).ok).toBe(false);
  });

  it('7 de 8 => permite reservar', () => {
    expect(validarSaldoMembresia(7, 8).ok).toBe(true);
  });
});

describe('R-02 · Contraindicaciones y banner', () => {
  it('Banner verde sin contraindicaciones, rojo con alguna', () => {
    expect(bannerSeguridad([])).toBe('verde');
    expect(bannerSeguridad(['HBOT_NEUMOTORAX_NO_TRATADO'])).toBe('rojo');
  });

  it('Absoluta activa sin autorización => bloqueo', () => {
    const r = validarContraindicaciones(['HBOT'], ['HBOT_NEUMOTORAX_NO_TRATADO']);
    expect(r.ok).toBe(false);
    expect(r.bloqueos[0]?.regla).toBe('R-02');
  });

  it('Absoluta con autorización médica => permite', () => {
    const r = validarContraindicaciones(['HBOT'], ['HBOT_NEUMOTORAX_NO_TRATADO'], {
      autorizacionMedica: true,
    });
    expect(r.ok).toBe(true);
  });

  it('Relativa => advertencia, no bloqueo', () => {
    const r = validarContraindicaciones(['HBOT'], ['HBOT_CLAUSTROFOBIA']);
    expect(r.ok).toBe(true);
    expect(r.advertencias).toHaveLength(1);
  });

  it('Contraindicación de otra categoría no afecta', () => {
    const r = validarContraindicaciones(['RECOVERY_PRO'], ['HBOT_NEUMOTORAX_NO_TRATADO']);
    expect(r.ok).toBe(true);
  });
});

describe('R-03 · Prescripción médica', () => {
  it('IV sin prescripción => bloqueo', () => {
    const r = validarPrescripcion(getServicio('IV_NAD'), false);
    expect(r.ok).toBe(false);
  });

  it('IV con prescripción activa => permite', () => {
    const r = validarPrescripcion(getServicio('IV_NAD'), true);
    expect(r.ok).toBe(true);
  });

  it('Servicio sin prescripción requerida => siempre permite', () => {
    const r = validarPrescripcion(getServicio('HBOT_MONO'), false);
    expect(r.ok).toBe(true);
  });
});
