/**
 * Tabla de contraindicaciones — VALIDADA por el Director Médico.
 *
 * Ni el Manual v8 ni el v9 incluían tabla de contraindicaciones; se cargó una
 * lista estándar de HBOT e IHHT como borrador. El Dr. Conrado López Alonso
 * (Director Médico) la validó tal cual el 2026-08-09 (OK transmitido por
 * Andrés). Las 13 entradas quedan aprobadas para uso real.
 *
 * Cambios futuros: toda entrada NUEVA o modificada entra con
 * `borradorPendienteRevision: true` hasta que el Director Médico la apruebe —
 * eso vuelve el CodeSystem a `draft` y reactiva el aviso del seed solo.
 *
 * Uso (R-02): una contraindicación `absoluta` activa bloquea la confirmación del turno
 * sin autorización médica explícita registrada. Una `relativa` genera advertencia.
 *
 * La recepción solo ve la señal binaria del banner (verde/rojo), nunca el detalle clínico.
 *
 * ## Revisión 2026-09-01 — mapeo del documento de admisión (Andrés → Dalessandro)
 *
 * La especificación "Consentimiento Informado Digital" (25-ago-2026) asigna a
 * varias respuestas del screening un bloqueo que esta tabla tenía como simple
 * advertencia. Andrés decidió (2026-09-01) que **manda el criterio más
 * estricto**: si el documento dice que bloquea, bloquea.
 *
 * Las entradas afectadas vuelven a `borradorPendienteRevision` — que es el
 * mecanismo de esta tabla: el CodeSystem pasa a `draft` y el seed avisa hasta
 * que el Director Médico valide. NO es una formalidad: subir una severidad
 * significa que el sistema va a impedir sesiones que hoy deja pasar con
 * advertencia, y eso lo firma un médico. El propio documento lo pide
 * ("requieren validación del Dr. Dalessandro y la Dra. Dos Santos"), y la
 * tabla vigente la validó el Dr. Conrado: son DOS fuentes clínicas que hay que
 * conciliar en una sola revisión.
 */
import type { Contraindicacion } from '../domain/types.js';

export const CONTRAINDICACIONES: Contraindicacion[] = [
  // ---- HBOT ----
  {
    codigo: 'HBOT_NEUMOTORAX_NO_TRATADO',
    aplicaA: ['HBOT'],
    descripcion: 'Neumotórax no tratado (contraindicación absoluta de HBOT).',
    severidad: 'absoluta',
  },
  {
    codigo: 'HBOT_MEDICACION_INCOMPATIBLE',
    aplicaA: ['HBOT'],
    descripcion: 'Tratamiento con bleomicina, cisplatino, doxorrubicina o disulfiram.',
    severidad: 'absoluta',
  },
  {
    codigo: 'HBOT_EPOC_RETENCION_CO2',
    aplicaA: ['HBOT'],
    descripcion: 'EPOC con retención de CO2 / enfisema severo.',
    severidad: 'relativa',
  },
  {
    codigo: 'HBOT_INFECCION_VIA_AEREA',
    aplicaA: ['HBOT'],
    descripcion: 'Infección de vías aéreas superiores o sinusitis activa (riesgo de barotrauma).',
    // Doc de admisión B1: bloquea HBOT. Es la contraindicación transitoria más
    // frecuente y "la que más barotraumas óticos causa" — el documento la
    // señala como la pregunta que no puede faltar si hay que elegir una sola.
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_CONVULSIONES',
    aplicaA: ['HBOT'],
    descripcion: 'Antecedente de convulsiones no controladas / epilepsia.',
    // Doc de admisión A.1 #5: bloquea HBOT (y terapia de contraste, que aún no
    // existe como categoría en el catálogo — ver decisiones-pendientes).
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_FIEBRE_ALTA',
    aplicaA: ['HBOT'],
    descripcion: 'Fiebre alta (umbral convulsivo reducido).',
    severidad: 'relativa',
  },
  {
    // NUEVA (doc de admisión A.1 #2): la pregunta `hbot-marcapasos` ya existía
    // en el cuestionario y no tenía código en la tabla — el doc le asigna
    // bloqueo de HBOT salvo certificación del implante para uso hiperbárico.
    codigo: 'HBOT_IMPLANTE_NO_CERTIFICADO',
    aplicaA: ['HBOT'],
    descripcion: 'Marcapasos, desfibrilador u otro implante electrónico sin certificación para uso hiperbárico.',
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    // NUEVA (doc de admisión A.1 #3): `cirugia-reciente-ont` ya se preguntaba
    // pero estaba fuera del screening y no declaraba riesgo.
    codigo: 'HBOT_CIRUGIA_ONT_RECIENTE',
    aplicaA: ['HBOT'],
    descripcion: 'Cirugía de oído, nariz o tórax en los últimos 30 días.',
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_CLAUSTROFOBIA',
    aplicaA: ['HBOT'],
    descripcion: 'Claustrofobia severa.',
    // Doc de admisión A.1 #4: bloquea HBOT.
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_EMBARAZO',
    aplicaA: ['HBOT', 'IHHT'],
    descripcion: 'Embarazo (evaluación médica requerida).',
    // Doc de admisión B2: bloquea HBOT, IHHT y contraste, y deriva a consulta.
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },

  // ---- IHHT ----
  {
    codigo: 'IHHT_SCA_RECIENTE',
    aplicaA: ['IHHT'],
    descripcion: 'Síndrome coronario agudo o infarto reciente / angina inestable.',
    severidad: 'absoluta',
  },
  {
    codigo: 'IHHT_INSUF_CARDIACA_DESCOMP',
    aplicaA: ['IHHT'],
    descripcion: 'Insuficiencia cardíaca descompensada.',
    severidad: 'absoluta',
  },
  {
    codigo: 'IHHT_HTP_SEVERA',
    aplicaA: ['IHHT'],
    descripcion: 'Hipertensión pulmonar severa.',
    severidad: 'relativa',
  },
  {
    codigo: 'IHHT_INFECCION_RESPIRATORIA',
    aplicaA: ['IHHT'],
    descripcion: 'Infección respiratoria aguda.',
    severidad: 'relativa',
  },
  {
    codigo: 'IHHT_HTA_NO_CONTROLADA',
    aplicaA: ['IHHT'],
    descripcion: 'Hipertensión arterial no controlada (>180/110).',
    // Doc de admisión A.2 #7: bloquea IHHT.
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    // NUEVA (doc de admisión A.2 #8): la tabla solo tenía EPOC para HBOT
    // (`HBOT_EPOC_RETENCION_CO2`); la pregunta `ihht-epoc` no tenía código.
    codigo: 'IHHT_EPOC_SEVERO',
    aplicaA: ['IHHT'],
    descripcion: 'EPOC severo (estadio IV) o enfermedad pulmonar obstructiva avanzada.',
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    // NUEVA (doc de admisión A.2 #9): bloquea IHHT **y botas de compresión** —
    // la compresión neumática sobre una trombosis activa es el riesgo obvio, y
    // la tabla no cubría COMPRESION en ninguna entrada.
    codigo: 'IHHT_TVP_ACTIVA',
    aplicaA: ['IHHT', 'COMPRESION'],
    descripcion: 'Trombosis venosa profunda activa o reciente.',
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
];

export const CONTRAINDICACIONES_POR_CODIGO: ReadonlyMap<string, Contraindicacion> = new Map(
  CONTRAINDICACIONES.map((c) => [c.codigo, c]),
);
