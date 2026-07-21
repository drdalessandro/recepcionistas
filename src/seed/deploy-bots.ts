/**
 * Deploy de los Medplum Bots.
 *
 *   npm run bots:bundle   → DRY-RUN: bundlea cada bot y muestra tamaños (sin red).
 *   npm run deploy:bots   → crea (si faltan) + bundlea + deploya a Medplum, y
 *                            escribe los ids en medplum.config.json.
 *
 * Replica lo que hace la CLI de Medplum, pero con dotenv (mismo flujo que el seed):
 *   - crear bot:   POST admin/projects/{projectId}/bot { name, runtimeVersion }
 *   - deployar:    POST Bot/{id}/$deploy { code, filename }
 * El código se bundlea a un único módulo CJS (exports.handler) con esbuild.
 */
import 'dotenv/config';
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { MedplumClient } from '@medplum/core';
import type { Bot } from '@medplum/fhirtypes';
import { CONFIG_TC_ID } from '../fhir/identifiers.js';
import { BOTS, type DefBot } from './bots-def.js';

/** Runtime de los bots. Medplum Biowellness usa AWS Lambda. Configurable por env. */
const RUNTIME_VERSION = process.env.BOT_RUNTIME_VERSION ?? 'awslambda';

/** Resuelve imports relativos ".js" a su fuente ".ts" (ESM + Bundler). */
const jsToTs: Plugin = {
  name: 'js-to-ts',
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.importer || !args.path.startsWith('.')) {
        return undefined;
      }
      const tsPath = resolve(dirname(args.importer), args.path.replace(/\.js$/, '.ts'));
      return existsSync(tsPath) ? { path: tsPath } : undefined;
    });
  },
};

async function bundle(source: string): Promise<string> {
  const result = await build({
    entryPoints: [source],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    legalComments: 'none',
    plugins: [jsToTs],
  });
  return result.outputFiles[0]!.text;
}

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

async function resolverProjectId(medplum: MedplumClient): Promise<string> {
  const fromProfile = medplum.getProfile()?.meta?.project;
  if (fromProfile) {
    return fromProfile;
  }
  const basic = await medplum.searchOne('Basic', `identifier=${CONFIG_TC_ID}`);
  if (basic?.meta?.project) {
    return basic.meta.project;
  }
  throw new Error('No pude determinar el projectId del proyecto Medplum.');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  // 1) Bundle (siempre; sirve para verificar sin red).
  const bundles = new Map<string, string>();
  for (const b of BOTS) {
    const code = await bundle(b.source);
    bundles.set(b.name, code);
    console.log(`  • ${b.name}: ${(code.length / 1024).toFixed(1)} kB bundleado`);
  }

  if (dryRun) {
    console.log('\n[dry-run] Bots bundleados OK. No se conecta a Medplum.');
    return;
  }

  // 2) Conectar a Medplum.
  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  const projectId = await resolverProjectId(medplum);
  console.log(`\nConectado a Medplum (project ${projectId}).`);

  // 3) Asegurar + deployar cada bot.
  const ids = new Map<string, string>();
  const faltantes: string[] = [];
  for (const b of BOTS) {
    const id = await asegurarBot(medplum, projectId, b);
    if (!id) {
      faltantes.push(b.name);
      continue;
    }
    await medplum.post(medplum.fhirUrl('Bot', id, '$deploy'), {
      code: bundles.get(b.name),
      filename: basename(b.dist),
    });
    console.log(`    ✓ deployado`);
    ids.set(b.name, id);
  }

  // 4) Escribir los ids en medplum.config.json.
  escribirConfig(ids);

  if (faltantes.length > 0) {
    console.log('\n⚠️  Faltan crear estos bots (sin permiso de admin del proyecto):');
    for (const n of faltantes) {
      console.log(`   - ${n}`);
    }
    console.log(
      '\n   Crealos UNA vez en Medplum (Project Admin → Bots → New Bot) con ese nombre exacto\n' +
        `   y runtime "${RUNTIME_VERSION}". Después volvé a correr: npm run deploy:bots\n` +
        '   (el bundle + deploy lo hace el script; solo falta la creación inicial).',
    );
  } else {
    console.log('\nDeploy de bots completado. Ids guardados en medplum.config.json.');
  }
}

/** Devuelve el id del bot: lo busca por nombre; si no existe intenta crearlo. */
async function asegurarBot(medplum: MedplumClient, projectId: string, b: DefBot): Promise<string | undefined> {
  const existente = await medplum.searchOne('Bot', `name=${encodeURIComponent(b.name)}`);
  if (existente?.id) {
    console.log(`  = Bot existente: ${b.name} (${existente.id})`);
    return existente.id;
  }
  try {
    const creado = (await medplum.post(`admin/projects/${projectId}/bot`, {
      name: b.name,
      description: b.description,
      runtimeVersion: RUNTIME_VERSION,
    })) as Bot;
    const bot = await medplum.readResource('Bot', creado.id as string);
    console.log(`  + Bot creado: ${b.name} (${bot.id})`);
    return bot.id;
  } catch (err) {
    if (esForbidden(err)) {
      console.warn(`  ! Sin permiso para crear "${b.name}" (la ClientApplication no es admin del proyecto).`);
      return undefined;
    }
    throw err;
  }
}

function esForbidden(err: unknown): boolean {
  const id = (err as { outcome?: { id?: string } })?.outcome?.id;
  const msg = err instanceof Error ? err.message : String(err);
  return id === 'forbidden' || /forbidden/i.test(msg);
}

function escribirConfig(ids: Map<string, string>): void {
  const path = 'medplum.config.json';
  const config = { bots: BOTS.map((b) => ({ name: b.name, id: ids.get(b.name) ?? '', source: b.source, dist: b.dist })) };
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}

main().catch((err) => {
  console.error('Deploy de bots falló:', err);
  process.exitCode = 1;
});
