import type { Appointment, Coverage, Patient } from '@medplum/fhirtypes';
import { getDisplayString } from '@medplum/core';
import { medplum } from '../medplum';
import { esPlanBW, estadoDeCoverage, planCodigoDeCoverage } from '@bw/fhir/coverage';
import { saldoPlan } from '@bw/lib/planes';
import { EXT } from '@bw/fhir/identifiers';
import { nombreYBase } from './planes';

/**
 * Dashboard "Planes y sesiones": cada cliente con plan activo, con las sesiones
 * repartidas en tres baldes y la urgencia para no perder las libres.
 *
 *   total = realizadas + proximas + libres
 *   - realizadas: sesiones ya consumidas que no son turnos futuros (pasadas).
 *   - proximas:   turnos futuros ya agendados con este plan (descuentan saldo).
 *   - libres:     saldo sin comprometer = lo que falta agendar antes de perderlo.
 *
 * Las sesiones NO usadas se pierden (membresía: al cerrar el mes; paquete: al
 * vencer), así que la urgencia ordena por lo que está por perderse.
 */
export type NivelUrgencia = 'critico' | 'pronto' | 'tranquilo' | 'sinAccion';

export interface FilaPlan {
  coverageId: string;
  pacienteId: string;
  pacienteNombre: string;
  tipo: 'membresia' | 'paquete';
  planNombre: string;
  total: number;
  realizadas: number;
  proximas: number;
  libres: number;
  /** El paquete ya venció (membresías no vencen, resetean por ciclo). */
  vencido: boolean;
  /** Días hasta el límite: fin de mes (membresía) o vencimiento (paquete). */
  diasRestantes: number;
  nivel: NivelUrgencia;
}

export interface PanelPlanes {
  filas: FilaPlan[];
  totalClientes: number;
  /** Clientes con sesiones libres en riesgo de perderse (nivel crítico/pronto). */
  enRiesgo: number;
}

const ESTADOS_OCULTOS = new Set(['cancelled', 'entered-in-error']);
const ORDEN_NIVEL: Record<NivelUrgencia, number> = { critico: 0, pronto: 1, tranquilo: 2, sinAccion: 3 };

const DIA_MS = 86_400_000;

function diasHasta(objetivo: Date, ahora: Date): number {
  return Math.ceil((objetivo.getTime() - ahora.getTime()) / DIA_MS);
}

function finDeMes(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

function nivelUrgencia(libres: number, vencido: boolean, dias: number): NivelUrgencia {
  if (libres <= 0) {
    return 'sinAccion';
  }
  if (vencido || dias <= 3) {
    return 'critico';
  }
  if (dias <= 7) {
    return 'pronto';
  }
  return 'tranquilo';
}

/** Carga todos los planes activos con sus baldes de sesiones y urgencia. */
export async function cargarPanelPlanes(ahora: Date = new Date()): Promise<PanelPlanes> {
  const coberturas = await medplum.searchResources('Coverage', { status: 'active', _count: 500 });

  // Turnos futuros agendados, para contar las "próximas" por cobertura.
  const proximosPorCobertura = new Map<string, number>();
  const apptsFuturos = await safe(() =>
    medplum.searchResources('Appointment', { date: `ge${ahora.toISOString()}`, _count: 1000 }),
  );
  for (const a of apptsFuturos as Appointment[]) {
    if (ESTADOS_OCULTOS.has(a.status ?? '')) {
      continue;
    }
    const ref = a.extension?.find((e) => e.url === EXT.coberturaUsada)?.valueString;
    const id = ref?.startsWith('Coverage/') ? ref.slice('Coverage/'.length) : undefined;
    if (id) {
      proximosPorCobertura.set(id, (proximosPorCobertura.get(id) ?? 0) + 1);
    }
  }

  // Nombres de pacientes (batch).
  const pacienteIds = [
    ...new Set(
      (coberturas as Coverage[])
        .map((c) => c.beneficiary?.reference)
        .filter((r): r is string => Boolean(r?.startsWith('Patient/')))
        .map((r) => r.slice('Patient/'.length)),
    ),
  ];
  const nombrePaciente = new Map<string, string>();
  if (pacienteIds.length > 0) {
    const pacientes = await safe(() =>
      medplum.searchResources('Patient', { _id: pacienteIds.join(','), _count: pacienteIds.length }),
    );
    for (const p of pacientes as Patient[]) {
      if (p.id) {
        nombrePaciente.set(p.id, getDisplayString(p));
      }
    }
  }

  const filas: FilaPlan[] = [];
  for (const c of coberturas as Coverage[]) {
    // La obra social del paciente (portal, ActCode HIP) no es un plan BW.
    if (!esPlanBW(c)) {
      continue;
    }
    const planCodigo = planCodigoDeCoverage(c);
    const pacienteId = c.beneficiary?.reference?.slice('Patient/'.length);
    if (!c.id || !planCodigo || !pacienteId) {
      continue;
    }
    const estado = estadoDeCoverage(c);
    const saldo = saldoPlan(estado, ahora);
    const { nombre } = nombreYBase(estado.tipo, planCodigo);

    const libres = saldo.restantes;
    const proximas = Math.min(proximosPorCobertura.get(c.id) ?? 0, estado.usadas);
    const realizadas = Math.max(estado.usadas - proximas, 0);

    const limite = estado.tipo === 'paquete' && estado.vencimiento ? new Date(estado.vencimiento) : finDeMes(ahora);
    const diasRestantes = Math.max(diasHasta(limite, ahora), saldo.vencido ? Number.NEGATIVE_INFINITY : 0);

    filas.push({
      coverageId: c.id,
      pacienteId,
      pacienteNombre: nombrePaciente.get(pacienteId) ?? 'Paciente',
      tipo: estado.tipo,
      planNombre: nombre,
      total: estado.total,
      realizadas,
      proximas,
      libres,
      vencido: saldo.vencido,
      diasRestantes: saldo.vencido ? 0 : Math.max(diasHasta(limite, ahora), 0),
      nivel: nivelUrgencia(libres, saldo.vencido, diasRestantes),
    });
  }

  filas.sort(
    (a, b) =>
      ORDEN_NIVEL[a.nivel] - ORDEN_NIVEL[b.nivel] ||
      a.diasRestantes - b.diasRestantes ||
      b.libres - a.libres ||
      a.pacienteNombre.localeCompare(b.pacienteNombre),
  );

  const enRiesgo = filas.filter((f) => f.nivel === 'critico' || f.nivel === 'pronto').length;
  return { filas, totalClientes: filas.length, enRiesgo };
}

async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}
