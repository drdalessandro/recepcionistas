import type { Coverage } from '@medplum/fhirtypes';
import { medplum } from '../medplum';
import { estadoDeCoverage, planCodigoDeCoverage } from '@bw/fhir/coverage';
import { saldoPlan, type EstadoPlan, type SaldoPlan } from '@bw/lib/planes';
import { MEMBRESIAS_POR_CODIGO } from '@bw/config/membresias';
import { PAQUETES_POR_CODIGO } from '@bw/config/paquetes';

/** Plan activo de un paciente con su saldo ya calculado (para mostrar/usar). */
export interface PlanPaciente {
  coverage: Coverage;
  coverageId: string;
  planCodigo: string;
  estado: EstadoPlan;
  saldo: SaldoPlan;
  nombre: string;
  /** Código base que cubre el plan: combo (membresía) o servicio (paquete). */
  baseCodigo: string;
  /** Coverage `draft`: asignado con MercadoPago, esperando que el pago se acredite. */
  pendientePago: boolean;
}

export function nombreYBase(tipo: EstadoPlan['tipo'], planCodigo: string): { nombre: string; base: string } {
  if (tipo === 'membresia') {
    const m = MEMBRESIAS_POR_CODIGO.get(planCodigo);
    return {
      nombre: m ? `Membresía ${m.tier} ${m.intensidad} ${m.variante}` : planCodigo,
      base: m?.comboBaseCodigo ?? '',
    };
  }
  const p = PAQUETES_POR_CODIGO.get(planCodigo);
  return { nombre: p ? `Paquete ${p.nombre}` : planCodigo, base: p?.servicioBaseCodigo ?? '' };
}

/**
 * Planes del paciente con saldo resuelto: los activos + los PENDIENTES de pago
 * (Coverage `draft`, alta con MercadoPago sin acreditar). Los pendientes se
 * muestran pero nunca son usables (R-10: `saldo.disponible` es false porque el
 * Coverage no está activo).
 */
export async function cargarPlanesActivos(pacienteId: string, ahora: Date = new Date()): Promise<PlanPaciente[]> {
  const coberturas = await medplum.searchResources('Coverage', {
    beneficiary: `Patient/${pacienteId}`,
    status: 'active,draft',
    _count: 20,
  });
  const planes: PlanPaciente[] = [];
  for (const c of coberturas) {
    const planCodigo = planCodigoDeCoverage(c);
    if (!c.id || !planCodigo) {
      continue;
    }
    const estado = estadoDeCoverage(c);
    const { nombre, base } = nombreYBase(estado.tipo, planCodigo);
    planes.push({
      coverage: c,
      coverageId: c.id,
      planCodigo,
      estado,
      saldo: saldoPlan(estado, ahora),
      nombre,
      baseCodigo: base,
      pendientePago: c.status === 'draft',
    });
  }
  // Activos primero; pendientes de pago al final.
  return planes.sort((a, b) => Number(a.pendientePago) - Number(b.pendientePago));
}

/**
 * Busca un plan utilizable para lo que se está reservando: debe estar disponible
 * (activo, no vencido, con saldo) y su base coincidir con el ítem
 * (membresía↔combo, paquete↔servicio).
 */
export function planUsable(
  planes: PlanPaciente[],
  item: { tipo: 'servicio' | 'combo'; codigo: string },
): PlanPaciente | undefined {
  const tipoPlan = item.tipo === 'combo' ? 'membresia' : 'paquete';
  return planes.find((p) => p.saldo.disponible && p.estado.tipo === tipoPlan && p.baseCodigo === item.codigo);
}
