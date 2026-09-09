/**
 * Cuestionario de ingreso de BIOWELLNESS — FUENTE DE VERDAD.
 *
 * Incluye el screening de contraindicaciones HBOT/IHHT: es lo que R-20 exige
 * completo antes de reservar, y lo que separa "apto" de "no sabemos" en el
 * banner de seguridad de Atender.
 *
 * Vivía solo en el portal, que lo llevaba como definición local y leía del
 * servidor "si estaba cargado" — pero **nadie lo subía**. Resultado: el recurso
 * canónico no existía, el portal siempre caía a su copia y el kiosco del
 * mostrador no tenía formulario que mostrar. Se trae acá porque este repo es el
 * que tiene el seed.
 *
 * El contenido se copió BYTE A BYTE del original. Las preguntas son clínicas:
 * todo cambio lo aprueba el Director Médico y sube la `version` del recurso.
 */
import type { Questionnaire } from '@medplum/fhirtypes';
import { INTAKE_QUESTIONNAIRE_URL } from '../fhir/identifiers.js';

/**
 * Mapeo pregunta del screening → contraindicación de la tabla validada.
 *
 * Este era el eslabón que faltaba en el camino del "apto": el cuestionario
 * guardaba las respuestas y NADIE las leía — contestar "sí" a "¿tenés
 * neumotórax no tratado?" producía exactamente el mismo banner verde que
 * contestar todo "no" (bug real, 2026-08-28: paciente del portal con dos
 * descalificantes en True y "Paciente apto para atención" en el mostrador).
 *
 * `codigos` referencia la tabla de `contraindicaciones.ts`: una respuesta
 * afirmativa cuenta para R-02 con la severidad de la tabla (absoluta bloquea,
 * relativa advierte). Una entrada con `codigos: []` sería una pregunta de
 * riesgo sin equivalente: pinta el banner igual pero no muerde en la reserva.
 *
 * Desde 2026-09-01 **no queda ninguna sin mapear**: el documento de admisión
 * (Andrés → Dalessandro, 25-ago) asignó bloqueo a las tres que faltaban
 * —marcapasos, EPOC de IHHT y TVP— y sumó la cirugía de oído/nariz/tórax
 * reciente, que se preguntaba fuera del screening. Sus códigos entraron a la
 * tabla como `borradorPendienteRevision` (ver el encabezado de
 * `contraindicaciones.ts`): el CodeSystem queda en `draft` hasta que el
 * Director Médico valide.
 */
export interface RiesgoScreening {
  linkId: string;
  /** Códigos de `CONTRAINDICACIONES` equivalentes ([] = sin entrada en la tabla, aún). */
  codigos: string[];
}

export const SCREENING_RIESGOS: RiesgoScreening[] = [
  // ---- HBOT ----
  { linkId: 'hbot-neumotorax', codigos: ['HBOT_NEUMOTORAX_NO_TRATADO'] },
  { linkId: 'hbot-infeccion-resp', codigos: ['HBOT_INFECCION_VIA_AEREA'] },
  { linkId: 'hbot-marcapasos', codigos: ['HBOT_IMPLANTE_NO_CERTIFICADO'] },
  { linkId: 'hbot-claustrofobia', codigos: ['HBOT_CLAUSTROFOBIA'] },
  { linkId: 'hbot-convulsiones', codigos: ['HBOT_CONVULSIONES'] },
  // Dos preguntas de medicación, no una: doxorrubicina y bleomicina son absolutas
  // y las otras tres relativas. Juntas en una sola pregunta, un "sí" no se podría
  // desambiguar y todas terminarían con la severidad de la más grave.
  { linkId: 'hbot-quimio-bloqueante', codigos: ['HBOT_DOXORRUBICINA', 'HBOT_BLEOMICINA'] },
  { linkId: 'hbot-medicacion-oxigeno', codigos: ['HBOT_CISPLATINO', 'HBOT_DISULFIRAM', 'HBOT_MAFENIDA'] },
  { linkId: 'hbot-neumotorax-previo', codigos: ['HBOT_NEUMOTORAX_ESPONTANEO_PREVIO'] },
  // EPOC y bullas van juntas: el riesgo es el mismo (atrapamiento aéreo) y la
  // severidad también (relativa), así que un "sí" no necesita desambiguarse.
  { linkId: 'hbot-epoc-bullas', codigos: ['HBOT_EPOC_RETENCION_CO2', 'HBOT_BULLAS_PULMONARES'] },
  { linkId: 'hbot-barotrauma', codigos: ['HBOT_BAROTRAUMA_PREVIO'] },
  { linkId: 'hbot-fiebre', codigos: ['HBOT_FIEBRE_ALTA'] },
  { linkId: 'hbot-esferocitosis', codigos: ['HBOT_ESFEROCITOSIS'] },
  { linkId: 'hbot-neuritis-optica', codigos: ['HBOT_NEURITIS_OPTICA'] },
  { linkId: 'hbot-ansiedad', codigos: ['HBOT_ANSIEDAD'] },
  // Estaba FUERA del screening (sección "Cirugías") y no declaraba riesgo; el
  // doc de admisión la pone como bloqueante de HBOT (A.1 #3).
  { linkId: 'cirugia-reciente-ont', codigos: ['HBOT_CIRUGIA_ONT_RECIENTE'] },
  // ---- IHHT ----
  // La pregunta junta insuficiencia descompensada E infarto reciente (las dos
  // absolutas de la tabla): un "sí" cuenta por ambas — el efecto es el mismo.
  { linkId: 'ihht-insuf-cardiaca', codigos: ['IHHT_INSUF_CARDIACA_DESCOMP', 'IHHT_SCA_RECIENTE'] },
  { linkId: 'ihht-hta', codigos: ['IHHT_HTA_NO_CONTROLADA'] },
  { linkId: 'ihht-epoc', codigos: ['IHHT_EPOC_SEVERO'] },
  { linkId: 'ihht-tvp', codigos: ['IHHT_TVP_ACTIVA'] },
  { linkId: 'ihht-htp', codigos: ['IHHT_HTP_SEVERA'] },
  { linkId: 'ihht-infeccion-resp', codigos: ['IHHT_INFECCION_RESPIRATORIA'] },
  // ---- Generales ----
  // Choice "Sí"/"No"/"No aplica": solo el "Sí" cuenta como afirmativa.
  // Mapea a las DOS entradas: el embarazo se partió por terapia (relativa en HBOT,
  // absoluta en IHHT) y un "sí" tiene que encender ambas.
  { linkId: 'embarazo', codigos: ['HBOT_EMBARAZO', 'IHHT_EMBARAZO'] },
];

