import { describe, expect, it } from 'vitest';
import { validarReserva } from '../src/bots/reservar-turno.js';
import { reservasRelevantes, type ReservaRecurso } from '../src/lib/reglas-turno.js';
import { getServicio } from '../src/config/catalogo.js';

/**
 * 2026-09-11, producción: Andrés pidió un turno de Multiplaza desde el portal,
 * que lo ofreció con 6 lugares. En recepción, confirmarlo fallaba con
 *
 *   [R-07] Se excede la capacidad del recurso R_IHHT_1 (máx 1 personas).
 *
 * R_IHHT_1 es OTRA sala. `validarRecursos` valida todo lo que se le pasa, y la
 * reserva le pasaba la agenda entera del día: un problema preexistente en
 * cualquier sala bloqueaba cualquier turno. La disponibilidad ya filtraba —por
 * eso las dos pantallas se contradecían, cada una con razón por su lado.
 */

const AHORA = new Date('2026-09-11T12:00:00-03:00');
const INICIO = new Date('2026-09-11T18:00:00-03:00');
const MULTIPLAZA = getServicio('HBOT_MULTIPLAZA');

function reserva(recurso: string, hora: string, ocupantes = 1): ReservaRecurso {
  const inicio = new Date(`2026-09-11T${hora}:00-03:00`);
  return { recursoCodigo: recurso, inicio, fin: new Date(inicio.getTime() + 60 * 60_000), ocupantes };
}

function reservarMultiplaza(reservasExistentes: ReservaRecurso[]) {
  return validarReserva({
    servicio: MULTIPLAZA,
    inicio: INICIO,
    fin: new Date(INICIO.getTime() + MULTIPLAZA.duracionMin * 60_000),
    recursoCodigo: 'R_HBOT_MULTIPLAZA',
    ocupantes: 1,
    contraindicacionesActivas: [],
    prescripcionActiva: false,
    consentimientoFirmado: false,
    consentimientoGeneralFirmado: true,
    screeningCompleto: true,
    autorizacionMedica: false,
    reservasExistentes,
    ahora: AHORA,
  });
}

describe('reservar · una sala rota no bloquea otra (R-07)', () => {
  it('la Multiplaza se reserva aunque R_IHHT_1 esté excedida', () => {
    // Dos turnos a la misma hora en una sala de capacidad 1: condición inválida
    // preexistente, en una sala que no tiene nada que ver con la Multiplaza.
    const r = reservarMultiplaza([reserva('R_IHHT_1', '18:00'), reserva('R_IHHT_1', '18:00')]);
    expect(r.bloqueos.filter((b) => b.mensaje.includes('R_IHHT_1'))).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('la capacidad de SU sala sí bloquea', () => {
    // Multiplaza tiene 6 asientos: con 6 ya tomados, el séptimo no entra.
    const llena = Array.from({ length: 6 }, () => reserva('R_HBOT_MULTIPLAZA', '18:00'));
    expect(reservarMultiplaza(llena).ok).toBe(false);
  });

  it('la sala que COMPARTE equipo sigue contando (R-07 · desfasaje Recovery)', () => {
    // Los gabinetes Recovery comparten las tumbonas: G2 a la misma hora que G1
    // tiene que seguir bloqueando, o el filtro habría roto AC-05.
    const r = validarReserva({
      servicio: getServicio('RECOVERY_PRO'),
      inicio: INICIO,
      fin: new Date(INICIO.getTime() + getServicio('RECOVERY_PRO').duracionMin * 60_000),
      recursoCodigo: 'R_RECOVERY_G1',
      ocupantes: 1,
      contraindicacionesActivas: [],
      prescripcionActiva: false,
      consentimientoFirmado: false,
      consentimientoGeneralFirmado: true,
      screeningCompleto: true,
      autorizacionMedica: false,
      reservasExistentes: [reserva('R_RECOVERY_G2', '18:00')],
      ahora: AHORA,
    });
    expect(r.ok).toBe(false);
  });
});

describe('reservasRelevantes', () => {
  const agenda = [
    reserva('R_HBOT_MULTIPLAZA', '18:00'),
    reserva('R_IHHT_1', '18:00'),
    reserva('R_RECOVERY_G2', '18:00'),
  ];

  it('se queda con la sala pedida y descarta las ajenas', () => {
    expect(reservasRelevantes(agenda, 'R_HBOT_MULTIPLAZA').map((r) => r.recursoCodigo)).toEqual([
      'R_HBOT_MULTIPLAZA',
    ]);
  });

  it('incluye las que comparten equipo', () => {
    expect(reservasRelevantes(agenda, 'R_RECOVERY_G1').map((r) => r.recursoCodigo)).toEqual([
      'R_RECOVERY_G2',
    ]);
  });
});
