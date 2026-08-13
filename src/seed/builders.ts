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
  SearchParameter,
  Slot,
  StructureDefinition,
} from '@medplum/fhirtypes';
import type { Servicio } from '../domain/types.js';
import { MEDICOS, type Medico } from '../config/medicos.js';
import { CATEGORIA_COMERCIAL, SERVICIOS } from '../config/catalogo.js';
import { COMBOS } from '../config/combos.js';
import { MEMBRESIAS } from '../config/membresias.js';
import { PAQUETES } from '../config/paquetes.js';
import { CONTRAINDICACIONES } from '../config/contraindicaciones.js';
import { RECURSOS } from '../config/recursos.js';
import { TC_DEFAULT } from '../config/tipo-cambio.js';
import type { SlotDescriptor } from '../lib/slots.js';
import type { HorarioDia } from '../config/horario.js';
import { EXTENSIONES } from '../fhir/extensions.js';
import { SEARCH_PARAMETERS } from '../fhir/search-parameters.js';
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
  // Posición en la góndola del portal (ascendente; sin extensión cae al final).
  if (s.orden != null) {
    ext.push({ url: EXT.orden, valueInteger: s.orden });
  }
  const ad: ActivityDefinition = {
    resourceType: 'ActivityDefinition',
    url: canonical('ActivityDefinition', s.codigo),
    name: s.codigo,
    title: s.nombre,
    // Voz de paciente: el portal la muestra tal cual en su lista de servicios.
    ...(s.descripcion ? { description: s.descripcion } : {}),
    status: 'active',
    kind: 'ServiceRequest',
    identifier: [{ system: SYSTEM.servicioCodigo, value: s.codigo }],
    // Sección COMERCIAL de la góndola (el código interno de categoría no viaja:
    // es contrato de R-07/pricing, no de la vidriera). `categoriaComercial`
    // permite sección propia por servicio (addendum 2.1: las consultas).
    topic: [{ text: s.categoriaComercial ?? CATEGORIA_COMERCIAL[s.categoria] ?? s.categoria }],
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
      { code: 'borrador', valueBoolean: c.borradorPendienteRevision ?? false },
    ],
  }));
  // El estado sale de la tabla: si TODA entrada está validada, el CodeSystem es
  // `active`; una sola entrada nueva sin validar lo vuelve a `draft` (y el seed
  // avisa). Validación vigente: Dr. Conrado López Alonso, 2026-08-09.
  const hayBorrador = CONTRAINDICACIONES.some((c) => c.borradorPendienteRevision);
  return {
    resourceType: 'CodeSystem',
    url: SYSTEM.contraindicacion,
    name: 'Contraindicaciones',
    title: hayBorrador
      ? 'Contraindicaciones (BORRADOR — validación médica pendiente)'
      : 'Contraindicaciones (validadas por el Director Médico)',
    status: hayBorrador ? 'draft' : 'active',
    date: '2026-08-09',
    publisher: 'Biowellness San Isidro — validación: Dr. Conrado López Alonso (Director Médico)',
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

/** Slug del médico para los identifiers del portal ("MED_CONRADO" → "conrado"). */
function slugMedico(codigo: string): string {
  return codigo.replace(/^MED_/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Agenda PUBLICADA de un médico (portal → "Consulta con Director Médico"):
 * Schedule con doble identifier — el canónico del repo (SCH_{codigo}) y el del
 * contrato del portal (`bw-sched-{medico}` bajo sid/recurso, que el portal
 * busca por valor). El actor es el Practitioner (referencia condicional).
 */
export function buildScheduleMedico(m: Medico): Schedule {
  return {
    resourceType: 'Schedule',
    identifier: [
      { system: SYSTEM.recursoCodigo, value: `SCH_${m.codigo}` },
      { system: SYSTEM.sidRecurso, value: `bw-sched-${slugMedico(m.codigo)}` },
    ],
    active: true,
    actor: [{ reference: `Practitioner?identifier=${SYSTEM.medico}|${m.codigo}`, display: m.nombre }],
  };
}

/**
 * Slot libre de la agenda de un médico. Identifier determinista para regenerar
 * sin duplicar; el runner NO pisa los existentes (un slot ya reservado quedó
 * `busy` y una regeneración jamás debe volverlo a ofrecer).
 */
export function buildSlotMedico(m: Medico, descriptor: SlotDescriptor, scheduleRef: string): Slot {
  return {
    resourceType: 'Slot',
    identifier: [
      { system: SYSTEM.recursoCodigo, value: `${m.codigo}|${descriptor.inicio}` },
      { system: SYSTEM.sidRecurso, value: `bw-slot-${slugMedico(m.codigo)}-${descriptor.inicio}` },
    ],
    schedule: { reference: scheduleRef },
    status: 'free',
    start: descriptor.inicio,
    end: descriptor.fin,
  };
}

/**
 * ¿Es el Schedule de la agenda publicada de un médico?
 *
 * Los Schedule de médicos NO llevan la extensión `recurso-fisico` (su actor es
 * el Practitioner, no una sala), así que las auditorías que definen "canónico"
 * por esa extensión los daban por ajenos — y `npm run limpiar -- --apply`
 * los habría BORRADO con todos sus Slots, tumbando la agenda del portal.
 * Se reconocen por su identifier canónico `SCH_<codigo del médico>`.
 */
export function esScheduleDeMedico(sch: Schedule): boolean {
  return (sch.identifier ?? []).some(
    (i) => i.system === SYSTEM.recursoCodigo && MEDICOS.some((m) => i.value === `SCH_${m.codigo}`),
  );
}

/** Horario semanal (shape de HORARIO_SEMANAL) armado desde la agenda del médico. */
export function horarioDeAgendaMedico(m: Medico): HorarioDia[] {
  return Array.from({ length: 7 }, (_, dia) => {
    const franjas = (m.agenda ?? []).filter((f) => f.dia === dia).map((f) => ({ desde: f.desde, hasta: f.hasta }));
    return { dia, abierto: franjas.length > 0, franjas };
  });
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
  searchParameters: SearchParameter[];
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
    searchParameters: SEARCH_PARAMETERS,
    accessPolicies: ACCESS_POLICIES,
    tcConfig: buildTcConfig(),
    activityDefinitions: SERVICIOS.map(buildActivityDefinition),
    combos: COMBOS.map((c) => buildComboPlanDefinition(c.codigo)),
    membresias: MEMBRESIAS.map((m) => buildMembresiaPlanDefinition(m.codigo)),
    paquetes: PAQUETES.map((p) => buildPaquetePlanDefinition(p.codigo)),
    contraindicaciones: buildContraindicacionesCodeSystem(),
    locations: RECURSOS.map((r) => buildLocation(r.codigo)),
    schedules: [
      ...RECURSOS.map((r) => buildSchedule(r.codigo)),
      // Agendas publicadas de médicos (portal): solo los que definen `agenda`.
      ...MEDICOS.filter((m) => (m.agenda?.length ?? 0) > 0).map(buildScheduleMedico),
    ],
    practitioners: MEDICOS.map((m) => buildPractitioner(m.codigo)),
  };
}
