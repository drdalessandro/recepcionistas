import { describe, it, expect } from 'vitest';
import { corridasPorDia, describirCron, validarCron } from '../src/lib/cron.js';
import { BOTS } from '../src/seed/bots-def.js';

/**
 * El horario de los bots.
 *
 * Lo que se defiende acá es una sola cosa: **un cron mal escrito no da error**.
 * Medplum guarda el string y el bot no corre nunca. Es exactamente lo que pasó
 * con `cronTimer` —un campo que no existe— recomendado por los docs durante
 * meses sin que nadie se enterara. Un horario que falla en silencio es peor que
 * uno que falla fuerte.
 */

describe('un cron mal escrito se caza antes de mandarlo', () => {
  it('cinco campos, ni cuatro ni seis', () => {
    // El error más fácil de cometer y el más difícil de ver.
    expect(validarCron('*/10 * * *').ok).toBe(false);
    expect(validarCron('*/10 * * *').error).toContain('4 campos');
    expect(validarCron('0 9 * * * *').ok).toBe(false);
    expect(validarCron('*/10 * * * *').ok).toBe(true);
  });

  it('vacío o indefinido no es un horario', () => {
    expect(validarCron('').ok).toBe(false);
    expect(validarCron(undefined).ok).toBe(false);
    expect(validarCron('   ').ok).toBe(false);
  });

  it('los valores tienen que estar en rango, y el error dice cuál', () => {
    expect(validarCron('60 * * * *').error).toContain('minuto');
    expect(validarCron('0 24 * * *').error).toContain('hora');
    expect(validarCron('0 9 0 * *').error).toContain('día del mes');
    expect(validarCron('0 9 * 13 *').error).toContain('mes');
    // 0 y 7 son los dos domingo: los dos válidos.
    expect(validarCron('0 9 * * 0').ok).toBe(true);
    expect(validarCron('0 9 * * 7').ok).toBe(true);
    expect(validarCron('0 9 * * 8').ok).toBe(false);
  });

  it('acepta listas, rangos y pasos', () => {
    expect(validarCron('0,30 * * * *').ok).toBe(true);
    expect(validarCron('0 9-18 * * *').ok).toBe(true);
    expect(validarCron('0 9-18/2 * * 1-5').ok).toBe(true);
  });

  it('un rango al revés no se pasa por alto', () => {
    expect(validarCron('0 18-9 * * *').ok).toBe(false);
    expect(validarCron('0 18-9 * * *').error).toContain('al revés');
  });

  it('lo que no es número, rango ni asterisco se rechaza', () => {
    // `@daily` y `L`/`W` existen en otros dialectos; Medplum no los documenta,
    // así que aceptarlos sería prometer algo que no sabemos si anda.
    expect(validarCron('@daily').ok).toBe(false);
    expect(validarCron('0 9 L * *').ok).toBe(false);
    expect(validarCron('0 9 * * *,').ok).toBe(false);
  });
});

describe('el cron en castellano, para leer lo que se va a guardar', () => {
  it('traduce las formas que usamos', () => {
    expect(describirCron('*/10 * * * *')).toBe('cada 10 minutos');
    expect(describirCron('*/30 * * * *')).toBe('cada 30 minutos');
    expect(describirCron('0 * * * *')).toBe('cada hora, al minuto 0');
    expect(describirCron('0 9 * * *')).toBe('todos los días a las 09:00');
    expect(describirCron('30 14 * * *')).toBe('todos los días a las 14:30');
  });

  it('ante algo que no entiende devuelve la expresión, no una traducción inventada', () => {
    // Adivinar acá sería peor que no traducir: el operador confiaría en la
    // descripción en vez de en el cron.
    expect(describirCron('0 9 1-5 * *')).toBe('0 9 1-5 * *');
    expect(describirCron('0 9 * * 1-5')).toBe('0 9 * * 1-5');
  });
});

describe('cuántas veces por día dispara', () => {
  it('cuenta las formas simples', () => {
    expect(corridasPorDia('*/10 * * * *')).toBe(144);
    expect(corridasPorDia('*/30 * * * *')).toBe(48);
    expect(corridasPorDia('0 * * * *')).toBe(24);
    expect(corridasPorDia('0 9 * * *')).toBe(1);
  });

  it('cuando no sabe, no opina', () => {
    expect(corridasPorDia('0 9 1-5 * *')).toBeUndefined();
    expect(corridasPorDia('0 9 * * 1-5')).toBeUndefined();
  });
});

/**
 * Los horarios que el repo va a escribir en el servidor. Si alguien toca uno en
 * `bots-def.ts`, esto lo revisa antes de que llegue a producción.
 */
describe('los horarios declarados en bots-def', () => {
  const programables = BOTS.filter((b) => b.cron);

  it('hay bots con horario, y todos son válidos', () => {
    expect(programables.length).toBeGreaterThan(0);
    for (const b of programables) {
      const r = validarCron(b.cron);
      expect(r.ok, `${b.name} tiene un cron inválido: ${r.error}`).toBe(true);
    }
  });

  it('los cuatro bots de cron son los que dicen serlo', () => {
    // Un bot con `cron` cuya descripción no lo menciona es señal de que alguien
    // programó algo que no estaba pensado para correr solo.
    for (const b of programables) {
      expect(b.description.toLowerCase(), `${b.name}`).toContain('cron');
    }
  });

  it('ninguno corre más seguido que cada 10 minutos', () => {
    // No es una regla del negocio: es un tope de sensatez. El bus de Medplum y
    // las integraciones (Twilio, MercadoPago) se pagan por uso.
    for (const b of programables) {
      const porDia = corridasPorDia(b.cron as string);
      if (porDia !== undefined) {
        expect(porDia, `${b.name} corre ${porDia} veces por día`).toBeLessThanOrEqual(144);
      }
    }
  });

  it('el que cobra plata NO corre seguido', () => {
    // bw-cobro-membresias es idempotente por ciclo, pero programarlo cada pocos
    // minutos sería pedirle problemas a la única cosa que mueve dinero sola.
    const cobro = BOTS.find((b) => b.name === 'bw-cobro-membresias');
    expect(corridasPorDia(cobro?.cron as string)).toBe(1);
  });
});
