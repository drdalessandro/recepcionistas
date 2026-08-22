/**
 * El validador de configuración: qué se rechaza al arrancar y por qué.
 *
 * La regla que le da sentido a todo el archivo: una configuración que no cierra
 * es un bug de despliegue, no un caso de uso. Por eso `compilarConfig` lanza al
 * arrancar en vez de improvisar defaults en caliente — un slot mal supuesto no
 * produce un atraso puntual, produce atraso acumulativo a lo largo del día.
 *
 * Todas las configuraciones inválidas se arman partiendo de `configSanIsidro()`
 * y sobrescribiendo lo mínimo, para que lo que falla sea exactamente lo que el
 * test dice que falla.
 */

import { describe, expect, it } from 'vitest';
import {
  auditarConfig,
  bloqueoRecursoMin,
  compilarConfig,
  configSanIsidro,
  ErrorDeConfiguracion,
  nombreRecurso,
  type ConfigMotor,
  type EtapaInterna,
  type Recurso,
  type TiemposRecurso,
  type TipoRecurso,
  type VersionListaPrecios,
} from '../../src/motor-agenda/index.js';
import { motorDePrueba } from './ayudas.js';

// ── Andamios locales ────────────────────────────────────────────────────────

/** Reemplaza un recurso de la config por su versión parcheada. */
function conRecurso(
  config: ConfigMotor,
  tipo: TipoRecurso,
  parche: (recurso: Recurso) => Recurso,
): ConfigMotor {
  return { ...config, recursos: config.recursos.map((r) => (r.tipo === tipo ? parche(r) : r)) };
}

/** Los tiempos de un recurso de la config base, o un error si no los tiene. */
function tiemposDe(recurso: Recurso): TiemposRecurso {
  if (!recurso.tiempos) {
    throw new Error(`El recurso "${recurso.tipo}" no tiene tiempos en la configuración base.`);
  }
  return recurso.tiempos;
}

/** Parchea los tiempos de un recurso agendable. */
function conTiempos(
  config: ConfigMotor,
  tipo: TipoRecurso,
  parche: (tiempos: TiemposRecurso) => TiemposRecurso,
): ConfigMotor {
  return conRecurso(config, tipo, (r) => ({ ...r, tiempos: parche(tiemposDe(r)) }));
}

/** Parchea la secuencia interna de un recurso que la declara. */
function conEtapas(
  config: ConfigMotor,
  tipo: TipoRecurso,
  parche: (etapas: readonly EtapaInterna[]) => readonly EtapaInterna[],
): ConfigMotor {
  return conTiempos(config, tipo, (t) => {
    if (!t.etapas) throw new Error(`El recurso "${tipo}" no declara etapas internas.`);
    return { ...t, etapas: parche(t.etapas) };
  });
}

/** Parchea todas las versiones de la lista de precios. */
function conListas(
  config: ConfigMotor,
  parche: (lista: VersionListaPrecios) => VersionListaPrecios,
): ConfigMotor {
  return { ...config, listasPrecios: config.listasPrecios.map(parche) };
}

/**
 * Tiempos armados a mano, como los que llegarían de un JSON de despliegue mal
 * cargado: el compilador de TypeScript no está para defender al validador.
 */
function tiemposCrudos(campos: Record<string, unknown>): TiemposRecurso {
  return campos as unknown as TiemposRecurso;
}

function problemasDe(config: ConfigMotor): readonly string[] {
  return auditarConfig(config).problemas;
}

/** Los problemas con los que `compilarConfig` se negó a arrancar. */
function problemasAlCompilar(config: ConfigMotor): readonly string[] {
  try {
    compilarConfig(config);
  } catch (error) {
    if (error instanceof ErrorDeConfiguracion) return error.problemas;
    throw error;
  }
  throw new Error('Se esperaba que compilarConfig lanzara ErrorDeConfiguracion, pero compiló.');
}

/** El único problema esperado, sin indexar a ciegas. */
function unicoProblema(problemas: readonly string[]): string {
  expect(problemas).toHaveLength(1);
  return problemas[0] ?? '';
}

/**
 * El problema que habla de lo que el test está probando.
 *
 * Una misma configuración rota suele romper varias verificaciones a la vez —un
 * recurso que se pasa del slot rompe el invariante nominal y además el bloqueo
 * efectivo—, así que el test busca el problema que le importa en vez de contar
 * cuántos salieron.
 */
function problemaQueHablaDe(problemas: readonly string[], patron: RegExp): string {
  const hallado = problemas.find((p) => patron.test(p));
  const contexto = `ningún problema matchea ${patron}. Se reportaron:\n${problemas.join('\n')}`;
  expect(hallado, contexto).toBeDefined();
  return hallado ?? '';
}

