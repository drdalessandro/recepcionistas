/**
 * AccessPolicies de Medplum (Documento de Requerimientos §3, mínimo privilegio).
 *
 * Pieza central: la recepcionista con acceso "Operativo". Privacidad por diseño:
 * sólo lista recursos operativos; los recursos clínicos (Observation, Condition,
 * DiagnosticReport, DocumentReference, CarePlan, MedicationRequest) NO se listan,
 * por lo que quedan denegados por defecto. La recepción ve el banner de seguridad
 * (Flag), nunca el detalle clínico.
 */
import type { AccessPolicy } from '@medplum/fhirtypes';
import { EXT } from './identifiers.js';

/** Recepcionista — acceso Operativo: agenda, check-in/out, pagos, comunicación, CRM. */
export const POLICY_RECEPCIONISTA: AccessPolicy = {
  resourceType: 'AccessPolicy',
  name: 'Recepción — Operativo',
  resource: [
    // Agenda
    { resourceType: 'Appointment' },
    { resourceType: 'Schedule', readonly: true },
    { resourceType: 'Slot' },
    // Check-in / check-out (datos operativos del Encounter, sin contenido clínico)
    { resourceType: 'Encounter' },
    // Pagos
    { resourceType: 'Invoice' },
    { resourceType: 'ChargeItem' },
    { resourceType: 'PaymentReconciliation' },
    { resourceType: 'Account' },
    // Membresía / sesiones del mes (sólo lectura)
    { resourceType: 'Coverage', readonly: true },
    { resourceType: 'Contract', readonly: true },
    // Comunicación (WhatsApp / email)
    { resourceType: 'Communication' },
    // CRM / leads
    { resourceType: 'Task' },
    // Banner de seguridad (señal binaria; sin detalle clínico)
    { resourceType: 'Flag', readonly: true },
    // Ficha del paciente: demografía y datos comerciales; se oculta lo clínico.
    {
      resourceType: 'Patient',
      hiddenFields: [`Patient.extension('${EXT.perfilClinico}')`],
    },
    // Catálogo y profesionales (sólo lectura, para mostrar precios y quién atiende)
    { resourceType: 'ActivityDefinition', readonly: true },
    { resourceType: 'PlanDefinition', readonly: true },
    { resourceType: 'Practitioner', readonly: true },
    { resourceType: 'Location', readonly: true },
    { resourceType: 'HealthcareService', readonly: true },
    // Bots: lectura para poder invocarlos (cobro, validación, WhatsApp).
    { resourceType: 'Bot', readonly: true },
    // Campanita de la app (novedades en tiempo real): solo Subscriptions WebSocket
    // (sin el criteria se podrían crear rest-hooks hacia URLs externas).
    { resourceType: 'Subscription', criteria: 'Subscription?type=websocket' },
  ],
};

/** Director Médico — acceso clínico completo. */
export const POLICY_DIRECTOR_MEDICO: AccessPolicy = {
  resourceType: 'AccessPolicy',
  name: 'Director Médico — Clínico completo',
  resource: [{ resourceType: '*' }],
};

/** Médico prescriptor — clínico completo + prescripción/autorización IV y TB. */
export const POLICY_MEDICO_PRESCRIPTOR: AccessPolicy = {
  resourceType: 'AccessPolicy',
  name: 'Médico Prescriptor — Clínico + prescripción',
  resource: [{ resourceType: '*' }],
};

/** Enfermera — clínico limitado: ve órdenes IV/TB del día y registra ejecución. */
export const POLICY_ENFERMERA: AccessPolicy = {
  resourceType: 'AccessPolicy',
  name: 'Enfermería — Clínico limitado',
  resource: [
    { resourceType: 'Appointment', readonly: true },
    { resourceType: 'Encounter' },
    { resourceType: 'ServiceRequest' },
    { resourceType: 'MedicationAdministration' },
    { resourceType: 'Observation' },
    { resourceType: 'Patient', readonly: true },
  ],
};

/** Terapeuta — sólo sus turnos y registrar la sesión. */
export const POLICY_TERAPEUTA: AccessPolicy = {
  resourceType: 'AccessPolicy',
  name: 'Terapeuta — Propio',
  resource: [
    { resourceType: 'Appointment', readonly: true },
    { resourceType: 'Encounter' },
    { resourceType: 'Patient', readonly: true },
  ],
};

/** Nombre canónico de la policy del portal del paciente (lo usa el bot de invitación). */
export const NOMBRE_POLICY_PACIENTE = 'Paciente — Portal';

