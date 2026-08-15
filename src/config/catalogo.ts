/**
 * Catálogo de servicios — Manual de Protocolos v9 (documento final).
 * Todos los precios en USD. Fuente de verdad de precios: el Manual.
 *
 * v9 final: IHHT vuelve a ser una única sesión (30 min / USD 90); las variantes
 * Express/Premium del changelog intermedio quedaron descartadas. La duración
 * pasó de 45 a 30 el 2026-08-15 (Andrés): ver la nota del servicio.
 *
 * Catálogo COMERCIAL (handoff v2, 2026-07-21): la góndola del portal se ordena
 * por valor y prestigio, no alfabético (`orden`, de a 10 para intercalar), los
 * títulos son nombres comerciales y las descripciones van en voz de paciente.
 * Regla de oro: los CÓDIGOS jamás cambian (contrato con portal/bots/Admin);
 * los códigos de equipo (IPC06, COT03) salen de los títulos visibles.
 */
import type { CategoriaServicio, Servicio, Split } from '../domain/types.js';
import { MEDICOS, MEDICOS_POR_CODIGO, codigoConsulta } from './medicos.js';

const BW100: Split = { tipo: 'BW_100' };
const IV_TB: Split = { tipo: 'IV_TB_85_15', bw: 85, prescriptores: 15 };
const MASAJE: Split = { tipo: 'MASAJE_50_50', bw: 50, terapeuta: 50 };

/**
 * Etiqueta COMERCIAL de cada categoría (→ `ActivityDefinition.topic`, lo que
 * muestra el portal como sección). El código interno de categoría no cambia:
 * lo usan R-07, el mapeo a recursos y el pricing.
 */
export const CATEGORIA_COMERCIAL: Record<CategoriaServicio, string> = {
  CONSULTA: 'Evaluación',
  HBOT: 'Cámara Hiperbárica',
  IHHT: 'IHHT',
  RECOVERY_PRO: 'Recovery',
  RED_LIGHT: 'Red Light',
  COMPRESION: 'Compresión',
  CRIO: 'Crioterapia',
  MASAJE_OSTEOPATIA: 'Masajes y Osteopatía',
  IV_THERAPY: 'Terapias IV',
  TERAPIA_BIOLOGICA: 'Terapias Biológicas',
};

// Descripciones compartidas por grupo (los nombres propios se mantienen).
const DESC_CONSULTA =
  'La puerta de entrada a tu protocolo: evaluación integral, revisión de tus biomarcadores y plan personalizado.';
const DESC_CONSULTA_CONRADO =
  'Consultas médicas traumatológicas y de Medicina del Deporte de Alto Rendimiento. No realiza las Evaluaciones ' +
  'Biowellness: para tu evaluación inicial, elegí una Consulta Evaluación o el Chequeo Biowellness.';

/**
 * Addendum 2.1 (2026-07-21) + correcciones vistas en producción (misma tarde):
 * las consultas se SEPARAN en la góndola. Las dos de evaluación viven en la
 * sección "Consulta Médica" como producto "Evaluación Biowellness" — SIN el
 * nombre del médico en el título: el paciente lo elige al reservar (selector
 * de médicos del portal; la Dra. Dos Santos primera, 11 < 12). El Dr. Conrado
 * tiene sección propia y su descripción aclara que NO hace las Evaluaciones.
 * Un médico nuevo cae al default. Para RECEPCIÓN el médico se re-agrega en el
 * display (`nombreServicioRecepcion`): el mostrador sí distingue los códigos.
 */
const CONSULTAS_COMERCIAL: Record<
  string,
  { orden: number; categoriaComercial: string; descripcion: string; nombre?: string }
> = {
  CONSULTA_MED_DOS_SANTOS: { orden: 11, categoriaComercial: 'Consulta Médica', descripcion: DESC_CONSULTA, nombre: 'Evaluación Biowellness' },
  CONSULTA_MED_DALESSANDRO: { orden: 12, categoriaComercial: 'Consulta Médica', descripcion: DESC_CONSULTA, nombre: 'Evaluación Biowellness' },
  CONSULTA_MED_CONRADO: { orden: 13, categoriaComercial: 'Consulta Director Médico', descripcion: DESC_CONSULTA_CONRADO },
};
const DESC_IV =
  'Vitaminas, minerales y antioxidantes directo en sangre, según tu objetivo. Siempre con evaluación médica previa.';
const DESC_TB = 'Medicina regenerativa avanzada con indicación médica personalizada. El primer paso es la consulta.';
const DESC_MASAJES = 'Trabajo manual profesional para soltar tensiones y complementar tu protocolo.';

