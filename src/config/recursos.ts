/**
 * Recursos físicos agendables.
 *
 * Lista de 14 recursos: los 13 del Documento de Requerimientos v4 §6.2
 * (confirmados por Andrés, 2026-06-20) + el 2.º puesto IV del handoff v9
 * de Administración (2 puestos IV en agenda).
 *
 * `comparteCon` modela cuellos de botella de agenda (R-07): dos recursos que
 * comparten una misma clave NO pueden solaparse en la misma franja. Los dos
 * gabinetes Recovery Pro comparten las 2 tumbonas Red Light, por eso van
 * desfasados.
 */
import type { CategoriaServicio, RecursoFisico, TipoRecurso } from '../domain/types.js';

const TUMBONAS_RECOVERY = 'TUMBONAS_RECOVERY';

export const RECURSOS: RecursoFisico[] = [
  { codigo: 'R_HBOT_MONO', nombre: 'Cámara Hiperbárica Monoplaza', tipo: 'HBOT', capacidad: 1 },
  { codigo: 'R_HBOT_BIPLAZA', nombre: 'Cámara Hiperbárica Biplaza', tipo: 'HBOT', capacidad: 2 },
  { codigo: 'R_HBOT_MULTIPLAZA', nombre: 'Cámara Hiperbárica Multiplaza', tipo: 'HBOT', capacidad: 6 },
  { codigo: 'R_IHHT_1', nombre: 'Puesto IHHT 1 (JAY-20H)', tipo: 'IHHT', capacidad: 1 },
  { codigo: 'R_IHHT_2', nombre: 'Puesto IHHT 2 (JAY-20H)', tipo: 'IHHT', capacidad: 1 },
  {
    codigo: 'R_RECOVERY_G1',
    nombre: 'Recovery Pro — Gabinete 1',
    tipo: 'RECOVERY_PRO',
    capacidad: 2,
    comparteCon: [TUMBONAS_RECOVERY],
    nota: 'Comparte las 2 tumbonas Red Light con Gabinete 2 (R-07: desfasaje obligatorio).',
  },
  {
    codigo: 'R_RECOVERY_G2',
    nombre: 'Recovery Pro — Gabinete 2',
    tipo: 'RECOVERY_PRO',
    capacidad: 2,
    comparteCon: [TUMBONAS_RECOVERY],
    nota: 'Comparte las 2 tumbonas Red Light con Gabinete 1 (R-07: desfasaje obligatorio).',
  },
  { codigo: 'R_RED_LIGHT', nombre: 'Tumbona Red Light (standalone)', tipo: 'RED_LIGHT', capacidad: 1 },
  { codigo: 'R_IPC06', nombre: 'Botas Compression Recovery (IPC06)', tipo: 'COMPRESION', capacidad: 1 },
  { codigo: 'R_COT03', nombre: 'Crio Therapy (COT03)', tipo: 'CRIO', capacidad: 1 },
  { codigo: 'R_CAMILLA_MASAJES', nombre: 'Camilla de masajes', tipo: 'SALA', capacidad: 1 },
  { codigo: 'R_CONSULTORIO', nombre: 'Consultorio médico', tipo: 'CONSULTORIO', capacidad: 1 },
  { codigo: 'R_SALA_TB', nombre: 'Sala de Terapias Biológicas / IV', tipo: 'BOX_CLINICO', capacidad: 1 },
  {
    codigo: 'R_IV_2',
    nombre: 'Puesto IV 2',
    tipo: 'BOX_CLINICO',
    capacidad: 1,
    nota: 'Segundo puesto IV (handoff v9 Administración): permite 2 sesiones IV/TB en simultáneo.',
  },
];

export const RECURSOS_POR_CODIGO: ReadonlyMap<string, RecursoFisico> = new Map(
  RECURSOS.map((r) => [r.codigo, r]),
);

/** Tipo de recurso físico donde se ejecuta cada categoría de servicio. */
const CATEGORIA_A_TIPO: Record<CategoriaServicio, TipoRecurso> = {
  HBOT: 'HBOT',
  IHHT: 'IHHT',
  RED_LIGHT: 'RED_LIGHT',
  RECOVERY_PRO: 'RECOVERY_PRO',
  COMPRESION: 'COMPRESION',
  CRIO: 'CRIO',
  IV_THERAPY: 'BOX_CLINICO',
  TERAPIA_BIOLOGICA: 'BOX_CLINICO',
  MASAJE_OSTEOPATIA: 'SALA',
  CONSULTA: 'CONSULTORIO',
};

/** Recursos físicos donde se puede agendar un servicio de la categoría dada. */
export function recursosParaCategoria(categoria: CategoriaServicio): RecursoFisico[] {
  const tipo = CATEGORIA_A_TIPO[categoria];
  return RECURSOS.filter((r) => r.tipo === tipo);
}

/**
 * Devuelve true si dos recursos comparten algún equipo (cuello de botella),
 * por lo que sus turnos no pueden solaparse (R-07).
 */
export function compartenEquipo(codigoA: string, codigoB: string): boolean {
  if (codigoA === codigoB) {
    return true;
  }
  const a = RECURSOS_POR_CODIGO.get(codigoA);
  const b = RECURSOS_POR_CODIGO.get(codigoB);
  if (!a?.comparteCon || !b?.comparteCon) {
    return false;
  }
  return a.comparteCon.some((k) => b.comparteCon!.includes(k));
}