/**
 * Paciente — Portal: el paciente accede **sólo a lo suyo** desde el portal
 * (bio.medplum.com.ar). Ve su agenda, plan, pagos y mensajes, y —ejerciendo su
 * derecho de acceso a sus propios datos— su historia (laboratorio, biomarcadores,
 * vacunas, medicación, plan de cuidado, consentimientos). Lo no listado queda
 * denegado; nunca ve datos de otros pacientes. `%patient` se liga al perfil del
 * usuario logueado (su propio Patient).
 *
 * Alcance dentro de su compartimento:
 *  - **Escribe** (autogestión): su perfil, las observaciones/vitales que él carga,
 *    sus respuestas de cuestionarios, sus consentimientos y sus mensajes.
 *  - **Sólo lee**: agenda, cobertura/plan, facturas y su historia clínica (esa la
 *    genera el equipo médico, no el paciente).
 * Catálogo, agenda y profesionales: sólo lectura (para mostrar la oferta).
 *
 * Reservar un turno NO se hace escribiendo `Appointment` directo: el modelo es de
 * **solicitud** (el paciente ejecuta solo el bot `bw-solicitar-turno`, que crea un
 * `Task`, y Recepción confirma con los bots de reserva), por eso `Appointment` es de
 * sólo lectura y el acceso a `Bot` está acotado a ese único bot.
 *
 * IMPORTANTE — fuente de verdad: esta definición es la que aplica `npm run seed`
 * (upsert por `name`). Debe mantenerse en sincronía con su **espejo** de
 * documentación en el portal: `portal/docs/medplum/access-policy-paciente-portal.json`.
 */
export const POLICY_PACIENTE_PORTAL: AccessPolicy = {
  resourceType: 'AccessPolicy',
  name: NOMBRE_POLICY_PACIENTE,
  resource: [
    // Compartimento propio — autogestión (lectura/escritura).
    { resourceType: 'Patient', criteria: 'Patient?_id=%patient.id' },
    { resourceType: 'Observation', criteria: 'Observation?subject=%patient' },
    { resourceType: 'QuestionnaireResponse', criteria: 'QuestionnaireResponse?subject=%patient' },
    { resourceType: 'DocumentReference', criteria: 'DocumentReference?subject=%patient' },
    { resourceType: 'Communication', criteria: 'Communication?subject=%patient' },
    // Compartimento propio — sólo lectura (lo gestiona Recepción / el equipo médico).
    { resourceType: 'Appointment', readonly: true, criteria: 'Appointment?actor=%patient' },
    { resourceType: 'Coverage', readonly: true, criteria: 'Coverage?beneficiary=%patient' },
    { resourceType: 'Invoice', readonly: true, criteria: 'Invoice?subject=%patient' },
    { resourceType: 'DiagnosticReport', readonly: true, criteria: 'DiagnosticReport?subject=%patient' },
    // CarePlan escribible: "Mi plan" del portal marca acciones (Empezar/Lograda)
    // con updateResource (portal/src/pages/care-plan/ActionItems.tsx).
    { resourceType: 'CarePlan', criteria: 'CarePlan?subject=%patient' },
    { resourceType: 'MedicationRequest', readonly: true, criteria: 'MedicationRequest?patient=%patient' },
    { resourceType: 'Immunization', readonly: true, criteria: 'Immunization?patient=%patient' },
    // Solicitudes de turno propias (las crea el bot; el paciente solo las lee).
    // `patient` mapea a Task.for (que el bot setea al paciente).
    { resourceType: 'Task', readonly: true, criteria: 'Task?patient=%patient' },
    // Catálogo, agenda y profesionales — sólo lectura (para mostrar la oferta).
    { resourceType: 'ObservationDefinition', readonly: true },
    { resourceType: 'Questionnaire', readonly: true },
    { resourceType: 'Schedule', readonly: true },
    { resourceType: 'Slot', readonly: true },
    { resourceType: 'HealthcareService', readonly: true },
    { resourceType: 'Practitioner', readonly: true },
    { resourceType: 'Organization', readonly: true },
    // Chat en tiempo real (Mensajes): solo Subscriptions WebSocket. Sin el criteria,
    // el paciente podría crear rest-hooks que posteen datos a URLs externas.
    { resourceType: 'Subscription', criteria: 'Subscription?type=websocket' },
    // Binary escribible: subida de adjuntos (mensajes / consentimientos).
    { resourceType: 'Binary' },
    // Reserva por solicitud: el paciente solo puede ejecutar ESTE bot (crea el Task
    // de solicitud y avisa a Recepción). No puede ejecutar ningún otro bot.
    { resourceType: 'Bot', readonly: true, criteria: 'Bot?name=bw-solicitar-turno' },
  ],
};

export const ACCESS_POLICIES: AccessPolicy[] = [
  POLICY_RECEPCIONISTA,
  POLICY_DIRECTOR_MEDICO,
  POLICY_MEDICO_PRESCRIPTOR,
  POLICY_ENFERMERA,
  POLICY_TERAPEUTA,
  POLICY_PACIENTE_PORTAL,
];
