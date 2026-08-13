/**
 * Agendas publicadas de los médicos (portal → Consulta médica).
 * Franjas definidas por Andrés: Conrado 2026-07-26, D'Alessandro y Dos Santos
 * 2026-08-13.
 */
import { describe, it, expect } from 'vitest';
import { solapamientosDeAgendas } from '../src/lib/agenda-medicos.js';
import { MEDICOS, MEDICOS_POR_CODIGO, codigoConsulta } from '../src/config/medicos.js';
import { getServicio } from '../src/config/catalogo.js';
import { horarioDeAgendaMedico } from '../src/seed/builders.js';
import { generarSlots } from '../src/lib/slots.js';
import { HORARIO_SEMANAL } from '../src/config/horario.js';

/** Slots de una semana completa para un médico, como los genera el seed. */
function slotsDeUnaSemana(codigo: string): string[] {
  const m = MEDICOS_POR_CODIGO.get(codigo)!;
  const dur = getServicio(codigoConsulta(codigo)).duracionMin;
  return generarSlots([{ codigo, nombre: m.nombre, tipo: 'CONSULTORIO', capacidad: 1 }], horarioDeAgendaMedico(m), {
    // Lunes 2026-08-17, 7 días: cubre la semana entera.
    desde: new Date('2026-08-17T00:00:00Z'),
    dias: 7,
    granularidadMin: dur,
  }).map((s) => s.inicio);
}

describe('Agenda publicada — franjas declaradas', () => {
  it("D'Alessandro: martes y jueves 16-20, miércoles 8-12 (4 turnos de 60 min cada día)", () => {
    const inicios = slotsDeUnaSemana('MED_DALESSANDRO');
    // Martes 18/08 y jueves 20/08 a la tarde; miércoles 19/08 a la mañana.
    expect(inicios).toContain('2026-08-18T16:00:00-03:00');
    expect(inicios).toContain('2026-08-18T19:00:00-03:00');
    expect(inicios).toContain('2026-08-19T08:00:00-03:00');
    expect(inicios).toContain('2026-08-19T11:00:00-03:00');
    expect(inicios).toContain('2026-08-20T16:00:00-03:00');
    // El último turno TERMINA a las 20:00: no se ofrece uno que se pase.
    expect(inicios).not.toContain('2026-08-18T20:00:00-03:00');
    expect(inicios).not.toContain('2026-08-19T12:00:00-03:00');
    // Nada fuera de sus días.
    expect(inicios.some((i) => i.startsWith('2026-08-17'))).toBe(false); // lunes
    expect(inicios.some((i) => i.startsWith('2026-08-21'))).toBe(false); // viernes
    expect(inicios).toHaveLength(12); // 3 días × 4 turnos
  });

  it('Dos Santos: miércoles 17-20 (3 turnos)', () => {
    const inicios = slotsDeUnaSemana('MED_DOS_SANTOS');
    expect(inicios).toEqual([
      '2026-08-19T17:00:00-03:00',
      '2026-08-19T18:00:00-03:00',
      '2026-08-19T19:00:00-03:00',
    ]);
  });

  it('Toda franja publicada cae dentro del horario del centro', () => {
    for (const m of MEDICOS.filter((x) => (x.agenda?.length ?? 0) > 0)) {
      for (const f of m.agenda!) {
        const centro = HORARIO_SEMANAL.find((h) => h.dia === f.dia)!;
        expect(centro.abierto, `${m.nombre}: el centro cierra ese día`).toBe(true);
        const cabe = centro.franjas.some((c) => c.desde <= f.desde && f.hasta <= c.hasta);
        expect(cabe, `${m.nombre} ${f.desde}-${f.hasta} fuera del horario del centro`).toBe(true);
      }
    }
  });
});

describe('solapamientosDeAgendas — un solo consultorio', () => {
  it('Detecta el cruce real: Dos Santos y Conrado comparten miércoles 17-20', () => {
    const cruces = solapamientosDeAgendas(MEDICOS);
    const miercoles = cruces.find((c) => c.dia === 3 && c.desde === '17:00' && c.hasta === '20:00');
    expect(miercoles).toBeDefined();
    expect([miercoles!.medicoA, miercoles!.medicoB].sort()).toEqual([
      'Dr. Conrado López Alonso',
      'Dra. Stephanie Dos Santos',
    ]);
  });

  it("D'Alessandro no cruza con nadie (miércoles a la mañana, los otros a la tarde)", () => {
    const cruces = solapamientosDeAgendas(MEDICOS);
    expect(cruces.some((c) => c.medicoA.includes('Alessandro') || c.medicoB.includes('Alessandro'))).toBe(false);
  });

  it('Tocarse no es superponerse (una termina cuando la otra empieza)', () => {
    const pegadas = solapamientosDeAgendas([
      { codigo: 'A', nombre: 'A', esDirector: false, precioConsultaARS: 1, agenda: [{ dia: 1, desde: '08:00', hasta: '12:00' }] },
      { codigo: 'B', nombre: 'B', esDirector: false, precioConsultaARS: 1, agenda: [{ dia: 1, desde: '12:00', hasta: '16:00' }] },
    ]);
    expect(pegadas).toEqual([]);
  });

  it('Un médico sin agenda no genera cruces', () => {
    const sinAgenda = solapamientosDeAgendas([
      { codigo: 'A', nombre: 'A', esDirector: false, precioConsultaARS: 1, agenda: [{ dia: 1, desde: '08:00', hasta: '12:00' }] },
      { codigo: 'B', nombre: 'B', esDirector: false, precioConsultaARS: 1 },
    ]);
    expect(sinAgenda).toEqual([]);
  });
});