// ═══════════════════════════════════════════════════════════════════════════
describe('(a) El invariante setup + terapia + turnaround <= slot', () => {
  it('un puesto de IHHT con 10 minutos de turnaround no cierra su slot de 30 y no arranca', () => {
    // Es el escenario que el propio Manual anticipa: si el protocolo de higiene
    // de máscara y clip pidiera más de 5 minutos, la grilla de 30 deja de cerrar.
    const config = conTiempos(configSanIsidro(), 'ihht', (t) => ({ ...t, turnaroundMin: 10 }));

    expect(() => compilarConfig(config)).toThrow(ErrorDeConfiguracion);

    // El mismo turnaround de más rompe dos cosas —la suma nominal y el bloqueo
    // efectivo contra el slot— y las dos se reportan. Acá interesa el invariante.
    const problema = problemaQueHablaDe(problemasAlCompilar(config), /atraso acumulativo/);
    expect(problema).toMatch(/ihht/);
    expect(problema).toMatch(/setup \(3\) \+ terapia \(22\) \+ turnaround \(10\) = 35 min/);
    expect(problema).toMatch(/supera el slot de 30 min/);
    // Lo que hay que explicarle a quien despliega: no es un atraso de 5 minutos,
    // es un atraso que se acumula turno tras turno.
    expect(problema).toMatch(/atraso acumulativo/);
  });

  it('la igualdad cierra: Recovery Pro ocupa exactamente sus 60 minutos de slot', () => {
    const recovery = configSanIsidro().recursos.find((r) => r.tipo === 'recovery-pro');
    expect(recovery).toBeDefined();
    if (!recovery) return;
    const t = tiemposDe(recovery);

    expect(t.setupMin + t.terapiaMin + t.turnaroundMin).toBe(t.slotMin);
    expect(problemasDe(configSanIsidro())).toEqual([]);
  });

  it('un minuto de más ya no cierra: 61 sobre un slot de 60', () => {
    const config = conTiempos(configSanIsidro(), 'recovery-pro', (t) => ({
      ...t,
      turnaroundMin: t.turnaroundMin + 1,
    }));
    expect(problemaQueHablaDe(problemasDe(config), /supera el slot/)).toMatch(
      /= 61 min, que supera el slot de 60 min/,
    );
  });

  it('con dos recursos que no cierran, el error los trae a los dos: no falla en el primero', () => {
    const config = conTiempos(
      conTiempos(configSanIsidro(), 'ihht', (t) => ({ ...t, turnaroundMin: 10 })),
      'compresion',
      (t) => ({ ...t, terapiaMin: 40 }),
    );

    // Lo que se prueba es que el validador no corta en el primero: los dos
    // recursos tienen que estar nombrados, cuenten lo que cuenten los mensajes.
    const problemas = problemasAlCompilar(config);
    expect(problemas.some((p) => /"ihht"/.test(p))).toBe(true);
    expect(problemas.some((p) => /"compresion"/.test(p))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(b) Campos numéricos: si faltan o son negativos hay error, nunca un default', () => {
  it('un slot ausente es un problema, no un valor supuesto', () => {
    const config = conRecurso(configSanIsidro(), 'ihht', (r) => ({
      ...r,
      tiempos: tiemposCrudos({ setupMin: 3, terapiaMin: 22, turnaroundMin: 5, grillaInicioMin: 30 }),
    }));

    const problema = unicoProblema(problemasDe(config));
    expect(problema).toMatch(/slotMin falta o no es un entero no negativo \(se recibió undefined\)/);
    expect(problema).toMatch(/nunca toma un default/);
  });

  it('un setup negativo es un problema', () => {
    const config = conTiempos(configSanIsidro(), 'ihht', (t) => ({ ...t, setupMin: -3 }));
    expect(unicoProblema(problemasDe(config))).toMatch(/setupMin falta o no es un entero/);
  });

  it('un tiempo fraccionario tampoco pasa: los minutos de la grilla son enteros', () => {
    const config = conTiempos(configSanIsidro(), 'ihht', (t) => ({ ...t, terapiaMin: 22.5 }));
    expect(unicoProblema(problemasDe(config))).toMatch(/terapiaMin falta o no es un entero/);
  });

  it('un slot de 0 minutos no es un recurso agendable', () => {
    const config = conTiempos(configSanIsidro(), 'crioterapia', (t) => ({ ...t, slotMin: 0 }));
    expect(unicoProblema(problemasDe(config))).toMatch(/el slot debe ser positivo/);
  });

  it('una grilla de inicio de 0 no define ningún inicio posible', () => {
    const config = conTiempos(configSanIsidro(), 'crioterapia', (t) => ({ ...t, grillaInicioMin: 0 }));
    expect(unicoProblema(problemasDe(config))).toMatch(/la grilla de inicio debe ser positiva/);
  });

  it('si faltan dos campos se reportan los dos, uno por campo', () => {
    const config = conRecurso(configSanIsidro(), 'ihht', (r) => ({
      ...r,
      tiempos: tiemposCrudos({ slotMin: 30, terapiaMin: 22, turnaroundMin: -1, grillaInicioMin: 30 }),
    }));

    const problemas = problemasDe(config);
    expect(problemas).toHaveLength(2);
    expect(problemas.join('\n')).toMatch(/setupMin/);
    expect(problemas.join('\n')).toMatch(/turnaroundMin/);
  });

  it('la granularidad de la agenda también tiene que ser un entero positivo', () => {
    const config: ConfigMotor = { ...configSanIsidro(), granularidadAgendaMin: 0 };
    expect(unicoProblema(problemasDe(config))).toMatch(
      /granularidadAgendaMin debe ser un entero positivo/,
    );
  });

  it('una ventana de reserva no puede ser cero ni negativa', () => {
    const base = configSanIsidro();
    const config: ConfigMotor = {
      ...base,
      ventanasReservaHoras: { ...base.ventanasReservaHoras, publico: 0 },
    };
    expect(unicoProblema(problemasDe(config))).toMatch(
      /La ventana de reserva "publico" debe ser un número de horas positivo/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(c) El ancla de salida del cliente', () => {
  it('el ancla de HBOT (minuto 55) es coherente y compila', () => {
    // setup + terapia = 53 y el cliente sale a los 55: sale después de que
    // termina la terapia nominal, que es exactamente lo que modela el ancla.
    // El bloqueo real no es la suma nominal (58) sino el ancla más el turnaround
    // (60): la higienización arranca cuando el cliente sale, no antes.
    const hbot = configSanIsidro().recursos.find((r) => r.tipo === 'hbot-monoplaza');
    expect(hbot).toBeDefined();
    if (!hbot) return;
    const t = tiemposDe(hbot);

    expect(t.anclaSalidaMin).toBe(55);
    expect(t.setupMin + t.terapiaMin).toBe(53);
    expect(t.setupMin + t.terapiaMin + t.turnaroundMin).toBe(58);
    expect(bloqueoRecursoMin(t)).toBe(60);
    expect(bloqueoRecursoMin(t)).toBeLessThanOrEqual(t.slotMin);
    expect(problemasDe(configSanIsidro())).toEqual([]);
  });

  it('un ancla anterior al fin de la terapia es error: el cliente no puede salir antes de terminar', () => {
    const config = conTiempos(configSanIsidro(), 'hbot-monoplaza', (t) => ({
      ...t,
      anclaSalidaMin: 40,
    }));
    const problema = unicoProblema(problemasDe(config));
    expect(problema).toMatch(/el ancla de salida \(40\) cae antes de que termine la terapia/);
    expect(problema).toMatch(/setup \+ terapia = 53/);
  });

  it('un ancla tan tardía que la limpieza se pasa del slot es error: el turno siguiente arrancaría tarde', () => {
    // Ya no puede pasar que el ancla caiga después de la liberación: el bloqueo
    // se calcula como el ancla más el turnaround. Lo que sí puede pasar es que
    // esa suma se vaya del slot, y es lo que el validador caza ahora: con el
    // ancla en 59, la cámara queda tomada 64 minutos sobre un slot de 60.
    const config = conTiempos(configSanIsidro(), 'hbot-monoplaza', (t) => ({
      ...t,
      anclaSalidaMin: 59,
    }));
    const problema = unicoProblema(problemasDe(config));
    expect(problema).toMatch(/hbot-monoplaza/);
    expect(problema).toMatch(
      /queda bloqueado 64 min \(ancla y turnaround incluidos\), más que su slot de 60 min/,
    );
  });

  it('un ancla que contradice la secuencia interna es error: se declara una sola de las dos', () => {
    // Recovery Pro no declara ancla a propósito: sale del minuto 56 de sus etapas.
    const config = conTiempos(configSanIsidro(), 'recovery-pro', (t) => ({
      ...t,
      anclaSalidaMin: 50,
    }));
    // Declarar el ancla también corre el bloqueo (50 + 12 = 62 sobre un slot de
    // 60), así que sale ese problema además del que este test persigue.
    const problema = problemaQueHablaDe(problemasDe(config), /contradice a la secuencia interna/);
    expect(problema).toMatch(/el ancla declarada \(50\) contradice a la secuencia interna/);
    expect(problema).toMatch(/el cliente sale en el minuto 56/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(d) La secuencia interna de etapas', () => {
  it('un hueco entre etapas es error: el desfasaje entre gabinetes depende de que sean contiguas', () => {
    const config = conEtapas(configSanIsidro(), 'recovery-pro', (etapas) =>
      etapas.map((e) => (e.nombre === 'Ducha y vestuario' ? { ...e, desdeMin: 50 } : e)),
    );

    const problema = unicoProblema(problemasDe(config));
    expect(problema).toMatch(/salto entre "Red Light" \(termina en 48\)/);
    expect(problema).toMatch(/"Ducha y vestuario" \(empieza en 50\)/);
    expect(problema).toMatch(/desfasaje entre gabinetes/);
  });

  it('una secuencia que no arranca en el minuto 0 es error', () => {
    const config = conEtapas(configSanIsidro(), 'recovery-pro', (etapas) =>
      etapas.map((e, i) => (i === 0 ? { ...e, desdeMin: 2 } : e)),
    );
    expect(unicoProblema(problemasDe(config))).toMatch(
      /la secuencia interna no arranca en el minuto 0/,
    );
  });

  it('una secuencia que se pasa del slot es error', () => {
    const config = conEtapas(configSanIsidro(), 'recovery-pro', (etapas) =>
      etapas.map((e) => (e.nombre === 'Salida' ? { ...e, hastaMin: 70 } : e)),
    );
    // La secuencia larga arrastra también el bloqueo efectivo (70 sobre un slot
    // de 60): son dos mensajes, uno por cada cosa que dejó de cerrar.
    expect(problemaQueHablaDe(problemasDe(config), /la secuencia interna termina/)).toMatch(
      /la secuencia interna termina en el minuto 70, más allá del slot de 60/,
    );
  });

  it('una etapa que termina cuando empieza es error', () => {
    const config = conEtapas(configSanIsidro(), 'recovery-pro', (etapas) =>
      etapas.map((e) => (e.nombre === 'Cold plunge' && e.desdeMin === 12 ? { ...e, hastaMin: 12 } : e)),
    );

    const problemas = problemasDe(config);
    expect(problemas.join('\n')).toMatch(/etapa "Cold plunge": termina \(12\) antes o cuando empieza \(12\)/);
  });

  it('la ventana de tumbona de Recovery Pro va del minuto 28 al 48 y valida sin problemas', () => {
    // El dato del que emerge R-07: la tumbona se devuelve a los 48, mientras el
    // cliente sigue en el gabinete duchándose hasta los 56.
    const recovery = configSanIsidro().recursos.find((r) => r.tipo === 'recovery-pro');
    expect(recovery).toBeDefined();
    if (!recovery) return;

    const luz = tiemposDe(recovery).etapas?.find((e) => e.ocupa !== 'propio');
    expect(luz?.desdeMin).toBe(28);
    expect(luz?.hastaMin).toBe(48);
    expect(problemasDe(configSanIsidro())).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(e) Una etapa que toma de un pool inexistente', () => {
  it('se reporta como error, junto con todo lo demás que ese pool arrastra', () => {
    // Sacar el pool de tumbonas deja a Recovery Pro tomando de la nada y al
    // servicio RED_LIGHT sin recurso: el validador reporta los dos, no el primero.
    const base = configSanIsidro();
    const config: ConfigMotor = {
      ...base,
      recursos: base.recursos.filter((r) => r.tipo !== 'tumbona-red-light'),
    };

    const problemas = problemasAlCompilar(config);
    expect(problemas.join('\n')).toMatch(
      /Recurso "recovery-pro", etapa "Red Light": toma del pool "tumbona-red-light", que no existe/,
    );
    expect(problemas.join('\n')).toMatch(
      /El servicio "RED_LIGHT" se ejecuta sobre "tumbona-red-light", que no existe/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(f) Unidades físicas', () => {
  it('dos unidades con el mismo id son error, aunque cuelguen de recursos distintos', () => {
    const config = conRecurso(configSanIsidro(), 'crioterapia', (r) => ({
      ...r,
      unidades: r.unidades.map((u) => ({ ...u, id: 'IPC06' })),
    }));
    expect(unicoProblema(problemasDe(config))).toMatch(/El id de unidad "IPC06" está repetido/);
  });

  it('una unidad con capacidad 0 es error: no entra nadie', () => {
    const config = conRecurso(configSanIsidro(), 'ihht', (r) => ({
      ...r,
      unidades: r.unidades.map((u, i) => (i === 0 ? { ...u, capacidad: 0 } : u)),
    }));
    expect(unicoProblema(problemasDe(config))).toMatch(
      /La unidad "IHHT-1" tiene capacidad inválida \(0\)/,
    );
  });

  it('un recurso sin ninguna unidad declarada es error', () => {
    const config = conRecurso(configSanIsidro(), 'crioterapia', (r) => ({ ...r, unidades: [] }));
    expect(unicoProblema(problemasDe(config))).toMatch(
      /El recurso "crioterapia" no tiene ninguna unidad declarada/,
    );
  });

  it('una tumbona sin ubicación es error: sin ella no hay direccionalidad del pool', () => {
    const config = conRecurso(configSanIsidro(), 'tumbona-red-light', (r) => ({
      ...r,
      unidades: r.unidades.map((u) =>
        u.id === 'RL-STANDALONE'
          ? { id: u.id, tipo: u.tipo, nombre: u.nombre, capacidad: u.capacidad, planta: u.planta }
          : u,
      ),
    }));

    const problema = unicoProblema(problemasDe(config));
    expect(problema).toMatch(/La tumbona "RL-STANDALONE" no declara ubicación/);
    expect(problema).toMatch(/Recovery Pro nunca va al área común/);
  });

  it('una unidad cuyo tipo no coincide con su recurso es error', () => {
    const config = conRecurso(configSanIsidro(), 'crioterapia', (r) => ({
      ...r,
      unidades: r.unidades.map((u) => ({ ...u, tipo: 'compresion' as TipoRecurso })),
    }));
    expect(unicoProblema(problemasDe(config))).toMatch(
      /La unidad "COT03" dice ser de tipo "compresion" pero cuelga del recurso "crioterapia"/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(g) Recursos sin tiempos medidos', () => {
  it('sin tiempos y sin explicación es error', () => {
    const config = conRecurso(configSanIsidro(), 'camilla-masajes', (r) => ({
      tipo: r.tipo,
      nombre: r.nombre,
      unidades: r.unidades,
    }));

    const problema = unicoProblema(problemasAlCompilar(config));
    expect(problema).toMatch(/El recurso "camilla-masajes" no tiene tiempos y tampoco explica por qué/);
    expect(problema).toMatch(/el motivo tiene que quedar escrito/);
  });

  it('una explicación en blanco no alcanza como explicación', () => {
    const config = conRecurso(configSanIsidro(), 'camilla-masajes', (r) => ({
      ...r,
      sinTiempos: '   ',
    }));
    expect(unicoProblema(problemasDe(config))).toMatch(/no tiene tiempos y tampoco explica por qué/);
  });

  it('con la explicación escrita, la config arranca y el recurso queda sin tiempos', () => {
    // No hay default silencioso: el recurso existe, se puede nombrar, y recién
    // al intentar agendarlo aparece RECURSO_SIN_TIEMPOS.
    const motor = motorDePrueba();
    for (const tipo of ['camilla-masajes', 'consultorio', 'sala-tb', 'puesto-iv'] as const) {
      const recurso = motor.recursoPorTipo.get(tipo);
      expect(recurso?.tiempos).toBeUndefined();
      expect(recurso?.sinTiempos?.trim()).toBeTruthy();
    }
    expect(motor.informe.problemas).toEqual([]);
  });

  it('declarar tiempos y a la vez decir que no los tiene es error', () => {
    const config = conRecurso(configSanIsidro(), 'ihht', (r) => ({
      ...r,
      sinTiempos: 'La tabla operativa no los define.',
    }));
    expect(unicoProblema(problemasDe(config))).toMatch(
      /El recurso "ihht" declara tiempos y a la vez dice no tenerlos/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(h) Catálogo: combos y membresías', () => {
  it('los órdenes de tramo tienen que ser 1..n sin huecos', () => {
    const base = configSanIsidro();
    const config: ConfigMotor = {
      ...base,
      combos: base.combos.map((c) =>
        c.codigo === 'BIO_ENERGY'
          ? { ...c, tramos: c.tramos.map((t) => (t.orden === 2 ? { ...t, orden: 3 } : t)) }
          : c,
      ),
    };
    expect(unicoProblema(problemasDe(config))).toMatch(
      /El combo "BIO_ENERGY" tiene los órdenes de tramo \[1, 3\]/,
    );
  });

  it('un tramo que referencia un servicio inexistente es error', () => {
    const base = configSanIsidro();
    const config: ConfigMotor = {
      ...base,
      combos: base.combos.map((c) =>
        c.codigo === 'BIO_ENERGY'
          ? {
              ...c,
              tramos: [
                { orden: 1, servicios: ['SAUNA_FINLANDESA'] },
                { orden: 2, servicios: ['RED_LIGHT'] },
              ],
            }
          : c,
      ),
    };
    expect(unicoProblema(problemasDe(config))).toMatch(
      /tramo 1, referencia el servicio "SAUNA_FINLANDESA", que no existe/,
    );
  });

  it('un tramo sin ningún servicio es error', () => {
    const base = configSanIsidro();
    const config: ConfigMotor = {
      ...base,
      combos: base.combos.map((c) =>
        c.codigo === 'BIO_ENERGY'
          ? { ...c, tramos: [{ orden: 1, servicios: [] }, { orden: 2, servicios: ['RED_LIGHT'] }] }
          : c,
      ),
    };
    expect(unicoProblema(problemasDe(config))).toMatch(
      /El combo "BIO_ENERGY", tramo 1, no ofrece ningún servicio/,
    );
  });

  it('un combo sin tramos es error', () => {
    const base = configSanIsidro();
    const config: ConfigMotor = {
      ...base,
      combos: base.combos.map((c) => (c.codigo === 'BIO_ENERGY' ? { ...c, tramos: [] } : c)),
    };
    expect(unicoProblema(problemasDe(config))).toMatch(/El combo "BIO_ENERGY" no tiene tramos/);
  });

  it('una membresía basada en un combo inexistente es error', () => {
    const base = configSanIsidro();
    const config: ConfigMotor = {
      ...base,
      membresias: base.membresias.map((m) =>
        m.codigo === 'FOCUS' ? { ...m, comboBase: 'BIO_INMORTALIDAD' } : m,
      ),
    };
    expect(unicoProblema(problemasDe(config))).toMatch(
      /La membresía "FOCUS" se basa en el combo "BIO_INMORTALIDAD", que no existe/,
    );
  });

  it('una membresía sin sesiones en alguna modalidad es error', () => {
    const base = configSanIsidro();
    const config: ConfigMotor = {
      ...base,
      membresias: base.membresias.map((m) =>
        m.codigo === 'FOCUS'
          ? { ...m, sesionesPorModalidad: { ...m.sesionesPorModalidad, standard: 0 } }
          : m,
      ),
    };
    expect(unicoProblema(problemasDe(config))).toMatch(
      /La membresía "FOCUS", modalidad "standard", declara 0 sesiones/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(i) exigirRatificacion convierte los valores no ratificados en errores fatales', () => {
  it('apagado, los valores no ratificados son informe y el motor arranca', () => {
    const motor = compilarConfig(configSanIsidro({ exigirRatificacion: false }));
    expect(motor.informe.problemas).toEqual([]);
    expect(motor.informe.noRatificado.length).toBeGreaterThan(0);
  });

  it('prendido, cada valor no ratificado es un problema fatal y el motor no se construye', () => {
    const config = configSanIsidro({ exigirRatificacion: true });
    const informe = auditarConfig(config);

    expect(informe.problemas).toEqual([]); // nada roto: sólo pendientes de ratificar
    const problemas = problemasAlCompilar(config);
    expect(problemas).toHaveLength(informe.noRatificado.length);
    for (const p of problemas) {
      expect(p).toMatch(/^Valor no ratificado con exigirRatificacion activo/);
    }
  });

  it('el turnaround de IHHT está entre los fatales: el protocolo de higiene todavía no existe', () => {
    const problemas = problemasAlCompilar(configSanIsidro({ exigirRatificacion: true }));
    const ihht = problemas.find((p) => p.includes('recurso:ihht.turnaroundMin'));
    expect(ihht).toBeDefined();
    expect(ihht).toMatch(/protocolo de higiene/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(j) exigirCatalogoDePreciosCompleto convierte los precios faltantes en errores', () => {
  it('apagado, un servicio sin precio es un faltante y no impide arrancar', () => {
    const informe = auditarConfig(configSanIsidro({ exigirCatalogoDePreciosCompleto: false }));
    expect(informe.problemas).toEqual([]);
    expect(informe.faltantes.join('\n')).toMatch(
      /el servicio "IHHT" no tiene precio cargado.*PRECIO_NO_DEFINIDO/s,
    );
  });

  it('prendido, los mismos faltantes pasan a ser problemas y el motor no arranca', () => {
    const conExigencia = configSanIsidro({ exigirCatalogoDePreciosCompleto: true });
    const sinExigencia = configSanIsidro({ exigirCatalogoDePreciosCompleto: false });

    const problemas = problemasAlCompilar(conExigencia);
    expect(problemas).toHaveLength(auditarConfig(sinExigencia).faltantes.length);
    expect(problemas.join('\n')).toMatch(/el servicio "IHHT" no tiene precio cargado/);
  });

  it('los precios que sí están decididos (R-04 y R-06) no figuran como faltantes', () => {
    const informe = auditarConfig(configSanIsidro());
    expect(informe.faltantes.join('\n')).not.toMatch(/HBOT_BIPLAZA/);
    expect(informe.faltantes.join('\n')).not.toMatch(/HBOT_MULTIPLAZA/);
  });

  it('una lista que pone precio a un servicio inexistente es error', () => {
    const config = conListas(configSanIsidro(), (lista) => ({
      ...lista,
      servicios: [...lista.servicios, { servicio: 'CRIOSAUNA', precioPorOcupantesUsd: { 1: 50 } }],
    }));
    expect(problemasDe(config).join('\n')).toMatch(
      /pone precio al servicio "CRIOSAUNA", que no existe/,
    );
  });

  it('un precio tabulado no positivo es error', () => {
    const config = conListas(configSanIsidro(), (lista) => ({
      ...lista,
      servicios: lista.servicios.map((s) =>
        s.servicio === 'HBOT_BIPLAZA' ? { ...s, precioPorOcupantesUsd: { 1: 165, 2: 0 } } : s,
      ),
    }));
    expect(unicoProblema(problemasDe(config))).toMatch(
      /servicio "HBOT_BIPLAZA" con 2 ocupante\(s\): el precio debe ser positivo/,
    );
  });

  it('un precio de membresía no positivo es error', () => {
    const config = conListas(configSanIsidro(), (lista) => ({
      ...lista,
      membresias: lista.membresias.map((p) =>
        p.membresia === 'FOCUS' && p.modalidad === 'standard' && p.formato === 'individual'
          ? { ...p, precioBaseUsd: 0 }
          : p,
      ),
    }));
    expect(unicoProblema(problemasDe(config))).toMatch(
      /FOCUS\|standard\|individual: el precio base debe ser positivo/,
    );
  });

  it('sin ninguna versión de lista cargada, no hay contra qué cotizar', () => {
    const config: ConfigMotor = { ...configSanIsidro(), listasPrecios: [] };
    expect(unicoProblema(problemasDe(config))).toMatch(
      /No hay ninguna versión de lista de precios cargada/,
    );
  });

  it('una versión declarada dos veces es error: las versiones son inmutables e irrepetibles', () => {
    const base = configSanIsidro();
    const primera = base.listasPrecios[0];
    expect(primera).toBeDefined();
    if (!primera) return;

    const config: ConfigMotor = { ...base, listasPrecios: [primera, { ...primera }] };
    expect(problemasDe(config).join('\n')).toMatch(
      /La versión de lista "2026-08" está declarada dos veces/,
    );
  });

  // BUG (no arreglado a propósito): el validador exige que los precios tabulados
  // por ocupantes sean positivos, pero nunca mira `precioPorPersonaUsd`, que es
  // justamente cómo está cargada la multiplaza (R-06, USD 80 por persona). Una
  // lista con -80 arranca sin una sola queja.
  it.fails('un precio por persona negativo debería ser un problema de configuración', () => {
    const config = conListas(configSanIsidro(), (lista) => ({
      ...lista,
      servicios: lista.servicios.map((s) =>
        s.servicio === 'HBOT_MULTIPLAZA' ? { ...s, precioPorPersonaUsd: -80 } : s,
      ),
    }));
    expect(problemasDe(config).some((p) => p.includes('HBOT_MULTIPLAZA'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(k) La configuración real de San Isidro', () => {
  it('compila sin un solo problema', () => {
    const informe = auditarConfig(configSanIsidro());
    expect(informe.problemas).toEqual([]);
    expect(() => compilarConfig(configSanIsidro())).not.toThrow();
  });

  it('no tiene ninguna discrepancia de duración: el modelo reproduce lo que publica el Manual', () => {
    // 60 / 90 / 120 / 150 / 60 no están escritos en ninguna regla: salen de
    // encadenar la salida del cliente con la grilla del recurso siguiente.
    const motor = motorDePrueba();
    expect(motor.informe.discrepanciasDeDuracion).toEqual([]);

    const publicadas = new Map(
      motor.config.combos.map((c) => [c.codigo, c.duracionPublicadaMin] as const),
    );
    expect(publicadas.get('BIO_ENERGY')).toBe(60);
    expect(publicadas.get('BIO_OXYGEN')).toBe(90);
    expect(publicadas.get('BIO_RECOVERY')).toBe(120);
    expect(publicadas.get('BIO_LONGEVITY')).toBe(150);
    expect(publicadas.get('BIO_COMPRESS')).toBe(60);
  });

  it('una duración publicada que el modelo no reproduce es discrepancia, no error', () => {
    // Quién tiene razón —el catálogo comercial o los tiempos del recurso— es una
    // decisión de producto, así que el motor arranca igual y lo deja anotado.
    const base = configSanIsidro();
    const config: ConfigMotor = {
      ...base,
      combos: base.combos.map((c) =>
        c.codigo === 'BIO_ENERGY' ? { ...c, duracionPublicadaMin: 55 } : c,
      ),
    };

    const motor = compilarConfig(config);
    expect(motor.informe.problemas).toEqual([]);

    // La duración se contrasta en cada arranque posible dentro de la hora —la
    // grilla se aplica sobre el reloj de pared—, así que una sola discrepancia
    // real se reporta una vez por minuto de arranque, con la hora adentro.
    const discrepancias = motor.informe.discrepanciasDeDuracion;
    expect(discrepancias.length).toBeGreaterThan(0);
    expect(discrepancias.every((d) => /BIO_ENERGY/.test(d))).toBe(true);
    expect(
      discrepancias.some((d) =>
        /arrancando 00:00: el Manual publica 55 min y el modelo deriva 60 min/.test(d),
      ),
    ).toBe(true);
  });

  it('deja armados los índices que el motor usa en caliente', () => {
    const motor = motorDePrueba();
    expect(motor.recursoPorTipo.size).toBe(motor.config.recursos.length);
    expect(motor.servicioPorCodigo.size).toBe(motor.config.servicios.length);
    expect(motor.comboPorCodigo.size).toBe(motor.config.combos.length);
    expect(motor.membresiaPorCodigo.size).toBe(motor.config.membresias.length);
    expect(motor.listaPorVersion.get('2026-08')).toBeDefined();

    // Un id por unidad física: si alguno se pisara, el validador ya habría fallado.
    const unidades = motor.config.recursos.flatMap((r) => r.unidades);
    expect(motor.unidadPorId.size).toBe(unidades.length);
    expect(motor.unidadPorId.get('RL-SALA-1')?.ubicacion).toBe('sala-recovery');
    expect(motor.unidadPorId.get('RL-STANDALONE')?.ubicacion).toBe('standalone');
  });

  it('nombreRecurso traduce el tipo al nombre que ve recepción', () => {
    const motor = motorDePrueba();
    expect(nombreRecurso(motor, 'recovery-pro')).toBe('Gabinete Recovery Pro');
    expect(nombreRecurso(motor, 'puesto-iv')).toBe('Puesto IV');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(l) El informe: qué queda anotado aunque el motor arranque', () => {
  it('reporta el turnaround de IHHT con el motivo escrito, no con un rótulo genérico', () => {
    const nota = motorDePrueba().informe.noRatificado.find(
      (n) => n.ambito === 'recurso:ihht.turnaroundMin',
    );
    expect(nota).toBeDefined();
    expect(nota?.motivo).toMatch(/protocolo de higiene de máscara y clip de dedo/);
    expect(nota?.motivo).toMatch(/TODAVÍA NO EXISTE/);
    expect(nota?.motivo).toMatch(/el slot de 30 deja de cerrar/);
  });

  it('reporta los tres tiempos estimados de cada recurso sin medición formal', () => {
    const ambitos = motorDePrueba().informe.noRatificado.map((n) => n.ambito);
    for (const tipo of ['ihht', 'tumbona-red-light', 'compresion', 'crioterapia']) {
      for (const campo of ['setupMin', 'terapiaMin', 'turnaroundMin']) {
        expect(ambitos).toContain(`recurso:${tipo}.${campo}`);
      }
    }
    // HBOT y Recovery Pro sí tienen tiempos cerrados.
    expect(ambitos.some((a) => a.startsWith('recurso:hbot'))).toBe(false);
    expect(ambitos.some((a) => a.startsWith('recurso:recovery-pro'))).toBe(false);
  });

  it('reporta también los pendientes que no son de un recurso', () => {
    const ambitos = motorDePrueba().informe.noRatificado.map((n) => n.ambito);
    expect(ambitos).toContain('membresias.estructura-y-precios');
    expect(ambitos).toContain('pausa.redondeoSesiones');
    expect(ambitos).toContain('franjaClinica.bloqueaFlujoNormal');
  });

  it('reporta como faltantes los servicios del catálogo sin precio cargado', () => {
    const faltantes = motorDePrueba().informe.faltantes;
    const sinPrecio = [
      'HBOT_MONOPLAZA',
      'IHHT',
      'RED_LIGHT',
      'RECOVERY_PRO',
      'COMPRESION',
      'CRIOTERAPIA',
      'MASAJE',
      'CONSULTA_MEDICA',
      'IV_THERAPY',
      'TERAPIA_BIOLOGICA',
    ];
    expect(faltantes).toHaveLength(sinPrecio.length);
    for (const servicio of sinPrecio) {
      expect(faltantes.join('\n')).toMatch(new RegExp(`el servicio "${servicio}" no tiene precio`));
    }
  });

  it('el informe viaja adentro del motor compilado, para que nadie tenga que auditarlo aparte', () => {
    const motor = motorDePrueba();
    const suelto = auditarConfig(motor.config);
    expect(motor.informe.noRatificado).toEqual(suelto.noRatificado);
    expect(motor.informe.faltantes).toEqual(suelto.faltantes);
  });

  // BUG (no arreglado a propósito): las tres notas globales de no ratificación se
  // emiten desde adentro de `validarListasDePrecios`, que hace `return` temprano
  // si no hay listas cargadas. Un problema de precios se lleva puestos pendientes
  // que no tienen nada que ver con precios — y con `exigirRatificacion` prendido,
  // eso afloja el gate en vez de endurecerlo.
  it.fails('sin listas de precios, el informe no debería perder las notas globales', () => {
    const informe = auditarConfig({ ...configSanIsidro(), listasPrecios: [] });
    expect(informe.noRatificado.map((n) => n.ambito)).toContain('pausa.redondeoSesiones');
  });

  // BUG (no arreglado a propósito): el motivo de la nota de la franja clínica
  // afirma «Está en false», pero es un texto fijo que no mira la config. Con
  // `bloqueaFlujoNormal: true` el informe le miente a quien lo lee.
  it.fails('la nota de la franja clínica no debería afirmar un valor que la config contradice', () => {
    const base = configSanIsidro();
    const informe = auditarConfig({
      ...base,
      franjaClinica: { ...base.franjaClinica, bloqueaFlujoNormal: true },
    });
    const nota = informe.noRatificado.find((n) => n.ambito === 'franjaClinica.bloqueaFlujoNormal');
    expect(nota?.motivo ?? '').not.toMatch(/Está en false/);
  });
});
