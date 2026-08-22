/**
 * Pool de tumbonas Red Light y registro de ocupación.
 *
 * Dos piezas chicas de las que dependen las reglas más caras del motor:
 *
 *  - `pool-tumbonas.ts` es el único lugar donde vive la direccionalidad: Recovery
 *    Pro sólo puede usar las tumbonas de su sala (el cliente paga un gabinete
 *    privado), y todo lo demás prefiere la standalone justamente para no
 *    quitarle a Recovery Pro su única opción.
 *  - `ocupacion.ts` decide qué es «estar ocupado». Compartir una unidad exige
 *    **ventana idéntica** más plazas disponibles: una cámara multiplaza se
 *    presuriza como una sola sesión, así que sumarse a la tanda de 10:00 se
 *    puede (R-06) y empezar una propia a las 10:30 no.
 *
 * El desfasaje de 30 minutos entre gabinetes (R-07) no se testea acá: emerge del
 * encadenamiento y ya tiene su caso obligatorio. Acá se testea el ladrillo.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENDA_VACIA,
  asignarTumbonas,
  conOcupaciones,
  contarUnidadesLibres,
  estaDisponible,
  evaluarDisponibilidad,
  expandir,
  unidadesDisponibles,
  type AgendaOcupada,
  type ConsumidorDeTumbona,
  type Ocupacion,
  type TipoRecurso,
  type UnidadRecurso,
} from '../../src/motor-agenda/index.js';
import { agendaCon, codigosDeRechazo, lunes, motorDePrueba, ocupar, RELOJ } from './ayudas.js';

// ── Andamios locales ────────────────────────────────────────────────────────

const MOTOR = motorDePrueba();

/** Las tres tumbonas reales del centro: RL-SALA-1, RL-SALA-2 y RL-STANDALONE. */
const TUMBONAS: readonly UnidadRecurso[] =
  MOTOR.recursoPorTipo.get('tumbona-red-light')?.unidades ?? [];

/** Unidades de un tipo de recurso, tomadas de la configuración real. */
function unidadesDe(tipo: TipoRecurso): readonly UnidadRecurso[] {
  return MOTOR.recursoPorTipo.get(tipo)?.unidades ?? [];
}

/** Una unidad concreta por id, ya validada: si no está, el test tiene que romper. */
function unidad(id: string): UnidadRecurso {
  const encontrada = MOTOR.unidadPorId.get(id);
  if (!encontrada) throw new Error(`La configuración de prueba no tiene la unidad ${id}.`);
  return encontrada;
}

function ids(unidades: readonly UnidadRecurso[]): string[] {
  return unidades.map((u) => u.id);
}

/** Ocupación con la cantidad de plazas que se pida (la de `ayudas` siempre usa 1). */
function ocuparPlazas(
  unidadId: string,
  tipoRecurso: TipoRecurso,
  inicio: Date,
  fin: Date,
  plazas: number,
): Ocupacion {
  return { unidadId, tipoRecurso, inicio, fin, motivo: 'reserva previa', plazas };
}

/** Agenda con las tumbonas indicadas tomadas en la ventana de prueba. */
function conTumbonasTomadas(
  tomadas: readonly string[],
  inicio: Date = lunes(10),
  duracionMin = 30,
): AgendaOcupada {
  return agendaCon(...tomadas.map((id) => ocupar(id, inicio, duracionMin)));
}

interface PedidoDePrueba {
  readonly consumidor: ConsumidorDeTumbona;
  readonly cantidad: number;
  readonly agenda?: AgendaOcupada;
  readonly inicio?: Date;
  readonly fin?: Date;
  readonly tumbonas?: readonly UnidadRecurso[];
}

function pedirTumbonas(pedido: PedidoDePrueba) {
  return asignarTumbonas({
    consumidor: pedido.consumidor,
    cantidad: pedido.cantidad,
    inicio: pedido.inicio ?? lunes(10),
    fin: pedido.fin ?? lunes(10, 30),
    tumbonas: pedido.tumbonas ?? TUMBONAS,
    agenda: pedido.agenda ?? AGENDA_VACIA,
    reloj: RELOJ,
  });
}

