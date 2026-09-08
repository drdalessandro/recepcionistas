import { describe, expect, it } from 'vitest';
import type { Coverage } from '@medplum/fhirtypes';
import { PROGRAMAS, getPrograma } from '../src/config/programas.js';
import { buildProgramaPlanDefinition } from '../src/seed/builders.js';
import { buildSeed } from '../src/seed/builders.js';
import { ACCESS_POLICIES } from '../src/fhir/access-policies.js';
import { EXT, SYSTEM } from '../src/fhir/identifiers.js';
import { estadoDeCoverage, esPlanBW } from '../src/fhir/coverage.js';

/**
 * Plan Bienestar 100 Días (handoff PB100D, 2026-09-06 + verificación en
 * producción del 2026-09-08). Dos cosas distintas se prueban acá:
 *  - los PERMISOS que desbloquean el piloto (sin ellos la paciente no puede
 *    marcar un día, que es la única escritura del programa);
 *  - que un programa NO se comporte como una membresía: vende tiempo, no
 *    sesiones, y el cron de cobro mensual no debe levantarlo por error.
 */

const policyPortal = ACCESS_POLICIES.find((p) => p.name === 'Paciente — Portal')!;
const entradas = (tipo: string) => (policyPortal.resource ?? []).filter((r) => r.resourceType === tipo);

describe('AccessPolicy del portal — lo que desbloquea el PB100D', () => {
  it('Task: lectura amplia MÁS una entrada escribible acotada al CodeSystem del programa', () => {
    const tasks = entradas('Task');
    // La readonly amplia se conserva: solicitudes, controles, etc.
    expect(tasks.some((t) => t.readonly === true && t.criteria === 'Task?patient=%patient')).toBe(true);
    // Y la escribible, acotada por code. Sin `code`, la paciente podría editar
    // CUALQUIER Task suya, incluidas las que el equipo usa como bandeja.
    const escribible = tasks.find((t) => !t.readonly);
    expect(escribible, 'falta la entrada Task escribible: sin ella no se puede marcar un día').toBeDefined();
    expect(escribible!.criteria).toContain(`code=${SYSTEM.biowellnessPlan}|`);
    expect(escribible!.criteria).toContain('patient=%patient');
  });

  it('Goal y NutritionOrder: lectura de lo propio (hoy daban 403)', () => {
    for (const [tipo, criteria] of [
      ['Goal', 'Goal?subject=%patient'],
      ['NutritionOrder', 'NutritionOrder?patient=%patient'],
    ] as const) {
      const e = entradas(tipo);
      expect(e, `falta ${tipo} en la policy del portal`).toHaveLength(1);
      expect(e[0]!.readonly).toBe(true);
      expect(e[0]!.criteria).toBe(criteria);
    }
  });

  it('ValueSet y CodeSystem: terminología en solo lectura para el renderer', () => {
    for (const tipo of ['ValueSet', 'CodeSystem'] as const) {
      const e = entradas(tipo);
      expect(e, `falta ${tipo}`).toHaveLength(1);
      expect(e[0]!.readonly).toBe(true);
    }
  });

  it('la escritura del paciente sigue acotada: nada quedó abierto sin criteria', () => {
    // Red de seguridad del cambio: una entrada escribible SIN criteria le daría
    // al paciente acceso a los recursos de TODOS. Binary es la excepción
    // conocida y preexistente (adjuntos de mensajes/consentimientos).
    const abiertas = (policyPortal.resource ?? []).filter((r) => !r.readonly && !r.criteria);
    expect(abiertas.map((r) => r.resourceType)).toEqual(['Binary']);
  });

  it('existe la policy de Kinesiología y no puede editar el plan ni las metas', () => {
    const kine = ACCESS_POLICIES.find((p) => p.name === 'Kinesiología — Clínico limitado');
    expect(kine, 'falta la policy de kinesiología (handoff §4)').toBeDefined();
    const porTipo = new Map((kine!.resource ?? []).map((r) => [r.resourceType, r]));
    expect(porTipo.get('CarePlan')?.readonly).toBe(true);
    expect(porTipo.get('Goal')?.readonly).toBe(true);
    // Y sí escribe lo suyo.
    for (const tipo of ['Observation', 'Task', 'QuestionnaireResponse']) {
      expect(porTipo.get(tipo)?.readonly).toBeUndefined();
    }
  });
});

