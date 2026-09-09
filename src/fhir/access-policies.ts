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
import { EXT, SYSTEM } from './identifiers.js';

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
    // Basic de recepción: caja chica (movimientos egreso/reposición/ajuste) y
    // demanda no cubierta (lo que piden y no tenemos). SOLO esos dos codes — el
    // config del TC también es Basic y desde el mostrador no se toca. Va como
    // UNA entrada con los dos codes en OR (`code=a|,b|`) y no como dos entradas
    // del mismo resourceType, para no depender de cómo resuelve el servidor dos
    // policies que compiten por el mismo tipo. El arqueo va en
    // PaymentReconciliation (ya listado arriba).
    { resourceType: 'Basic', criteria: `Basic?code=${SYSTEM.caja}|,${SYSTEM.demanda}|` },
    // Membresía / sesiones del mes (sólo lectura)
    { resourceType: 'Coverage', readonly: true },
    { resourceType: 'Contract', readonly: true },
    // Comunicación (WhatsApp / email)
    { resourceType: 'Communication' },
    // Adjuntos del chat (indicaciones PDF, foto del estudio que manda el
    // paciente). Un Binary solo se alcanza desde un recurso que lo referencia
    // (acá, Communication): lo clínico sigue oculto porque DocumentReference
    // y demás recursos clínicos están denegados.
    { resourceType: 'Binary' },
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
    // Kiosco del mostrador: el cuestionario de ingreso que contesta el PACIENTE
    // en la tablet, y el texto legal del consentimiento que lee antes de firmar.
    // Son definicionales y no llevan PHI — las respuestas del paciente
    // (QuestionnaireResponse) siguen FUERA del alcance de recepción, igual que
    // el Consent y el DocumentReference: los escribe `bw-ingreso-presencial`.
    { resourceType: 'Questionnaire', readonly: true },
    { resourceType: 'Library', readonly: true },
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

/**
 * Kinesiología (handoff PB100D §4): no existía rol ni policy en ningún repo.
 * El PB100D deriva a kinesiología pelviperineal (acción A02) y en los niveles
 * 3 y 4 kinesiología lleva el entrenamiento. Lee el plan y las metas (no los
 * edita: eso es del médico/nutrición) y escribe lo suyo: observaciones,
 * tareas y cuestionarios. El PractitionerRole del usuario se asigna a mano
 * desde el admin, como enfermería y terapeutas (docs/usuarios.md).
 */
export const POLICY_KINESIOLOGIA: AccessPolicy = {
  resourceType: 'AccessPolicy',
  name: 'Kinesiología — Clínico limitado',
  resource: [
    { resourceType: 'Appointment', readonly: true },
    { resourceType: 'Patient', readonly: true },
    { resourceType: 'CarePlan', readonly: true },
    { resourceType: 'Goal', readonly: true },
    { resourceType: 'Observation' },
    { resourceType: 'Task' },
    { resourceType: 'QuestionnaireResponse' },
  ],
};

/** Nombre canónico de la policy del portal del paciente (lo usa el bot de invitación). */
export const NOMBRE_POLICY_PACIENTE = 'Paciente — Portal';

