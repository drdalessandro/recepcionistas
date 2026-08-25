import { describe, it, expect } from 'vitest';
import {
  corridasPorDia,
  decidirCron,
  decidirDesprogramar,
  describirCron,
  estaBloqueado,
  hayQueEscribir,
  tieneCodigo,
  validarCron,
  type BotProgramable,
} from '../src/lib/cron.js';
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

  it('dos barras en un campo no pasan', () => {
    // `*/2/3` parseaba como paso 2 descartando el 3 en silencio — lo encontró
    // la revisión adversarial. Es exactamente el fallo mudo que se quiere atajar.
    expect(validarCron('*/2/3 * * * *').ok).toBe(false);
    expect(validarCron('*/2/3 * * * *').error).toContain('barra');
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

  it('un paso que no divide al rango no se traduce como "cada N"', () => {
    // Un paso de 45 en los minutos dispara a :00 y :45, con un salto de 15 al
    // dar la vuelta: "cada 45 minutos" sería mentira. Cruda antes que mentirosa.
    expect(describirCron('*/45 * * * *')).toBe('*/45 * * * *');
    expect(describirCron('0 */7 * * *')).toBe('0 */7 * * *');
    // Cuando sí divide, se traduce.
    expect(describirCron('0 */8 * * *')).toBe('cada 8 horas, al minuto 0');
  });
});

describe('cuántas veces por día dispara', () => {
  it('cuenta las formas simples', () => {
    expect(corridasPorDia('*/10 * * * *')).toBe(144);
    expect(corridasPorDia('*/30 * * * *')).toBe(48);
    expect(corridasPorDia('0 * * * *')).toBe(24);
    expect(corridasPorDia('0 9 * * *')).toBe(1);
  });

  it('cuenta expandiendo, no dividiendo: un paso de 9 son 168, no 144', () => {
    // Math.floor(60/9)=6, pero los minutos 0,9,…,54 son SIETE. La aritmética
    // subestimaba justo lo que el aviso de frecuencia existe para atajar.
    expect(corridasPorDia('*/9 * * * *')).toBe(7 * 24);
  });

  it('las listas y los rangos también cuentan', () => {
    // Antes una coma bastaba para dejar el aviso de frecuencia ciego.
    expect(corridasPorDia('0,30 * * * *')).toBe(48);
    expect(corridasPorDia('0 9-18 * * *')).toBe(10);
    expect(corridasPorDia('0 9,15,21 * * *')).toBe(3);
    expect(corridasPorDia('0,15,30,45 9-17 * * *')).toBe(36);
  });

  it('cuando no sabe, no opina', () => {
    expect(corridasPorDia('0 9 1-5 * *')).toBeUndefined();
    expect(corridasPorDia('0 9 * * 1-5')).toBeUndefined();
    // Un paso sobre un valor suelto significa cosas distintas según la
    // implementación; y el paso 0 directamente no es un cron.
    expect(corridasPorDia('5/2 * * * *')).toBeUndefined();
    expect(corridasPorDia('*/0 * * * *')).toBeUndefined();
  });
});

/**
 * La decisión de qué hacer con cada bot — la lógica que determina si se le
 * escribe algo al bot que cobra plata. Vive en src/lib justamente para que
 * estos casos existan; en la primera versión estaba embebida en el script y
 * ninguna de las guardias que el runbook prometía tenía un test.
 */
