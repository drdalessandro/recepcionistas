/**
 * Diagnóstico de agenda (Schedules y Slots en el servidor).
 *
 *   npm run agenda:check
 *
 * Audita el estado real de la agenda en Medplum contra el catálogo local
 * (src/config/recursos.ts): para cada recurso físico verifica que exista su
 * Schedule canónico (identifier `SCH_<codigo>`, el que busca el bot de reserva
 * en R-07) y cuenta sus Slots futuros. Además lista los Schedules "ajenos"
 * (sin extensión recurso-fisico válida), que son los que eliminaría
 * `npm run limpiar -- --apply`.
 *
 * Si falta algún Schedule: `npm run seed` los recrea (upsert idempotente por
 * identifier; no toca pacientes ni turnos). Los Slots libres materializados son
 * opcionales: `npm run seed -- --with-slots --dias=14`.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Bundle, Schedule, Slot } from '@medplum/fhirtypes';
import { RECURSOS, RECURSOS_POR_CODIGO } from '../config/recursos.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/** Cuenta recursos sin traerlos (_count=0 + _total=accurate). */
async function contar(medplum: MedplumClient, tipo: 'Slot', query: string): Promise<number> {
  const bundle = (await medplum.get(`fhir/R4/${tipo}?${query}&_count=0&_total=accurate`)) as Bundle<Slot>;
  return bundle.total ?? 0;
}

async function main(): Promise<void> {
  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log(`Conectado a ${process.env.MEDPLUM_BASE_URL}\n`);

  const ahora = new Date().toISOString();

  // 1) Catálogo local → ¿existe el Schedule canónico de cada recurso?
  console.log('=== Schedules canónicos (los que busca el bot de reserva) ===');
  let faltantes = 0;
  for (const r of RECURSOS) {
    const sch = await medplum.searchOne('Schedule', `identifier=${SYSTEM.recursoCodigo}|SCH_${r.codigo}`);
    if (!sch?.id) {
      faltantes++;
      console.log(`  ✗ ${r.codigo.padEnd(20)} FALTA — la reserva en este recurso da error R-07`);
      continue;
    }
    const libres = await contar(medplum, 'Slot', `schedule=Schedule/${sch.id}&status=free&start=ge${ahora}`);
    const ocupados = await contar(medplum, 'Slot', `schedule=Schedule/${sch.id}&status=busy&start=ge${ahora}`);
    console.log(
      `  ✓ ${r.codigo.padEnd(20)} Schedule/${sch.id} · slots futuros: ${libres} libres, ${ocupados} ocupados`,
    );
  }

  // 2) Todo lo demás que haya en el servidor (duplicados / convenciones viejas).
  const todos = await medplum.searchResources('Schedule', { _count: 200 });
  const ajenos = (todos as Schedule[]).filter((s) => {
    const code = s.extension?.find((e) => e.url === EXT.recursoFisico)?.valueString;
    return !(code && RECURSOS_POR_CODIGO.has(code));
  });
  console.log(`\n=== Schedules en el servidor: ${todos.length} (ajenos/no canónicos: ${ajenos.length}) ===`);
  for (const s of ajenos) {
    const ident = s.identifier?.[0] ? `${s.identifier[0].system ?? ''}|${s.identifier[0].value ?? ''}` : '(sin identifier)';
    console.log(`  ! ajeno: Schedule/${s.id} · ${s.actor?.[0]?.display ?? '?'} · ${ident}`);
  }
  if (ajenos.length > 0) {
    console.log('  (estos son los que borra `npm run limpiar -- --apply`; el bot de reserva NO los usa)');
  }

  // 3) Veredicto.
  console.log('\n=== Veredicto ===');
  if (faltantes === 0) {
    console.log('✓ Los 13 Schedules canónicos están. Si la reserva igual falla, revisá los permisos del bot.');
  } else {
    console.log(`✗ Faltan ${faltantes} Schedule(s) canónicos. Para recrearlos (idempotente, no toca turnos ni pacientes):`);
    console.log('    npm run seed');
    console.log('  Opcional (materializar disponibilidad futura):');
    console.log('    npm run seed -- --with-slots --dias=14');
  }
}

main().catch((err) => {
  console.error('Diagnóstico de agenda falló:', err);
  process.exitCode = 1;
});