export const SERVICIOS: Servicio[] = [
  // ---------------------- 01 · HBOT ----------------------
  {
    codigo: 'HBOT_MONO',
    nombre: 'Cámara Hiperbárica (HBOT) — Monoplaza',
    categoria: 'HBOT',
    duracionMin: 60,
    precioUSD: 165,
    requierePrescripcion: false,
    reglaPricing: 'HBOT_MONO',
    split: BW100,
    fmAplica: true,
    orden: 20,
    descripcion:
      'Hasta 6 veces más oxígeno en tus células: regeneración profunda, menos inflamación, mejor recuperación. ' +
      'Sesión individual, acostado y cómodo.',
  },
  {
    codigo: 'HBOT_BIPLAZA',
    nombre: 'Cámara Hiperbárica (HBOT) — Biplaza (2 personas)',
    categoria: 'HBOT',
    duracionMin: 60,
    precioUSD: 100, // por persona cuando van 2; 1 sola => precio monoplaza (165)
    requierePrescripcion: false,
    reglaPricing: 'HBOT_BIPLAZA',
    split: BW100,
    fmAplica: true,
    orden: 21,
    descripcion: 'La misma terapia, compartida: para dos personas en simultáneo.',
    nota: '2 personas = USD 100 c/u (USD 200 total); 1 persona sola = USD 165.',
  },
  {
    codigo: 'HBOT_MULTIPLAZA',
    nombre: 'Cámara Hiperbárica (HBOT) — Multiplaza (grupal)',
    categoria: 'HBOT',
    duracionMin: 60,
    precioUSD: 80, // por persona; mínimo 3, máximo 6 plazas
    requierePrescripcion: false,
    reglaPricing: 'HBOT_MULTIPLAZA',
    split: BW100,
    fmAplica: true,
    orden: 22,
    descripcion: 'Sesión grupal de hasta 6 personas — sumate a un grupo.',
    nota: 'USD 80/persona. Mínimo 3 personas, máximo 6 plazas.',
  },

  // ---------------------- 02 · IHHT (v9) ----------------------
  {
    codigo: 'IHHT',
    nombre: 'Entrenamiento Hipóxico-Hiperóxico Intermitente (IHHT)',
    categoria: 'IHHT',
    // 30 y no 45 (Andrés, 2026-08-15). Hasta acá el catálogo decía 45 para la
    // sesión suelta y 30 dentro de los combos, y las dos cosas eran ciertas a la
    // vez en la misma app: `/servicios` mostraba "45 minutos" y `/combos` armaba
    // los bloques con 30. Además 30 es **el único valor que hace verdaderas las
    // seis duraciones de combo publicadas** (60/60/60/90/120/150): con 45, Bio
    // Energy daría 75 y Bio Longevity 165. El precio no cambia: sigue USD 90.
    duracionMin: 30,
    precioUSD: 90,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: BW100,
    fmAplica: true,
    orden: 30,
    descripcion:
      'Como entrenar tus células en la altura de los Andes sin salir de San Isidro: ciclos de hipoxia e ' +
      'hiperoxia que fortalecen tus mitocondrias en 30 minutos.',
    nota: 'Sesión de 30 min, suelta o dentro de un combo. USD 90 en los dos casos.',
  },

  // ---------------------- 03 · RED LIGHT ----------------------
  {
    codigo: 'RED_LIGHT',
    nombre: 'Red Light — Fotobiomodulación',
    categoria: 'RED_LIGHT',
    duracionMin: 30,
    precioUSD: 50,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: BW100,
    fmAplica: true,
    orden: 50,
    descripcion: 'Luz roja e infrarroja que estimula la reparación de la piel y desinflama músculos y articulaciones en 30 minutos.',
    nota: 'Tumbona suelta (fuera del gabinete Recovery).',
  },

  // ---------------------- 04 · RECOVERY PRO ----------------------
  {
    codigo: 'RECOVERY_PRO',
    nombre: 'Recovery Pro',
    categoria: 'RECOVERY_PRO',
    duracionMin: 60,
    precioUSD: 200, // por gabinete, INDIVISIBLE, 1 o 2 personas
    requierePrescripcion: false,
    reglaPricing: 'RECOVERY_PRO_INDIVISIBLE',
    split: BW100,
    fmAplica: true,
    orden: 40,
    descripcion:
      'El circuito completo que usan los centros de longevidad del mundo — sauna infrarrojo, frío y red light — ' +
      'en un gabinete privado.',
    nota: 'USD 200 por gabinete, mismo precio 1 o 2 personas. Nunca por persona ni por componente.',
  },

  // ---------------------- 05 · BOTAS ----------------------
  {
    codigo: 'COMPRESION',
    nombre: 'Compresión Neumática',
    categoria: 'COMPRESION',
    duracionMin: 30,
    precioUSD: 60,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: BW100,
    fmAplica: true,
    orden: 60,
    descripcion:
      'Compresión neumática de piernas que activa el drenaje linfático: menos retención, piernas livianas, ' +
      'mejor recuperación deportiva.',
    nota: 'Equipo: IPC06 (código interno, fuera del título visible).',
  },
  {
    codigo: 'CRIO',
    nombre: 'Crioterapia Localizada',
    categoria: 'CRIO',
    duracionMin: 30,
    precioUSD: 90,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: BW100,
    fmAplica: true,
    orden: 70,
    descripcion: 'Frío de precisión para desinflamar lesiones, calmar dolor articular y recuperar zonas puntuales.',
    nota: 'Equipo: COT03 (código interno, fuera del título visible).',
  },

  // ---------------------- 06 · IV THERAPY (add-on, requiere prescripción) ----------------------
  {
    codigo: 'IV_HIDRATACION',
    nombre: 'IV Hidratación',
    categoria: 'IV_THERAPY',
    duracionMin: 30,
    precioUSD: 120,
    requierePrescripcion: true,
    reglaPricing: 'CASCADA_TB',
    split: IV_TB,
    fmAplica: false,
    orden: 90,
    descripcion: DESC_IV,
  },
  {
    codigo: 'IV_PERFORMANCE',
    nombre: 'IV Performance',
    categoria: 'IV_THERAPY',
    duracionMin: 45,
    precioUSD: 180,
    requierePrescripcion: true,
    reglaPricing: 'CASCADA_TB',
    split: IV_TB,
    fmAplica: false,
    orden: 90,
    descripcion: DESC_IV,
  },
  {
    codigo: 'IV_NAD',
    nombre: 'IV Anti-Aging NAD+',
    categoria: 'IV_THERAPY',
    duracionMin: 45,
    precioUSD: 250,
    requierePrescripcion: true,
    reglaPricing: 'CASCADA_TB',
    split: IV_TB,
    fmAplica: false,
    orden: 90,
    descripcion: DESC_IV,
  },

  // ---------------------- 07 · TERAPIAS BIOLÓGICAS (requieren prescripción) ----------------------
  ...tb('PRP', 'PRP — Plasma Rico en Plaquetas', 45, 400),
  ...tb('PEPTIDOS_G1', 'Péptidos Bioactivos G1 (36 péptidos)', 30, 480),
  ...tb('PEPTIDOS_G2', 'Péptidos Bioactivos G2 (13 péptidos)', 30, 800),
  ...tb('PEPTIDOS_G3', 'Péptidos Bioactivos G3 (5 productos)', 30, 910),
  ...tb('EXOSOMAS', 'Exosomas — paquete 3 ampollas', 45, 450),
  ...tb('LISADO_PLAQUETARIO', 'Lisado Plaquetario', 45, 900),
  ...tb('AC_HIALURONICO_APM', 'Ácido Hialurónico APM', 45, 600),
  ...tb('COLIRIO_PLASMA', 'Colirio de Plasma', 30, 365),
  ...tb('PRP_BIOFILLER_ESTETICO', 'PRP Biofiller estético', 45, 900),
  ...tb('CREMA_DERMATO', 'Crema Dermato (por frasco)', 0, 150),
  ...tb('CELULAS_MADRE', 'Células Madre (Concentrado Celular)', 60, 2500),
  ...tb('COLIRIO_PLASMA_COAGULO', 'Colirio de Plasma Coágulo', 30, 480),
  ...tb('EXPANSION_10MM', 'Expansión Celular 10MM (1 aplicación)', 60, 1900),
  ...tb('EXPANSION_20MM', 'Expansión Celular 20MM (1 aplicación)', 60, 2700),
  ...tb('EXPANSION_30MM', 'Expansión Celular 30MM (3 aplicaciones)', 60, 2900),
  ...tb('EXPANSION_60MM', 'Expansión Celular 60MM (3 aplicaciones)', 60, 3350),
  ...tb('AC_HIALURONICO_BPM', 'Ácido Hialurónico BPM', 45, 220),
  ...tb('PRP_BIOFILLER_TRAUMATICO', 'PRP Biofiller Traumático', 45, 365),

  // ---------------------- 08 · MASAJES Y OSTEOPATÍA (add-ons, split 50/50) ----------------------
  {
    codigo: 'MASAJE_DESCONTRACTURANTE',
    nombre: 'Masaje Descontracturante',
    categoria: 'MASAJE_OSTEOPATIA',
    duracionMin: 60,
    precioUSD: 80,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: MASAJE,
    fmAplica: false, // confirmar si FM aplica a masajes
    orden: 80,
    descripcion: DESC_MASAJES,
  },
  {
    codigo: 'MASAJE_DEPORTIVO',
    nombre: 'Masaje Deportivo',
    categoria: 'MASAJE_OSTEOPATIA',
    duracionMin: 60,
    precioUSD: 90,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: MASAJE,
    fmAplica: false,
    orden: 80,
    descripcion: DESC_MASAJES,
  },
  {
    codigo: 'OSTEOPATIA',
    nombre: 'Osteopatía',
    categoria: 'MASAJE_OSTEOPATIA',
    duracionMin: 60,
    precioUSD: 100,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: MASAJE,
    fmAplica: false,
    orden: 80,
    descripcion: DESC_MASAJES,
  },

  // ---------------------- 09 · CONSULTAS MÉDICAS (consultorio, precio en ARS) ----------------------
  ...consultasDeMedicos(),

  // ---------------------- 10 · CHEQUEO BIOWELLNESS (evaluación inicial — journey del portal) ----------------------
  // Producto de entrada (decisiones de Andrés 2026-07-20): precio = consulta;
  // devolución con Dalessandro o Dos Santos indistinto (sin practitionerCodigo);
  // la orden de laboratorio NO se cobra (el paciente la resuelve por su
  // cobertura y sube el PDF al portal). Comparte consultorio y reglas R-07.
  {
    codigo: 'CHEQUEO_BW',
    nombre: 'Chequeo Biowellness',
    categoria: 'CONSULTA',
    duracionMin: 60,
    precioUSD: 0,
    precioARS: 120_000,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: BW100,
    fmAplica: false,
    orden: 10, // la góndola arranca acá: el producto de entrada, arriba de todo
    descripcion:
      'Tu evaluación inicial completa: consulta médica, orden de laboratorio y devolución con tu plan personalizado.',
    nota: 'Precio = consulta (2026-07-20); si cambia, ajustar acá y avisar al portal.',
  },
];

