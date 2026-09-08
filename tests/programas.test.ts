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