describe('decidirCron: qué se hace con un bot que corre solo', () => {
  const CRON = '*/10 * * * *';
  const conCodigo: BotProgramable = { id: 'b1', executableCode: { url: 'https://storage/bot.js' } };

  it('coincide y sin restos: no se toca', () => {
    expect(decidirCron(CRON, [{ ...conCodigo, cronString: CRON }]).accion).toBe('ya-esta');
  });

  it('sin horario en el servidor: se pone', () => {
    expect(decidirCron(CRON, [conCodigo]).accion).toBe('poner');
  });

  it('con otro horario: se cambia', () => {
    const c = decidirCron(CRON, [{ ...conCodigo, cronString: '0 9 * * *' }]);
    expect(c.accion).toBe('cambiar');
    expect(c.actual).toBe('0 9 * * *');
  });

  it('coincide PERO arrastra cronTiming: se escribe igual, para borrarlo', () => {
    // El caso real de producción, 2026-08-25: tres bots con el horario bien y el
    // cronTiming de la configuración vieja por UI conviviendo en el recurso.
    // "Coincide" con estado ambiguo no es coincidir.
    const c = decidirCron(CRON, [{ ...conCodigo, cronString: CRON, cronTiming: { repeat: { period: 1 } } }]);
    expect(c.accion).toBe('cambiar');
    expect(c.conTiming).toBe(true);
    expect(c.detalle).toContain('cronTiming');
  });

  it('un cron inválido del repo NUNCA llega al servidor', () => {
    const c = decidirCron('*/10 * * *', [{ ...conCodigo, cronString: 'x' }]);
    expect(c.accion).toBe('cron-invalido');
    expect(hayQueEscribir(c.accion)).toBe(false);
    expect(estaBloqueado(c.accion)).toBe(true);
  });

  it('un bot sin código deployado no se programa: tiquearía al vacío', () => {
    expect(decidirCron(CRON, [{ id: 'b1' }]).accion).toBe('sin-codigo');
    // Un Attachment que quedó vacío tras un $deploy a medias es truthy pero no
    // es código — la misma vara que usa bots:check.
    expect(decidirCron(CRON, [{ id: 'b1', executableCode: {} }]).accion).toBe('sin-codigo');
    expect(tieneCodigo({ executableCode: { data: 'ZXhwb3J0cw==' } })).toBe(true);
  });

  it('duplicados: no se elige por el operador', () => {
    const c = decidirCron(CRON, [conCodigo, { ...conCodigo, id: 'b2' }]);
    expect(c.accion).toBe('duplicado');
    expect(c.detalle).toContain('b1');
    expect(c.detalle).toContain('b2');
  });

  it('el bot no existe: falta', () => {
    expect(decidirCron(CRON, []).accion).toBe('falta');
  });
});

describe('decidirDesprogramar: sacar el cron del repo apaga el bot de verdad', () => {
  it('un bot del repo sin `cron` pero programado en el servidor se desprograma', () => {
    // Sin esto, "frenar el cobro automático" en un PR no frena nada: el PR se
    // mergea, el gate queda verde y el bot sigue cobrando.
    const c = decidirDesprogramar([{ id: 'b1', cronString: '0 9 * * *' }]);
    expect(c?.accion).toBe('desprogramar');
    expect(hayQueEscribir('desprogramar')).toBe(true);
  });

  it('también si lo que quedó es solo un cronTiming', () => {
    expect(decidirDesprogramar([{ id: 'b1', cronTiming: { repeat: {} } }])?.accion).toBe('desprogramar');
  });

  it('sin nada programado no hay caso', () => {
    expect(decidirDesprogramar([{ id: 'b1' }])).toBeUndefined();
  });

  it('con duplicados no se opina', () => {
    expect(decidirDesprogramar([{ id: 'b1', cronString: 'x' }, { id: 'b2' }])).toBeUndefined();
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

  it('todo bot que se presenta como cron tiene horario, y viceversa', () => {
    // En las DOS direcciones — la primera versión solo miraba una y era
    // tautológica: filtrar por `cron` y pedir que digan "cron" se auto-cumple.
    // La dirección que atrapa el error real es esta: si a `bw-vencer-tentativas`
    // le borran el campo `cron` en un PR, su descripción sigue diciendo "Cron"
    // y este test lo canta.
    for (const b of programables) {
      expect(b.description.toLowerCase(), `${b.name} tiene cron pero no se presenta como cron`).toContain('cron');
    }
    for (const b of BOTS.filter((x) => /^cron\b/i.test(x.description))) {
      expect(b.cron, `${b.name} se presenta como "Cron:" pero no tiene horario declarado`).toBeTruthy();
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
    // `undefined` también pasa: significa un cron restringido por fecha (p. ej.
    // `0 9 1-5 * *`), que es MÁS acotado que el diario — prohibirlo obligaría a
    // quedarse con la forma menos precisa.
    const cobro = BOTS.find((b) => b.name === 'bw-cobro-membresias');
    const porDia = corridasPorDia(cobro?.cron as string);
    if (porDia !== undefined) {
      expect(porDia).toBeLessThanOrEqual(1);
    } else {
      expect(validarCron(cobro?.cron).ok).toBe(true);
    }
  });
});
