import { describe, it, expect } from 'vitest';
import {
  candidatosSemana,
  claveSemana,
  fechasPreferidasDeSemana,
  horariosAlternativos,
  inicioTurnoISO,
  parsePreferencia,
  perteneceASemana,
  serializarDias,
  validarTopeSemanal,
} from '../src/lib/semana-membresia.js';
import { HORARIO_SEMANAL } from '../src/config/horario.js';

const esDiaAbierto = (dia: number): boolean => HORARIO_SEMANAL.find((h) => h.dia === dia)?.abierto ?? false;

// Miércoles 2 de septiembre de 2026, 10:00 de Argentina (semana del lunes 31/8).
const AHORA = new Date('2026-09-02T10:00:00-03:00');

const basePref = { dias: [1, 4], hora: '18:00' }; // lunes y jueves 18:00

function opts(extra: Partial<Parameters<typeof candidatosSemana>[0]> = {}) {
  return {
    preferencia: basePref,
    perfil: 'FM' as const,
    ahora: AHORA,
    fechasAsignadas: new Set<string>(),
    saldoRestante: 8,
    frecuenciaSemanal: 2,
    esDiaAbierto,
    ...extra,
  };
}

describe('R-21 · semanas y preferencia', () => {
  it('claveSemana: el domingo pertenece a la semana que termina', () => {
    expect(claveSemana(new Date('2026-09-06T12:00:00-03:00'))).toBe('2026-08-31'); // domingo
    expect(claveSemana(AHORA)).toBe('2026-08-31'); // miércoles
    expect(claveSemana(new Date('2026-09-07T00:30:00-03:00'))).toBe('2026-09-07'); // lunes siguiente
  });

  it('perteneceASemana y fechasPreferidasDeSemana', () => {
    expect(perteneceASemana('2026-09-03', '2026-08-31')).toBe(true);
    expect(perteneceASemana('2026-09-07', '2026-08-31')).toBe(false);
    expect(fechasPreferidasDeSemana('2026-08-31', [1, 4])).toEqual(['2026-08-31', '2026-09-03']);
  });

  it('parsePreferencia: normaliza, deduplica y rechaza inválidas', () => {
    expect(parsePreferencia('4,1', '18:00')).toEqual({ dias: [1, 4], hora: '18:00' });
    expect(parsePreferencia('1,1,9', '08:30')).toEqual({ dias: [1], hora: '08:30' });
    expect(parsePreferencia('x', '18:00')).toBeUndefined();
    expect(parsePreferencia('1,4', '25:99')).toBeUndefined();
    expect(parsePreferencia(undefined, '18:00')).toBeUndefined();
    expect(serializarDias([4, 1, 4])).toBe('1,4');
  });

  it('inicioTurnoISO fija el offset de Argentina', () => {
    expect(inicioTurnoISO('2026-09-03', '18:00')).toBe('2026-09-03T18:00:00-03:00');
  });
});

describe('R-21 · tope semanal', () => {
  it('Bloquea al llegar a la frecuencia del plan (tope duro, sin recupero)', () => {
    const r = validarTopeSemanal(2, 2);
    expect(r.ok).toBe(false);
    expect(r.bloqueos[0]?.regla).toBe('R-21');
  });

  it('Deja pasar por debajo de la frecuencia', () => {
    expect(validarTopeSemanal(1, 2).ok).toBe(true);
    expect(validarTopeSemanal(2, 3).ok).toBe(true);
  });
});

describe('R-21 · candidatos de la semana (la escalera de ventanas se da sola)', () => {
  it('STANDARD (72 h): solo entra el jueves de ESTA semana; la próxima todavía no abrió', () => {
    const c = candidatosSemana(opts({ perfil: 'STANDARD' }));
    expect(c.map((x) => x.fecha)).toEqual(['2026-09-03']);
  });

  it('FM (7 días): entra el jueves de esta semana Y el lunes de la próxima', () => {
    const c = candidatosSemana(opts({ perfil: 'FM' }));
    expect(c.map((x) => x.fecha)).toEqual(['2026-09-03', '2026-09-07']);
  });

  it('INTENSIVO (96 h) con 3 días: jueves entra, viernes entra, lunes próximo no', () => {
    const c = candidatosSemana(
      opts({ perfil: 'INTENSIVO', preferencia: { dias: [1, 3, 5], hora: '18:00' }, frecuenciaSemanal: 3 }),
    );
    // Miércoles 18:00 de hoy está a 8 h (entra), viernes 4/9 a 56 h (entra); lunes 7/9 a 128 h (no).
    expect(c.map((x) => x.fecha)).toEqual(['2026-09-02', '2026-09-04']);
  });

  it('No duplica fechas ya asignadas y respeta el tope de la semana', () => {
    const c = candidatosSemana(opts({ fechasAsignadas: new Set(['2026-09-03']) }));
    expect(c.map((x) => x.fecha)).toEqual(['2026-09-07']);

    const semanaLlena = candidatosSemana(opts({ fechasAsignadas: new Set(['2026-08-31', '2026-09-03']) }));
    expect(semanaLlena.map((x) => x.fecha)).toEqual(['2026-09-07']); // el tope es POR semana
  });

  it('Respeta el saldo del ciclo (R-10)', () => {
    expect(candidatosSemana(opts({ saldoRestante: 1 })).map((x) => x.fecha)).toEqual(['2026-09-03']);
    expect(candidatosSemana(opts({ saldoRestante: 0 }))).toEqual([]);
  });

  it('Saltea los días cerrados (domingo) y los horarios ya pasados', () => {
    const c = candidatosSemana(opts({ preferencia: { dias: [0, 1], hora: '18:00' } }));
    // Domingo cerrado; lunes 31/8 ya pasó → solo el lunes de la semana próxima.
    expect(c.map((x) => x.fecha)).toEqual(['2026-09-07']);
  });
});

describe('R-21 · horarios alternativos del día', () => {
  const franjas = [{ desde: '08:00', hasta: '22:00' }];

  it('Ordena por cercanía a la hora preferida (empate → el más temprano)', () => {
    expect(horariosAlternativos('18:00', franjas, 120, 30, 4)).toEqual(['17:30', '18:30', '17:00', '19:00']);
  });

  it('No ofrece inicios donde la sesión no termina antes del cierre', () => {
    const alts = horariosAlternativos('21:00', franjas, 120, 30, 4);
    expect(alts[0]).toBe('20:00'); // 20:00 + 120 min = cierre exacto
    expect(alts).not.toContain('20:30');
    expect(alts).not.toContain('21:30');
  });
});
