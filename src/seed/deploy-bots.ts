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

/** Runtime de los bots. Medplum BioWellness usa AWS Lambda. Configurable por env. */
const RUNTIME_VERSION = process.env.BOT_RUNTIME_VERSION ?? 'awslambda';

interface DefBot {
  name: string;
  source: string;
  dist: string;
  description: string;
}

const BOTS: DefBot[] = [
  { name: 'bw-calcular-cobro', source: 'src/bots/calcular-cobro.ts', dist: 'dist/bots/calcular-cobro.js', description: 'Calcula el cobro (USD→ARS, splits) y emite Invoice.' },
  { name: 'bw-registrar-cobro', source: 'src/bots/registrar-cobro.ts', dist: 'dist/bots/registrar-cobro.js', description: 'Registra un cobro presencial: ChargeItems + un Invoice balanced por medio (contrato Administración).' },
  { name: 'bw-cobrar-pendiente', source: 'src/bots/cobrar-pendiente.ts', dist: 'dist/bots/cobrar-pendiente.js', description: 'Cobra en recepción un Invoice issued de plan: balanced + ChargeItem + levanta bloqueo R-11.' },
  { name: 'bw-validar-turno', source: 'src/bots/validar-turno.ts', dist: 'dist/bots/validar-turno.js', description: 'Valida un turno (orden HBOT, contraindicaciones, recursos, ventana, saldo).' },
  { name: 'bw-reservar-turno', source: 'src/bots/reservar-turno.ts', dist: 'dist/bots/reservar-turno.js', description: 'Valida y crea un turno (Appointment + Slot ocupado).' },
  { name: 'bw-reservar-combo', source: 'src/bots/reservar-combo.ts', dist: 'dist/bots/reservar-combo.js', description: 'Reserva un combo: agenda los componentes en secuencia (HBOT primero).' },
  { name: 'bw-estado-turno', source: 'src/bots/estado-turno.ts', dist: 'dist/bots/estado-turno.js', description: 'Cambia el estado del turno (check-in/out), gestiona Encounter y libera la sala.' },
  { name: 'bw-pagar-sena', source: 'src/bots/pagar-sena.ts', dist: 'dist/bots/pagar-sena.js', description: 'Registra la seña (50%), confirma el turno y envía WhatsApp.' },
  { name: 'bw-link-mercadopago', source: 'src/bots/link-mercadopago.ts', dist: 'dist/bots/link-mercadopago.js', description: 'Genera link de MercadoPago para pagar la seña.' },
  { name: 'bw-webhook-mercadopago', source: 'src/bots/webhook-mercadopago.ts', dist: 'dist/bots/webhook-mercadopago.js', description: 'Webhook de MercadoPago: confirma el turno al acreditarse el pago.' },
  { name: 'bw-asignar-plan', source: 'src/bots/asignar-plan.ts', dist: 'dist/bots/asignar-plan.js', description: 'Asigna una membresía/paquete (Coverage), emite el cobro inicial y avisa por WhatsApp.' },
  { name: 'bw-cobro-membresias', source: 'src/bots/cobro-membresias.ts', dist: 'dist/bots/cobro-membresias.js', description: 'Cron días 1-5: renueva membresías (reset de sesiones + cobro mensual).' },
  { name: 'bw-recordatorios', source: 'src/bots/recordatorios.ts', dist: 'dist/bots/recordatorios.js', description: 'Cron: envía recordatorios de turnos confirmados a 48 h y 2 h (WhatsApp).' },
  { name: 'bw-alta-paciente', source: 'src/bots/alta-paciente.ts', dist: 'dist/bots/alta-paciente.js', description: 'Alta de paciente (Patient) con dedupe por DNI/email/teléfono.' },
  { name: 'bw-invitar-paciente', source: 'src/bots/invitar-paciente.ts', dist: 'dist/bots/invitar-paciente.js', description: 'Invita al paciente al portal (invite Medplum) y entrega el link por WhatsApp/email/QR. Requiere admin.' },
  { name: 'bw-limpiar-demo', source: 'src/bots/limpiar-demo.ts', dist: 'dist/bots/limpiar-demo.js', description: 'Cron: borra los datos demo (tag demo) con más de 48 h.' },
  { name: 'bw-enviar-whatsapp', source: 'src/bots/enviar-whatsapp.ts', dist: 'dist/bots/enviar-whatsapp.js', description: 'Envía WhatsApp (Twilio) y registra Communication.' },
  { name: 'bw-solicitar-turno', source: 'src/bots/solicitar-turno.ts', dist: 'dist/bots/solicitar-turno.js', description: 'Crea una solicitud de turno (Task) desde el portal del paciente y avisa a Recepción por WhatsApp.' },
];

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
