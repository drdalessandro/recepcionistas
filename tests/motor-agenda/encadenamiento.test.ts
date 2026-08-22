/**
 * Derivación de tiempos y expansión de combos.
 *
 * Lo que se especifica acá es el principio de diseño del motor: **ningún offset
 * se declara, todos se derivan**. Un combo dice qué servicios y en qué orden; los
 * minutos salen de los atributos del recurso (setup, terapia, turnaround, slot,
 * grilla) encadenados por una sola regla:
 *
 *     inicio del tramo siguiente = alinearAGrilla(salida del cliente anterior,
 *                                                 grilla del recurso siguiente)
 *
 * Si alguno de estos números hubiera que escribirlo a mano en el código, el
 * modelo estaría mal.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENDA_VACIA,
  alinearAGrilla,
  bloqueoRecursoMin,
  conOcupaciones,
  derivarCadena,
  duracionCadenaMin,
  expandir,
  salidaClienteMin,
  salidaFinalCadenaMin,
  tomasDePool,
  type MotorCompilado,
  type TiemposRecurso,
  type TipoRecurso,
  type TramoAEncadenar,
} from '../../src/motor-agenda/index.js';
import { agendaCon, codigosDeRechazo, lunes, motorDePrueba, ocupar } from './ayudas.js';

/** Tiempos de un recurso real, o el test falla en vez de inventar valores. */
function tiemposDe(motor: MotorCompilado, tipo: TipoRecurso): TiemposRecurso {
  const tiempos = motor.recursoPorTipo.get(tipo)?.tiempos;
  if (!tiempos) throw new Error(`El recurso "${tipo}" no declara tiempos.`);
  return tiempos;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('Los tiempos son atributos del recurso: salida del cliente y bloqueo', () => {
  const motor = motorDePrueba();

  /**
   * Tabla de la operación. `setupMasTerapia` está de más para el motor, pero es
   * justamente lo que hace visibles los dos recursos que no salen ahí.
   */
  const ESPERADOS: readonly {
    readonly tipo: TipoRecurso;
    readonly setupMasTerapia: number;
    readonly salida: number;
    readonly bloqueo: number;
    readonly grilla: number;
    readonly slot: number;
  }[] = [
    // Las tres cámaras se liberan a los 60, no a los 58: el ancla explícita corre
    // la salida del cliente al minuto 55 y la higienización arranca recién ahí
    // (55 + 5 de turnaround). Antes quedaban publicadas como libres mientras
    // todavía se estaban limpiando.
    { tipo: 'hbot-monoplaza', setupMasTerapia: 53, salida: 55, bloqueo: 60, grilla: 60, slot: 60 },
    { tipo: 'hbot-biplaza', setupMasTerapia: 53, salida: 55, bloqueo: 60, grilla: 60, slot: 60 },
    { tipo: 'hbot-multiplaza', setupMasTerapia: 53, salida: 55, bloqueo: 60, grilla: 60, slot: 60 },
    { tipo: 'ihht', setupMasTerapia: 25, salida: 25, bloqueo: 30, grilla: 30, slot: 30 },
    { tipo: 'recovery-pro', setupMasTerapia: 48, salida: 56, bloqueo: 60, grilla: 30, slot: 60 },
    { tipo: 'tumbona-red-light', setupMasTerapia: 23, salida: 23, bloqueo: 30, grilla: 30, slot: 30 },
    { tipo: 'compresion', setupMasTerapia: 27, salida: 27, bloqueo: 30, grilla: 30, slot: 30 },
    { tipo: 'crioterapia', setupMasTerapia: 27, salida: 27, bloqueo: 30, grilla: 30, slot: 30 },
  ];

  for (const esperado of ESPERADOS) {
    it(`${esperado.tipo}: el cliente sale a los ${esperado.salida} y el recurso se libera a los ${esperado.bloqueo}`, () => {
      const tiempos = tiemposDe(motor, esperado.tipo);
      expect(tiempos.setupMin + tiempos.terapiaMin).toBe(esperado.setupMasTerapia);
      expect(salidaClienteMin(tiempos)).toBe(esperado.salida);
      expect(bloqueoRecursoMin(tiempos)).toBe(esperado.bloqueo);
      expect(tiempos.grillaInicioMin).toBe(esperado.grilla);
      expect(tiempos.slotMin).toBe(esperado.slot);
    });
  }

  it('todo recurso agendable cumple el invariante setup + terapia + turnaround <= slot', () => {
    // Un recurso que no cierra no produce un atraso puntual sino acumulativo.
    for (const recurso of motor.config.recursos) {
      if (!recurso.tiempos) continue;
      const t = recurso.tiempos;
      expect(t.setupMin + t.terapiaMin + t.turnaroundMin).toBeLessThanOrEqual(t.slotMin);
      expect(bloqueoRecursoMin(t)).toBeLessThanOrEqual(t.slotMin);
    }
  });

  it('HBOT sale a los 55 por el ancla explícita, aunque setup + terapia den 53', () => {
    // El protocolo tiene tres tramos que el operador reparte según el cliente. El
    // motor no los modela: modela el único invariante, que el cliente sale del
    // recinto en el minuto 55.
    const tiempos = tiemposDe(motor, 'hbot-monoplaza');
    expect(tiempos.anclaSalidaMin).toBe(55);
    expect(salidaClienteMin(tiempos)).toBe(55);
    expect(salidaClienteMin(tiempos)).not.toBe(tiempos.setupMin + tiempos.terapiaMin);
  });

  it('Recovery Pro sale a los 56 derivado de sus etapas, aunque setup + terapia den 48', () => {
    // La terapia termina a los 48 (fin de la luz roja) pero el cliente todavía se
    // ducha y se viste hasta el 56. No hay ancla declarada: sale de la secuencia.
    const tiempos = tiemposDe(motor, 'recovery-pro');
    expect(tiempos.anclaSalidaMin).toBeUndefined();
    expect(tiempos.setupMin + tiempos.terapiaMin).toBe(48);
    expect(salidaClienteMin(tiempos)).toBe(56);
  });

  it('la etapa final sin cliente presente no corre la salida: "Salida" 56-60 no cuenta', () => {
    const tiempos = tiemposDe(motor, 'recovery-pro');
    const ultima = tiempos.etapas?.[tiempos.etapas.length - 1];
    expect(ultima?.nombre).toBe('Salida');
    expect(ultima?.hastaMin).toBe(60);
    expect(ultima?.clientePresente).toBe(false);
    // El gabinete sigue tomado hasta el 60, pero el cliente ya se fue a los 56.
    expect(salidaClienteMin(tiempos)).toBe(56);
    expect(bloqueoRecursoMin(tiempos)).toBe(60);
  });

  it('el ancla explícita le gana a la secuencia interna cuando las dos están declaradas', () => {
    const conAncla: TiemposRecurso = {
      ...tiemposDe(motor, 'recovery-pro'),
      anclaSalidaMin: 40,
    };
    expect(salidaClienteMin(conAncla)).toBe(40);
  });

  it('si la secuencia interna se extiende más allá del turnaround, manda la secuencia', () => {
    // El recurso no puede liberarse antes de terminar su propia coreografía.
    const recorte: TiemposRecurso = {
      ...tiemposDe(motor, 'recovery-pro'),
      turnaroundMin: 5, // 2 + 46 + 5 = 53, pero las etapas llegan al 60
    };
    expect(recorte.setupMin + recorte.terapiaMin + recorte.turnaroundMin).toBe(53);
    expect(bloqueoRecursoMin(recorte)).toBe(60);
  });

  it('Recovery Pro es el único recurso que toma otro pool: una tumbona del 28 al 48', () => {
    for (const recurso of motor.config.recursos) {
      if (!recurso.tiempos) continue;
      const tomas = tomasDePool(recurso.tiempos);
      if (recurso.tipo !== 'recovery-pro') {
        expect(tomas).toEqual([]);
        continue;
      }
      expect(tomas).toEqual([
        { pool: 'tumbona-red-light', etapa: 'Red Light', desdeMin: 28, hastaMin: 48 },
      ]);
    }
  });

  it('los recursos sin tiempos medidos no se agendan: devuelven RECURSO_SIN_TIEMPOS', () => {
    // No hay default silencioso: inventarles un slot sería peor que no tenerlo.
    const sinTiempos = motor.config.recursos.filter((r) => !r.tiempos).map((r) => r.tipo);
    expect(sinTiempos).toEqual(['camilla-masajes', 'consultorio', 'sala-tb', 'puesto-iv']);

    const plan = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'MASAJE' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(codigosDeRechazo(plan)).toEqual(['RECURSO_SIN_TIEMPOS']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('alinearAGrilla: la pieza que hace emerger los offsets', () => {
  it('un valor ya alineado se queda donde está, no salta un slot', () => {
    expect(alinearAGrilla(60, 30)).toBe(60);
    expect(alinearAGrilla(30, 30)).toBe(30);
  });

  it('el minuto 0 se queda en 0: el primer tramo arranca cuando arranca', () => {
    expect(alinearAGrilla(0, 30)).toBe(0);
    expect(alinearAGrilla(0, 60)).toBe(0);
  });

  it('un valor entre dos inicios sube al siguiente', () => {
    expect(alinearAGrilla(1, 30)).toBe(30);
    expect(alinearAGrilla(23, 30)).toBe(30);
    expect(alinearAGrilla(25, 30)).toBe(30);
    expect(alinearAGrilla(55, 60)).toBe(60);
  });

  it('con una grilla que no divide la hora, alinea igual al múltiplo siguiente', () => {
    expect(alinearAGrilla(55, 45)).toBe(90);
    expect(alinearAGrilla(45, 45)).toBe(45);
    expect(alinearAGrilla(7, 7)).toBe(7);
    expect(alinearAGrilla(8, 7)).toBe(14);
  });

  it('una grilla no positiva es un error de programación, no un rechazo de negocio', () => {
    expect(() => alinearAGrilla(10, 0)).toThrow(RangeError);
    expect(() => alinearAGrilla(10, -30)).toThrow(RangeError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Offsets derivados de los cinco combos, tramo por tramo', () => {
  const motor = motorDePrueba();

  /** Expande el combo a las 10:00 de un lunes y devuelve el plan o falla. */
  function planDe(codigo: string, ocupantes = 1) {
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo },
      inicio: lunes(10),
      ocupantes,
      agenda: AGENDA_VACIA,
    });
    if (!plan.ok) {
      throw new Error(`El combo ${codigo} no se pudo expandir: ${codigosDeRechazo(plan).join(', ')}`);
    }
    return plan.valor;
  }

  /** Duración publicada en el Manual v9 para ese combo. */
  function duracionPublicada(codigo: string): number | undefined {
    return motor.comboPorCodigo.get(codigo)?.duracionPublicadaMin;
  }

  it('BIO ENERGY: IHHT 10:00-10:30 (sale 10:25) → tumbona 10:30-11:00, total 60', () => {
    const plan = planDe('BIO_ENERGY');
    const [ihht, tumbona] = plan.tramos;

    expect(ihht?.servicio).toBe('IHHT');
    expect(ihht?.offsetMin).toBe(0);
    expect(ihht?.inicio).toEqual(lunes(10, 0));
    expect(ihht?.salidaCliente).toEqual(lunes(10, 25));
    expect(ihht?.finRecurso).toEqual(lunes(10, 30));

    // El cliente sale del IHHT a los 25, pero la tumbona recién abre a los 30.
    // Esos 5 minutos de espera son la razón de que el combo dure 60 y no 55.
    expect(tumbona?.servicio).toBe('RED_LIGHT');
    expect(tumbona?.offsetMin).toBe(30);
    expect(tumbona?.inicio).toEqual(lunes(10, 30));
    expect(tumbona?.salidaCliente).toEqual(lunes(10, 53));
    expect(tumbona?.finRecurso).toEqual(lunes(11, 0));

    expect(plan.fin).toEqual(lunes(11, 0));
    expect(plan.salidaCliente).toEqual(lunes(10, 53));
    expect(duracionPublicada('BIO_ENERGY')).toBe(60);
  });

  it('BIO OXYGEN: HBOT 10:00-11:00 (sale 10:55) → IHHT 11:00-11:30, total 90', () => {
    const plan = planDe('BIO_OXYGEN');
    const [camara, ihht] = plan.tramos;

    expect(camara?.servicio).toBe('HBOT_MONOPLAZA');
    expect(camara?.offsetMin).toBe(0);
    expect(camara?.salidaCliente).toEqual(lunes(10, 55));
    // La limpieza de la cámara arranca cuando el cliente sale (10:55), no antes:
    // se libera a las 11:00, no a las 10:58.
    expect(camara?.finRecurso).toEqual(lunes(11, 0));

    // Sale a los 55 y el IHHT abre cada 30: el siguiente inicio es el 60.
    expect(ihht?.servicio).toBe('IHHT');
    expect(ihht?.offsetMin).toBe(60);
    expect(ihht?.inicio).toEqual(lunes(11, 0));
    expect(ihht?.salidaCliente).toEqual(lunes(11, 25));
    expect(ihht?.finRecurso).toEqual(lunes(11, 30));

    expect(plan.fin).toEqual(lunes(11, 30));
    expect(duracionPublicada('BIO_OXYGEN')).toBe(90);
  });

  it('BIO RECOVERY: HBOT 10:00-11:00 → Recovery Pro 11:00-12:00, total 120', () => {
    const plan = planDe('BIO_RECOVERY');
    const [camara, recovery] = plan.tramos;

    expect(camara?.offsetMin).toBe(0);
    expect(camara?.salidaCliente).toEqual(lunes(10, 55));

    expect(recovery?.servicio).toBe('RECOVERY_PRO');
    expect(recovery?.offsetMin).toBe(60);
    expect(recovery?.inicio).toEqual(lunes(11, 0));
    expect(recovery?.salidaCliente).toEqual(lunes(11, 56));
    expect(recovery?.finRecurso).toEqual(lunes(12, 0));

    // La sub-reserva de tumbona se corre con el tramo: 28-48 sobre el offset 60.
    // La tumbona prestada queda bloqueada 7 minutos más (su turnaround): estar
    // prestada a un gabinete no la exime de la limpieza, así que vuelve al pool
    // a las 11:55 y no a las 11:48.
    const luz = recovery?.subReservas[0];
    expect(recovery?.subReservas).toHaveLength(1);
    expect(luz?.tipoRecurso).toBe('tumbona-red-light');
    expect(luz?.inicio).toEqual(lunes(11, 28));
    expect(luz?.fin).toEqual(lunes(11, 55));

    expect(plan.fin).toEqual(lunes(12, 0));
    expect(plan.salidaCliente).toEqual(lunes(11, 56));
    expect(duracionPublicada('BIO_RECOVERY')).toBe(120);
  });

  it('BIO LONGEVITY: HBOT → IHHT 11:00-11:30 → Recovery Pro 11:30-12:30, total 150', () => {
    const plan = planDe('BIO_LONGEVITY');
    const [camara, ihht, recovery] = plan.tramos;

    expect(camara?.offsetMin).toBe(0);
    expect(camara?.salidaCliente).toEqual(lunes(10, 55));

    expect(ihht?.offsetMin).toBe(60);
    expect(ihht?.salidaCliente).toEqual(lunes(11, 25));
    expect(ihht?.finRecurso).toEqual(lunes(11, 30));

    // Sale del IHHT a los 85 y el gabinete abre cada 30: entra en el 90.
    expect(recovery?.offsetMin).toBe(90);
    expect(recovery?.inicio).toEqual(lunes(11, 30));
    expect(recovery?.salidaCliente).toEqual(lunes(12, 26));
    expect(recovery?.finRecurso).toEqual(lunes(12, 30));

    const luz = recovery?.subReservas[0];
    expect(luz?.inicio).toEqual(lunes(11, 58));
    // 20 minutos de luz roja + los 7 de turnaround de la tumbona prestada.
    expect(luz?.fin).toEqual(lunes(12, 25));

    expect(plan.fin).toEqual(lunes(12, 30));
    expect(plan.salidaCliente).toEqual(lunes(12, 26));
    expect(duracionPublicada('BIO_LONGEVITY')).toBe(150);
  });

  it('BIO COMPRESS: compresión 10:00-10:30 (sale 10:27) → tumbona 10:30-11:00, total 60', () => {
    const plan = planDe('BIO_COMPRESS');
    const [compresion, tumbona] = plan.tramos;

    expect(compresion?.servicio).toBe('COMPRESION');
    expect(compresion?.offsetMin).toBe(0);
    expect(compresion?.salidaCliente).toEqual(lunes(10, 27));
    expect(compresion?.finRecurso).toEqual(lunes(10, 30));

    expect(tumbona?.servicio).toBe('RED_LIGHT');
    expect(tumbona?.offsetMin).toBe(30);
    expect(tumbona?.inicio).toEqual(lunes(10, 30));
    expect(tumbona?.finRecurso).toEqual(lunes(11, 0));

    expect(plan.fin).toEqual(lunes(11, 0));
    expect(duracionPublicada('BIO_COMPRESS')).toBe(60);
  });

  it('la duración derivada de cada combo coincide con la publicada en el Manual', () => {
    const esperadas: Readonly<Record<string, number>> = {
      BIO_ENERGY: 60,
      BIO_OXYGEN: 90,
      BIO_RECOVERY: 120,
      BIO_LONGEVITY: 150,
      BIO_COMPRESS: 60,
    };

    for (const [codigo, minutos] of Object.entries(esperadas)) {
      const plan = planDe(codigo);
      const derivada = (plan.fin.getTime() - plan.inicio.getTime()) / 60_000;
      expect(derivada, `duración derivada de ${codigo}`).toBe(minutos);
      expect(duracionPublicada(codigo), `duración publicada de ${codigo}`).toBe(minutos);
    }

    // Y el validador de configuración no encontró ninguna discrepancia entre el
    // modelo y el catálogo comercial, para ninguna variante de cámara.
    expect(motor.informe.discrepanciasDeDuracion).toEqual([]);
  });

  it('la duración del combo se mide hasta que se libera el recurso, no hasta que sale el cliente', () => {
    const plan = planDe('BIO_ENERGY');
    // El cliente se va 10:53 y la tumbona queda tomada hasta las 11:00 por el
    // turnaround. La agenda bloquea 60 minutos; el cliente estuvo 53.
    expect(plan.salidaCliente).toEqual(lunes(10, 53));
    expect(plan.fin).toEqual(lunes(11, 0));
  });

  it('las tres cámaras dan los mismos offsets: la duración no depende de cuál se use', () => {
    for (const camara of ['HBOT_MONOPLAZA', 'HBOT_BIPLAZA', 'HBOT_MULTIPLAZA']) {
      const plan = expandir({
        motor,
        producto: { tipo: 'combo', codigo: 'BIO_LONGEVITY' },
        inicio: lunes(10),
        ocupantes: 1,
        agenda: AGENDA_VACIA,
        seleccion: { 1: camara },
      });
      expect(plan.ok, camara).toBe(true);
      if (!plan.ok) continue;
      expect(plan.valor.tramos.map((t) => t.offsetMin), camara).toEqual([0, 60, 90]);
      expect(plan.valor.fin, camara).toEqual(lunes(12, 30));
    }
  });

  it('una cadena vacía dura cero: derivarCadena no inventa tramos', () => {
    expect(derivarCadena([])).toEqual([]);
    expect(duracionCadenaMin([])).toBe(0);
    expect(salidaFinalCadenaMin([])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('BIO LONGEVITY dura 150 porque el gabinete Recovery Pro abre cada 30 minutos', () => {
  // Este bloque documenta la sensibilidad del modelo. Los 150 minutos no son un
  // número del Manual copiado al código: son consecuencia de la grilla del
  // gabinete. Si mañana Recovery Pro abriera cada hora, el producto publicado
  // pasaría a durar 180 y habría que decidir qué se cambia — el catálogo o la
  // operación —, no ajustar una constante.

  const motor = motorDePrueba();

  /** La cadena de BIO LONGEVITY con la grilla de Recovery Pro que se le pase. */
  function cadenaLongevity(grillaRecoveryProMin: number): TramoAEncadenar[] {
    return [
      {
        orden: 1,
        servicio: 'HBOT_MONOPLAZA',
        tipoRecurso: 'hbot-monoplaza',
        tiempos: tiemposDe(motor, 'hbot-monoplaza'),
      },
      { orden: 2, servicio: 'IHHT', tipoRecurso: 'ihht', tiempos: tiemposDe(motor, 'ihht') },
      {
        orden: 3,
        servicio: 'RECOVERY_PRO',
        tipoRecurso: 'recovery-pro',
        tiempos: { ...tiemposDe(motor, 'recovery-pro'), grillaInicioMin: grillaRecoveryProMin },
      },
    ];
  }

  it('con la grilla real de 30, el cliente sale del IHHT a los 85 y entra al gabinete a los 90', () => {
    const cadena = derivarCadena(cadenaLongevity(30));
    expect(cadena.map((t) => t.offsetMin)).toEqual([0, 60, 90]);
    expect(cadena[1]?.salidaClienteMin).toBe(85);
    expect(duracionCadenaMin(cadena)).toBe(150);
    expect(salidaFinalCadenaMin(cadena)).toBe(146);
  });

  it('con una grilla alternativa de 60, la misma salida de los 85 espera hasta el 120 y el combo salta a 180', () => {
    const cadena = derivarCadena(cadenaLongevity(60));
    expect(cadena.map((t) => t.offsetMin)).toEqual([0, 60, 120]);
    // El cliente sigue saliendo del IHHT a los 85: lo que cambió es la espera.
    expect(cadena[1]?.salidaClienteMin).toBe(85);
    expect(duracionCadenaMin(cadena)).toBe(180);
    expect(salidaFinalCadenaMin(cadena)).toBe(176);
  });

  it('BIO RECOVERY, en cambio, es insensible: la salida de la cámara a los 55 alinea igual con 30 que con 60', () => {
    // El contraste importa: la sensibilidad no es de "la grilla" en abstracto,
    // es de esta cadena. Con dos tramos, el 55 sube al 60 en las dos grillas.
    const bioRecovery = (grilla: number): TramoAEncadenar[] => [
      {
        orden: 1,
        servicio: 'HBOT_MONOPLAZA',
        tipoRecurso: 'hbot-monoplaza',
        tiempos: tiemposDe(motor, 'hbot-monoplaza'),
      },
      {
        orden: 2,
        servicio: 'RECOVERY_PRO',
        tipoRecurso: 'recovery-pro',
        tiempos: { ...tiemposDe(motor, 'recovery-pro'), grillaInicioMin: grilla },
      },
    ];

    expect(duracionCadenaMin(derivarCadena(bioRecovery(30)))).toBe(120);
    expect(duracionCadenaMin(derivarCadena(bioRecovery(60)))).toBe(120);
  });

  it('las sub-reservas de tumbona también se corren con el offset derivado', () => {
    const conGrillaDe30 = derivarCadena(cadenaLongevity(30))[2];
    const conGrillaDe60 = derivarCadena(cadenaLongevity(60))[2];

    expect(conGrillaDe30?.tomasDePool).toEqual([
      { pool: 'tumbona-red-light', etapa: 'Red Light', desdeMin: 118, hastaMin: 138 },
    ]);
    expect(conGrillaDe60?.tomasDePool).toEqual([
      { pool: 'tumbona-red-light', etapa: 'Red Light', desdeMin: 148, hastaMin: 168 },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('El inicio pedido tiene que caer en la grilla del primer recurso', () => {
  const motor = motorDePrueba();

  it('HBOT a las 10:30 se rechaza: la cámara arranca cada 60 minutos', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'HBOT_MONOPLAZA' },
      inicio: lunes(10, 30),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });

    expect(plan.ok).toBe(false);
    expect(codigosDeRechazo(plan)).toEqual(['INICIO_FUERA_DE_GRILLA']);
    if (plan.ok) return;
    expect(plan.rechazos[0]?.mensaje).toMatch(/cada 60 minutos/);
    expect(plan.rechazos[0]?.detalle).toMatchObject({ grillaMin: 60, minutoDelDia: 630 });
  });

  it('la misma cámara a las 10:00 y a las 11:00 entra', () => {
    for (const hora of [10, 11]) {
      const plan = expandir({
        motor,
        producto: { tipo: 'suelta', codigo: 'HBOT_MONOPLAZA' },
        inicio: lunes(hora),
        ocupantes: 1,
        agenda: AGENDA_VACIA,
      });
      expect(plan.ok, `${hora}:00`).toBe(true);
    }
  });

  it('un recurso de grilla 30 sí admite las y media: el IHHT a las 10:30 entra', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'IHHT' },
      inicio: lunes(10, 30),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(plan.ok).toBe(true);
  });

  it('el combo se valida contra la grilla de su primer tramo, no contra la del centro', () => {
    // BIO ENERGY arranca en el IHHT (grilla 30): 10:30 vale, 10:15 no.
    const aYMedia = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_ENERGY' },
      inicio: lunes(10, 30),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(aYMedia.ok).toBe(true);

    const aYCuarto = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_ENERGY' },
      inicio: lunes(10, 15),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(codigosDeRechazo(aYCuarto)).toEqual(['INICIO_FUERA_DE_GRILLA']);
    if (aYCuarto.ok) return;
    expect(aYCuarto.rechazos[0]?.mensaje).toMatch(/Puesto IHHT/);
  });

  it('BIO OXYGEN a las 10:30 se rechaza nombrando la cámara, que es su primer tramo', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10, 30),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(codigosDeRechazo(plan)).toEqual(['INICIO_FUERA_DE_GRILLA']);
    if (plan.ok) return;
    expect(plan.rechazos[0]?.detalle).toMatchObject({ grillaMin: 60 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Producto y servicio desconocidos', () => {
  const motor = motorDePrueba();

  it('un combo que no está en el catálogo devuelve PRODUCTO_DESCONOCIDO', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_INMORTALIDAD' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(codigosDeRechazo(plan)).toEqual(['PRODUCTO_DESCONOCIDO']);
    if (plan.ok) return;
    expect(plan.rechazos[0]?.mensaje).toContain('BIO_INMORTALIDAD');
  });

  it('un servicio suelto que no está en el catálogo devuelve SERVICIO_DESCONOCIDO', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'CRIOSAUNA' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(codigosDeRechazo(plan)).toEqual(['SERVICIO_DESCONOCIDO']);
  });

  it('pedir un combo existente como suelta también es desconocido: no hay fallback', () => {
    // BIO_ENERGY es un combo, no un servicio. Resolverlo "por las dudas" contra
    // el otro catálogo sería exactamente el default silencioso que el motor evita.
    const plan = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'BIO_ENERGY' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(codigosDeRechazo(plan)).toEqual(['SERVICIO_DESCONOCIDO']);
  });

  it('pedir un servicio existente como combo devuelve PRODUCTO_DESCONOCIDO', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'IHHT' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(codigosDeRechazo(plan)).toEqual(['PRODUCTO_DESCONOCIDO']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('La cantidad de ocupantes tiene que ser un entero de 1 en adelante', () => {
  const motor = motorDePrueba();

  function conOcupantes(ocupantes: number) {
    return expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'HBOT_MULTIPLAZA' },
      inicio: lunes(10),
      ocupantes,
      agenda: AGENDA_VACIA,
    });
  }

  for (const invalido of [0, -1, -6, 1.5, 2.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`${invalido} ocupantes se rechaza con OCUPANTES_INVALIDOS`, () => {
      const plan = conOcupantes(invalido);
      expect(codigosDeRechazo(plan)).toEqual(['OCUPANTES_INVALIDOS']);
      if (plan.ok) return;
      expect(plan.rechazos[0]?.mensaje).toMatch(/entero de 1 en adelante/);
    });
  }

  it('1 ocupante es válido: la multiplaza no tiene piso de sesión (R-06)', () => {
    expect(conOcupantes(1).ok).toBe(true);
  });

  it('el rechazo por ocupantes no depende del producto: se valida antes de mirar el catálogo', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_LONGEVITY' },
      inicio: lunes(10),
      ocupantes: 0,
      agenda: AGENDA_VACIA,
    });
    expect(codigosDeRechazo(plan)).toEqual(['OCUPANTES_INVALIDOS']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Selección forzada de un servicio para un tramo', () => {
  const motor = motorDePrueba();

  it('forzar la multiplaza en BIO OXYGEN con 1 ocupante cambia la cámara sin cambiar los offsets', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
      seleccion: { 1: 'HBOT_MULTIPLAZA' },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.valor.tramos[0]?.servicio).toBe('HBOT_MULTIPLAZA');
    expect(plan.valor.tramos.map((t) => t.offsetMin)).toEqual([0, 60]);
  });

  it('forzar un servicio que el tramo no ofrece deja al combo sin ninguna variante posible', () => {
    // El tramo 1 de BIO OXYGEN ofrece las tres cámaras, no Recovery Pro. Al
    // filtrar, no queda ninguna combinación que probar.
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
      seleccion: { 1: 'RECOVERY_PRO' },
    });
    expect(plan.ok).toBe(false);
    expect(codigosDeRechazo(plan)).toEqual(['COMBO_SIN_SERVICIO_APLICABLE']);
  });

  it('forzar un servicio inexistente también deja al combo sin variantes', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_ENERGY' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
      seleccion: { 2: 'NO_EXISTE' },
    });
    expect(codigosDeRechazo(plan)).toEqual(['COMBO_SIN_SERVICIO_APLICABLE']);
  });

  it('forzar el mismo servicio que el tramo ya iba a elegir no cambia nada', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_ENERGY' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
      seleccion: { 1: 'IHHT', 2: 'RED_LIGHT' },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.valor.tramos.map((t) => t.servicio)).toEqual(['IHHT', 'RED_LIGHT']);
  });

  // BUG (reportado, no corregido): una selección que apunta a un número de tramo
  // que el combo no tiene se ignora en silencio. Recepción pide «BIO OXYGEN en la
  // multiplaza» equivocándose de tramo y el motor reserva la monoplaza sin decir
  // nada. El código de rechazo SELECCION_DE_TRAMO_INVALIDA existe en
  // `dominio/rechazos.ts` y no lo emite nadie: era exactamente para esto.
  it.fails('una selección para un tramo que no existe debería rechazarse, no ignorarse', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
      seleccion: { 5: 'HBOT_MULTIPLAZA' },
    });
    expect(codigosDeRechazo(plan)).toContain('SELECCION_DE_TRAMO_INVALIDA');
  });

  it('hoy esa selección fuera de rango se ignora y el combo se reserva igual', () => {
    // Contracara del test anterior: deja registrado el comportamiento actual para
    // que el día que se corrija se vea qué cambia.
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
      seleccion: { 5: 'HBOT_MULTIPLAZA' },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.valor.tramos[0]?.servicio).toBe('HBOT_MONOPLAZA');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Capacidad excedida contra recurso ocupado: son dos rechazos distintos', () => {
  const motor = motorDePrueba();

  function multiplaza(ocupantes: number, agenda = AGENDA_VACIA) {
    return expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'HBOT_MULTIPLAZA' },
      inicio: lunes(10),
      ocupantes,
      agenda,
    });
  }

  it('7 personas en la multiplaza de 6 es CAPACIDAD_EXCEDIDA, con la agenda vacía', () => {
    // No es un problema de disponibilidad: no entran nunca, ni en un día sin
    // reservas. Distinguirlo importa porque el consejo a recepción es distinto:
    // acá no sirve ofrecer otro horario.
    const plan = multiplaza(7);
    expect(codigosDeRechazo(plan)).toEqual(['CAPACIDAD_EXCEDIDA']);
    if (plan.ok) return;
    expect(plan.rechazos[0]?.detalle).toMatchObject({
      recurso: 'hbot-multiplaza',
      capacidadTotal: 6,
      ocupantes: 7,
    });
  });

  it('6 personas entran justo', () => {
    expect(multiplaza(6).ok).toBe(true);
  });

  it('con la multiplaza ya llena, 1 persona más es RECURSO_OCUPADO, no CAPACIDAD_EXCEDIDA', () => {
    const llena = multiplaza(6);
    expect(llena.ok).toBe(true);
    if (!llena.ok) return;

    const unoMas = multiplaza(1, conOcupaciones(AGENDA_VACIA, llena.valor.ocupaciones));
    expect(codigosDeRechazo(unoMas)).toEqual(['RECURSO_OCUPADO']);
    if (unoMas.ok) return;
    expect(unoMas.rechazos[0]?.detalle).toMatchObject({
      recurso: 'hbot-multiplaza',
      ocupantes: 1,
      lugaresDisponibles: 0,
      // La cámara queda tomada hasta las 11:00: la higienización arranca cuando
      // el cliente sale (10:55), no cuando termina la terapia nominal.
      ventana: '10:00–11:00',
    });
  });

  it('con los dos puestos de IHHT tomados, el tercero es RECURSO_OCUPADO', () => {
    const dos = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'IHHT' },
      inicio: lunes(10),
      ocupantes: 2,
      agenda: AGENDA_VACIA,
    });
    expect(dos.ok).toBe(true);
    if (!dos.ok) return;

    const tercero = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'IHHT' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: conOcupaciones(AGENDA_VACIA, dos.valor.ocupaciones),
    });
    expect(codigosDeRechazo(tercero)).toEqual(['RECURSO_OCUPADO']);
  });

  it('3 personas en los 2 puestos de IHHT es CAPACIDAD_EXCEDIDA aunque estén libres', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'IHHT' },
      inicio: lunes(10),
      ocupantes: 3,
      agenda: AGENDA_VACIA,
    });
    expect(codigosDeRechazo(plan)).toEqual(['CAPACIDAD_EXCEDIDA']);
    if (plan.ok) return;
    expect(plan.rechazos[0]?.detalle).toMatchObject({ capacidadTotal: 2, ocupantes: 3 });
  });

  it('con 2 plazas tomadas de la multiplaza, todavía quedan 4 libres para la misma tanda', () => {
    // Ventana idéntica + plazas <= capacidad: R-06 deja sumarse a la tanda.
    const dos = multiplaza(2);
    expect(dos.ok).toBe(true);
    if (!dos.ok) return;
    const agenda = conOcupaciones(AGENDA_VACIA, dos.valor.ocupaciones);

    expect(multiplaza(4, agenda).ok).toBe(true);
    expect(multiplaza(5, agenda).ok).toBe(false);
  });

  // El rechazo informa las plazas que de verdad quedan. Decir «quedan 0» cuando
  // quedan 4 llevaba a recepción a descartar la tanda en vez de ofrecerle al
  // cliente venir con 4.
  it('el rechazo por plazas informa las plazas que realmente quedan', () => {
    const dos = multiplaza(2);
    if (!dos.ok) throw new Error('la reserva de 2 ocupantes tendría que entrar');
    const cinco = multiplaza(5, conOcupaciones(AGENDA_VACIA, dos.valor.ocupaciones));

    expect(codigosDeRechazo(cinco)).toEqual(['RECURSO_OCUPADO']);
    if (cinco.ok) return;
    expect(cinco.rechazos[0]?.detalle).toMatchObject({ lugaresDisponibles: 4 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Entre variantes que fallan, se reporta la que llegó más lejos', () => {
  // Con dos ocupantes, «no entran en la monoplaza» es ruido; «no quedan puestos
  // de IHHT a las 11:00» es la respuesta. El expansor prueba las cámaras en orden
  // y se queda con el rechazo de la variante que resolvió más tramos.

  const motor = motorDePrueba();

  it('BIO OXYGEN con 4 personas reporta el encadenamiento con IHHT, no la monoplaza chica', () => {
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10),
      ocupantes: 4,
      agenda: AGENDA_VACIA,
    });

    expect(plan.ok).toBe(false);
    // La monoplaza y la biplaza fallan en el tramo 1 (profundidad 0); la
    // multiplaza resuelve el tramo 1 y cae en el 2 (profundidad 1), y gana.
    expect(codigosDeRechazo(plan)).toEqual(['ENCADENAMIENTO_SIN_CAPACIDAD']);
    expect(codigosDeRechazo(plan)).not.toContain('CAPACIDAD_EXCEDIDA');
    if (plan.ok) return;
    expect(plan.rechazos[0]?.detalle).toMatchObject({
      recurso: 'ihht',
      ocupantes: 4,
      lugaresDisponibles: 2,
      ventana: '11:00–11:30',
    });
    expect(plan.rechazos[0]?.mensaje).toMatch(/partir el grupo en tandas/);
  });

  it('forzando la monoplaza, el mismo pedido sí devuelve CAPACIDAD_EXCEDIDA de la cámara', () => {
    // El control: la variante superficial existía, sólo que no era la que mejor
    // explicaba el problema.
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10),
      ocupantes: 4,
      agenda: AGENDA_VACIA,
      seleccion: { 1: 'HBOT_MONOPLAZA' },
    });
    expect(codigosDeRechazo(plan)).toEqual(['CAPACIDAD_EXCEDIDA']);
    if (plan.ok) return;
    expect(plan.rechazos[0]?.mensaje).toMatch(/HBOT Monoplaza/);
  });

  it('BIO LONGEVITY con 2 personas y las tumbonas de sala tomadas reporta el tramo 3', () => {
    // La monoplaza cae en el tramo 1 (profundidad 0). La biplaza resuelve cámara
    // e IHHT y recién se cae en la luz roja del gabinete (profundidad 2): ese es
    // el rechazo útil.
    const agenda = agendaCon(
      ocupar('RL-SALA-1', lunes(11, 30), 60),
      ocupar('RL-SALA-2', lunes(11, 30), 60),
    );

    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_LONGEVITY' },
      inicio: lunes(10),
      ocupantes: 2,
      agenda,
    });

    expect(plan.ok).toBe(false);
    expect(codigosDeRechazo(plan)).toEqual(['TUMBONA_STANDALONE_PROHIBIDA']);
    expect(codigosDeRechazo(plan)).not.toContain('CAPACIDAD_EXCEDIDA');
    if (plan.ok) return;
    // Y la ventana que nombra es la de la luz roja del tramo 3, derivada: 11:58,
    // más el turnaround de la tumbona prestada (7 min), que también hay que
    // reservar: la tumbona no vuelve al pool sin higienizar.
    expect(plan.rechazos[0]?.mensaje).toMatch(/11:58–12:25/);
  });

  it('cuando todas las variantes fallan a la misma profundidad, se reporta la primera', () => {
    // 7 personas no entran en ninguna cámara. Ninguna llega más lejos que otra,
    // así que gana el orden de preferencia del catálogo: la monoplaza.
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10),
      ocupantes: 7,
      agenda: AGENDA_VACIA,
    });
    expect(codigosDeRechazo(plan)).toEqual(['CAPACIDAD_EXCEDIDA']);
    if (plan.ok) return;
    expect(plan.rechazos[0]?.detalle).toMatchObject({
      recurso: 'hbot-monoplaza',
      capacidadTotal: 1,
    });
  });

  it('si una variante cierra, no se reporta ningún rechazo de las que fallaron antes', () => {
    // Con 2 ocupantes la monoplaza no sirve, pero la biplaza sí: el fallo de la
    // primera no ensucia el resultado.
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10),
      ocupantes: 2,
      agenda: AGENDA_VACIA,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.valor.tramos[0]?.servicio).toBe('HBOT_BIPLAZA');
  });
});
