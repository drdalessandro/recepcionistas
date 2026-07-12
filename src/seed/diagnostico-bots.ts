/**
 * Diagnóstico de Bots: ¿están TODOS los bots del repo creados y deployados en el
 * servidor Medplum (api.medplum.com.ar)?
 *
 *   npm run bots:check
 *
 * Solo lectura (no crea ni deploya nada). Para cada bot de `bots-def.ts` busca el
 * recurso Bot por nombre y reporta:
 *   ✓ OK         → existe y tiene código deployado (executableCode)
 *   ⚠ SIN CÓDIGO → existe pero nunca se le hizo $deploy (correr deploy:bots)
 *   ✗ FALTA      → no existe en el servidor (deploy:bots lo crea si hay admin)
 * Además lista los bots del servidor que NO están en el repo (huérfanos u otras
 * apps, p. ej. del portal) y avisa si el runtime no es el esperado.
 *
 * Sale con código 1 si falta alguno o hay bots sin código (sirve para CI).
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import { BOTS } from './bots-def.js';

const RUNTIME_ESPERADO = process.env.BOT_RUNTIME_VERSION ?? 'awslambda';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

async function main(): Promise<void> {
  const baseUrl = requireEnv('MEDPLUM_BASE_URL');
  const medplum = new MedplumClient({ baseUrl, fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log(`Verificando ${BOTS.length} bots del repo contra ${baseUrl}\n`);

  // Todos los bots del servidor de una (evita N búsquedas y detecta huérfanos).
  const delServidor = await medplum.searchResources('Bot', { _count: 200 });
  const porNombre = new Map(delServidor.map((b) => [b.name ?? '', b]));

  let ok = 0;
  let sinCodigo = 0;
  let faltan = 0;
  for (const def of BOTS) {
    const bot = porNombre.get(def.name);
    if (!bot?.id) {
      console.log(`  ✗ FALTA        ${def.name}`);
      faltan++;
      continue;
    }
    const deployado = Boolean(bot.executableCode?.url ?? bot.executableCode?.data);
    const runtime = bot.runtimeVersion ?? '(sin runtime)';
    const avisoRuntime = runtime !== RUNTIME_ESPERADO ? `  ⚠ runtime=${runtime} (esperado ${RUNTIME_ESPERADO})` : '';
    if (!deployado) {
      console.log(`  ⚠ SIN CÓDIGO   ${def.name} (Bot/${bot.id})${avisoRuntime}`);
      sinCodigo++;
    } else {
      const actualizado = bot.meta?.lastUpdated ? ` · deploy: ${bot.meta.lastUpdated.slice(0, 16).replace('T', ' ')}` : '';
      console.log(`  ✓ OK           ${def.name} (Bot/${bot.id})${actualizado}${avisoRuntime}`);
      ok++;
    }
  }

  const nombresRepo = new Set(BOTS.map((b) => b.name));
  const huerfanos = delServidor.filter((b) => b.name && !nombresRepo.has(b.name));
  if (huerfanos.length > 0) {
    console.log(`\nBots en el servidor que NO están en este repo (¿portal u otra app?):`);
    for (const h of huerfanos) {
      console.log(`  - ${h.name} (Bot/${h.id})`);
    }
  }

  console.log(`\nResumen: ${ok}/${BOTS.length} OK · ${sinCodigo} sin código · ${faltan} faltantes`);
  if (faltan > 0 || sinCodigo > 0) {
    console.log('→ Corré `npm run deploy:bots` para crear/deployar lo que falta.');
    process.exitCode = 1;
  } else {
    console.log('✓ Todos los bots del repo están creados y deployados.');
  }
}

main().catch((err) => {
  console.error('bots:check falló:', err);
  process.exitCode = 1;
});
