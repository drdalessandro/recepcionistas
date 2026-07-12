/**
 * Builders FHIR del seed: traducen el catálogo de dominio (Manual v9) a recursos
 * FHIR R4 (ActivityDefinition, PlanDefinition, CodeSystem, Basic, Location, Schedule).
 * Funciones puras: no hacen IO. El runner (index.ts) los persiste en Medplum.
 */
import type {
  ActivityDefinition,
  Basic,
  CodeSystem,
  CodeSystemConcept,
  Extension,
  Location,
  PlanDefinition,
  PlanDefinitionAction,
  Practitioner,
  Schedule,
  Slot,
  StructureDefinition,
} from '@medplum/fhirtypes';
import type { Servicio } from '../domain/types.js';
import { MEDICOS } from '../config/medicos.js';
import { SERVICIOS } from '../config/catalogo.js';
import { COMBOS } from '../config/combos.js';
import { MEMBRESIAS } from '../config/membresias.js';
import { PAQUETES } from '../config/paquetes.js';
import { CONTRAINDICACIONES } from '../config/contraindicaciones.js';
import { RECURSOS } from '../config/recursos.js';
import { TC_DEFAULT } from '../config/tipo-cambio.js';
import type { SlotDescriptor } from '../lib/slots.js';
import { EXTENSIONES } from '../fhir/extensions.js';
import { ACCESS_POLICIES } from '../fhir/access-policies.js';
import { CONFIG_TC_ID, EXT, SYSTEM } from '../fhir/identifiers.js';

const BASE = 'https://biowellness.ar/fhir';

function canonical(tipo: string, codigo: string): string {
  return `${BASE}/${tipo}/${codigo}`;
}

export function buildActivityDefinition(s: Servicio): ActivityDefinition {
  const ext: Extension[] = [
    { url: EXT.precioUsd, valueDecimal: s.precioUSD },
    { url: EXT.reglaPricingRecurso, valueCode: s.reglaPricing },
    { url: EXT.splitBw, valueCode: s.split.tipo },
    { url: EXT.requierePrescripcion, valueBoolean: s.requierePrescripcion },
  ];
  if (s.precioARS != null) {
    ext.push({ url: EXT.precioArs, valueDecimal: s.precioARS });
  }
  const ad: ActivityDefinition = {
    resourceType: 'ActivityDefinition',
    url: canonical('ActivityDefinition', s.codigo),
    name: s.codigo,
    title: s.nombre,
    status: 'active',
    kind: 'ServiceRequest',
    identifier: [{ system: SYSTEM.servicioCodigo, value: s.codigo }],
    topic: [{ text: s.categoria }],
    extension: ext,
  };
  if (s.duracionMin > 0) {
    ad.timingTiming = { repeat: { duration: s.duracionMin, durationUnit: 'min' } };
  }
  return ad;
}

export function buildComboPlanDefinition(codigo: string): PlanDefinition {
  const combo = COMBOS.find((c) => c.codigo === codigo)!;
  const action: PlanDefinitionAction[] = combo.componentes.map((c) => ({
    title: c.servicioCodigo,
    definitionCanonical: canonical('ActivityDefinition', c.servicioCodigo),
    extension: [{ url: EXT.ordenProtocolo, valueInteger: c.orden }],
  }));
  return {
    resourceType: 'PlanDefinition',
    url: canonical('PlanDefinition', codigo),
    name: codigo,
    title: combo.nombre,
    status: 'active',
    type: { text: 'combo' },
    identifier: [{ system: SYSTEM.comboCodigo, value: codigo }],
    extension: [
      { url: EXT.precioUsd, valueDecimal: combo.precioUSD },
      { url: EXT.descuentoCombo, valueDecimal: combo.descuento },
      { url: EXT.secuenciaOrdenada, valueBoolean: true },
    ],
    action,
  };
}

export function buildMembresiaPlanDefinition(codigo: string): PlanDefinition {
  const m = MEMBRESIAS.find((x) => x.codigo === codigo)!;
  return {
    resourceType: 'PlanDefinition',
    url: canonical('PlanDefinition', codigo),
    name: codigo,
    title: `Membresía ${m.tier} ${m.intensidad} ${m.variante}`,
    status: 'active',
    type: { text: 'membership' },
    identifier: [{ system: SYSTEM.membresiaCodigo, value: codigo }],
    extension: [
      { url: EXT.tier, valueCode: m.tier },
      { url: EXT.sesionesMes, valueInteger: m.sesionesMes },
      { url: EXT.precioUsd, valueDecimal: m.precioMesUSD },
      { url: EXT.descuentoCombo, valueDecimal: m.descuentoContinuidad },
    ],
    action: [
      {
        title: m.comboBaseCodigo,
        definitionCanonical: canonical('PlanDefinition', m.comboBaseCodigo),
      },
    ],
  };
}

