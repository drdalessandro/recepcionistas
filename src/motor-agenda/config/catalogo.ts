/**
 * Catálogo: servicios sueltos y combos.
 *
 * Un combo declara **qué** servicios y en **qué orden**, nunca en qué minuto.
 * Los offsets los deriva el expansor encadenando la salida del cliente de un
 * tramo con la grilla de inicio del recurso del siguiente. `duracionPublicadaMin`
 * está sólo para que el validador contraste el modelo contra el Manual y avise
 * si discrepan.
 */

import type { Combo, Servicio } from '../dominio/tipos.js';

export const SERVICIOS: readonly Servicio[] = [
  {
    codigo: 'HBOT_MONOPLAZA',
    nombre: 'Cámara hiperbárica monoplaza',
    tipoRecurso: 'hbot-monoplaza',
    requiereAutorizacionMedica: false,
    soloFranjaClinica: false,
  },
  {
    codigo: 'HBOT_BIPLAZA',
    nombre: 'Cámara hiperbárica biplaza',
    tipoRecurso: 'hbot-biplaza',
    requiereAutorizacionMedica: false,
    soloFranjaClinica: false,
  },
  {
    codigo: 'HBOT_MULTIPLAZA',
    nombre: 'Cámara hiperbárica multiplaza',
    tipoRecurso: 'hbot-multiplaza',
    requiereAutorizacionMedica: false,
    soloFranjaClinica: false,
  },
  {
    codigo: 'IHHT',
    nombre: 'IHHT',
    tipoRecurso: 'ihht',
    requiereAutorizacionMedica: false,
    soloFranjaClinica: false,
  },
  {
    codigo: 'RED_LIGHT',
    nombre: 'Red Light',
    tipoRecurso: 'tumbona-red-light',
    requiereAutorizacionMedica: false,
    soloFranjaClinica: false,
  },
  {
    codigo: 'RECOVERY_PRO',
    nombre: 'Recovery Pro',
    tipoRecurso: 'recovery-pro',
    requiereAutorizacionMedica: false,
    soloFranjaClinica: false,
  },
  {
    codigo: 'COMPRESION',
    nombre: 'Compresión neumática',
    tipoRecurso: 'compresion',
    requiereAutorizacionMedica: false,
    soloFranjaClinica: false,
  },
  {
    codigo: 'CRIOTERAPIA',
    nombre: 'Crioterapia',
    tipoRecurso: 'crioterapia',
    requiereAutorizacionMedica: false,
    soloFranjaClinica: false,
  },
  {
    codigo: 'MASAJE',
    nombre: 'Masaje',
    tipoRecurso: 'camilla-masajes',
    requiereAutorizacionMedica: false,
    soloFranjaClinica: false,
  },
  {
    codigo: 'CONSULTA_MEDICA',
    nombre: 'Consulta médica',
    tipoRecurso: 'consultorio',
    requiereAutorizacionMedica: false,
    soloFranjaClinica: false,
  },
  // R-03 + franja clínica: toda IV y toda TB, sin excepción.
  {
    codigo: 'IV_THERAPY',
    nombre: 'IV Therapy',
    tipoRecurso: 'puesto-iv',
    requiereAutorizacionMedica: true,
    soloFranjaClinica: true,
  },
  {
    codigo: 'TERAPIA_BIOLOGICA',
    nombre: 'Terapia Biológica',
    tipoRecurso: 'sala-tb',
    requiereAutorizacionMedica: true,
    soloFranjaClinica: true,
  },
];

/**
 * Los tres tramos de cámara posibles, en orden de preferencia.
 *
 * El expansor prueba en orden y se queda con la primera que cierra: con dos
 * ocupantes la monoplaza no entra, así que sale biplaza, que es justamente la
 * combinación que encadena sin fricción hacia los dos puestos de IHHT.
 */
const CAMARAS = ['HBOT_MONOPLAZA', 'HBOT_BIPLAZA', 'HBOT_MULTIPLAZA'] as const;

export const COMBOS: readonly Combo[] = [
  {
    codigo: 'BIO_ENERGY',
    nombre: 'Bio Energy',
    tramos: [
      { orden: 1, servicios: ['IHHT'] },
      { orden: 2, servicios: ['RED_LIGHT'] },
    ],
    duracionPublicadaMin: 60,
  },
  {
    codigo: 'BIO_OXYGEN',
    nombre: 'Bio Oxygen',
    tramos: [
      { orden: 1, servicios: [...CAMARAS] },
      { orden: 2, servicios: ['IHHT'] },
    ],
    duracionPublicadaMin: 90,
  },
  {
    codigo: 'BIO_RECOVERY',
    nombre: 'Bio Recovery',
    tramos: [
      { orden: 1, servicios: [...CAMARAS] },
      { orden: 2, servicios: ['RECOVERY_PRO'] },
    ],
    duracionPublicadaMin: 120,
  },
  {
    codigo: 'BIO_LONGEVITY',
    nombre: 'Bio Longevity',
    tramos: [
      { orden: 1, servicios: [...CAMARAS] },
      { orden: 2, servicios: ['IHHT'] },
      { orden: 3, servicios: ['RECOVERY_PRO'] },
    ],
    // El Manual v9 y el sitio publican 150. El modelo lo reproduce solo:
    // HBOT 0-60 (el cliente sale a los 55) → IHHT 60-90 (sale a los 85) →
    // Recovery Pro 90-150, porque el gabinete abre cada 30 minutos. El validador
    // contrasta esta duración publicada contra la derivada y avisa si difieren.
    duracionPublicadaMin: 150,
  },
  {
    codigo: 'BIO_COMPRESS',
    nombre: 'Bio Compress',
    tramos: [
      { orden: 1, servicios: ['COMPRESION'] },
      { orden: 2, servicios: ['RED_LIGHT'] },
    ],
    duracionPublicadaMin: 60,
  },
];
