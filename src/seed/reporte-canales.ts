/**
 * Reporte CRM · Clientes por canal (origen-lead):
 *
 *   npm run crm:canales
 *
 * Para cada canal de la lista cerrada muestra cuántos clientes llegaron por ahí
 * y cuántos convirtieron (turno confirmado/realizado; pago registrado). Es la
 * MISMA agregación que consume el CRM de Administración (AdminDashboard /
 * kpis-crm) — este script sirve de demo y de verificación cruzada.
 *
 * Solo lectura (no modifica nada). Usa las credenciales del .env.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Appointment, Coverage, Invoice, Patient, Resource } from '@medplum/fhirtypes';
import { EXT, ORIGENES_LEAD_LABELS, type OrigenLead } from '../fhir/identifiers.js';
import { altasPorMes, resumenPorCanal, SIN_ORIGEN, type PacienteCanal } from '../lib/canales.js';

const MAX_PAGINAS = 50;
const POR_PAGINA = 200;

/** Estados de turno que cuentan como conversión (confirmó o vino). */
const ESTADOS_CONVERSION = new Set(['booked', 'arrived', 'checked-in', 'fulfilled']);

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

async function todas<T extends Resource>(medplum: MedplumClient, tipo: T['resourceType'], query: string): Promise<T[]> {
  const out: T[] = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const lote = (await medplum.searchResources(
      tipo,
      `${query}&_count=${POR_PAGINA}&_offset=${pagina * POR_PAGINA}`,
    )) as unknown as T[];
    out.push(...lote);
    if (lote.length < POR_PAGINA) {
      break;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));

  // Fichas activas (los duplicados fusionados quedan inactivos con link).
  const pacientes = (await todas<Patient>(medplum, 'Patient', '_elements=extension,active,link'))
    .filter((p) => p.id && p.active !== false && !p.link?.length)
    .map<PacienteCanal>((p) => ({
      id: p.id as string,
      origen: p.extension?.find((x) => x.url === EXT.origenLead)?.valueString,
      fechaAlta: p.extension?.find((x) => x.url === EXT.fechaAlta)?.valueDate,
    }));

  // Conversión a turno: cualquier Appointment confirmado/realizado del paciente.
  const turnos = await todas<Appointment>(medplum, 'Appointment', '_elements=participant,status');
  const conTurno = new Set<string>();
  for (const t of turnos) {
    if (!ESTADOS_CONVERSION.has(t.status ?? '')) {
      continue;
    }
    for (const par of t.participant ?? []) {
      const ref = par.actor?.reference;
      if (ref?.startsWith('Patient/')) {
        conTurno.add(ref.slice('Patient/'.length));
      }
    }
  }

  // Conversión a pago: cualquier Invoice saldada del paciente.
  const pagos = await todas<Invoice>(medplum, 'Invoice', 'status=balanced&_elements=subject,status');
  const conPago = new Set<string>(
    pagos
      .map((i) => i.subject?.reference)
      .filter((r): r is string => Boolean(r?.startsWith('Patient/')))
      .map((r) => r.slice('Patient/'.length)),
  );

  // Socios: membresía activa (Coverage tipo-cobertura = membresia).
  const coberturas = await todas<Coverage>(medplum, 'Coverage', 'status=active&_elements=beneficiary,extension,status');
  const esSocio = new Set<string>(
    coberturas
      .filter((c) => (c.extension?.find((x) => x.url === EXT.tipoCobertura)?.valueCode ?? 'membresia') === 'membresia')
      .map((c) => c.beneficiary?.reference)
      .filter((r): r is string => Boolean(r?.startsWith('Patient/')))
      .map((r) => r.slice('Patient/'.length)),
  );

  const filas = resumenPorCanal(pacientes, conTurno, conPago, esSocio);

  console.log('=== CRM · Clientes por canal (origen-lead) ===\n');
  const etiqueta = (o: string): string => (o === SIN_ORIGEN ? o : (ORIGENES_LEAD_LABELS[o as OrigenLead] ?? o));
  const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
  console.log('Canal                     Clientes   Con turno    Con pago      Socios');
  console.log('─'.repeat(72));
  for (const f of filas) {
    console.log(
      `${etiqueta(f.origen).padEnd(26)}${String(f.clientes).padStart(6)}   ${String(f.conTurno).padStart(5)} (${pct(f.conTurno, f.clientes).padStart(4)})   ${String(f.conPago).padStart(4)} (${pct(f.conPago, f.clientes).padStart(4)})   ${String(f.socios).padStart(4)} (${pct(f.socios, f.clientes).padStart(4)})`,
    );
  }
  const total = pacientes.length;
  const sinDatos = filas.find((f) => f.origen === SIN_ORIGEN)?.clientes ?? 0;
  console.log('─'.repeat(72));
  console.log(`TOTAL: ${total} clientes · ${total - sinDatos} con canal cargado (${pct(total - sinDatos, total)})`);

  // Cohortes mensuales (fecha-alta): el gráfico del AdminDashboard.
  console.log('\n=== Altas por mes y canal (fecha-alta; lanzamiento 10/08/2026) ===\n');
  for (const m of altasPorMes(pacientes)) {
    const desglose = m.porCanal.map((d) => `${etiqueta(d.origen)} ${d.clientes}`).join(' · ');
    console.log(`${m.mes.padEnd(12)}${String(m.total).padStart(5)}   ${desglose}`);
  }
  console.log('\nEl canal se carga en el alta ("¿Cómo nos conoció?"); las fichas viejas');
  console.log('se completan de a poco al atenderlas. Administración puede consultar');
  console.log('por canal con: GET Patient?origen-lead=<código>&_summary=count');
  console.log('(requiere el SearchParameter del seed + reindex de Patient, ver docs).');
}

main().catch((err) => {
  console.error('crm:canales falló:', err);
  process.exitCode = 1;
});
