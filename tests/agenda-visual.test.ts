/**
 * El reparto vertical de la Agenda.
 *
 * Lo que se defiende es que ninguna banda quede tan finita que no se pueda
 * clickear — que es un bug que nadie reporta como tal: se reporta como "el
 * turno no está". Los tres casos (sala entera, sala con aforo, sala virtual)
 * usan denominadores distintos y confundirlos es exactamente lo que producía
 * bandas de 1 px.
 */
import { describe, expect, it } from 'vitest';
import {
  PESO_FILA_MAX,
  bandasDeFila,
  ocupacionEn,
  pesoDeFila,
  pesoTurno,
  posicionarTurnos,
  type SalaLayout,
} from '../src/lib/agenda-visual.js';
import { RECURSOS_POR_CODIGO } from '../src/config/recursos.js';

const sala = (codigo: string): SalaLayout => {
  const r = RECURSOS_POR_CODIGO.get(codigo);
  if (!r) {
    throw new Error(`recurso inexistente: ${codigo}`);
  }
  return { capacidad: r.capacidad, reservaExclusiva: r.reservaExclusiva === true, tipo: r.tipo };
};

const MULTIPLAZA = sala('R_HBOT_MULTIPLAZA');
const BIPLAZA = sala('R_HBOT_BIPLAZA');
const MONO = sala('R_HBOT_MONO');
const VIDEO = sala('R_TELECONSULTA');

const turno = (inicioMin: number, finMin: number, ocupantes = 1): { inicioMin: number; finMin: number; ocupantes: number } => ({
  inicioMin,
  finMin,
  ocupantes,
});