export function buildPaquetePlanDefinition(codigo: string): PlanDefinition {
  const p = PAQUETES.find((x) => x.codigo === codigo)!;
  return {
    resourceType: 'PlanDefinition',
    url: canonical('PlanDefinition', codigo),
    name: codigo,
    title: `Paquete ${p.nombre}`,
    status: 'active',
    type: { text: 'package' },
    identifier: [{ system: SYSTEM.paqueteCodigo, value: codigo }],
    extension: [{ url: EXT.precioUsd, valueDecimal: p.totalUSD }],
    action: [
      {
        title: p.servicioBaseCodigo,
        definitionCanonical: canonical('ActivityDefinition', p.servicioBaseCodigo),
      },
    ],
  };
}

export function buildContraindicacionesCodeSystem(): CodeSystem {
  const concept: CodeSystemConcept[] = CONTRAINDICACIONES.map((c) => ({
    code: c.codigo,
    display: c.descripcion,
    property: [
      { code: 'severidad', valueString: c.severidad },
      { code: 'aplicaA', valueString: c.aplicaA.join(',') },
      { code: 'borrador', valueBoolean: c.borradorPendienteRevision },
    ],
  }));
  return {
    resourceType: 'CodeSystem',
    url: SYSTEM.contraindicacion,
    name: 'Contraindicaciones',
    title: 'Contraindicaciones (BORRADOR — validación médica pendiente)',
    status: 'draft',
    content: 'complete',
    property: [
      { code: 'severidad', type: 'string' },
      { code: 'aplicaA', type: 'string' },
      { code: 'borrador', type: 'boolean' },
    ],
    concept,
  };
}

export function buildTcConfig(): Basic {
  return {
    resourceType: 'Basic',
    identifier: [{ system: SYSTEM.config, value: CONFIG_TC_ID }],
    code: { text: CONFIG_TC_ID },
    extension: [{ url: EXT.tcAplicado, valueDecimal: TC_DEFAULT }],
  };
}

export function buildLocation(codigo: string): Location {
  const r = RECURSOS.find((x) => x.codigo === codigo)!;
  return {
    resourceType: 'Location',
    identifier: [{ system: SYSTEM.recursoCodigo, value: r.codigo }],
    name: r.nombre,
    status: 'active',
    mode: 'instance',
  };
}

export function buildSchedule(codigo: string): Schedule {
  const r = RECURSOS.find((x) => x.codigo === codigo)!;
  return {
    resourceType: 'Schedule',
    identifier: [{ system: SYSTEM.recursoCodigo, value: `SCH_${r.codigo}` }],
    active: true,
    actor: [{ reference: `Location?identifier=${SYSTEM.recursoCodigo}|${r.codigo}`, display: r.nombre }],
    extension: [
      { url: EXT.recursoFisico, valueString: r.codigo },
      { url: EXT.comparteTumbona, valueBoolean: Boolean(r.comparteCon?.length) },
    ],
  };
}

/**
 * Slot FHIR a partir de un descriptor. Con identifier determinista
 * (recurso|inicio) para que el seed sea idempotente al regenerar la agenda.
 */
export function buildSlot(descriptor: SlotDescriptor, scheduleRef: string): Slot {
  return {
    resourceType: 'Slot',
    identifier: [
      { system: SYSTEM.recursoCodigo, value: `${descriptor.recursoCodigo}|${descriptor.inicio}` },
    ],
    schedule: { reference: scheduleRef },
    status: 'free',
    start: descriptor.inicio,
    end: descriptor.fin,
    extension: [{ url: EXT.recursoFisico, valueString: descriptor.recursoCodigo }],
  };
}

export function buildPractitioner(codigo: string): Practitioner {
  const m = MEDICOS.find((x) => x.codigo === codigo)!;
  return {
    resourceType: 'Practitioner',
    identifier: [{ system: SYSTEM.medico, value: m.codigo }],
    name: [{ text: m.nombre }],
    extension: [{ url: EXT.tipoContrato, valueCode: m.esDirector ? 'director-medico' : 'prescriptor' }],
  };
}

export interface RecursosSeed {
  structureDefinitions: StructureDefinition[];
  accessPolicies: typeof ACCESS_POLICIES;
  tcConfig: Basic;
  activityDefinitions: ActivityDefinition[];
  combos: PlanDefinition[];
  membresias: PlanDefinition[];
  paquetes: PlanDefinition[];
  contraindicaciones: CodeSystem;
  locations: Location[];
  schedules: Schedule[];
  practitioners: Practitioner[];
}

/** Construye TODOS los recursos del seed (sin IO). */
export function buildSeed(): RecursosSeed {
  return {
    structureDefinitions: EXTENSIONES,
    accessPolicies: ACCESS_POLICIES,
    tcConfig: buildTcConfig(),
    activityDefinitions: SERVICIOS.map(buildActivityDefinition),
    combos: COMBOS.map((c) => buildComboPlanDefinition(c.codigo)),
    membresias: MEMBRESIAS.map((m) => buildMembresiaPlanDefinition(m.codigo)),
    paquetes: PAQUETES.map((p) => buildPaquetePlanDefinition(p.codigo)),
    contraindicaciones: buildContraindicacionesCodeSystem(),
    locations: RECURSOS.map((r) => buildLocation(r.codigo)),
    schedules: RECURSOS.map((r) => buildSchedule(r.codigo)),
    practitioners: MEDICOS.map((m) => buildPractitioner(m.codigo)),
  };
}
