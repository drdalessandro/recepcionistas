/**
 * SearchParameters custom de BioWellness (los aplica `npm run seed`).
 *
 * `origen-lead` habilita la consulta por canal directamente en FHIR — es lo que
 * consume el CRM de Administración (AdminDashboard / kpis-crm) para comparar
 * canales sin leer paciente por paciente:
 *
 *   GET [base]/Patient?origen-lead=instagram&_summary=count
 *
 * ⚠️ Tras el primer seed hay que REINDEXAR los Patient existentes para que el
 * parámetro alcance a los datos viejos (Super Admin → Rebuild/Reindex →
 * resource type `Patient`). Los pacientes creados DESPUÉS se indexan solos.
 */
import type { SearchParameter } from '@medplum/fhirtypes';
import { EXT } from './identifiers.js';

export const SEARCH_PARAMETER_ORIGEN_LEAD: SearchParameter = {
  resourceType: 'SearchParameter',
  url: 'https://biowellness.ar/fhir/SearchParameter/patient-origen-lead',
  version: '1.0.0',
  name: 'PatientOrigenLead',
  status: 'active',
  publisher: 'BioWellness San Isidro',
  description:
    'Canal de origen del lead (extensión origen-lead; lista cerrada ORIGENES_LEAD de src/fhir/identifiers.ts). Contrato CRM con Administración.',
  code: 'origen-lead',
  base: ['Patient'],
  type: 'string',
  expression: `Patient.extension.where(url='${EXT.origenLead}').value`,
};

export const SEARCH_PARAMETERS: SearchParameter[] = [SEARCH_PARAMETER_ORIGEN_LEAD];
