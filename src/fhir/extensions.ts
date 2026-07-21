/**
 * StructureDefinitions de las extensiones custom de Biowellness.
 * Se generan a partir de una tabla compacta (url, contexto, tipo de valor).
 * El seed las carga en Medplum para registrar el modelo de datos del Bloque 0.
 */
import type { StructureDefinition, ElementDefinition } from '@medplum/fhirtypes';
import { EXT } from './identifiers.js';

/** Tipo de valor permitido en value[x] de la extensión. */
type TipoValor = 'string' | 'boolean' | 'decimal' | 'integer' | 'code' | 'date' | 'dateTime' | 'Money';

interface SpecExtension {
  url: string;
  nombre: string;
  /** Recursos FHIR donde aplica (context.expression). */
  contexto: string[];
  tipoValor: TipoValor;
  descripcion: string;
}

const SPECS: SpecExtension[] = [
  // Patient
  { url: EXT.tipoCliente, nombre: 'tipo-cliente', contexto: ['Patient'], tipoValor: 'code', descripcion: 'Tipo de cliente (público, miembro, FM, etc.).' },
  { url: EXT.tagFm, nombre: 'tag-fm', contexto: ['Patient'], tipoValor: 'boolean', descripcion: 'Marca de Founding Member.' },
  { url: EXT.tcBloqueoFm, nombre: 'tc-bloqueo-fm', contexto: ['Patient'], tipoValor: 'decimal', descripcion: 'TC bloqueado para FM (precio de membresía en USD bloqueado).' },
  { url: EXT.perfilClinico, nombre: 'perfil-clinico', contexto: ['Patient', 'CarePlan'], tipoValor: 'code', descripcion: 'Perfil clínico (fatiga crónica, atleta, longevidad, estrés).' },
  { url: EXT.origenLead, nombre: 'origen-lead', contexto: ['Patient'], tipoValor: 'string', descripcion: 'Origen del lead (UTM / fuente).' },
  { url: EXT.fechaAlta, nombre: 'fecha-alta', contexto: ['Patient'], tipoValor: 'date', descripcion: 'Fecha de alta de la ficha (cohortes mensuales del CRM de Administración).' },
  // Practitioner
  { url: EXT.splitPorcentaje, nombre: 'split-porcentaje', contexto: ['Practitioner'], tipoValor: 'decimal', descripcion: 'Porcentaje de split del profesional.' },
  { url: EXT.tipoContrato, nombre: 'tipo-contrato', contexto: ['Practitioner'], tipoValor: 'code', descripcion: 'Tipo de contrato del profesional.' },
  // Schedule / Slot
  { url: EXT.recursoFisico, nombre: 'recurso-fisico', contexto: ['Schedule', 'Slot'], tipoValor: 'string', descripcion: 'Código del recurso físico al que pertenece la franja.' },
  { url: EXT.comparteTumbona, nombre: 'comparte-tumbona', contexto: ['Schedule', 'Slot'], tipoValor: 'boolean', descripcion: 'Recurso que comparte tumbonas Red Light (Recovery Pro).' },
  // Appointment
  { url: EXT.ordenProtocolo, nombre: 'orden-protocolo', contexto: ['Appointment'], tipoValor: 'integer', descripcion: 'Orden de ejecución dentro de un combo (HBOT primero).' },
  { url: EXT.requiereHbotPrevio, nombre: 'requiere-hbot-previo', contexto: ['Appointment'], tipoValor: 'boolean', descripcion: 'El turno se beneficia de HBOT previo.' },
  { url: EXT.ocupantes, nombre: 'ocupantes', contexto: ['Appointment', 'Slot'], tipoValor: 'integer', descripcion: 'Cantidad de ocupantes de la reserva (multiplaza / biplaza).' },
  { url: EXT.venceSena, nombre: 'vence-sena', contexto: ['Appointment'], tipoValor: 'dateTime', descripcion: 'Vencimiento de la tentativa: si la seña no se paga antes, el lugar se libera (R-19).' },
  // ActivityDefinition (catálogo)
  { url: EXT.precioUsd, nombre: 'precio-usd', contexto: ['ActivityDefinition'], tipoValor: 'decimal', descripcion: 'Precio de lista en USD.' },
  { url: EXT.reglaPricingRecurso, nombre: 'regla-pricing-recurso', contexto: ['ActivityDefinition'], tipoValor: 'code', descripcion: 'Regla de pricing del recurso.' },
  { url: EXT.splitBw, nombre: 'split-bw', contexto: ['ActivityDefinition'], tipoValor: 'code', descripcion: 'Tipo de split de ingresos.' },
  { url: EXT.requierePrescripcion, nombre: 'requiere-prescripcion', contexto: ['ActivityDefinition'], tipoValor: 'boolean', descripcion: 'Requiere prescripción médica.' },
  { url: EXT.orden, nombre: 'orden', contexto: ['ActivityDefinition'], tipoValor: 'integer', descripcion: 'Posición en la góndola del portal (ascendente; sin extensión cae al final).' },
  // PlanDefinition (combos)
  { url: EXT.secuenciaOrdenada, nombre: 'secuencia-ordenada', contexto: ['PlanDefinition'], tipoValor: 'boolean', descripcion: 'El combo tiene secuencia ordenada (HBOT primero).' },
  { url: EXT.descuentoCombo, nombre: 'descuento-combo', contexto: ['PlanDefinition'], tipoValor: 'decimal', descripcion: 'Descuento del combo sobre lista.' },
  // Coverage / Contract (membresía)
  { url: EXT.tier, nombre: 'tier', contexto: ['Coverage', 'Contract'], tipoValor: 'code', descripcion: 'Tier de membresía (FOCUS/PRIME/HEALTHSPAN).' },
  { url: EXT.version, nombre: 'version', contexto: ['Coverage', 'Contract'], tipoValor: 'string', descripcion: 'Versión de la membresía contratada.' },
  { url: EXT.sesionesMes, nombre: 'sesiones-mes', contexto: ['Coverage', 'Contract'], tipoValor: 'integer', descripcion: 'Sesiones por mes incluidas.' },
  { url: EXT.sesionesUsadas, nombre: 'sesiones-usadas', contexto: ['Coverage', 'Contract'], tipoValor: 'integer', descripcion: 'Sesiones consumidas en el ciclo.' },
  { url: EXT.precioBloqueadoFm, nombre: 'precio-bloqueado-fm', contexto: ['Coverage', 'Contract'], tipoValor: 'decimal', descripcion: 'Precio bloqueado en USD para FM.' },
  // Invoice / ChargeItem
  { url: EXT.montoSplitBw, nombre: 'monto-split-bw', contexto: ['Invoice', 'ChargeItem'], tipoValor: 'Money', descripcion: 'Monto que corresponde a BW.' },
  { url: EXT.montoSplitProfesional, nombre: 'monto-split-profesional', contexto: ['Invoice', 'ChargeItem'], tipoValor: 'Money', descripcion: 'Monto que corresponde al profesional / prescriptores.' },
  { url: EXT.tcAplicado, nombre: 'tc-aplicado', contexto: ['Invoice', 'ChargeItem'], tipoValor: 'decimal', descripcion: 'Tipo de cambio aplicado al cobro.' },
  // Communication
  { url: EXT.canal, nombre: 'canal', contexto: ['Communication'], tipoValor: 'code', descripcion: 'Canal de la comunicación (whatsapp/email).' },
  { url: EXT.templateUsado, nombre: 'template-usado', contexto: ['Communication'], tipoValor: 'string', descripcion: 'Template usado para el mensaje.' },
];

function buildStructureDefinition(spec: SpecExtension): StructureDefinition {
  const valueElement: ElementDefinition = {
    id: 'Extension.value[x]',
    path: 'Extension.value[x]',
    min: 0,
    max: '1',
    type: [{ code: spec.tipoValor }],
  };
  return {
    resourceType: 'StructureDefinition',
    url: spec.url,
    name: toPascal(spec.nombre),
    title: spec.nombre,
    status: 'active',
    description: spec.descripcion,
    kind: 'complex-type',
    abstract: false,
    type: 'Extension',
    baseDefinition: 'http://hl7.org/fhir/StructureDefinition/Extension',
    derivation: 'constraint',
    context: spec.contexto.map((expression) => ({ type: 'element', expression })),
    differential: {
      element: [
        { id: 'Extension', path: 'Extension', short: spec.descripcion },
        { id: 'Extension.url', path: 'Extension.url', fixedUri: spec.url },
        valueElement,
      ],
    },
  };
}

function toPascal(kebab: string): string {
  return kebab
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

export const EXTENSIONES: StructureDefinition[] = SPECS.map(buildStructureDefinition);
