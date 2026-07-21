/**
 * Médicos que atienden en el consultorio.
 *
 * Hay UN solo consultorio (recurso R_CONSULTORIO, capacidad 1): tres médicos
 * distintos atienden ahí, nunca superpuestos (la regla R-07 de capacidad lo
 * garantiza). El precio de la consulta es por médico y está en ARS (pesos),
 * no en USD.
 */
export interface Medico {
  codigo: string;
  nombre: string;
  /** Director Médico (honorario fijo mensual, sin split por consulta). */
  esDirector: boolean;
  /** Precio de la consulta en ARS (pesos). */
  precioConsultaARS: number;
  /** Marca de precio provisorio (pendiente de confirmar). */
  precioProvisorio?: boolean;
}

export const MEDICOS: Medico[] = [
  { codigo: 'MED_DALESSANDRO', nombre: "Dr. Alejandro D'Alessandro", esDirector: false, precioConsultaARS: 120_000 },
  { codigo: 'MED_DOS_SANTOS', nombre: 'Dra. Stephanie Dos Santos', esDirector: false, precioConsultaARS: 120_000 },
  {
    codigo: 'MED_CONRADO',
    nombre: 'Dr. Conrado López Alonso',
    esDirector: true,
    // PROVISORIO: el Director Médico cobra más; confirmar monto con Andrés.
    precioConsultaARS: 150_000,
    precioProvisorio: true,
  },
];

export const MEDICOS_POR_CODIGO: ReadonlyMap<string, Medico> = new Map(MEDICOS.map((m) => [m.codigo, m]));

/** Código de servicio de consulta para un médico (p. ej. CONSULTA_MED_DALESSANDRO). */
export function codigoConsulta(medicoCodigo: string): string {
  return `CONSULTA_${medicoCodigo}`;
}
