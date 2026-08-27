import { describe, expect, it } from 'vitest';
import { armarMapaSemana, fechaLocalISO, lunesDe, type TurnoMapa } from '../src/lib/mapa-semana.js';
import { HORARIO_SEMANAL } from '../src/config/horario.js';

// Semana fija: lunes 24 al domingo 30 de agosto de 2026.
const LUNES = new Date(2026, 7, 24);

function turno(recursoCodigo: string, fecha: string, desde: number, hasta: number): TurnoMapa {
  return { recursoCodigo, fecha, inicioMin: desde, finMin: hasta };
}

function celda(mapa: ReturnType<typeof armarMapaSemana>, fecha: string, hora: number): number | null {
  const dia = mapa.dias.find((d) => d.fecha === fecha);
  const c = dia?.celdas.find((x) => x.hora === hora);
  if (!dia || !c) {
    throw new Error(`No existe la celda ${fecha} ${hora}:00`);
  }
  return c.salas;
}

describe('lunesDe · la semana arranca el lunes', () => {
  it('de un miércoles vuelve al lunes', () => {
    expect(fechaLocalISO(lunesDe(new Date(2026, 7, 26)))).toBe('2026-08-24');
  });

  it('de un lunes se queda en el lunes', () => {
    expect(fechaLocalISO(lunesDe(new Date(2026, 7, 24)))).toBe('2026-08-24');
  });

  it('el domingo pertenece a la semana que TERMINA, no a la que empieza', () => {
    expect(fechaLocalISO(lunesDe(new Date(2026, 7, 30)))).toBe('2026-08-24');
  });
});

describe('armarMapaSemana · estructura', () => {
  const mapa = armarMapaSemana([], LUNES, HORARIO_SEMANAL);

  it('siempre 7 días, lunes a domingo, aunque no haya un solo turno', () => {
    expect(mapa.dias.map((d) => d.fecha)).toEqual([
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
    ]);
  });

  it('el eje de horas es la unión: 8 a 21 (L-V cierra 22, la última celda arranca 21)', () => {
    expect(mapa.horas[0]).toBe(8);
    expect(mapa.horas[mapa.horas.length - 1]).toBe(21);
  });

  it('el domingo está cerrado entero: celdas null, nunca 0', () => {
    const domingo = mapa.dias.find((d) => d.dia === 0)!;
    expect(domingo.abierto).toBe(false);
    expect(domingo.celdas.every((c) => c.salas === null)).toBe(true);
  });

  it('el sábado corta a las 20: la celda de las 19 abre y la de las 20 no', () => {
    expect(celda(mapa, '2026-08-29', 19)).toBe(0);
    expect(celda(mapa, '2026-08-29', 20)).toBeNull();
    expect(celda(mapa, '2026-08-29', 21)).toBeNull();
  });

  it('un día abierto sin turnos es 0 (vacío), que no es lo mismo que cerrado', () => {
    expect(celda(mapa, '2026-08-24', 10)).toBe(0);
  });
});

describe('armarMapaSemana · la cuenta es de SALAS, no de turnos', () => {
  it('seis personas en la Multiplaza son UNA sala ocupada', () => {
    const seis = Array.from({ length: 6 }, () => turno('R_HBOT_MULTIPLAZA', '2026-08-25', 720, 750));
    const mapa = armarMapaSemana(seis, LUNES, HORARIO_SEMANAL);
    expect(celda(mapa, '2026-08-25', 12)).toBe(1);
  });

  it('dos salas distintas en la misma hora son 2', () => {
    const mapa = armarMapaSemana(
      [turno('R_HBOT_MONO', '2026-08-25', 600, 660), turno('R_IHHT_1', '2026-08-25', 630, 660)],
      LUNES,
      HORARIO_SEMANAL,
    );
    expect(celda(mapa, '2026-08-25', 10)).toBe(2);
  });

  it('un turno de 60 que arranca a la media pisa las DOS celdas que toca', () => {
    // 10:30–11:30 ocupa la celda de las 10 y la de las 11.
    const mapa = armarMapaSemana([turno('R_HBOT_MONO', '2026-08-26', 630, 690)], LUNES, HORARIO_SEMANAL);
    expect(celda(mapa, '2026-08-26', 10)).toBe(1);
    expect(celda(mapa, '2026-08-26', 11)).toBe(1);
    expect(celda(mapa, '2026-08-26', 12)).toBe(0);
  });

  it('el turno que TERMINA justo a la hora no pisa la celda siguiente', () => {
    // 09:00–10:00: la celda de las 10 queda libre (intervalos semiabiertos).
    const mapa = armarMapaSemana([turno('R_COT03', '2026-08-27', 540, 600)], LUNES, HORARIO_SEMANAL);
    expect(celda(mapa, '2026-08-27', 9)).toBe(1);
    expect(celda(mapa, '2026-08-27', 10)).toBe(0);
  });

  it('los turnos de otro día no ensucian la celda', () => {
    const mapa = armarMapaSemana([turno('R_HBOT_MONO', '2026-08-25', 600, 660)], LUNES, HORARIO_SEMANAL);
    expect(celda(mapa, '2026-08-26', 10)).toBe(0);
  });
});
