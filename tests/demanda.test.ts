import { describe, it, expect } from 'vitest';
import {
  PEDIDO_MAX,
  agruparDemanda,
  normalizarPedido,
  validarPedido,
  type PedidoRegistrado,
} from '../src/lib/demanda.js';
import { basicADemanda, demandaABasic, CODIGO_DEMANDA_NO_DISPONIBLE } from '../src/fhir/demanda.js';
import { EXT, SYSTEM } from '../src/fhir/identifiers.js';

/**
 * Caso 11 del walk-in: alguien entra y pide algo que NO ofrecemos.
 *
 * Hasta hoy eso caía en "Otra cosa" del selector, sin texto libre: quedaba
 * registrado que alguien pidió algo, y nunca qué. O sea, el evento sin el dato
 * — y el dato es lo único valioso, porque ningún otro canal nos dice qué
 * producto nos están pidiendo y no vendemos.
 */

describe('normalizarPedido — juntar lo que es el mismo pedido', () => {
  it('mayúsculas, tildes y espacios de más no hacen filas distintas', () => {
    const formas = ['Nutricionista', 'nutricionista ', '  NUTRICIONISTA', 'nutricioniśta'];
    const claves = new Set(formas.map(normalizarPedido));
    expect(claves.size).toBe(1);
  });

  it('los signos de pregunta con los que se anota una consulta no cuentan', () => {
    expect(normalizarPedido('¿Nutricionista?')).toBe(normalizarPedido('nutricionista'));
  });

  it('la ñ se pisa a n: en el mostrador se escribe de las dos formas', () => {
    expect(normalizarPedido('masaje para niños')).toBe(normalizarPedido('masaje para ninos'));
  });

  it('pedidos distintos NO se juntan (no inventa sinónimos)', () => {
    expect(normalizarPedido('nutricionista')).not.toBe(normalizarPedido('kinesiologia'));
  });
});

describe('validarPedido — poca fricción, pero algo contable', () => {
  it('un pedido normal pasa y devuelve texto + clave', () => {
    const v = validarPedido('  Crioterapia de cuerpo entero ');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.texto).toBe('Crioterapia de cuerpo entero');
      expect(v.clave).toBe('crioterapia de cuerpo entero');
    }
  });

  it('vacío NO pasa: es exactamente el registro que teníamos antes (nada)', () => {
    for (const t of [undefined, '', '   ']) {
      expect(validarPedido(t).ok).toBe(false);
    }
  });

  it('ruido de un carácter tampoco: no se puede contar', () => {
    expect(validarPedido('x').ok).toBe(false);
    expect(validarPedido('¿?').ok).toBe(false);
  });

  it('una etiqueta, no la crónica de la charla', () => {
    expect(validarPedido('a'.repeat(PEDIDO_MAX + 1)).ok).toBe(false);
    expect(validarPedido('a'.repeat(PEDIDO_MAX)).ok).toBe(true);
  });

  it('el error dice qué hacer, no solo que está mal', () => {
    const v = validarPedido('');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error.length).toBeGreaterThan(10);
    }
  });
});