describe('Catálogo de programas', () => {
  it('se publican como PlanDefinition con type "programa", NO "membership"', () => {
    for (const p of PROGRAMAS) {
      const pd = buildProgramaPlanDefinition(p.codigo);
      // El portal deriva variantes de membresía de los sufijos del código y
      // exige `tier`: publicarlo como membership rompería esa derivación.
      expect(pd.type?.text).toBe('programa');
      expect(pd.status).toBe('active');
      expect(pd.identifier?.[0]?.system).toBe(SYSTEM.programaCodigo);
      expect(pd.identifier?.[0]?.value).toBe(p.codigo);
      // Título, bajada y precio salen del recurso: el portal no hardcodea nada.
      expect(pd.title).toBe(p.nombre);
      expect(pd.description).toBe(p.descripcion);
      expect(pd.extension?.find((e) => e.url === EXT.precioUsd)?.valueDecimal).toBe(p.precioUSD);
      expect(pd.extension?.find((e) => e.url === EXT.orden)?.valueInteger).toBe(p.orden);
      // Un programa no vende sesiones: no puede llevar contador ni tier.
      expect(pd.extension?.some((e) => e.url === EXT.sesionesMes || e.url === EXT.tier)).toBe(false);
    }
  });

  it('el seed los incluye y los códigos no chocan con membresías ni paquetes', () => {
    const seed = buildSeed();
    expect(seed.programas).toHaveLength(PROGRAMAS.length);
    const otros = new Set([...seed.membresias, ...seed.paquetes, ...seed.combos].map((r) => r.name));
    for (const p of seed.programas) {
      expect(otros.has(p.name!), `código repetido: ${p.name}`).toBe(false);
    }
  });

  it('getPrograma falla fuerte con un código desconocido', () => {
    expect(() => getPrograma('NO_EXISTE')).toThrow(/desconocido/i);
  });
});

describe('Coverage de programa — vende tiempo, no sesiones', () => {
  const coverturaPrograma: Coverage = {
    resourceType: 'Coverage',
    status: 'active',
    beneficiary: { reference: 'Patient/p1' },
    payor: [{ reference: 'Patient/p1' }],
    extension: [
      { url: EXT.tipoCobertura, valueCode: 'programa' },
      { url: EXT.planCodigo, valueString: 'PB100D_PREMIUM_MENSUAL' },
    ],
  };

  it('se reconoce como plan BW y su tipo es "programa" (no membresía con 0 sesiones)', () => {
    expect(esPlanBW(coverturaPrograma)).toBe(true);
    const estado = estadoDeCoverage(coverturaPrograma);
    expect(estado.tipo).toBe('programa');
    expect(estado.activo).toBe(true);
  });

  it('el cron de cobro mensual NO lo levanta: filtra por tipo === "membresia"', () => {
    // `bw-cobro-membresias` hace `if (estado.tipo !== 'membresia') continue`.
    // Si un programa se guardara sin `tipo-cobertura`, el default es
    // 'membresia' y el cron intentaría facturarlo contra el catálogo de
    // membresías — `getMembresia` tiraría y cortaría la corrida del mes.
    expect(estadoDeCoverage(coverturaPrograma).tipo).not.toBe('membresia');
    // Sin la extensión, en cambio, SÍ caería en membresía: por eso el alta de
    // un programa debe escribir `tipo-cobertura` siempre.
    const sinTipo: Coverage = { ...coverturaPrograma, extension: [{ url: EXT.planCodigo, valueString: 'X' }] };
    expect(estadoDeCoverage(sinTipo).tipo).toBe('membresia');
  });
});

// ---------------------------------------------------------------------------
// Alta y cobro del programa (handoff §2, segunda mitad)
// ---------------------------------------------------------------------------

