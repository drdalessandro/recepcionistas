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
    severidad: 'relativa',
  },
  {
    codigo: 'HBOT_CONVULSIONES',
    aplicaA: ['HBOT'],
    descripcion: 'Antecedente de convulsiones no controladas / epilepsia.',
    severidad: 'relativa',
  },
  {
    codigo: 'HBOT_FIEBRE_ALTA',
    aplicaA: ['HBOT'],
    descripcion: 'Fiebre alta (umbral convulsivo reducido).',
    severidad: 'relativa',
  },
  {
    codigo: 'HBOT_CLAUSTROFOBIA',
    aplicaA: ['HBOT'],
    descripcion: 'Claustrofobia severa.',
    severidad: 'relativa',
  },
  {
    codigo: 'HBOT_EMBARAZO',
    aplicaA: ['HBOT', 'IHHT'],
    descripcion: 'Embarazo (evaluación médica requerida).',
    severidad: 'relativa',
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
    descripcion: 'Hipertensión arterial no controlada.',
    severidad: 'relativa',
  },
];

export const CONTRAINDICACIONES_POR_CODIGO: ReadonlyMap<string, Contraindicacion> = new Map(
  CONTRAINDICACIONES.map((c) => [c.codigo, c]),
);
