/**
 * Diagnóstico del catálogo publicado (ActivityDefinition / PlanDefinition).
 *
 *   npm run catalogo:check
 *
 * Audita lo que hay en Medplum contra el catálogo local (src/config): qué
 * recursos son CANÓNICOS (los publica el seed desde el código), cuáles son
 * AJENOS (creados a mano o por otra convención: el seed no los toca y nadie
 * los mantiene) y cuáles están INCOMPLETOS (sin precio o sin composición).
 *
 * Por qué existe: el seed hace upsert por identifier, así que un recurso creado
 * a mano con otro identifier queda huérfano para siempre — visible en el portal
 * y en recepción, sin precio, sin que nadie lo actualice. Es el mismo problema
 * que ya tuvimos con los Schedules ajenos (`npm run limpiar`).
 *
 * SOLO LECTURA: imprime los ids para que la baja se haga a conciencia desde el
 * admin de Medplum. Borrar catálogo es destructivo y no se automatiza.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { ActivityDefinition, PlanDefinition } from '@medplum/fhirtypes';
import { TODOS_LOS_SERVICIOS } from '../config/catalogo.js';
import { COMBOS } from '../config/combos.js';
import { MEMBRESIAS } from '../config/membresias.js';
import { PROGRAMAS } from '../config/programas.js';
import { TODOS_LOS_PAQUETES } from '../config/paquetes.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

type Recurso = ActivityDefinition | PlanDefinition;

/** Códigos del catálogo local, por sistema de identifier. */
function codigosEsperados(): Map<string, Set<string>> {
  return new Map([
    // Los RETIRADOS cuentan como canónicos: el seed los publica (como
    // `retired`), así que no son ajenos — marcarlos como tales mandaría a
    // dar de baja a mano justo lo que el seed mantiene a propósito.
    [SYSTEM.servicioCodigo, new Set(TODOS_LOS_SERVICIOS.map((s) => s.codigo))],
    [SYSTEM.comboCodigo, new Set(COMBOS.map((c) => c.codigo))],
    [SYSTEM.membresiaCodigo, new Set(MEMBRESIAS.map((m) => m.codigo))],
    [SYSTEM.paqueteCodigo, new Set(TODOS_LOS_PAQUETES.map((p) => p.codigo))],
    // Los programas faltaban: PB100D_PREMIUM_MENSUAL y _100D los publica este
    // seed y aparecían como AJENOS, o sea que el veredicto mandaba a dar de
    // baja lo que el propio seed mantiene.
    [SYSTEM.programaCodigo, new Set(PROGRAMAS.map((p) => p.codigo))],
  ]);
}

function precioDe(r: Recurso): number | undefined {
  return r.extension?.find((e) => e.url === EXT.precioUsd)?.valueDecimal;
}

function identifierDe(r: Recurso): { system?: string; value?: string } | undefined {
  return r.identifier?.[0];
}

/**
 * ¿Es del PB100D clínico, que publica `biowellness-fhir`?
 *
 * Se reconoce por el nombre porque esos recursos no llevan identifier nuestro
 * (`AdPb100d*` son las acciones del protocolo, `Pb100dNivel*` las cuatro
 * plantillas por nivel). Es una heurística, y por eso NO se usa para borrar
 * nada: solo para sacarlos de la lista de "dar de baja a mano". Un falso
 * positivo acá esconde un ajeno; un falso negativo mandaba a borrar la historia
 * clínica de otro equipo, que es muchísimo peor.
 */
function esDePB100D(r: Recurso): boolean {
  return /^(ad)?pb100d/i.test(r.name ?? '');
}

function esCanonico(r: Recurso, esperados: Map<string, Set<string>>): boolean {
  const ident = identifierDe(r);
  if (!ident?.system || !ident.value) {
    return false;
  }
  return esperados.get(ident.system)?.has(ident.value) === true;
}

