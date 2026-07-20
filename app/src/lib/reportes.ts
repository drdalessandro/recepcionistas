import type { Appointment, Invoice } from '@medplum/fhirtypes';
import { medplum } from '../medplum';
import { RECURSOS_POR_CODIGO } from '@bw/config/recursos';
import { EXT } from '@bw/fhir/identifiers';

export interface Reportes {
  hoy: {
    turnos: number;
    porEstado: Array<{ estado: string; n: number }>;
    ingresosARS: number;
    cobros: number;
    senasARS: number;
    whatsapp: number;
    /** Facturas `issued` emitidas hoy: plata que todavía NO entró (accionable). */
    aCobrarARS: number;
    aCobrarN: number;
  };
  mes: { ingresosARS: number; turnos: number; aCobrarARS: number };
  ocupacion: Array<{ sala: string; turnos: number }>;
}

function sum<T>(arr: T[], f: (x: T) => number): number {
  return arr.reduce((acc, x) => acc + f(x), 0);
}

function esSena(i: Invoice): boolean {
  return Boolean(i.extension?.some((e) => e.url === EXT.esSena && e.valueBoolean));
}

async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

async function contar(resourceType: 'Appointment' | 'Communication', query: Record<string, string>): Promise<number> {
  try {
    const bundle = await medplum.search(resourceType, { ...query, _summary: 'count' });
    return bundle.total ?? 0;
  } catch {
    return 0;
  }
}

export async function cargarReportes(): Promise<Reportes> {
  const now = new Date();
  const inicioHoy = new Date(now);
  inicioHoy.setHours(0, 0, 0, 0);
  const finHoy = new Date(now);
  finHoy.setHours(23, 59, 59, 999);
  const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);

  const finHoyISO = finHoy.toISOString();

  // Turnos de hoy.
  const apptsHoy = await safe(() =>
    medplum.searchResources('Appointment', { date: `ge${inicioHoy.toISOString()}`, _count: 1000 }),
  );
  const delDia = (apptsHoy as Appointment[]).filter(
    (a) => a.start && a.start <= finHoyISO && a.status !== 'cancelled' && a.status !== 'entered-in-error',
  );

  const estadoMap = new Map<string, number>();
  const salaMap = new Map<string, number>();
  for (const a of delDia) {
    const est = a.status ?? 'booked';
    estadoMap.set(est, (estadoMap.get(est) ?? 0) + 1);
    const code = a.extension?.find((e) => e.url === EXT.recursoFisico)?.valueString;
    if (code) {
      salaMap.set(code, (salaMap.get(code) ?? 0) + 1);
    }
  }
  const ocupacion = [...salaMap.entries()]
    .map(([code, n]) => ({ sala: RECURSOS_POR_CODIGO.get(code)?.nombre ?? code, turnos: n }))
    .sort((a, b) => b.turnos - a.turnos);

  // Cobros de hoy y del mes (Invoices, en ARS). SOLO `balanced` es ingreso:
  // el contrato de pagos (docs/bots.md) define balanced = cobrado · issued =
  // pendiente · cancelled = fallido/anulado. Sin el filtro, cada saldo o alta
  // de plan por MercadoPago sin acreditar inflaba "Ingresos" con plata que
  // todavía no entró (bug verificado en producción, 2026-07-20).
  const invHoy = await safe(() =>
    medplum.searchResources('Invoice', { date: `ge${inicioHoy.toISOString()}`, status: 'balanced', _count: 1000 }),
  );
  const invDelDia = (invHoy as Invoice[]).filter((i) => i.date && i.date <= finHoyISO);
  const ingresosARS = sum(invDelDia, (i) => i.totalGross?.value ?? 0);
  const senasARS = sum(invDelDia.filter(esSena), (i) => i.totalGross?.value ?? 0);

  const invMes = await safe(() =>
    medplum.searchResources('Invoice', { date: `ge${inicioMes.toISOString()}`, status: 'balanced', _count: 2000 }),
  );
  const ingresosMesARS = sum(invMes as Invoice[], (i) => i.totalGross?.value ?? 0);

  // A cobrar: las `issued` (pendientes), separadas de los ingresos reales.
  // El dato accionable para Recepción: perseguir estos cobros.
  const pendHoy = await safe(() =>
    medplum.searchResources('Invoice', { date: `ge${inicioHoy.toISOString()}`, status: 'issued', _count: 1000 }),
  );
  const pendDelDia = (pendHoy as Invoice[]).filter((i) => i.date && i.date <= finHoyISO);
  const pendMes = await safe(() =>
    medplum.searchResources('Invoice', { date: `ge${inicioMes.toISOString()}`, status: 'issued', _count: 2000 }),
  );

  const turnosMes = await contar('Appointment', { date: `ge${inicioMes.toISOString()}` });
  const whatsapp = await contar('Communication', { sent: `ge${inicioHoy.toISOString()}` });

  return {
    hoy: {
      turnos: delDia.length,
      porEstado: [...estadoMap.entries()].map(([estado, n]) => ({ estado, n })),
      ingresosARS,
      cobros: invDelDia.length,
      senasARS,
      whatsapp,
      aCobrarARS: sum(pendDelDia, (i) => i.totalGross?.value ?? 0),
      aCobrarN: pendDelDia.length,
    },
    mes: {
      ingresosARS: ingresosMesARS,
      turnos: turnosMes,
      aCobrarARS: sum(pendMes as Invoice[], (i) => i.totalGross?.value ?? 0),
    },
    ocupacion,
  };
}