/**
 * Paciente — Portal: el paciente accede **sólo a lo suyo** desde el portal
 * (app.biowellness.ar). Ve su agenda, plan, pagos y mensajes, y —ejerciendo su
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
 * **solicitud** (el paciente consulta horarios con `bw-disponibilidad` —solo
 * lectura— y pide con `bw-solicitar-turno`, que crea un `Task`; Recepción
 * confirma con los bots de reserva), por eso `Appointment` es de sólo lectura y
 * el acceso a `Bot` está acotado a esos dos bots.
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
    // readonlyFields: el paciente edita sus datos de contacto, pero NO los
    // campos con impacto en dinero o identidad — sin esto podría automarcarse
    // Founding Member (tag-fm → 20% off + ventana de 7 días), cambiarse el
    // tipo de cliente o tocar su DNI / número de fundador (identifier).
    {
      resourceType: 'Patient',
      criteria: 'Patient?_id=%patient.id',
      readonlyFields: [
        'Patient.identifier',
        `Patient.extension('${EXT.tagFm}')`,
        `Patient.extension('${EXT.tipoCliente}')`,
        `Patient.extension('${EXT.tcBloqueoFm}')`,
      ],
    },
    { resourceType: 'Observation', criteria: 'Observation?subject=%patient' },
    { resourceType: 'QuestionnaireResponse', criteria: 'QuestionnaireResponse?subject=%patient' },
    { resourceType: 'DocumentReference', criteria: 'DocumentReference?subject=%patient' },
    { resourceType: 'Communication', criteria: 'Communication?subject=%patient' },
    // Compartimento propio — sólo lectura (lo gestiona Recepción / el equipo médico).
    { resourceType: 'Appointment', readonly: true, criteria: 'Appointment?actor=%patient' },
    { resourceType: 'Coverage', readonly: true, criteria: 'Coverage?beneficiary=%patient' },
    // Cobertura de salud del paciente (obra social/prepaga, portal → Perfil →
    // "Datos de cobertura"): escritura SOLO de Coverages marcadas con type
    // ActCode HIP. Las membresías/paquetes BW no llevan ese type → siguen fuera
    // del alcance del paciente. Convive con la readonly amplia de arriba.
    // (Aplicada a mano el 2026-07-20; sin esta entrada el próximo seed la pisa
    // y rompe el guardado de cobertura del portal con 403.)
    {
      resourceType: 'Coverage',
      criteria: 'Coverage?beneficiary=%patient&type=http://terminology.hl7.org/CodeSystem/v3-ActCode|HIP',
    },
    { resourceType: 'Invoice', readonly: true, criteria: 'Invoice?subject=%patient' },
    { resourceType: 'DiagnosticReport', readonly: true, criteria: 'DiagnosticReport?subject=%patient' },
    // Estudios de laboratorio (portal → "Mis estudios"). Mismo patrón de dos
    // entradas que Coverage: lectura amplia de lo propio + escritura ACOTADA.
    //  - Lee TODAS sus ServiceRequest: las que pide él y las que le indica el
    //    médico (si la lectura se acotara a `proposal`, el paciente dejaría de
    //    ver sus órdenes reales).
    //  - Solo puede CREAR propuestas: una solicitud del portal es un pedido,
    //    nunca una orden médica autorizada. `intent=order` queda fuera de su
    //    alcance, así que no puede auto-indicarse estudios.
    // Sin estas entradas ServiceRequest no existía en la policy y hasta la
    // BÚSQUEDA daba 403 (2026-08-13: el portal no podía ni listar los pedidos,
    // y mostraba "No pudimos registrar tu solicitud").
    { resourceType: 'ServiceRequest', readonly: true, criteria: 'ServiceRequest?subject=%patient' },
    { resourceType: 'ServiceRequest', criteria: 'ServiceRequest?subject=%patient&intent=proposal,plan' },
    // Consentimientos informados que el paciente firma desde el portal. El
    // docstring de arriba los prometía desde siempre y el espejo del portal
    // tenía la entrada aplicada A MANO en el servidor
    // (docs/recepcionistaschequeohandoff.md), pero NO estaba en este array:
    // como el seed hace upsert por `name`, cada `npm run seed` la borraba y
    // dejaba la firma del portal en 403. Mismo accidente que ya pasó con
    // Coverage HIP y con ServiceRequest.
    //  - lee TODOS sus consentimientos (también los que carga el equipo médico);
    //  - firma los suyos: el criteria por paciente es la protección real.
    //
    // ⚠️ NO acotar por `category`: el portal usa la categoría estándar de HL7
    // (`v3-ActCode|IDSCL`, information disclosure) y pone el código de
    // Biowellness en `policyRule` (ej. `procesamiento-datos-salud` al subir un
    // PDF de laboratorio). Un criteria por category con nuestro system
    // rechazaría ese Consent con 403 y rompería la firma del portal — se probó
    // contra el recurso real del servidor (2026-08-14).
    { resourceType: 'Consent', readonly: true, criteria: 'Consent?patient=%patient' },
    { resourceType: 'Consent', criteria: 'Consent?patient=%patient' },
    // CarePlan escribible: "Mi plan" del portal marca acciones (Empezar/Lograda)
    // con updateResource (portal/src/pages/care-plan/ActionItems.tsx).
    // ⏳ Handoff PB100D §1: cuando entre la pantalla nueva (Hito 5) esta entrada
    // pasa a readonly — la paciente marcará Task, no editará el plan.
    { resourceType: 'CarePlan', criteria: 'CarePlan?subject=%patient' },
    // Plan Bienestar 100 Días (handoff PB100D §1, visto en producción
    // 2026-09-08: sin estas entradas el portal recibía 403 y el programa no
    // funciona — marcar un día es la ÚNICA escritura del programa).
    //  - Goal / NutritionOrder: la paciente VE sus metas y su plan nutricional.
    { resourceType: 'Goal', readonly: true, criteria: 'Goal?subject=%patient' },
    { resourceType: 'NutritionOrder', readonly: true, criteria: 'NutritionOrder?patient=%patient' },
    { resourceType: 'MedicationRequest', readonly: true, criteria: 'MedicationRequest?patient=%patient' },
    { resourceType: 'Immunization', readonly: true, criteria: 'Immunization?patient=%patient' },
    // Solicitudes de turno propias (las crea el bot; el paciente solo las lee).
    // `patient` mapea a Task.for (que el bot setea al paciente).
    { resourceType: 'Task', readonly: true, criteria: 'Task?patient=%patient' },
    // …y ESCRITURA acotada por code: SOLO las acciones del PB100D (marcar
    // "hecho" escribe Task.status/output). Las tareas del equipo (alertas,
    // bandeja) llevan otro code y quedan fuera; las solicitudes también.
    // Convive con la readonly amplia de arriba, igual que Coverage HIP.
    { resourceType: 'Task', criteria: `Task?patient=%patient&code=${SYSTEM.biowellnessPlan}|` },
    // Catálogo, agenda y profesionales — sólo lectura (para mostrar la oferta).
    // ActivityDefinition (servicios) y PlanDefinition (combos/membresías/paquetes)
    // son el catálogo v9 que seedea este repo: el portal los lee para que su lista
    // de servicios sea EXACTAMENTE la misma que ve Recepción. No contienen PHI.
    { resourceType: 'ActivityDefinition', readonly: true },
    { resourceType: 'PlanDefinition', readonly: true },
    { resourceType: 'ObservationDefinition', readonly: true },
    { resourceType: 'Questionnaire', readonly: true },
    // Terminología para el renderer de cuestionarios del portal (ADR-037 del
    // portal / handoff PB100D §1): sin esto usa una copia local de las opciones.
    { resourceType: 'ValueSet', readonly: true },
    { resourceType: 'CodeSystem', readonly: true },
    // Texto legal del consentimiento, publicado por el seed: el portal y el
    // kiosco leen la MISMA versión (no puede haber dos textos firmados).
    { resourceType: 'Library', readonly: true },
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
    // Bots que el paciente puede ejecutar — y NINGÚN otro:
    //  - bw-solicitar-turno: crea el Task de solicitud y avisa a Recepción.
    //  - bw-disponibilidad: SOLO LECTURA, horarios reservables para él (R-13).
    //  - bw-cancelar-turno / bw-mover-turno: autogestión de SUS turnos. Los dos
    //    verifican que el turno sea del paciente antes de tocar nada: esta
    //    policy acota lo que LEE, no lo que le pasa a un bot.
    //  - bw-preferencia-semanal: SU preferencia semanal (R-21). Con `pacienteRef`
    //    el bot verifica que la membresía sea del paciente antes de escribir.
    // (Cambio acá => avisar al portal para actualizar su espejo.)
    {
      resourceType: 'Bot',
      readonly: true,
      criteria: 'Bot?name=bw-solicitar-turno,bw-disponibilidad,bw-cancelar-turno,bw-mover-turno,bw-preferencia-semanal',
    },
  ],
};

export const ACCESS_POLICIES: AccessPolicy[] = [
  POLICY_RECEPCIONISTA,
  POLICY_DIRECTOR_MEDICO,
  POLICY_MEDICO_PRESCRIPTOR,
  POLICY_ENFERMERA,
  POLICY_TERAPEUTA,
  POLICY_KINESIOLOGIA,
  POLICY_PACIENTE_PORTAL,
];