/** Los ocho estados posibles del pool de tres tumbonas. */
const ESTADOS_DEL_POOL: readonly (readonly string[])[] = [
  [],
  ['RL-SALA-1'],
  ['RL-SALA-2'],
  ['RL-STANDALONE'],
  ['RL-SALA-1', 'RL-SALA-2'],
  ['RL-SALA-1', 'RL-STANDALONE'],
  ['RL-SALA-2', 'RL-STANDALONE'],
  ['RL-SALA-1', 'RL-SALA-2', 'RL-STANDALONE'],
];

function etiqueta(tomadas: readonly string[]): string {
  return tomadas.length === 0 ? 'con el pool entero libre' : `con ${tomadas.join(' + ')} tomada(s)`;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('El pool arranca con las tres tumbonas que declara la configuración', () => {
  it('dos en la sala Recovery Pro y una en el área común', () => {
    expect(ids(TUMBONAS)).toEqual(['RL-SALA-1', 'RL-SALA-2', 'RL-STANDALONE']);
    expect(TUMBONAS.filter((t) => t.ubicacion === 'sala-recovery')).toHaveLength(2);
    expect(TUMBONAS.filter((t) => t.ubicacion === 'standalone')).toHaveLength(1);
    // Una tumbona es de a uno: no hay nada que compartir dentro de una unidad.
    expect(TUMBONAS.every((t) => t.capacidad === 1)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(a) Recovery Pro nunca recibe la tumbona standalone, en ningún estado del pool', () => {
  // Barrido exhaustivo de los ocho estados por las cantidades que un gabinete
  // puede pedir (capacidad 2, una tumbona por ocupante). La direccionalidad no
  // es «casi siempre»: es siempre.
  for (const tomadas of ESTADOS_DEL_POOL) {
    for (const cantidad of [1, 2]) {
      const libresEnSala = 2 - tomadas.filter((id) => id.startsWith('RL-SALA')).length;
      const alcanza = libresEnSala >= cantidad;

      it(`${cantidad} ocupante(s) ${etiqueta(tomadas)}: ${alcanza ? 'asigna sólo tumbonas de sala' : 'rechaza'}`, () => {
        const resultado = pedirTumbonas({
          consumidor: 'recovery-pro',
          cantidad,
          agenda: conTumbonasTomadas(tomadas),
        });

        expect(resultado.ok).toBe(alcanza);
        if (resultado.ok) {
          expect(resultado.valor).toHaveLength(cantidad);
          expect(resultado.valor.every((t) => t.ubicacion === 'sala-recovery')).toBe(true);
          expect(ids(resultado.valor)).not.toContain('RL-STANDALONE');
        } else {
          // (e) El código depende de si la standalone estaba libre o no: si no
          // había ninguna libre, no hay nada prohibido que explicar.
          const standaloneLibre = !tomadas.includes('RL-STANDALONE');
          expect(codigosDeRechazo(resultado)).toEqual([
            standaloneLibre ? 'TUMBONA_STANDALONE_PROHIBIDA' : 'SIN_TUMBONA_DISPONIBLE',
          ]);
        }
      });
    }
  }

  it('tres ocupantes no entran nunca: la sala tiene dos tumbonas y la standalone no cuenta', () => {
    const resultado = pedirTumbonas({ consumidor: 'recovery-pro', cantidad: 3 });
    expect(resultado.ok).toBe(false);
    expect(codigosDeRechazo(resultado)).toContain('TUMBONA_STANDALONE_PROHIBIDA');
  });

  it('con una sola tumbona en el centro, y standalone, Recovery Pro no puede reservar', () => {
    // El pool se reconfigura para dejar sólo la del área común: la única opción
    // disponible sigue siendo inutilizable para un gabinete.
    const soloStandalone = TUMBONAS.filter((t) => t.ubicacion === 'standalone');
    const resultado = pedirTumbonas({
      consumidor: 'recovery-pro',
      cantidad: 1,
      tumbonas: soloStandalone,
    });
    expect(resultado.ok).toBe(false);
    expect(codigosDeRechazo(resultado)).toEqual(['TUMBONA_STANDALONE_PROHIBIDA']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(b) Un consumidor externo prefiere la standalone y recién después las de la sala', () => {
  it('con el pool entero libre toma la standalone', () => {
    const resultado = pedirTumbonas({ consumidor: 'externo', cantidad: 1 });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(ids(resultado.valor)).toEqual(['RL-STANDALONE']);
  });

  it('pidiendo dos, la standalone va primera y la sala completa', () => {
    const resultado = pedirTumbonas({ consumidor: 'externo', cantidad: 2 });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(ids(resultado.valor)).toEqual(['RL-STANDALONE', 'RL-SALA-1']);
  });

  it('pidiendo las tres, el orden es standalone y después la sala en orden', () => {
    const resultado = pedirTumbonas({ consumidor: 'externo', cantidad: 3 });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(ids(resultado.valor)).toEqual(['RL-STANDALONE', 'RL-SALA-1', 'RL-SALA-2']);
  });

  it('con la standalone tomada baja a la sala, que es lo que la preferencia buscaba evitar', () => {
    const resultado = pedirTumbonas({
      consumidor: 'externo',
      cantidad: 1,
      agenda: conTumbonasTomadas(['RL-STANDALONE']),
    });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(ids(resultado.valor)).toEqual(['RL-SALA-1']);
  });

  it('con la standalone y la primera de sala tomadas, cae en la segunda de sala', () => {
    const resultado = pedirTumbonas({
      consumidor: 'externo',
      cantidad: 1,
      agenda: conTumbonasTomadas(['RL-STANDALONE', 'RL-SALA-1']),
    });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(ids(resultado.valor)).toEqual(['RL-SALA-2']);
  });

  it('la preferencia es por ubicación, no por posición: la sala figura primera en la lista', () => {
    // Control de que el orden devuelto no es simplemente el orden del arreglo de
    // unidades, que empieza por las de sala.
    expect(ids(TUMBONAS)[0]).toBe('RL-SALA-1');
    const resultado = pedirTumbonas({ consumidor: 'externo', cantidad: 1 });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(ids(resultado.valor)).toEqual(['RL-STANDALONE']);
  });

  it('un externo puede vaciar el pool y dejar a Recovery Pro sin sala', () => {
    // La preferencia mitiga el conflicto pero no lo impide: si el externo pide
    // las tres, la sala queda sin nada. Es una consecuencia buscada del modelo.
    const externo = pedirTumbonas({ consumidor: 'externo', cantidad: 3 });
    expect(externo.ok).toBe(true);
    if (!externo.ok) return;

    const gabinete = pedirTumbonas({
      consumidor: 'recovery-pro',
      cantidad: 1,
      agenda: conTumbonasTomadas(ids(externo.valor)),
    });
    expect(gabinete.ok).toBe(false);
    expect(codigosDeRechazo(gabinete)).toEqual(['SIN_TUMBONA_DISPONIBLE']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(c) Pedir cero tumbonas es una petición válida y vacía', () => {
  it('devuelve la lista vacía sin rechazar', () => {
    const resultado = pedirTumbonas({ consumidor: 'externo', cantidad: 0 });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.valor).toEqual([]);
  });

  it('con el pool entero tomado tampoco falla: cero tumbonas siempre están', () => {
    const resultado = pedirTumbonas({
      consumidor: 'recovery-pro',
      cantidad: 0,
      agenda: conTumbonasTomadas(['RL-SALA-1', 'RL-SALA-2', 'RL-STANDALONE']),
    });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.valor).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(d) Pedir más tumbonas de las que hay se rechaza contando las que quedan', () => {
  it('un externo que pide cuatro con tres libres: SIN_TUMBONA_DISPONIBLE con el detalle', () => {
    const resultado = pedirTumbonas({ consumidor: 'externo', cantidad: 4 });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;

    expect(codigosDeRechazo(resultado)).toEqual(['SIN_TUMBONA_DISPONIBLE']);
    expect(resultado.rechazos[0]?.detalle).toEqual({
      solicitadas: 4,
      disponibles: 3,
      consumidor: 'externo',
      ventana: '10:00–10:30',
    });
  });

  it('el mensaje dice cuántas quedan, que es lo que recepción necesita contestar', () => {
    const resultado = pedirTumbonas({
      consumidor: 'externo',
      cantidad: 2,
      agenda: conTumbonasTomadas(['RL-SALA-1', 'RL-SALA-2']),
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.rechazos[0]?.mensaje).toContain('quedan 1');
    expect(resultado.rechazos[0]?.mensaje).toContain('10:00–10:30');
  });

  it('la ventana del detalle es la del pedido, no la del turno completo', () => {
    const resultado = pedirTumbonas({
      consumidor: 'externo',
      cantidad: 4,
      inicio: lunes(15, 30),
      fin: lunes(16, 0),
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.rechazos[0]?.detalle).toMatchObject({ ventana: '15:30–16:00' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(e) TUMBONA_STANDALONE_PROHIBIDA se emite sólo si había una standalone libre', () => {
  it('Recovery Pro con la sala llena y la standalone libre: prohibida, con regla R-07', () => {
    const resultado = pedirTumbonas({
      consumidor: 'recovery-pro',
      cantidad: 1,
      agenda: conTumbonasTomadas(['RL-SALA-1', 'RL-SALA-2']),
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;

    expect(codigosDeRechazo(resultado)).toEqual(['TUMBONA_STANDALONE_PROHIBIDA']);
    expect(resultado.rechazos[0]?.regla).toBe('R-07');
    // El mensaje tiene que explicar por qué se rechaza algo que desde el
    // mostrador parece disponible.
    expect(resultado.rechazos[0]?.mensaje).toMatch(/gabinete privado/i);
    expect(resultado.rechazos[0]?.detalle).toMatchObject({
      solicitadas: 1,
      standaloneLibres: 1,
      ventana: '10:00–10:30',
    });
  });

  it('Recovery Pro con el pool entero tomado: no hay nada prohibido, simplemente no hay', () => {
    const resultado = pedirTumbonas({
      consumidor: 'recovery-pro',
      cantidad: 1,
      agenda: conTumbonasTomadas(['RL-SALA-1', 'RL-SALA-2', 'RL-STANDALONE']),
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;

    expect(codigosDeRechazo(resultado)).toEqual(['SIN_TUMBONA_DISPONIBLE']);
    expect(resultado.rechazos[0]?.detalle).toEqual({
      solicitadas: 1,
      disponibles: 0,
      consumidor: 'recovery-pro',
      ventana: '10:00–10:30',
    });
  });

  it('Recovery Pro pidiendo dos con una de sala libre y la standalone tomada: SIN_TUMBONA_DISPONIBLE', () => {
    const resultado = pedirTumbonas({
      consumidor: 'recovery-pro',
      cantidad: 2,
      agenda: conTumbonasTomadas(['RL-SALA-2', 'RL-STANDALONE']),
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(codigosDeRechazo(resultado)).toEqual(['SIN_TUMBONA_DISPONIBLE']);
    expect(resultado.rechazos[0]?.detalle).toMatchObject({ disponibles: 1 });
  });

  it('un externo nunca recibe TUMBONA_STANDALONE_PROHIBIDA, aunque falten tumbonas', () => {
    for (const tomadas of ESTADOS_DEL_POOL) {
      const resultado = pedirTumbonas({
        consumidor: 'externo',
        cantidad: 3,
        agenda: conTumbonasTomadas(tomadas),
      });
      if (resultado.ok) continue;
      expect(codigosDeRechazo(resultado)).not.toContain('TUMBONA_STANDALONE_PROHIBIDA');
    }
  });

  // BUG (no lo arreglo, sólo lo expongo): el detalle de
  // TUMBONA_STANDALONE_PROHIBIDA publica la clave con un error de tipeo,
  // `librasEnSala` en vez de `libresEnSala`
  // (src/motor-agenda/agenda/pool-tumbonas.ts:92). El detalle es contrato de
  // cara al app de recepción, así que la clave importa.
  it('el detalle nombra `libresEnSala`', () => {
    const resultado = pedirTumbonas({
      consumidor: 'recovery-pro',
      cantidad: 1,
      agenda: conTumbonasTomadas(['RL-SALA-1', 'RL-SALA-2']),
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.rechazos[0]?.detalle).toHaveProperty('libresEnSala', 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(f) evaluarDisponibilidad distingue los tres motivos', () => {
  const MULTI = unidad('HBOT-MULTI');
  const IHHT_1 = unidad('IHHT-1');

  it('libre: nadie tomó la unidad en esa ventana', () => {
    const motivo = evaluarDisponibilidad(AGENDA_VACIA, MULTI, lunes(10), lunes(11), 1);
    expect(motivo).toEqual({ tipo: 'libre' });
    expect(estaDisponible(AGENDA_VACIA, MULTI, lunes(10), lunes(11), 1)).toBe(true);
  });

  it('libre también cuando la ventana coincide y sobran plazas: es R-06 sumándose a la tanda', () => {
    const agenda = agendaCon(
      ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 2),
    );
    const motivo = evaluarDisponibilidad(agenda, MULTI, lunes(10), lunes(11), 3);
    expect(motivo).toEqual({ tipo: 'libre' });
  });

  it('ventana-distinta: hay solapamiento pero la ventana no es la misma, y devuelve con qué choca', () => {
    const previa = ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 1);
    const motivo = evaluarDisponibilidad(agendaCon(previa), MULTI, lunes(10, 30), lunes(11, 30), 1);
    expect(motivo.tipo).toBe('ventana-distinta');
    if (motivo.tipo !== 'ventana-distinta') return;
    expect(motivo.choca).toBe(previa);
  });

  it('sin-plazas: la ventana es idéntica pero la unidad ya está llena', () => {
    const agenda = agendaCon(
      ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 6),
    );
    const motivo = evaluarDisponibilidad(agenda, MULTI, lunes(10), lunes(11), 1);
    expect(motivo).toEqual({ tipo: 'sin-plazas', ocupadas: 6, capacidad: 6 });
  });

  it('sin-plazas suma las tandas parciales que ya comparten la ventana', () => {
    const agenda = agendaCon(
      ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 4),
      ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 1),
    );
    // Quedan 1 de 6: entra una persona, no entran dos.
    expect(evaluarDisponibilidad(agenda, MULTI, lunes(10), lunes(11), 1)).toEqual({ tipo: 'libre' });
    expect(evaluarDisponibilidad(agenda, MULTI, lunes(10), lunes(11), 2)).toEqual({
      tipo: 'sin-plazas',
      ocupadas: 5,
      capacidad: 6,
    });
  });

  it('sobre una unidad de capacidad 1 la misma ventana ya es sin-plazas', () => {
    const agenda = agendaCon(ocuparPlazas('IHHT-1', 'ihht', lunes(10), lunes(10, 30), 1));
    expect(evaluarDisponibilidad(agenda, IHHT_1, lunes(10), lunes(10, 30), 1)).toEqual({
      tipo: 'sin-plazas',
      ocupadas: 1,
      capacidad: 1,
    });
  });

  it('las ocupaciones de otra unidad no cuentan: se filtra por unidadId', () => {
    const agenda = agendaCon(ocuparPlazas('IHHT-2', 'ihht', lunes(10), lunes(10, 30), 1));
    expect(evaluarDisponibilidad(agenda, IHHT_1, lunes(10), lunes(10, 30), 1)).toEqual({
      tipo: 'libre',
    });
  });

  it('una ocupación que no se superpone no cuenta, aunque sea de la misma unidad', () => {
    const agenda = agendaCon(ocuparPlazas('IHHT-1', 'ihht', lunes(8), lunes(8, 30), 1));
    expect(evaluarDisponibilidad(agenda, IHHT_1, lunes(10), lunes(10, 30), 1)).toEqual({
      tipo: 'libre',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(g) Compartir una unidad exige ventana idéntica, no simplemente plazas libres', () => {
  const MULTI = unidad('HBOT-MULTI');

  it('una tanda de 10:00 a 11:00 y otra de 10:30 a 11:30 chocan aunque sobren cinco plazas', () => {
    // Una cámara multiplaza se presuriza como una sola sesión: no hay forma de
    // que alguien entre a mitad de la presurización.
    const agenda = agendaCon(
      ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 1),
    );
    const motivo = evaluarDisponibilidad(agenda, MULTI, lunes(10, 30), lunes(11, 30), 1);
    expect(motivo.tipo).toBe('ventana-distinta');
    expect(estaDisponible(agenda, MULTI, lunes(10, 30), lunes(11, 30), 1)).toBe(false);
  });

  it('mismo inicio y distinto fin tampoco es la misma ventana', () => {
    const agenda = agendaCon(
      ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 1),
    );
    expect(evaluarDisponibilidad(agenda, MULTI, lunes(10), lunes(10, 30), 1).tipo).toBe(
      'ventana-distinta',
    );
  });

  it('distinto inicio y mismo fin tampoco', () => {
    const agenda = agendaCon(
      ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 1),
    );
    expect(evaluarDisponibilidad(agenda, MULTI, lunes(10, 30), lunes(11), 1).tipo).toBe(
      'ventana-distinta',
    );
  });

  it('una ventana contenida dentro de otra tampoco comparte', () => {
    const agenda = agendaCon(
      ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 1),
    );
    expect(evaluarDisponibilidad(agenda, MULTI, lunes(10, 15), lunes(10, 45), 1).tipo).toBe(
      'ventana-distinta',
    );
  });

  it('la ventana idéntica sí comparte, y ése es el único camino', () => {
    const agenda = agendaCon(
      ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 1),
    );
    expect(evaluarDisponibilidad(agenda, MULTI, lunes(10), lunes(11), 5)).toEqual({ tipo: 'libre' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(h) Los intervalos son semiabiertos: tocarse en el borde no es superponerse', () => {
  const IHHT_1 = unidad('IHHT-1');

  it('una reserva que termina 10:30 no bloquea la que empieza 10:30', () => {
    const agenda = agendaCon(ocuparPlazas('IHHT-1', 'ihht', lunes(10), lunes(10, 30), 1));
    expect(evaluarDisponibilidad(agenda, IHHT_1, lunes(10, 30), lunes(11), 1)).toEqual({
      tipo: 'libre',
    });
  });

  it('y al revés: la que empieza 10:30 no bloquea la que termina 10:30', () => {
    const agenda = agendaCon(ocuparPlazas('IHHT-1', 'ihht', lunes(10, 30), lunes(11), 1));
    expect(evaluarDisponibilidad(agenda, IHHT_1, lunes(10), lunes(10, 30), 1)).toEqual({
      tipo: 'libre',
    });
  });

  it('un solo minuto de solapamiento sí bloquea', () => {
    const agenda = agendaCon(ocuparPlazas('IHHT-1', 'ihht', lunes(10), lunes(10, 31), 1));
    expect(evaluarDisponibilidad(agenda, IHHT_1, lunes(10, 30), lunes(11), 1).tipo).toBe(
      'ventana-distinta',
    );
  });

  it('el pool respeta el mismo borde: dos tandas de tumbona consecutivas usan la misma unidad', () => {
    const primera = pedirTumbonas({ consumidor: 'externo', cantidad: 1 });
    expect(primera.ok).toBe(true);
    if (!primera.ok) return;

    const segunda = pedirTumbonas({
      consumidor: 'externo',
      cantidad: 1,
      inicio: lunes(10, 30),
      fin: lunes(11, 0),
      agenda: conTumbonasTomadas(ids(primera.valor)),
    });
    expect(segunda.ok).toBe(true);
    if (!segunda.ok) return;
    expect(ids(segunda.valor)).toEqual(['RL-STANDALONE']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(i) contarUnidadesLibres y unidadesDisponibles', () => {
  const PUESTOS_IHHT = unidadesDe('ihht');

  it('con la agenda vacía están libres todas las unidades, en el orden recibido', () => {
    expect(ids(unidadesDisponibles(AGENDA_VACIA, TUMBONAS, lunes(10), lunes(10, 30), 1))).toEqual([
      'RL-SALA-1',
      'RL-SALA-2',
      'RL-STANDALONE',
    ]);
    expect(contarUnidadesLibres(AGENDA_VACIA, TUMBONAS, lunes(10), lunes(10, 30))).toBe(3);
  });

  it('descuenta las tomadas y conserva el orden de las que quedan', () => {
    const agenda = conTumbonasTomadas(['RL-SALA-1']);
    expect(ids(unidadesDisponibles(agenda, TUMBONAS, lunes(10), lunes(10, 30), 1))).toEqual([
      'RL-SALA-2',
      'RL-STANDALONE',
    ]);
    expect(contarUnidadesLibres(agenda, TUMBONAS, lunes(10), lunes(10, 30))).toBe(2);
  });

  it('el conteo es por ventana: fuera de ella el pool vuelve a estar entero', () => {
    const agenda = conTumbonasTomadas(['RL-SALA-1', 'RL-SALA-2', 'RL-STANDALONE']);
    expect(contarUnidadesLibres(agenda, TUMBONAS, lunes(10), lunes(10, 30))).toBe(0);
    expect(contarUnidadesLibres(agenda, TUMBONAS, lunes(10, 30), lunes(11))).toBe(3);
  });

  it('con la lista vacía el conteo es cero y no rompe', () => {
    expect(contarUnidadesLibres(AGENDA_VACIA, [], lunes(10), lunes(10, 30))).toBe(0);
    expect(unidadesDisponibles(AGENDA_VACIA, [], lunes(10), lunes(10, 30), 1)).toEqual([]);
  });

  it('unidadesDisponibles filtra por las plazas pedidas, no sólo por «está tomada»', () => {
    const multiplazas = unidadesDe('hbot-multiplaza');
    const agenda = agendaCon(
      ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 4),
    );
    expect(unidadesDisponibles(agenda, multiplazas, lunes(10), lunes(11), 2)).toHaveLength(1);
    expect(unidadesDisponibles(agenda, multiplazas, lunes(10), lunes(11), 3)).toHaveLength(0);
  });

  it('contarUnidadesLibres cuenta unidades para una persona, no plazas sueltas', () => {
    // Una multiplaza con cinco de sus seis plazas tomadas sigue siendo «una
    // unidad libre»: el número que interesa al encadenar es cuántas unidades
    // admiten a alguien más, no cuánta capacidad total sobra.
    const multiplazas = unidadesDe('hbot-multiplaza');
    const agenda = agendaCon(
      ocuparPlazas('HBOT-MULTI', 'hbot-multiplaza', lunes(10), lunes(11), 5),
    );
    expect(contarUnidadesLibres(agenda, multiplazas, lunes(10), lunes(11))).toBe(1);
  });

  it('es el número que decide un encadenamiento: cuántos puestos IHHT quedan a las 11:00', () => {
    expect(PUESTOS_IHHT).toHaveLength(2);
    const agenda = agendaCon(ocuparPlazas('IHHT-1', 'ihht', lunes(11), lunes(11, 30), 1));
    expect(contarUnidadesLibres(agenda, PUESTOS_IHHT, lunes(11), lunes(11, 30))).toBe(1);
  });

  it('conOcupaciones no muta la agenda que recibe', () => {
    const original = conTumbonasTomadas(['RL-SALA-1']);
    const ampliada = conOcupaciones(original, [ocupar('RL-SALA-2', lunes(10), 30)]);

    expect(original.ocupaciones).toHaveLength(1);
    expect(ampliada.ocupaciones).toHaveLength(2);
    expect(contarUnidadesLibres(original, TUMBONAS, lunes(10), lunes(10, 30))).toBe(2);
    expect(contarUnidadesLibres(ampliada, TUMBONAS, lunes(10), lunes(10, 30))).toBe(1);
  });

  it('AGENDA_VACIA no acumula nada entre llamadas', () => {
    conOcupaciones(AGENDA_VACIA, [ocupar('RL-SALA-1', lunes(10), 30)]);
    expect(AGENDA_VACIA.ocupaciones).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('(j) Saturación real: cuántos BIO ENERGY entran a las 10:00', () => {
  // BIO ENERGY = IHHT 10:00–10:30 (el cliente sale a los 25) → tumbona
  // 10:30–11:00. Cada reserva individual consume un puesto IHHT y una tumbona,
  // en ventanas distintas. Con 2 puestos y 3 tumbonas, el cuello de botella a
  // las 10:00 es el IHHT y no el pool.

  function bioEnergy(motor: ReturnType<typeof motorDePrueba>, inicio: Date, agenda: AgendaOcupada) {
    return expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_ENERGY' },
      inicio,
      ocupantes: 1,
      agenda,
    });
  }

  it('entran exactamente dos, y el tercero se cae por el IHHT con una tumbona todavía libre', () => {
    const motor = motorDePrueba();
    let agenda: AgendaOcupada = AGENDA_VACIA;

    const puestosIhht = motor.recursoPorTipo.get('ihht')?.unidades ?? [];
    const tumbonas = motor.recursoPorTipo.get('tumbona-red-light')?.unidades ?? [];
    expect(puestosIhht).toHaveLength(2);
    expect(tumbonas).toHaveLength(3);

    for (const esperado of ['IHHT-1', 'IHHT-2']) {
      const plan = bioEnergy(motor, lunes(10), agenda);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.valor.tramos[0]?.unidades).toEqual([esperado]);
      agenda = conOcupaciones(agenda, plan.valor.ocupaciones);
    }

    // Las dos reservas tomaron la standalone y una de sala, en ese orden.
    expect(contarUnidadesLibres(agenda, tumbonas, lunes(10, 30), lunes(11))).toBe(1);
    expect(contarUnidadesLibres(agenda, puestosIhht, lunes(10), lunes(10, 30))).toBe(0);

    const tercero = bioEnergy(motor, lunes(10), agenda);
    expect(tercero.ok).toBe(false);
    // El pool tiene una tumbona libre: lo que falta es el puesto de IHHT.
    expect(codigosDeRechazo(tercero)).toEqual(['RECURSO_OCUPADO']);
    if (tercero.ok) return;
    expect(tercero.rechazos[0]?.detalle).toMatchObject({
      recurso: 'ihht',
      lugaresDisponibles: 0,
      ventana: '10:00–10:30',
    });
  });

  it('el cuarto, con cuatro puestos IHHT, se cae recién en el pool de tumbonas', () => {
    // Mismo escenario con el cuello de botella corrido: cuatro puestos IHHT
    // dejan que el límite lo ponga el pool de tres tumbonas.
    const motor = motorDePrueba({ puestosIhht: 4 });
    let agenda: AgendaOcupada = AGENDA_VACIA;
    const tumbonas = motor.recursoPorTipo.get('tumbona-red-light')?.unidades ?? [];

    const asignadas: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const plan = bioEnergy(motor, lunes(10), agenda);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const tumbona = plan.valor.tramos.find((t) => t.tipoRecurso === 'tumbona-red-light');
      expect(tumbona).toBeDefined();
      asignadas.push(...(tumbona?.unidades ?? []));
      agenda = conOcupaciones(agenda, plan.valor.ocupaciones);
    }

    // La preferencia se ve en el orden: primero la standalone, después la sala.
    expect(asignadas).toEqual(['RL-STANDALONE', 'RL-SALA-1', 'RL-SALA-2']);
    expect(contarUnidadesLibres(agenda, tumbonas, lunes(10, 30), lunes(11))).toBe(0);

    const cuarto = bioEnergy(motor, lunes(10), agenda);
    expect(cuarto.ok).toBe(false);
    expect(codigosDeRechazo(cuarto)).toEqual(['SIN_TUMBONA_DISPONIBLE']);
    if (cuarto.ok) return;
    expect(cuarto.rechazos[0]?.detalle).toMatchObject({
      solicitadas: 1,
      disponibles: 0,
      consumidor: 'externo',
      ventana: '10:30–11:00',
    });
  });

  it('la saturación es de ventana, no de día: a las 10:30 vuelve a haber lugar', () => {
    const motor = motorDePrueba();
    let agenda: AgendaOcupada = AGENDA_VACIA;

    for (let i = 0; i < 2; i += 1) {
      const plan = bioEnergy(motor, lunes(10), agenda);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      agenda = conOcupaciones(agenda, plan.valor.ocupaciones);
    }

    // El IHHT se libera a las 10:30 y la tumbona de este turno recién se usa a
    // las 11:00, cuando las dos anteriores ya la soltaron.
    const tercero = bioEnergy(motor, lunes(10, 30), agenda);
    expect(tercero.ok).toBe(true);
    if (!tercero.ok) return;
    expect(tercero.valor.tramos[1]?.inicio).toEqual(lunes(11, 0));
  });

  it('dos BIO ENERGY a las 10:00 dejan un Recovery Pro de las 10:00 sin sala', () => {
    // Consecuencia cruzada del pool compartido: los dos combos toman la
    // standalone y una de sala entre 10:30 y 11:00, que es justo la ventana de
    // luz roja de un gabinete que arrancó a las 10:00 (minutos 28 a 48).
    const motor = motorDePrueba();
    let agenda: AgendaOcupada = AGENDA_VACIA;

    for (let i = 0; i < 2; i += 1) {
      const plan = bioEnergy(motor, lunes(10), agenda);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      agenda = conOcupaciones(agenda, plan.valor.ocupaciones);
    }

    const gabinete = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'RECOVERY_PRO' },
      inicio: lunes(10),
      ocupantes: 2,
      agenda,
    });
    expect(gabinete.ok).toBe(false);
    // Queda libre RL-SALA-2 pero hacen falta dos: la standalone está tomada, así
    // que no es el caso de la standalone prohibida.
    expect(codigosDeRechazo(gabinete)).toEqual(['SIN_TUMBONA_DISPONIBLE']);
  });
});