/**
 * Contraindicaciones que **a propósito** no se preguntan en el screening: no son
 * cosas que una paciente pueda contestar con honestidad. Son hallazgos de
 * laboratorio, de imagen o de examen físico, o estados del momento de la sesión.
 *
 * Preguntarlas igual sería peor que no preguntarlas: daría cobertura aparente
 * sobre respuestas que nadie puede dar bien. La vía correcta para éstas es el
 * chequeo del técnico hiperbárico antes de la sesión, o leerlas del chart
 * (`Condition` / `Observation`) — las dos cosas están pendientes de diseño.
 *
 * Esta lista NO es un lugar donde esconder trabajo: `screening.test.ts` verifica
 * que todo código de la tabla esté acá o tenga pregunta. Agregar una entrada acá
 * es una decisión explícita, con motivo escrito.
 */
export const SIN_PREGUNTA_POR_DISENIO: Readonly<Record<string, string>> = {
  HBOT_HIPOTERMIA: 'Estado del momento de la sesión: se mide, no se autorreporta.',
  HBOT_PACIENTE_DESCOMPENSADO: 'Es un juicio clínico sobre el estado general, no un dato que la paciente declare.',
  HBOT_AIRE_ATRAPADO: 'Embolia gaseosa, neumomediastino, neumoperitoneo y enfisema subcutáneo son hallazgos de imagen.',
  HBOT_NEUMONIA_PNEUMOCYSTIS: 'Diagnóstico microbiológico activo: viene del chart, no del cuestionario de ingreso.',
  HBOT_ACIDOSIS: 'Hallazgo de laboratorio.',
};

