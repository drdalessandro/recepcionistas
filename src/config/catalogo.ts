/**
 * Catálogo de servicios — Manual de Protocolos v9 (documento final).
 * Todos los precios en USD. Fuente de verdad de precios: el Manual.
 *
 * v9 final: IHHT vuelve a ser una única sesión (45 min / USD 90); las variantes
 * Express/Premium del changelog intermedio quedaron descartadas.
 */
import type { Servicio, Split } from '../domain/types.js';
import { MEDICOS, codigoConsulta } from './medicos.js';

const BW100: Split = { tipo: 'BW_100' };
const IV_TB: Split = { tipo: 'IV_TB_85_15', bw: 85, prescriptores: 15 };
const MASAJE: Split = { tipo: 'MASAJE_50_50', bw: 50, terapeuta: 50 };

export const SERVICIOS: Servicio[] = [
  // ---------------------- 01 · HBOT ----------------------
  {
    codigo: 'HBOT_MONO',
    nombre: 'HBOT Monoplaza',
    categoria: 'HBOT',
    duracionMin: 60,
    precioUSD: 165,
    requierePrescripcion: false,
    reglaPricing: 'HBOT_MONO',
    split: BW100,
    fmAplica: true,
  },
  {
    codigo: 'HBOT_BIPLAZA',
    nombre: 'HBOT Biplaza',
    categoria: 'HBOT',
    duracionMin: 60,
    precioUSD: 100, // por persona cuando van 2; 1 sola => precio monoplaza (165)
    requierePrescripcion: false,
    reglaPricing: 'HBOT_BIPLAZA',
    split: BW100,
    fmAplica: true,
    nota: '2 personas = USD 100 c/u (USD 200 total); 1 persona sola = USD 165.',
  },
  {
    codigo: 'HBOT_MULTIPLAZA',
    nombre: 'HBOT Multiplaza',
    categoria: 'HBOT',
    duracionMin: 60,
    precioUSD: 80, // por persona; mínimo 3, máximo 6 plazas
    requierePrescripcion: false,
    reglaPricing: 'HBOT_MULTIPLAZA',
    split: BW100,
    fmAplica: true,
    nota: 'USD 80/persona. Mínimo 3 personas, máximo 6 plazas.',
  },

  // ---------------------- 02 · IHHT (v9) ----------------------
  {
    codigo: 'IHHT',
    nombre: 'IHHT',
    categoria: 'IHHT',
    duracionMin: 45,
    precioUSD: 90,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: BW100,
    fmAplica: true,
    nota: 'Sesión individual 45 min. En combos dura 30 min pero lista a precio de sesión (USD 90).',
  },

  // ---------------------- 03 · RED LIGHT ----------------------
  {
    codigo: 'RED_LIGHT',
    nombre: 'Red Light (tumbona suelta)',
    categoria: 'RED_LIGHT',
    duracionMin: 30,
    precioUSD: 50,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: BW100,
    fmAplica: true,
  },

  // ---------------------- 04 · RECOVERY PRO ----------------------
  {
    codigo: 'RECOVERY_PRO',
    nombre: 'Recovery Pro (gabinete)',
    categoria: 'RECOVERY_PRO',
    duracionMin: 60,
    precioUSD: 200, // por gabinete, INDIVISIBLE, 1 o 2 personas
    requierePrescripcion: false,
    reglaPricing: 'RECOVERY_PRO_INDIVISIBLE',
    split: BW100,
    fmAplica: true,
    nota: 'USD 200 por gabinete, mismo precio 1 o 2 personas. Nunca por persona ni por componente.',
  },

  // ---------------------- 05 · BOTAS ----------------------
  {
    codigo: 'COMPRESION',
    nombre: 'Compression Recovery (IPC06)',
    categoria: 'COMPRESION',
    duracionMin: 30,
    precioUSD: 60,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: BW100,
    fmAplica: true,
  },
  {
    codigo: 'CRIO',
    nombre: 'Crio Therapy (COT03)',
    categoria: 'CRIO',
    duracionMin: 30,
    precioUSD: 90,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION',
    split: BW100,
    fmAplica: true,
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
    descripcion:
      'Tu evaluación inicial completa: consulta médica, orden de laboratorio y devolución con tu plan ' +
      "personalizado. Completá tu score de salud (Life's Essential 8) y arrancá tu protocolo con datos reales.",
    nota: 'Precio = consulta (2026-07-20); si cambia, ajustar acá y avisar al portal.',
  },
];

/**
 * Consultas médicas: una por médico. Precio en ARS (pesos), 45 min de atención +
 * 15 de descanso => el slot ocupa 60 min. Todas usan el único consultorio.
 */
function consultasDeMedicos(): Servicio[] {
  return MEDICOS.map((m) => ({
    codigo: codigoConsulta(m.codigo),
    nombre: `Consulta — ${m.nombre}`,
    categoria: 'CONSULTA' as const,
    duracionMin: 60,
    precioUSD: 0,
    precioARS: m.precioConsultaARS,
    practitionerCodigo: m.codigo,
    requierePrescripcion: false,
    reglaPricing: 'POR_SESION' as const,
    split: BW100,
    fmAplica: false,
    ...(m.precioProvisorio ? { nota: 'Precio provisorio (Director Médico) — confirmar' } : {}),
  }));
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
