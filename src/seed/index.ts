/**
 * Runner del seed del Bloque 0.
 *
 *   npm run seed -- --dry-run   → construye todos los recursos y muestra un resumen
 *                                  SIN conectarse a Medplum (sirve para CI/local).
 *   npm run seed                → conecta a Medplum (client credentials del .env) y
 *                                  hace upsert idempotente de todo el catálogo.
 *   npm run seed -- --with-slots [--dias=N]
 *                               → además genera la agenda (Slot) de cada recurso
 *                                  para los próximos N días (default 7).
 *
 * Idempotente: cada recurso se busca por url/identifier; si existe, se actualiza.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { buildSeed, buildSlot, buildSlotMedico, horarioDeAgendaMedico } from './builders.js';
import { HORARIO_ES_PLACEHOLDER, HORARIO_SEMANAL } from '../config/horario.js';
import { RECURSOS } from '../config/recursos.js';
import { MEDICOS, codigoConsulta } from '../config/medicos.js';
import { getServicio } from '../config/catalogo.js';
import { CONTRAINDICACIONES } from '../config/contraindicaciones.js';
import { generarSlots } from '../lib/slots.js';
import { SYSTEM } from '../fhir/identifiers.js';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const withSlots = process.argv.includes('--with-slots');
  const dias = parseDias();
  const seed = buildSeed();

  const grupos: Array<[string, Resource[]]> = [
    ['StructureDefinition (extensiones)', seed.structureDefinitions],
    ['SearchParameter (origen-lead, CRM)', seed.searchParameters],
    ['AccessPolicy (roles)', seed.accessPolicies],
    ['Basic (config TC)', [seed.tcConfig]],
    ['ActivityDefinition (servicios)', seed.activityDefinitions],
    ['PlanDefinition (combos)', seed.combos],
    ['PlanDefinition (membresías)', seed.membresias],
    ['PlanDefinition (paquetes)', seed.paquetes],
    ['CodeSystem (contraindicaciones)', [seed.contraindicaciones]],
    ['Location (recursos)', seed.locations],
    ['Schedule (agendas)', seed.schedules],
    ['Practitioner (médicos)', seed.practitioners],
  ];

  const total = grupos.reduce((acc, [, arr]) => acc + arr.length, 0);

  console.log('=== Seed Biowellness · Bloque 0 (Manual v9) ===');
  for (const [nombre, arr] of grupos) {
    console.log(`  • ${nombre}: ${arr.length}`);
  }
  console.log(`  TOTAL: ${total} recursos`);

  imprimirAdvertencias();

  if (withSlots) {
    const descriptores = generarSlots(RECURSOS, HORARIO_SEMANAL, { desde: new Date(), dias });
    console.log(`\nSlots a generar (${dias} días): ${descriptores.length}`);
    for (const m of MEDICOS.filter((x) => (x.agenda?.length ?? 0) > 0)) {
      const dur = getServicio(codigoConsulta(m.codigo)).duracionMin;
      const deMedico = generarSlots(
        [{ codigo: m.codigo, nombre: m.nombre, tipo: 'CONSULTORIO', capacidad: 1 }],
        horarioDeAgendaMedico(m),
        { desde: new Date(), dias, granularidadMin: dur },
      );
      console.log(`  + agenda de ${m.nombre}: ${deMedico.length} slots de ${dur} min`);
    }
    if (HORARIO_ES_PLACEHOLDER) {
      console.log('   ⚠️  Usando horario PLACEHOLDER: los Slot serán provisionales.');
    }
  }

  if (dryRun) {
    console.log('\n[dry-run] No se conecta a Medplum. Recursos construidos OK.');
    return;
  }

  const baseUrl = requireEnv('MEDPLUM_BASE_URL');
  const clientId = requireEnv('MEDPLUM_CLIENT_ID');
  const clientSecret = requireEnv('MEDPLUM_CLIENT_SECRET');

  const medplum = new MedplumClient({ baseUrl, fetch });
  await medplum.startClientLogin(clientId, clientSecret);
  console.log(`\nConectado a Medplum: ${baseUrl}`);

  for (const [nombre, arr] of grupos) {
    for (const recurso of arr) {
      await upsert(medplum, recurso);
    }
    console.log(`  ✓ ${nombre} (${arr.length})`);
  }

  if (withSlots) {
    await generarYCargarSlots(medplum, dias);
  }

  console.log('\nSeed completado.');
}

/** Genera y carga los Slot de cada recurso, referenciando su Schedule. */
async function generarYCargarSlots(medplum: MedplumClient, dias: number): Promise<void> {
  // Mapa recursoCodigo -> id del Schedule (ya creado en la fase anterior).
  const scheduleId = new Map<string, string>();
  for (const r of RECURSOS) {
    const sch = await withRetry(() =>
      medplum.searchOne('Schedule', `identifier=${SYSTEM.recursoCodigo}|SCH_${r.codigo}`),
    );
    if (sch?.id) {
      scheduleId.set(r.codigo, sch.id);
    }
  }

  const descriptores = generarSlots(RECURSOS, HORARIO_SEMANAL, { desde: new Date(), dias });
  let creados = 0;
  for (const desc of descriptores) {
    const id = scheduleId.get(desc.recursoCodigo);
    if (!id) {
      continue;
    }
    await upsert(medplum, buildSlot(desc, `Schedule/${id}`));
    creados++;
  }
  console.log(`  ✓ Slot (${creados})`);

  // Agendas publicadas de MÉDICOS (portal → "Consulta con Director Médico"):
  // slots free por franja del médico, con la duración de SU consulta. A
  // diferencia de las salas, acá se crea SOLO lo que falta: un slot reservado
  // quedó `busy` y una regeneración jamás debe volver a ofrecerlo.
  for (const m of MEDICOS.filter((x) => (x.agenda?.length ?? 0) > 0)) {
    const sch = await withRetry(() =>
      medplum.searchOne('Schedule', `identifier=${SYSTEM.recursoCodigo}|SCH_${m.codigo}`),
    );
    if (!sch?.id) {
      console.log(`  ⚠️  Sin Schedule para ${m.nombre}: se omite su agenda.`);
      continue;
    }
    const dur = getServicio(codigoConsulta(m.codigo)).duracionMin;
    const deMedico = generarSlots(
      [{ codigo: m.codigo, nombre: m.nombre, tipo: 'CONSULTORIO', capacidad: 1 }],
      horarioDeAgendaMedico(m),
      { desde: new Date(), dias, granularidadMin: dur },
    );
    let nuevos = 0;
    for (const desc of deMedico) {
      const slot = buildSlotMedico(m, desc, `Schedule/${sch.id}`);
      const existente = await withRetry(() =>
        medplum.searchOne('Slot', `identifier=${SYSTEM.recursoCodigo}|${encodeURIComponent(`${m.codigo}|${desc.inicio}`)}`),
      );
      if (existente) {
        continue; // ya existe (free u ocupado): no se pisa
      }
      await withRetry(() => medplum.createResource(slot));
      nuevos++;
    }
    console.log(`  ✓ Agenda ${m.nombre}: ${nuevos} slots nuevos (${deMedico.length - nuevos} ya existían)`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Si el error es un 429 de Medplum, devuelve los ms a esperar; si no, undefined. */
function esperaPorRateLimit(e: unknown): number | undefined {
  const msg = e instanceof Error ? e.message : String(e);
  const id = (e as { outcome?: { id?: string } })?.outcome?.id;
  if (id === 'too-many-requests' || /too many requests/i.test(msg)) {
    const m = /"_msBeforeNext":(\d+)/.exec(msg);
    return (m ? Number(m[1]) : 60_000) + 500;
  }
  return undefined;
}

/** Reintenta una operación ante rate limit (429), respetando _msBeforeNext de Medplum. */
async function withRetry<T>(fn: () => Promise<T>, maxIntentos = 8): Promise<T> {
  for (let intento = 1; ; intento++) {
    try {
      return await fn();
    } catch (e) {
      const espera = esperaPorRateLimit(e);
      if (espera === undefined || intento >= maxIntentos) {
        throw e;
      }
      console.log(`    … rate limit alcanzado; esperando ${Math.ceil(espera / 1000)}s (intento ${intento})`);
      await sleep(espera);
    }
  }
}

/** Upsert idempotente por url (recursos canónicos) o por identifier. Devuelve el id. */
async function upsert(medplum: MedplumClient, recurso: Resource): Promise<string | undefined> {
  const query = buildQuery(recurso);
  if (!query) {
    const creado = await withRetry(() => medplum.createResource(recurso));
    return creado.id;
  }
  const existente = await withRetry(() => medplum.searchOne(recurso.resourceType, query));
  if (existente?.id) {
    const actualizado = await withRetry(() => medplum.updateResource({ ...recurso, id: existente.id }));
    return actualizado.id;
  }
  const creado = await withRetry(() => medplum.createResource(recurso));
  return creado.id;
}

function buildQuery(recurso: Resource): string | undefined {
  const r = recurso as Resource & {
    url?: string;
    name?: string;
    identifier?: Array<{ system?: string; value?: string }>;
  };
  if (r.url) {
    return `url=${encodeURIComponent(r.url)}`;
  }
  const ident = r.identifier?.[0];
  if (ident?.value) {
    return `identifier=${ident.system ? `${ident.system}|` : ''}${ident.value}`;
  }
  if (recurso.resourceType === 'AccessPolicy' && r.name) {
    return `name=${encodeURIComponent(r.name)}`;
  }
  return undefined;
}

function imprimirAdvertencias(): void {
  const avisos: string[] = [];
  if (HORARIO_ES_PLACEHOLDER) {
    avisos.push(
      'Horario de atención es PLACEHOLDER (decisión bloqueante). Los Slot que se generen con --with-slots serán provisionales hasta confirmar el horario real.',
    );
  }
  if (RECURSOS.some((r) => r.provisional)) {
    avisos.push('La lista de recursos físicos es PROVISIONAL (lista preliminar de 13). Confirmar con Andrés.');
  }
  if (CONTRAINDICACIONES.some((c) => c.borradorPendienteRevision)) {
    avisos.push('Tabla de contraindicaciones es BORRADOR. Requiere validación del Director Médico.');
  }
  if (avisos.length) {
    console.log('\n⚠️  Pendientes (ver docs/decisiones-pendientes.md):');
    for (const a of avisos) {
      console.log(`   - ${a}`);
    }
  }
}

/** Lee --dias=N de los argumentos (default 7). */
function parseDias(): number {
  const arg = process.argv.find((a) => a.startsWith('--dias='));
  const n = arg ? Number(arg.split('=')[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

main().catch((err) => {
  console.error('Seed falló:', err);
  process.exitCode = 1;
});