async function main(): Promise<void> {
  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log(`Conectado a ${process.env.MEDPLUM_BASE_URL}\n`);

  const esperados = codigosEsperados();
  const servicios = (await medplum.searchResources('ActivityDefinition', { _count: 500 })) as ActivityDefinition[];
  const planes = (await medplum.searchResources('PlanDefinition', { _count: 500 })) as PlanDefinition[];
  const todos: Recurso[] = [...servicios, ...planes];

  // 1) Cobertura: ¿está publicado todo lo que define el código?
  console.log('=== Catálogo local vs servidor ===');
  let faltantes = 0;
  for (const [sistema, codigos] of esperados) {
    const publicados = new Set(
      todos.map(identifierDe).filter((i) => i?.system === sistema).map((i) => i!.value),
    );
    const sinPublicar = [...codigos].filter((c) => !publicados.has(c));
    faltantes += sinPublicar.length;
    const nombre = sistema.split('/').pop();
    console.log(
      `  ${sinPublicar.length === 0 ? '✓' : '✗'} ${String(nombre).padEnd(16)} ${codigos.size} en el código · ${publicados.size} publicados` +
        (sinPublicar.length ? ` · FALTAN: ${sinPublicar.join(', ')}` : ''),
    );
  }

  // 2) Ajenos: en el servidor pero NO en el código. Pero "ajeno a ESTE seed" no
  //    es lo mismo que "no lo mantiene nadie": los recursos clínicos del PB100D
  //    los publica el seed de `biowellness-fhir` (ver CLAUDE.md · PB100D) y este
  //    repo no tiene por qué conocerlos. Mezclarlos mandaba a dar de baja a mano
  //    las plantillas clínicas de otro equipo — el peor consejo posible.
  const otrosRepos = todos.filter((r) => !esCanonico(r, esperados) && esDePB100D(r));
  const ajenos = todos.filter((r) => !esCanonico(r, esperados) && !esDePB100D(r));

  if (otrosRepos.length > 0) {
    console.log(`\n=== De otro repo (biowellness-fhir · PB100D): ${otrosRepos.length} ===`);
    console.log('  Plantillas y acciones clínicas del programa. NO se tocan desde acá.');
  }

  console.log(`\n=== Ajenos al seed: ${ajenos.length} ===`);
  for (const r of ajenos) {
    const ident = identifierDe(r);
    const precio = precioDe(r);
    const acciones = (r as PlanDefinition).action?.length ?? 0;
    const marcas = [
      precio == null ? 'SIN PRECIO' : `USD ${precio}`,
      r.resourceType === 'PlanDefinition' ? `${acciones} componente(s)` : '',
      r.status !== 'active' ? `status=${r.status}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    console.log(
      `  ! ${r.resourceType}/${r.id} · ${r.name ?? r.title ?? '(sin nombre)'} · ` +
        `${ident ? `${ident.system?.split('/').pop()}|${ident.value}` : '(sin identifier)'} · ${marcas}`,
    );
  }
  if (ajenos.length > 0) {
    console.log('  → No los actualiza el seed: o se migran al código (src/config) o se dan de baja a mano.');
    console.log('  → Antes de borrar: fijate si el portal los está mostrando. Los que no tienen');
    console.log('    identifier son de una convención vieja y duplican a los canónicos.');
  }

  // 3) Identifiers DUPLICADOS: dos recursos con el mismo identifier hacen que el
  //    upsert del seed y las búsquedas del portal sean impredecibles.
  const porIdent = new Map<string, Recurso[]>();
  for (const r of todos) {
    const ident = identifierDe(r);
    if (!ident?.value) {
      continue;
    }
    const clave = `${ident.system}|${ident.value}`;
    porIdent.set(clave, [...(porIdent.get(clave) ?? []), r]);
  }
  const duplicados = [...porIdent.entries()].filter(([, rs]) => rs.length > 1);
  console.log(`\n=== Identifiers duplicados: ${duplicados.length} ===`);
  for (const [clave, rs] of duplicados) {
    console.log(`  ! ${clave} → ${rs.map((r) => `${r.resourceType}/${r.id}`).join(', ')}`);
  }
  if (duplicados.length > 0) {
    console.log('  → El seed actualiza UNO solo; el resto queda viejo. Dar de baja los sobrantes.');
  }

  // 4) Publicados sin precio: se ven en la góndola sin poder venderse.
  // Los del PB100D clínico no llevan precio A PROPÓSITO (son pasos de un
  // protocolo, no productos): listarlos acá era ruido que tapaba los reales.
  const sinPrecio = todos.filter((r) => precioDe(r) == null && !esDePB100D(r));
  console.log(`\n=== Publicados SIN precio: ${sinPrecio.length} ===`);
  for (const r of sinPrecio) {
    console.log(`  ! ${r.resourceType}/${r.id} · ${r.name ?? r.title ?? '(sin nombre)'}`);
  }

  console.log('\n=== Veredicto ===');
  if (faltantes === 0 && ajenos.length === 0 && duplicados.length === 0 && sinPrecio.length === 0) {
    console.log('✓ El catálogo del servidor coincide con el código.');
  } else {
    if (faltantes > 0) {
      console.log(`✗ Faltan ${faltantes} recurso(s) del código: correr \`npm run seed\`.`);
    }
    if (ajenos.length > 0 || duplicados.length > 0 || sinPrecio.length > 0) {
      console.log('✗ Hay recursos que el seed NO mantiene (arriba, con su id). Darlos de baja desde el admin.');
    }
  }
}

main().catch((err) => {
  console.error('Diagnóstico de catálogo falló:', err);
  process.exitCode = 1;
});