describe('bandasDeFila — el denominador correcto para cada clase de sala', () => {
  it('la sala con AFORO usa su capacidad aunque esté medio vacía', () => {
    // Media fila ocupada significa media sala ocupada: eso ES la información
    // que da el Multiplaza, y por eso el denominador no se achica.
    const uno = posicionarTurnos([turno(600, 660)], MULTIPLAZA);
    expect(bandasDeFila(MULTIPLAZA, uno)).toBe(6);
  });

  it('la sala ENTERA tiene una sola banda, sea cual sea su capacidad', () => {
    // El Biplaza tiene capacidad 2 pero una reserva lo toma completo: partir la
    // fila en dos mostraría un hueco que no se puede vender.
    expect(bandasDeFila(BIPLAZA, posicionarTurnos([turno(600, 660, 2)], BIPLAZA))).toBe(1);
    expect(bandasDeFila(MONO, posicionarTurnos([turno(600, 660)], MONO))).toBe(1);
  });

  it('la VIRTUAL cuenta videollamadas simultáneas, no su capacidad de 50', () => {
    // El bug que esto arregla: con 50 de denominador, una teleconsulta se
    // dibujaba con 1/50 del alto de la fila — 1 px, invisible. La capacidad de
    // la sala virtual no es aforo (lo dice `recursos.ts`): son llamadas que
    // pueden convivir.
    expect(VIDEO.capacidad).toBe(50);
    const una = posicionarTurnos([turno(600, 660)], VIDEO);
    expect(bandasDeFila(VIDEO, una)).toBe(1);

    const tres = posicionarTurnos([turno(600, 660), turno(600, 660), turno(630, 690)], VIDEO);
    expect(bandasDeFila(VIDEO, tres)).toBe(3);
  });

  it('sin turnos, toda fila tiene al menos una banda', () => {
    for (const s of [MULTIPLAZA, BIPLAZA, VIDEO]) {
      expect(bandasDeFila(s, [])).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('posicionarTurnos — apilar sin taparse', () => {
  it('en el Multiplaza, la banda es proporcional a la gente que trae', () => {
    const [dos, uno] = posicionarTurnos([turno(600, 660, 2), turno(600, 660, 1)], MULTIPLAZA);
    expect(dos?.peso).toBe(2);
    expect(dos?.asiento).toBe(0);
    // El de 1 persona arranca donde termina el de 2: no se pisan.
    expect(uno?.peso).toBe(1);
    expect(uno?.asiento).toBe(2);
  });

  it('los que NO se solapan en el tiempo reusan la banda de arriba', () => {
    const [manana, tarde] = posicionarTurnos([turno(600, 660), turno(660, 720)], MULTIPLAZA);
    expect(manana?.asiento).toBe(0);
    expect(tarde?.asiento).toBe(0);
  });

  it('con sobrecupo, el último se superpone al final en vez de desaparecer', () => {
    // Datos viejos pueden tener 7 personas en una sala de 6. Un turno mal
    // ubicado se ve y se arregla; uno que no se dibuja, no.
    const turnos = Array.from({ length: 7 }, () => turno(600, 660, 1));
    const ubicados = posicionarTurnos(turnos, MULTIPLAZA);
    expect(ubicados).toHaveLength(7);
    expect(ubicados.every((t) => t.asiento + t.peso <= 6)).toBe(true);
  });

  it('en una sala entera, dos turnos a la misma hora NO se apilan', () => {
    // No hay dos bandas que mostrar: el recurso es uno solo.
    const ubicados = posicionarTurnos([turno(600, 660, 2), turno(600, 660, 1)], BIPLAZA);
    expect(ubicados.every((t) => t.peso === 1 && t.asiento === 0)).toBe(true);
  });

  it('una teleconsulta pesa UNA banda, no sus ocupantes', () => {
    expect(pesoTurno(turno(600, 660, 3), VIDEO)).toBe(1);
  });
});

describe('pesoDeFila — de dónde sale el alto', () => {
  it('una fila simple pide lo de siempre', () => {
    expect(pesoDeFila(1)).toBe(1);
  });

  it('el Multiplaza pide el triple, que es el tope', () => {
    // Con todas las filas iguales, sus 6 bandas quedaban de ~8 px: imposibles
    // de clickear (reporte de Andrés, 2026-09-22). Al triple son ~25 px.
    expect(pesoDeFila(6)).toBe(PESO_FILA_MAX);
    expect(pesoDeFila(6)).toBe(3);
  });

  it('crece de a poco y NUNCA se come la pantalla', () => {
    expect(pesoDeFila(2)).toBeCloseTo(1.4);
    expect(pesoDeFila(3)).toBeCloseTo(1.8);
    // El tope existe para que una fila con muchas bandas no empuje al resto
    // fuera del viewport: la grilla entra sin scroll, ése es su contrato.
    expect(pesoDeFila(50)).toBe(PESO_FILA_MAX);
  });
});

describe('ocupacionEn — si la franja admite otra reserva', () => {
  it('suma las bandas ocupadas en ese minuto, no los turnos', () => {
    const ubicados = posicionarTurnos([turno(600, 660, 2), turno(600, 660, 1)], MULTIPLAZA);
    expect(ocupacionEn(ubicados, 600)).toBe(3); // 2 personas + 1
    expect(ocupacionEn(ubicados, 660)).toBe(0); // el fin no cuenta: ahí ya se liberó
  });
});

describe('los nombres de las salas entran en la columna', () => {
  it('las tres cámaras dicen HBOT, no "Cámara Hiperbárica"', () => {
    // La columna mide 170 px y corta a los dos renglones. El nombre largo
    // gastaba los dos en la parte que se REPITE y dejaba al final lo que
    // distingue una sala de otra.
    for (const codigo of ['R_HBOT_MONO', 'R_HBOT_BIPLAZA', 'R_HBOT_MULTIPLAZA']) {
      const nombre = RECURSOS_POR_CODIGO.get(codigo)?.nombre ?? '';
      expect(nombre.startsWith('HBOT '), codigo).toBe(true);
      expect(nombre.length, `${codigo}: "${nombre}"`).toBeLessThanOrEqual(18);
    }
  });
});
