/**
 * Andamios compartidos por los tests del motor de agenda.
 *
 * Fechas de referencia (verificadas): en 2026, el 17 de agosto cae **lunes**,
 * el 22 **sábado** y el 23 **domingo**.
 */

import {
  CANTIDADES_SAN_ISIDRO,
  compilarConfig,
  configSanIsidro,
  instanteLocal,
  RELOJ_BUENOS_AIRES,
  sumarMinutos,
  type AgendaOcupada,
  type CantidadesRecursos,
  type Cliente,
  type MotorCompilado,
  type Ocupacion,
  type Titularidad,
} from '../../src/motor-agenda/index.js';

export const RELOJ = RELOJ_BUENOS_AIRES;

/** Un lunes cualquiera, a la hora que se pida. */
export function lunes(hora: number, minuto = 0): Date {
  return instanteLocal(2026, 8, 17, hora, minuto, RELOJ);
}

/** Un sábado (el centro cierra a las 20:00). */
export function sabado(hora: number, minuto = 0): Date {
  return instanteLocal(2026, 8, 22, hora, minuto, RELOJ);
}

/** Un domingo (el centro no abre). */
export function domingo(hora: number, minuto = 0): Date {
  return instanteLocal(2026, 8, 23, hora, minuto, RELOJ);
}

/** Motor con la configuración real del centro. */
export function motorDePrueba(cantidades?: Partial<CantidadesRecursos>): MotorCompilado {
  return compilarConfig(
    configSanIsidro(
      cantidades ? { cantidades: { ...CANTIDADES_SAN_ISIDRO, ...cantidades } } : {},
    ),
  );
}

/** Un momento razonable para estar reservando un turno: dos horas antes. */
export function dosHorasAntes(inicio: Date): Date {
  return sumarMinutos(inicio, -120);
}

/** Cliente del público general, sin membresía ni autorizaciones. */
export function clientePublico(parcial: Partial<Cliente> = {}): Cliente {
  return {
    id: 'paciente-1',
    categoria: 'publico',
    tagFoundingMember: false,
    enMora: false,
    autorizaciones: [],
    ...parcial,
  };
}

/** Titularidad activa de membresía, con los valores que se pidan. */
export function titularidadActiva(parcial: Partial<Titularidad> = {}): Titularidad {
  return {
    membresia: 'FOCUS',
    modalidad: 'standard',
    formato: 'individual',
    plazo: 'trimestral',
    estado: 'activa',
    inicioCiclo: instanteLocal(2026, 8, 1, 0, 0, RELOJ),
    finCiclo: instanteLocal(2026, 8, 31, 23, 59, RELOJ),
    sesionesAsignadas: 8,
    sesionesUsadas: 0,
    pausas: [],
    ...parcial,
  };
}

/** Agenda con las ocupaciones que se le pasen. */
export function agendaCon(...ocupaciones: Ocupacion[]): AgendaOcupada {
  return { ocupaciones };
}

/** Una ocupación cruda, para simular lo que ya hay reservado. */
export function ocupar(
  unidadId: string,
  inicio: Date,
  finMinutos: number,
  motivo = 'reserva previa',
): Ocupacion {
  return {
    unidadId,
    tipoRecurso: 'tumbona-red-light',
    inicio,
    fin: sumarMinutos(inicio, finMinutos),
    motivo,
    plazas: 1,
  };
}

/** Códigos de rechazo de un resultado fallido, para asertar sin ruido. */
export function codigosDeRechazo(resultado: {
  ok: boolean;
  rechazos?: readonly { codigo: string }[];
}): string[] {
  return resultado.ok ? [] : (resultado.rechazos ?? []).map((r) => r.codigo);
}
