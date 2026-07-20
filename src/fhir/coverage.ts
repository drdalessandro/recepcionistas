/**
 * Lectura de planes desde recursos Coverage (membresías y paquetes).
 * Lo usan los bots y el front para calcular el saldo (`saldoPlan`).
 */
import type { Coverage } from '@medplum/fhirtypes';
import { EXT } from './identifiers.js';
import type { EstadoPlan, TipoCobertura } from '../lib/planes.js';

export function estadoDeCoverage(c: Coverage): EstadoPlan {
  const tipo = (c.extension?.find((e) => e.url === EXT.tipoCobertura)?.valueCode ?? 'membresia') as TipoCobertura;
  const totalUrl = tipo === 'membresia' ? EXT.sesionesMes : EXT.sesionesTotal;
  const total = c.extension?.find((e) => e.url === totalUrl)?.valueInteger ?? 0;
  const usadas = c.extension?.find((e) => e.url === EXT.sesionesUsadas)?.valueInteger ?? 0;
  return { tipo, total, usadas, vencimiento: c.period?.end, activo: c.status === 'active' };
}

export function planCodigoDeCoverage(c: Coverage): string | undefined {
  return c.extension?.find((e) => e.url === EXT.planCodigo)?.valueString;
}

/**
 * ¿Es un plan BioWellness (membresía/paquete)? Un Coverage del paciente puede
 * ser también su obra social/prepaga, registrada desde el portal (type ActCode
 * HIP, sin extensiones BW): esa NUNCA es un plan — no lista sesiones, no se
 * renueva ni se cobra. Ojo: `estadoDeCoverage` defaulta `tipo` a 'membresia'
 * cuando falta la extensión, así que todo listado de planes debe filtrar por
 * este marcador ANTES de interpretar el estado.
 */
export function esPlanBW(c: Coverage): boolean {
  return Boolean(
    c.extension?.some(
      (e) =>
        e.url === EXT.tipoCobertura || e.url === EXT.planCodigo || e.url === EXT.sesionesMes || e.url === EXT.sesionesTotal,
    ),
  );
}