describe('pricing — un programa se cotiza del catálogo, sin descuentos', () => {
  it('cada programa cotiza su precio de lista en USD', async () => {
    const { calcularCobro } = await import('../src/lib/pricing.js');
    for (const p of PROGRAMAS) {
      const r = calcularCobro([{ tipo: 'programa', codigo: p.codigo }], { tc: 1000 });
      expect(r.lineas[0]!.subtotalUSD, p.codigo).toBe(p.precioUSD);
      expect(r.lineas[0]!.descripcion).toBe(p.nombre);
    }
  });

  it('el 20% de Founding Member NO aplica: es de sueltas y paquetes (R-09)', async () => {
    const { calcularCobro } = await import('../src/lib/pricing.js');
    const conFm = calcularCobro([{ tipo: 'programa', codigo: 'PB100D_PREMIUM_100D', fm: true }], { tc: 1000 });
    const sinFm = calcularCobro([{ tipo: 'programa', codigo: 'PB100D_PREMIUM_100D' }], { tc: 1000 });
    expect(conFm.totalARS).toBe(sinFm.totalARS);
    expect(conFm.lineas[0]!.descuentoPct).toBeUndefined();
  });
});

describe('bw-asignar-plan — alta de un programa', () => {
  /** Fake mínimo: captura los recursos creados. */
  function fakeMedplum() {
    const creados: Array<Record<string, unknown>> = [];
    const medplum = {
      searchOne: async () => undefined,
      searchResources: async () => [],
      readResource: async () => ({ resourceType: 'Patient', id: 'p1', telecom: [] }),
      createResource: async (r: Record<string, unknown>) => {
        creados.push(r);
        return { ...r, id: `x${creados.length}` };
      },
      updateResource: async (r: Record<string, unknown>) => r,
    } as never;
    return { medplum, creados };
  }
  const evento = (input: unknown) => ({ input, secrets: {} }) as never;

  it('el Coverage NO lleva contador de sesiones: un programa vende tiempo', async () => {
    const { handler } = await import('../src/bots/asignar-plan.js');
    const { medplum, creados } = fakeMedplum();
    const r = await handler(medplum, evento({
      pacienteRef: 'Patient/p1',
      tipo: 'programa',
      planCodigo: 'PB100D_PREMIUM_MENSUAL',
      medioPago: 'efectivo',
      tc: 1000,
    }));

    expect(r.ok).toBe(true);
    const cov = creados.find((c) => c.resourceType === 'Coverage') as unknown as Coverage | undefined;
    expect(cov, 'no se creó el Coverage').toBeDefined();
    const urls = (cov!.extension ?? []).map((x) => x.url);
    expect(urls).toContain(EXT.tipoCobertura);
    expect(urls).not.toContain(EXT.sesionesMes);
    expect(urls).not.toContain(EXT.sesionesTotal);
    expect(cov!.extension?.find((x) => x.url === EXT.tipoCobertura)?.valueCode).toBe('programa');
    // Y el portal lo reconoce como plan BW (lo muestra en "Mi cuenta").
    expect(esPlanBW(cov!)).toBe(true);
    expect(estadoDeCoverage(cov!).tipo).toBe('programa');
  });

  it('el mensual no vence; el de 100 días termina solo', async () => {
    const { handler } = await import('../src/bots/asignar-plan.js');
    const base = { pacienteRef: 'Patient/p1', tipo: 'programa', medioPago: 'efectivo', tc: 1000, desde: '2026-09-08T12:00:00-03:00' };

    const mensual = fakeMedplum();
    await handler(mensual.medplum, evento({ ...base, planCodigo: 'PB100D_PREMIUM_MENSUAL' }));
    const covMensual = mensual.creados.find((c) => c.resourceType === 'Coverage') as unknown as Coverage;
    expect(covMensual.period?.end, 'el mensual se renueva: no vence').toBeUndefined();

    const cien = fakeMedplum();
    await handler(cien.medplum, evento({ ...base, planCodigo: 'PB100D_PREMIUM_100D' }));
    const covCien = cien.creados.find((c) => c.resourceType === 'Coverage') as unknown as Coverage;
    expect(covCien.period?.end).toBeDefined();
    const dias = Math.round(
      (new Date(covCien.period!.end!).getTime() - new Date(base.desde).getTime()) / 86_400_000,
    );
    expect(dias).toBe(getPrograma('PB100D_PREMIUM_100D').vigenciaDias);
  });
});