export const CUESTIONARIO_INGRESO: Questionnaire = {
  resourceType: 'Questionnaire',
  url: INTAKE_QUESTIONNAIRE_URL,
  version: '1.1.0',
  status: 'active',
  name: 'biowellness-intake-clinico',
  title: 'Cuestionario de ingreso',
  subjectType: ['Patient'],
  item: [
    {
      linkId: 'antecedentes',
      text: 'Antecedentes médicos',
      type: 'group',
      item: [
        {
          linkId: 'antecedentes-cronicos',
          text: '¿Tenés alguna enfermedad crónica diagnosticada (cardiovascular, respiratoria, neurológica, oncológica, metabólica, etc.)?',
          type: 'boolean',
        },
        {
          linkId: 'antecedentes-detalle',
          text: 'Contanos el detalle de tus antecedentes',
          type: 'text',
          enableWhen: [{ question: 'antecedentes-cronicos', operator: '=', answerBoolean: true }],
        },
      ],
    },
    {
      linkId: 'cirugias',
      text: 'Cirugías',
      type: 'group',
      item: [
        { linkId: 'cirugias-tiene', text: '¿Te realizaron alguna cirugía?', type: 'boolean' },
        {
          linkId: 'cirugia-reciente-ont',
          text: '¿Tuviste una cirugía de oído, nariz o tórax en los últimos 30 días?',
          type: 'boolean',
        },
        {
          linkId: 'cirugias-detalle',
          text: 'Detalle de tus cirugías (cuáles y cuándo)',
          type: 'text',
          enableWhen: [{ question: 'cirugias-tiene', operator: '=', answerBoolean: true }],
        },
      ],
    },
    {
      linkId: 'medicacion',
      text: 'Medicación',
      type: 'group',
      item: [
        {
          linkId: 'medicacion-toma',
          text: '¿Tomás alguna medicación actualmente? (incluí anticoagulantes y suplementos)',
          type: 'boolean',
        },
        {
          linkId: 'medicacion-detalle',
          text: 'Detalle de tu medicación y dosis',
          type: 'text',
          enableWhen: [{ question: 'medicacion-toma', operator: '=', answerBoolean: true }],
        },
      ],
    },
    {
      linkId: 'alergias',
      text: 'Alergias',
      type: 'group',
      item: [
        { linkId: 'alergias-tiene', text: '¿Tenés alergias conocidas?', type: 'boolean' },
        {
          linkId: 'alergias-detalle',
          text: 'Detalle de tus alergias',
          type: 'text',
          enableWhen: [{ question: 'alergias-tiene', operator: '=', answerBoolean: true }],
        },
      ],
    },
    {
      linkId: 'contraind-hbot',
      text: 'Screening de seguridad — Cámara Hiperbárica (HBOT)',
      type: 'group',
      item: [
        { linkId: 'hbot-neumotorax', text: '¿Tenés neumotórax no tratado?', type: 'boolean' },
        {
          linkId: 'hbot-infeccion-resp',
          text: '¿Tenés una infección respiratoria alta aguda (resfrío, sinusitis u otitis)?',
          type: 'boolean',
        },
        {
          linkId: 'hbot-marcapasos',
          text: '¿Tenés marcapasos o implantes electrónicos no certificados para uso hiperbárico?',
          type: 'boolean',
        },
        { linkId: 'hbot-claustrofobia', text: '¿Tenés claustrofobia severa no controlada?', type: 'boolean' },
        { linkId: 'hbot-convulsiones', text: '¿Tenés convulsiones no controladas?', type: 'boolean' },
        {
          linkId: 'hbot-quimio-bloqueante',
          text: '¿Estás en tratamiento con doxorrubicina o bleomicina? (Si no recordás el nombre, mirá la indicación de tu médico.)',
          type: 'boolean',
        },
        {
          linkId: 'hbot-medicacion-oxigeno',
          text: '¿Estás tomando cisplatino, disulfiram o acetato de mafenida?',
          type: 'boolean',
        },
        {
          linkId: 'hbot-neumotorax-previo',
          text: '¿Alguna vez se te colapsó un pulmón (neumotórax) sin que hubiera un golpe?',
          type: 'boolean',
        },
        {
          linkId: 'hbot-epoc-bullas',
          text: '¿Tenés EPOC, enfisema o bullas en los pulmones?',
          type: 'boolean',
        },
        {
          linkId: 'hbot-barotrauma',
          text: '¿Alguna vez te lastimaste los oídos o los senos paranasales al volar o al bucear?',
          type: 'boolean',
        },
        { linkId: 'hbot-fiebre', text: '¿Tenés fiebre hoy o tuviste en las últimas 24 horas?', type: 'boolean' },
        { linkId: 'hbot-esferocitosis', text: '¿Te diagnosticaron esferocitosis?', type: 'boolean' },
        { linkId: 'hbot-neuritis-optica', text: '¿Te diagnosticaron neuritis óptica?', type: 'boolean' },
        {
          linkId: 'hbot-ansiedad',
          text: '¿Tenés ansiedad que te dificulte quedarte quieto/a o seguir indicaciones durante una sesión?',
          type: 'boolean',
        },
      ],
    },
    {
      linkId: 'contraind-ihht',
      text: 'Screening de seguridad — Entrenamiento Hipóxico (IHHT)',
      type: 'group',
      item: [
        {
          linkId: 'ihht-insuf-cardiaca',
          text: '¿Tenés insuficiencia cardíaca descompensada o tuviste un infarto en los últimos 6 meses?',
          type: 'boolean',
        },
        {
          linkId: 'ihht-hta',
          text: '¿Tenés presión arterial no controlada (mayor a 180/110 mmHg)?',
          type: 'boolean',
        },
        { linkId: 'ihht-epoc', text: '¿Tenés EPOC severa (estadio IV)?', type: 'boolean' },
        { linkId: 'ihht-tvp', text: '¿Tenés trombosis venosa profunda activa?', type: 'boolean' },
        { linkId: 'ihht-htp', text: '¿Te diagnosticaron hipertensión pulmonar?', type: 'boolean' },
        {
          linkId: 'ihht-infeccion-resp',
          text: '¿Estás cursando una infección respiratoria en este momento?',
          type: 'boolean',
        },
      ],
    },
    {
      linkId: 'general',
      text: 'Otros datos',
      type: 'group',
      item: [
        {
          linkId: 'embarazo',
          text: '¿Estás o podrías estar embarazada?',
          type: 'choice',
          answerOption: [{ valueString: 'Sí' }, { valueString: 'No' }, { valueString: 'No aplica' }],
        },
        {
          linkId: 'contacto-emergencia',
          text: 'Contacto de emergencia (nombre y teléfono)',
          type: 'string',
        },
      ],
    },
    {
      linkId: 'declaracion',
      text: 'Declaro que la información provista es completa y veraz.',
      type: 'boolean',
      required: true,
    },
  ],
};