describe('agruparDemanda — el reporte que se lee a los tres meses', () => {
  const p = (texto: string, fechaISO?: string): PedidoRegistrado => ({ texto, fechaISO });

  it('cuenta las repeticiones aunque estén escritas distinto', () => {
    const r = agruparDemanda([p('Nutricionista'), p('nutricionista'), p('NUTRICIÓN')]);
    expect(r).toHaveLength(2);
    expect(r[0]?.n).toBe(2);
  });

  it('lo más pedido va primero: es la pregunta que se le hace a esta lista', () => {
    const r = agruparDemanda([
      p('kinesiologia'),
      p('nutricionista'),
      p('nutricionista'),
      p('nutricionista'),
      p('crioterapia'),
      p('crioterapia'),
    ]);
    expect(r.map((x) => x.n)).toEqual([3, 2, 1]);
    expect(r[0]?.etiqueta).toBe('nutricionista');
  });

  it('a igual cantidad, lo más reciente arriba', () => {
    const r = agruparDemanda([
      p('viejo', '2026-03-01'),
      p('viejo', '2026-03-02'),
      p('nuevo', '2026-08-10'),
      p('nuevo', '2026-08-12'),
    ]);
    expect(r[0]?.etiqueta).toBe('nuevo');
    expect(r[0]?.ultimaFechaISO).toBe('2026-08-12');
  });

  it('la etiqueta es la forma MÁS USADA, no la última que se tipeó', () => {
    const r = agruparDemanda([p('nutricionista'), p('nutricionista'), p('NUTRI', '2026-08-14')]);
    expect(r[0]?.etiqueta).toBe('nutricionista');
  });

  it('sin pedidos, lista vacía (y no una fila fantasma)', () => {
    expect(agruparDemanda([])).toEqual([]);
    expect(agruparDemanda([{ texto: '   ' }])).toEqual([]);
  });

  it('respeta la clave guardada: cambiar el normalizador no re-agrupa el pasado', () => {
    const r = agruparDemanda([
      { texto: 'Nutricionista', clave: 'clave-vieja' },
      { texto: 'nutricionista', clave: 'clave-vieja' },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]?.clave).toBe('clave-vieja');
  });

  it('el orden es determinístico con datos empatados', () => {
    const datos = [p('bbb'), p('aaa')];
    expect(agruparDemanda(datos)).toEqual(agruparDemanda([...datos].reverse()));
  });
});

describe('demandaABasic — dónde queda el pedido', () => {
  const entrada = {
    texto: 'Nutricionista',
    clave: 'nutricionista',
    pacienteRef: 'Patient/abc',
    registradoPorRef: 'Practitioner/rec1',
    fechaISO: '2026-08-14T18:30:00.000Z',
  };

  it('se guarda con su propio code: se lista sin mezclarse con la caja chica', () => {
    const b = demandaABasic(entrada);
    expect(b.code?.coding?.[0]).toEqual({ system: SYSTEM.demanda, code: CODIGO_DEMANDA_NO_DISPONIBLE });
    expect(b.code?.coding?.[0]?.system).not.toBe(SYSTEM.caja);
  });

  it('guarda el texto ORIGINAL (para entender) y la clave (para contar)', () => {
    const b = demandaABasic(entrada);
    expect(b.code?.text).toBe('Nutricionista');
    expect(b.extension?.find((e) => e.url === EXT.demandaClave)?.valueString).toBe('nutricionista');
  });

  it('queda apuntado a quién lo pidió: si algún día lo tenemos, hay a quién llamar', () => {
    expect(demandaABasic(entrada).subject?.reference).toBe('Patient/abc');
  });

  it('`created` es fecha (Basic.created es date, no dateTime)', () => {
    expect(demandaABasic(entrada).created).toBe('2026-08-14');
  });

  it('un autor que no sea Practitioner no se escribe: mejor sin autor que inválido', () => {
    expect(demandaABasic({ ...entrada, registradoPorRef: 'ClientApplication/x' }).author).toBeUndefined();
    expect(demandaABasic({ ...entrada, registradoPorRef: undefined }).author).toBeUndefined();
    expect(demandaABasic(entrada).author?.reference).toBe('Practitioner/rec1');
  });

  it('sin paciente igual se registra: el pedido vale aunque no deje datos', () => {
    const b = demandaABasic({ ...entrada, pacienteRef: undefined });
    expect(b.subject).toBeUndefined();
    expect(b.code?.text).toBe('Nutricionista');
  });

  it('ida y vuelta: lo que se guarda es lo que después se cuenta', () => {
    const leido = basicADemanda(demandaABasic(entrada));
    expect(leido).toBeDefined();
    expect(agruparDemanda([leido!])[0]).toMatchObject({ clave: 'nutricionista', etiqueta: 'Nutricionista', n: 1 });
  });

  it('un Basic de caja chica NO entra al reporte de demanda', () => {
    const caja = { resourceType: 'Basic' as const, code: { coding: [{ system: SYSTEM.caja, code: 'egreso' }], text: 'Café' } };
    expect(basicADemanda(caja)).toBeUndefined();
  });

  it('un registro viejo sin la extensión se agrupa igual (clave recalculada)', () => {
    const sinExt = { ...demandaABasic(entrada), extension: undefined };
    expect(basicADemanda(sinExt)?.clave).toBe('nutricionista');
  });
});
