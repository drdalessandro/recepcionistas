import { describe, expect, it } from 'vitest';
import {
  FAMILIAS_TB,
  ORDEN_FAMILIA,
  SERVICIOS,
  SERVICIOS_RETIRADOS,
  TODOS_LOS_SERVICIOS,
  getServicio,
} from '../src/config/catalogo.js';
import { buildActivityDefinition } from '../src/seed/builders.js';
import { EXT } from '../src/fhir/identifiers.js';

/**
 * Dos decisiones de Andrés (2026-09-11) con una trampa cada una.
 *
 * RETIRO. Lo que se retira no se borra: `getServicio` tira si el código no
 * existe y se llama sin `try` en los cobros y la clasificación de turnos, así
 * que borrar la entrada rompería cualquier turno histórico que la referencie.
 * Pero tampoco alcanza con sacarla de la lista: el seed hace upsert y NO borra,
 * así que el ActivityDefinition viejo se quedaría `active` en el servidor y el
 * portal lo seguiría ofreciendo. Tiene que publicarse como `retired`.
 *
 * FAMILIAS. Las seis viñetas de Terapias Biológicas reemplazan a 18 tarjetas
 * que repetían la misma bajada. El orden de las viñetas viaja al servidor
 * porque el portal no importa este archivo.
 */

const CODIGOS_RETIRADOS = [
  'MASAJE_DESCONTRACTURANTE',
  'COLIRIO_PLASMA',
  'COLIRIO_PLASMA_COAGULO',
  'CREMA_DERMATO',
  // Huérfanos desde julio: el Manual v9 volvió a una única sesión de IHHT y
  // estas dos variantes se sacaron del catálogo, pero siguieron `active` en
  // Medplum. El portal las ofrecía y al elegirlas tiraba "Servicio desconocido".
  'IHHT_EXPRESS',
  'IHHT_PREMIUM',
];

describe('catálogo · servicios retirados', () => {
  it.each(CODIGOS_RETIRADOS)('%s no se ofrece más', (codigo) => {
    expect(SERVICIOS.some((s) => s.codigo === codigo)).toBe(false);
  });

  it.each(CODIGOS_RETIRADOS)('%s SIGUE resolviendo (turnos y cobros históricos)', (codigo) => {
    expect(() => getServicio(codigo)).not.toThrow();
    expect(getServicio(codigo).retirado).toBe(true);
  });

  it('se publican como `retired`, no se omiten del seed', () => {
    // Omitirlos dejaría el recurso viejo `active` en el servidor: el seed no borra.
    for (const codigo of CODIGOS_RETIRADOS) {
      expect(buildActivityDefinition(getServicio(codigo)).status).toBe('retired');
    }
  });

  it('lo que se ofrece se publica `active`', () => {
    expect(buildActivityDefinition(getServicio('MASAJE_DEPORTIVO')).status).toBe('active');
  });

  it('el seed publica TODO: vigentes + retirados', () => {
    expect(TODOS_LOS_SERVICIOS).toHaveLength(SERVICIOS.length + SERVICIOS_RETIRADOS.length);
    expect(new Set(TODOS_LOS_SERVICIOS.map((s) => s.codigo)).size).toBe(TODOS_LOS_SERVICIOS.length);
  });

  it('ningún servicio que se ofrece está marcado retirado (y viceversa)', () => {
    expect(SERVICIOS.filter((s) => s.retirado)).toHaveLength(0);
    expect(SERVICIOS_RETIRADOS.filter((s) => !s.retirado)).toHaveLength(0);
  });
});

describe('catálogo · familias de Terapias Biológicas', () => {
  const tb = SERVICIOS.filter((s) => s.categoria === 'TERAPIA_BIOLOGICA');

  it('las seis viñetas de Andrés, en su orden', () => {
    expect([...FAMILIAS_TB]).toEqual([
      'Células Madre',
      'Exosomas',
      'Péptidos',
      'Lisado Plaquetario',
      'PRP',
      'Ácido Hialurónico',
    ]);
  });

  it('toda Terapia Biológica vigente cae en alguna viñeta', () => {
    // Una sin familia se mostraría suelta al lado de las viñetas: el caso que
    // dejaba la sección "eterna".
    expect(tb.filter((s) => !s.familia).map((s) => s.codigo)).toEqual([]);
  });

  it('las familias usadas son exactamente las seis declaradas', () => {
    expect([...new Set(tb.map((s) => s.familia))].sort()).toEqual([...FAMILIAS_TB].sort());
  });

  it('agrupa las 15 en 6 (antes eran 18 tarjetas sueltas)', () => {
    expect(tb).toHaveLength(15);
    expect(new Set(tb.map((s) => s.familia)).size).toBe(6);
  });

  it('el orden de la viñeta VIAJA al servidor: el portal no puede deducirlo', () => {
    const ext = buildActivityDefinition(getServicio('CELULAS_MADRE')).extension ?? [];
    expect(ext.find((e) => e.url === EXT.familia)?.valueString).toBe('Células Madre');
    expect(ext.find((e) => e.url === EXT.familiaOrden)?.valueInteger).toBe(1);
    const hialuronico = buildActivityDefinition(getServicio('AC_HIALURONICO_BPM')).extension ?? [];
    expect(hialuronico.find((e) => e.url === EXT.familiaOrden)?.valueInteger).toBe(6);
  });

  it('las Expansiones Celulares van bajo Células Madre', () => {
    for (const c of ['EXPANSION_10MM', 'EXPANSION_20MM', 'EXPANSION_30MM', 'EXPANSION_60MM']) {
      expect(getServicio(c).familia).toBe('Células Madre');
    }
  });

  it('un servicio sin familia no lleva las extensiones', () => {
    const ext = buildActivityDefinition(getServicio('MASAJE_DEPORTIVO')).extension ?? [];
    expect(ext.find((e) => e.url === EXT.familia)).toBeUndefined();
    expect(ext.find((e) => e.url === EXT.familiaOrden)).toBeUndefined();
  });

  it('ORDEN_FAMILIA cubre las seis, 1-based', () => {
    expect([...ORDEN_FAMILIA.values()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

/**
 * El IHHT que SÍ se ofrece es uno solo. Las variantes Express/Premium
 * vivieron dos meses huérfanas en Medplum —ofrecidas por el portal, rotas al
 * elegirlas— porque el seed no borra lo que se le saca del archivo. El test
 * fija las dos mitades: que quede una sola vigente, y que las otras dos sigan
 * publicándose (retiradas) en vez de desaparecer del seed.
 */
describe('catálogo · IHHT es una sola sesión (Manual v9)', () => {
  it('solo IHHT se ofrece', () => {
    expect(SERVICIOS.filter((s) => s.categoria === 'IHHT').map((s) => s.codigo)).toEqual(['IHHT']);
  });

  it('la sesión vigente es 30 min / USD 90', () => {
    const ihht = getServicio('IHHT');
    expect(ihht.duracionMin).toBe(30);
    expect(ihht.precioUSD).toBe(90);
  });

  it('las variantes viejas siguen resolviendo con lo que el servidor publicaba', () => {
    expect(getServicio('IHHT_EXPRESS').precioUSD).toBe(60);
    expect(getServicio('IHHT_PREMIUM').precioUSD).toBe(120);
  });
});