/**
 * Consultas médicas: una por médico. Precio en ARS (pesos), 45 min de atención +
 * 15 de descanso => el slot ocupa 60 min. Todas usan el único consultorio.
 */
function consultasDeMedicos(): Servicio[] {
  return MEDICOS.map((m) => {
    const codigo = codigoConsulta(m.codigo);
    const comercial = CONSULTAS_COMERCIAL[codigo] ?? {
      orden: 11,
      categoriaComercial: 'Consulta Médica',
      descripcion: DESC_CONSULTA,
    };
    return {
      codigo,
      nombre: `Consulta médica — ${m.nombre}`,
      categoria: 'CONSULTA' as const,
      duracionMin: 60,
      precioUSD: 0,
      precioARS: m.precioConsultaARS,
      practitionerCodigo: m.codigo,
      requierePrescripcion: false,
      reglaPricing: 'POR_SESION' as const,
      split: BW100,
      fmAplica: false,
      ...comercial,
      ...(m.precioProvisorio ? { nota: 'Precio provisorio (Director Médico) — confirmar' } : {}),
    };
  });
}

/** Helper para Terapias Biológicas (todas comparten split, regla y flags). */
function tb(codigo: string, nombre: string, duracionMin: number, precioUSD: number): Servicio[] {
  return [
    {
      codigo,
      nombre,
      categoria: 'TERAPIA_BIOLOGICA',
      duracionMin,
      precioUSD,
      requierePrescripcion: true,
      reglaPricing: 'CASCADA_TB',
      split: IV_TB,
      fmAplica: false,
      // IV/Biológicas cierran la góndola A PROPÓSITO: con su badge "requiere
      // consulta médica" son el final aspiracional del catálogo, no un descarte.
      orden: 95,
      descripcion: DESC_TB,
    },
  ];
}

/** Índice por código para lookups O(1). */
export const SERVICIOS_POR_CODIGO: ReadonlyMap<string, Servicio> = new Map(
  SERVICIOS.map((s) => [s.codigo, s]),
);

export function getServicio(codigo: string): Servicio {
  const s = SERVICIOS_POR_CODIGO.get(codigo);
  if (!s) {
    throw new Error(`Servicio desconocido: ${codigo}`);
  }
  return s;
}

/**
 * Nombre para las pantallas de RECEPCIÓN y los WhatsApps: si el título
 * comercial no menciona al médico (la góndola muestra "Evaluación Biowellness"
 * a secas y el paciente lo elige al reservar), acá se re-agrega — el mostrador
 * y la confirmación del turno sí tienen que decir con quién es.
 */
export function nombreServicioRecepcion(s: Servicio): string {
  const medico = s.practitionerCodigo ? MEDICOS_POR_CODIGO.get(s.practitionerCodigo) : undefined;
  if (!medico || s.nombre.includes(medico.nombre)) {
    return s.nombre;
  }
  return `${s.nombre} — ${medico.nombre}`;
}
