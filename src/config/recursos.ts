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
import type { CategoriaServicio, ModalidadAtencion, RecursoFisico, TipoRecurso } from '../domain/types.js';

const TUMBONAS_RECOVERY = 'TUMBONAS_RECOVERY';

/**
 * La sala de videollamada. Es un código y no una elección: un turno virtual va
 * SIEMPRE acá, lo pida quien lo pida (`bw-reservar-turno` lo fuerza). Si el
 * mostrador pudiera elegir, una teleconsulta terminaría ocupando el consultorio
 * —el único que hay— y trabándoselo a un paciente que sí necesita venir.
 */
export const RECURSO_TELECONSULTA = 'R_TELECONSULTA';

export const RECURSOS: RecursoFisico[] = [
  { codigo: 'R_HBOT_MONO', nombre: 'Cámara Hiperbárica Monoplaza', tipo: 'HBOT', capacidad: 1 },
  {
    codigo: 'R_HBOT_BIPLAZA',
    nombre: 'Cámara Hiperbárica Biplaza',
    tipo: 'HBOT',
    capacidad: 2,
    reservaExclusiva: true,
    nota: 'Una reserva toma la cámara completa (1 persona a precio mono o 2 juntas). No comparten desconocidos.',
  },
  {
    codigo: 'R_HBOT_MULTIPLAZA',
    nombre: 'Cámara Hiperbárica Multiplaza',
    tipo: 'HBOT',
    capacidad: 6,
    minimoPersonas: 3,
    nota: 'Sesión grupal: hasta 6 personas de distintas reservas. Mínimo operativo 3 (advertencia, no bloqueo).',
  },
  { codigo: 'R_IHHT_1', nombre: 'Puesto IHHT 1 (JAY-20H)', tipo: 'IHHT', capacidad: 1 },
  { codigo: 'R_IHHT_2', nombre: 'Puesto IHHT 2 (JAY-20H)', tipo: 'IHHT', capacidad: 1 },
  {
    codigo: 'R_RECOVERY_G1',
    nombre: 'Recovery Pro — Gabinete 1',
    tipo: 'RECOVERY_PRO',
    capacidad: 2,
    reservaExclusiva: true,
    comparteCon: [TUMBONAS_RECOVERY],
    nota: 'Gabinete privado: una reserva lo toma completo (1 o 2 personas, USD 200 indivisible). Comparte las 2 tumbonas Red Light con Gabinete 2 (R-07: desfasaje obligatorio).',
  },
  {
    codigo: 'R_RECOVERY_G2',
    nombre: 'Recovery Pro — Gabinete 2',
    tipo: 'RECOVERY_PRO',
    capacidad: 2,
    reservaExclusiva: true,
    comparteCon: [TUMBONAS_RECOVERY],
    nota: 'Gabinete privado: una reserva lo toma completo (1 o 2 personas, USD 200 indivisible). Comparte las 2 tumbonas Red Light con Gabinete 1 (R-07: desfasaje obligatorio).',
  },
  { codigo: 'R_RED_LIGHT', nombre: 'Tumbona Red Light (standalone)', tipo: 'RED_LIGHT', capacidad: 1 },
  { codigo: 'R_IPC06', nombre: 'Botas Compression Recovery (IPC06)', tipo: 'COMPRESION', capacidad: 1 },
  { codigo: 'R_COT03', nombre: 'Crio Therapy (COT03)', tipo: 'CRIO', capacidad: 1 },
  { codigo: 'R_CAMILLA_MASAJES', nombre: 'Camilla de masajes', tipo: 'SALA', capacidad: 1 },
  { codigo: 'R_CONSULTORIO', nombre: 'Consultorio médico', tipo: 'CONSULTORIO', capacidad: 1 },
  /**
   * Teleconsulta: capacidad alta a propósito. Lo que limita una videollamada es
   * la agenda del profesional (un turno presencial y uno virtual del mismo
   * médico compiten por el mismo horario y por eso comparten Schedule), no un
   * lugar físico. Ponerle capacidad 1 inventaría un cuello que no existe.
   *
   * ⚠️ **Acá `capacidad` significa otra cosa que en las salas físicas.** En la
   * Multiplaza son personas que entran JUNTAS a la misma sesión; acá son
   * videollamadas que pueden convivir. Quien lea este número como "ocupantes
   * por reserva" va a ofrecer teleconsultas de 50 personas — le pasó al modal
   * de reserva (2026-09-17), que ahora saltea el tipo `VIRTUAL`.
   */
  { codigo: RECURSO_TELECONSULTA, nombre: 'Videollamada', tipo: 'VIRTUAL', capacidad: 50 },
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

/**
 * Recursos donde se puede agendar un servicio de la categoría dada.
 *
 * `modalidad: 'virtual'` devuelve la sala de videollamada en vez del
 * consultorio: la misma categoría `CONSULTA` se presta de las dos maneras y la
 * diferencia está en el servicio, no en la categoría. Sin el parámetro, todo se
 * comporta como siempre — el catálogo v9 entero es presencial.
 */
export function recursosParaCategoria(
  categoria: CategoriaServicio,
  modalidad: ModalidadAtencion = 'presencial',
): RecursoFisico[] {
  const tipo = modalidad === 'virtual' ? 'VIRTUAL' : CATEGORIA_A_TIPO[categoria];
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
