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
import type { Practitioner, Resource, Slot } from '@medplum/fhirtypes';
import { buildSeed, buildSlot, buildSlotMedico, horarioDeAgendaMedico } from './builders.js';
import { HORARIO_ES_PLACEHOLDER, HORARIO_SEMANAL } from '../config/horario.js';
import { RECURSOS } from '../config/recursos.js';
import { MEDICOS, codigoConsulta } from '../config/medicos.js';
import { reconciliarSlots, solapamientosDeAgendas } from '../lib/agenda-medicos.js';
import { getServicio } from '../config/catalogo.js';
import { CONTRAINDICACIONES } from '../config/contraindicaciones.js';
import { generarSlots } from '../lib/slots.js';
import { SYSTEM } from '../fhir/identifiers.js';
import { fusionarPractitioner } from '../fhir/practitioner.js';

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
    ['PlanDefinition (programas)', seed.programas],
    ['CodeSystem (contraindicaciones)', [seed.contraindicaciones]],
    ['Library (consentimiento informado)', [seed.consentimiento]],
    ['Questionnaire (cuestionario de ingreso)', [seed.cuestionarioIngreso]],
    // ⚠️ ORDEN IMPORTA: los Schedule referencian por referencia CONDICIONAL a
    // su actor (Location la sala; Practitioner la agenda de un médico). El
    // actor tiene que existir CON su identifier antes de upsertear el
    // Schedule, o Medplum corta con "Conditional reference did not match".
    ['Location (recursos)', seed.locations],
    ['Practitioner (médicos)', seed.practitioners],
    ['Schedule (agendas)', seed.schedules],
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
    // Un solo consultorio: dos médicos en la misma franja compiten por él.
    for (const c of solapamientosDeAgendas(MEDICOS)) {
      console.log(`   ⚠️  ${c.detalle}`);
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
  // Ventana que este seed regenera: desde ahora hasta `dias` días. Solo dentro
  // de ella se reconcilian las agendas de médicos (más allá no hay nada
  // generado con qué comparar, así que nada se juzga ni se borra).
  const desde = new Date();
  const horizonte = new Date(desde.getTime() + dias * 24 * 60 * 60 * 1000);

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
  const slotsSalas = descriptores
    .filter((desc) => scheduleId.has(desc.recursoCodigo))
    .map((desc) => buildSlot(desc, `Schedule/${scheduleId.get(desc.recursoCodigo)}`));
  const r = await crearSlotsEnLotes(medplum, slotsSalas);
  console.log(`  ✓ Slot salas: ${r.creados} nuevos (${r.existentes} ya existían)`);

  // Agendas publicadas de MÉDICOS (portal → "Consulta con Director Médico"):
  // slots free por franja del médico, con la duración de SU consulta.
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
      { desde, dias, granularidadMin: dur },
    );
    const rm = await crearSlotsEnLotes(
      medplum,
      deMedico.map((desc) => buildSlotMedico(m, desc, `Schedule/${sch.id}`)),
    );
    console.log(`  ✓ Agenda ${m.nombre}: ${rm.creados} slots nuevos (${rm.existentes} ya existían)`);

    // Reconciliación: si la agenda CAMBIÓ (una franja se movió de día u hora),
    // los slots libres viejos seguirían publicados y el portal ofrecería un
    // horario en el que el médico ya no atiende. Se borran los libres que ya
    // no corresponden, dentro de la ventana regenerada. Los `busy` son turnos
    // dados: no se tocan, se reportan para que Recepción los reubique.
    const publicados = await withRetry(() =>
      medplum.searchResources('Slot', {
        schedule: `Schedule/${sch.id}`,
        start: `ge${desde.toISOString()}`,
        _count: 2000,
      }),
    );
    const { aBorrar, ocupadosFuera } = reconciliarSlots(
      publicados,
      deMedico.map((d) => d.inicio),
      { desde, hasta: horizonte },
    );
    for (const id of aBorrar) {
      await withRetry(() => medplum.deleteResource('Slot', id));
    }
    if (aBorrar.length > 0) {
      console.log(`     ↳ ${aBorrar.length} slot(s) libre(s) de la agenda anterior eliminados.`);
    }
    for (const s of ocupadosFuera) {
      console.log(
        `     ⚠️  Turno RESERVADO fuera de la agenda nueva: ${s.start} (Slot/${s.id}). No se tocó: reubicalo con el paciente.`,
      );
    }
  }
}

/**
 * Alta masiva de Slots por LOTES batch con create condicional (`ifNoneExist`
 * por identifier, resuelto en el server): una request cada N slots en vez de
 * dos por slot — sin esto, el seed de ~2300 slots vive esperando el rate
 * limit de Medplum. Nunca pisa un slot existente: uno reservado quedó `busy`
 * y una regeneración jamás debe volver a ofrecerlo.
 */
const SLOTS_POR_LOTE = 100;
async function crearSlotsEnLotes(
  medplum: MedplumClient,
  slots: Slot[],
): Promise<{ creados: number; existentes: number }> {
  let creados = 0;
  let existentes = 0;
  for (let i = 0; i < slots.length; i += SLOTS_POR_LOTE) {
    const lote = slots.slice(i, i + SLOTS_POR_LOTE);
    const bundle = await withRetry(() =>
      medplum.executeBatch({
        resourceType: 'Bundle',
        type: 'batch',
        entry: lote.map((s) => ({
          resource: s,
          request: {
            method: 'POST' as const,
            url: 'Slot',
            // Mismo formato token crudo que buildQuery (probado en prod).
            ifNoneExist: `identifier=${s.identifier![0]!.system}|${s.identifier![0]!.value}`,
          },
        })),
      }),
    );
    for (const e of bundle.entry ?? []) {
      if (e.response?.status?.startsWith('201')) {
        creados++;
      } else {
        existentes++;
      }
    }
    console.log(`    … slots ${Math.min(i + SLOTS_POR_LOTE, slots.length)}/${slots.length}`);
  }
  return { creados, existentes };
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
    // Reemplazo entero: es lo correcto para todo lo que el seed publica, que es
    // nuestro de punta a punta (servicios, combos, policies). El `Practitioner`
    // es la excepción y por eso se fusiona: esa ficha la comparte el Dashboard,
    // que le carga la matrícula. Ver src/fhir/practitioner.ts.
    const aEscribir =
      recurso.resourceType === 'Practitioner'
        ? fusionarPractitioner(existente as Practitioner, recurso as Practitioner)
        : recurso;
    const actualizado = await withRetry(() => medplum.updateResource({ ...aEscribir, id: existente.id }));
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