describe('el cron de membresías NO toca los programas (todavía)', () => {
  it('un Coverage de programa se saltea: la renovación mensual no existe', async () => {
    // Comportamiento DELIBERADO, no un olvido: falta decidir la cadencia (mes
    // calendario vs. cada 30 días desde el alta). Si algún día el cron los
    // cobra, este test tiene que cambiar A PROPÓSITO — no en silencio.
    const { handler } = await import('../src/bots/cobro-membresias.js');
    const covPrograma: Coverage = {
      resourceType: 'Coverage',
      id: 'cov-prog',
      status: 'active',
      beneficiary: { reference: 'Patient/p1' },
      payor: [{ reference: 'Patient/p1' }],
      extension: [
        { url: EXT.tipoCobertura, valueCode: 'programa' },
        { url: EXT.planCodigo, valueString: 'PB100D_PREMIUM_MENSUAL' },
      ],
    };
    const creados: Array<Record<string, unknown>> = [];
    const medplum = {
      searchResources: async (tipo: string) => (tipo === 'Coverage' ? [covPrograma] : []),
      searchOne: async () => undefined,
      readResource: async () => ({ resourceType: 'Patient', id: 'p1', telecom: [] }),
      createResource: async (r: Record<string, unknown>) => {
        creados.push(r);
        return { ...r, id: 'x1' };
      },
      updateResource: async (r: Record<string, unknown>) => r,
    } as never;

    await handler(medplum, { input: { hoy: '2026-10-01T12:00:00-03:00' }, secrets: {} } as never);
    expect(creados.filter((c) => c.resourceType === 'Invoice'), 'el cron no debe cobrar programas').toHaveLength(0);
  });
});

describe('contexto del asistente — un programa no es una membresía agotada', () => {
  /** Fake con las coberturas dadas; el resto de las búsquedas vacías. */
  function medplumCon(coberturas: Coverage[]) {
    return {
      readResource: async () => ({ resourceType: 'Patient', id: 'p1', name: [{ text: 'Ana' }] }),
      searchOne: async () => undefined,
      searchResources: async (tipo: string) => (tipo === 'Coverage' ? coberturas : []),
    } as never;
  }
  const cov = (tipo: string, codigo: string, extra: Coverage['extension'] = []): Coverage => ({
    resourceType: 'Coverage',
    status: 'active',
    beneficiary: { reference: 'Patient/p1' },
    payor: [{ reference: 'Patient/p1' }],
    extension: [
      { url: EXT.tipoCobertura, valueCode: tipo },
      { url: EXT.planCodigo, valueString: codigo },
      ...(extra ?? []),
    ],
  });
  const membresia = cov('membresia', 'PRIME_STD_IND', [
    { url: EXT.sesionesMes, valueInteger: 8 },
    { url: EXT.sesionesUsadas, valueInteger: 3 },
  ]);
  const programa = cov('programa', 'PB100D_PREMIUM_MENSUAL');

  it('solo programa: informa el plan SIN contador (no dice "0 sesiones")', async () => {
    const { contextoPacienteResumido } = await import('../src/bots/_shared.js');
    const ctx = await contextoPacienteResumido(medplumCon([programa]), 'Patient/p1');
    expect(ctx.plan?.nombre).toBe('PB100D_PREMIUM_MENSUAL');
    expect(ctx.plan?.sesionesRestantes, 'un programa no vende sesiones').toBeUndefined();
  });

  it('programa PRIMERO y membresía después: gana la membresía, con sus sesiones reales', async () => {
    // El bug que evita: `find` tomaba el primer plan. Con el programa adelante,
    // el asistente decía "le quedan 0 sesiones" y tapaba la membresía activa.
    const { contextoPacienteResumido } = await import('../src/bots/_shared.js');
    const ctx = await contextoPacienteResumido(medplumCon([programa, membresia]), 'Patient/p1');
    expect(ctx.plan?.nombre).toBe('PRIME_STD_IND');
    expect(ctx.plan?.sesionesRestantes).toBe(5);
  });

  it('el texto que lee el asistente omite la línea de sesiones para un programa', async () => {
    const { textoContexto } = await import('../src/lib/borrador.js');
    const texto = textoContexto({ nombre: 'Ana', plan: { nombre: 'PB100D_PREMIUM_MENSUAL' } });
    expect(texto).toContain('PB100D_PREMIUM_MENSUAL');
    expect(texto).not.toContain('sesiones');
  });
});
