/**
 * Horario de los bots que corren solos.
 *
 *   npm run bots:cron            # solo mira y reporta (no toca nada)
 *   npm run bots:cron -- --apply # escribe el cronString en el servidor
 *
 * El horario de cada bot vive en `bots-def.ts` (campo `cron`), no en un
 * instructivo: es una decisión de negocio —cada cuánto se libera un lugar,
 * cuándo se cobra— y se revisa en un PR como cualquier otra regla. Este script
 * es lo único que lo pone y lo compara.
 *
 * ## Por qué hace falta un comando y no alcanza con la UI
 *
 * Un cron mal escrito **no da error**. Medplum guarda el string y el bot no corre
 * nunca — es lo mismo que pasó con `cronTimer`, un campo que no existe y que los
 * docs recomendaron durante meses sin que nadie se enterara. Un horario que falla
 * en silencio es peor que uno que falla fuerte: quien lo configuró se va
 * convencido de que quedó andando.
 *
 * Por eso acá se valida la expresión **antes** de mandarla, se traduce a
 * castellano para que se lea lo que va a pasar, y se compara lo que hay en el
 * servidor contra lo que dice el repo.
 *
 * ## Tres cosas que no hace
 *
 * 1. **No programa un bot sin código.** Un bot con `cronString` y sin
 *    `executableCode` tiquea al vacío: el error queda en CloudWatch y desde
 *    afuera parece que anda. Primero `deploy:bots`, después esto.
 * 2. **No elige entre dos bots con el mismo nombre.** Si hay duplicados, el cron
 *    puede terminar en el viejo. Se avisa y se saltea.
 * 3. **No escribe nada sin `--apply`.** Mismo criterio que `migrar:dni-renaper`.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Bot } from '@medplum/fhirtypes';
import { BOTS } from './bots-def.js';
import { corridasPorDia, describirCron, validarCron } from '../lib/cron.js';

/**
 * Por encima de esto, un bot que cobra o borra da para preguntar si es a
 * propósito. No bloquea: avisa.
 */
const CORRIDAS_SOSPECHOSAS = 24 * 6;

/** Bots que hacen algo irreversible cada vez que tiquean. */
const DELICADOS = new Set(['bw-cobro-membresias', 'bw-limpiar-demo']);

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/** Qué hay que hacer con un bot. */
type Accion = 'ya-esta' | 'poner' | 'cambiar' | 'sin-codigo' | 'duplicado' | 'falta' | 'cron-invalido';

interface Caso {
  nombre: string;
  accion: Accion;
  deseado: string;
  actual?: string;
  bot?: Bot;
  detalle?: string;
}

function evaluar(nombre: string, deseado: string, candidatos: Bot[]): Caso {
  const validacion = validarCron(deseado);
  if (!validacion.ok) {
    // El repo tiene un cron mal escrito. Se corta acá: mandarlo sería programar
    // un bot que no va a correr nunca, en silencio.
    return { nombre, accion: 'cron-invalido', deseado, detalle: validacion.error };
  }
  if (candidatos.length === 0) {
    return { nombre, accion: 'falta', deseado };
  }
  if (candidatos.length > 1) {
    return {
      nombre,
      accion: 'duplicado',
      deseado,
      detalle: candidatos.map((b) => `Bot/${b.id}`).join(', '),
    };
  }
  const bot = candidatos[0]!;
  if (!bot.executableCode) {
    return { nombre, accion: 'sin-codigo', deseado, bot };
  }
  const actual = bot.cronString;
  if (actual === deseado) {
    return { nombre, accion: 'ya-esta', deseado, actual, bot };
  }
  return { nombre, accion: actual ? 'cambiar' : 'poner', deseado, actual, bot };
}

const MARCA: Record<Accion, string> = {
  'ya-esta': '✓',
  poner: '·',
  cambiar: '·',
  'sin-codigo': '⚠',
  duplicado: '⚠',
  falta: '✗',
  'cron-invalido': '✗',
};

async function main(): Promise<void> {
  const aplicar = process.argv.includes('--apply');
  const baseUrl = requireEnv('MEDPLUM_BASE_URL');
  const medplum = new MedplumClient({ baseUrl, fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));

  console.log('=== Horario de los bots (cronString) ===\n');
  console.log(`  Servidor: ${baseUrl}`);
  console.log(`  Modo    : ${aplicar ? 'APLICAR (escribe en el servidor)' : 'solo lectura (agregá --apply para escribir)'}\n`);

  const delServidor = await medplum.searchResources('Bot', { _count: 200 });
  const programables = BOTS.filter((b) => b.cron);
  const casos = programables.map((def) =>
    evaluar(def.name, def.cron as string, delServidor.filter((b) => b.name === def.name)),
  );

  for (const c of casos) {
    const linea = `  ${MARCA[c.accion]} ${c.nombre.padEnd(24)} ${c.deseado.padEnd(14)} ${describirCron(c.deseado)}`;
    switch (c.accion) {
      case 'ya-esta':
        console.log(`${linea}`);
        break;
      case 'poner':
        console.log(`${linea}\n      → sin horario en el servidor; se le pone este.`);
        break;
      case 'cambiar':
        console.log(`${linea}\n      → el servidor tiene "${c.actual}" (${describirCron(c.actual as string)}); se reemplaza.`);
        break;
      case 'sin-codigo':
        console.log(`${linea}\n      ⚠ El bot existe pero NO tiene código deployado. Un cron sobre un bot sin`);
        console.log('        código tiquea al vacío y desde afuera parece que anda. Corré');
        console.log('        `npm run deploy:bots` y volvé. NO se programa.');
        break;
      case 'duplicado':
        console.log(`${linea}\n      ⚠ Hay más de un bot con este nombre (${c.detalle}). El cron podría quedar`);
        console.log('        en el viejo. Borrá los duplicados en Medplum. NO se programa.');
        break;
      case 'falta':
        console.log(`${linea}\n      ✗ No existe en el servidor. Corré \`npm run deploy:bots\`.`);
        break;
      case 'cron-invalido':
        console.log(`${linea}\n      ✗ El cron del repo está mal: ${c.detalle}.`);
        console.log('        Arreglalo en src/seed/bots-def.ts — así como está, el bot no correría nunca.');
        break;
    }

    // Avisos que no dependen del estado del servidor.
    const porDia = corridasPorDia(c.deseado);
    if (porDia !== undefined && porDia > CORRIDAS_SOSPECHOSAS && DELICADOS.has(c.nombre)) {
      console.log(`      ⚠ ${porDia} corridas por día en un bot que hace algo irreversible. ¿Es a propósito?`);
    }
    // Los dos campos conviven en el recurso y no está documentado cuál gana.
    if (c.bot?.cronTiming) {
      console.log('      ⚠ Este bot ADEMÁS tiene `cronTiming` cargado. Los dos campos conviven en el');
      console.log('        recurso y Medplum no documenta cuál gana. Dejá uno solo: borrá el cronTiming');
      console.log('        desde la UI para que el horario sea el de acá y no una sorpresa.');
    }
  }

  // La deriva al revés: alguien programó por la UI algo que el repo no conoce.
  const nombresDelRepo = new Set(BOTS.map((b) => b.name));
  const inesperados = delServidor.filter(
    (b) => b.cronString && !programables.some((p) => p.name === b.name),
  );
  if (inesperados.length > 0) {
    console.log('\n  Bots CON horario en el servidor que el repo no programa:');
    for (const b of inesperados) {
      const origen = nombresDelRepo.has(b.name ?? '') ? 'del repo, sin `cron` en bots-def' : 'ajeno a este repo';
      console.log(`    - ${(b.name ?? '?').padEnd(24)} ${b.cronString}   (${origen})`);
    }
    console.log('    Si alguno tiene que correr solo, su horario va en bots-def.ts para que quede');
    console.log('    versionado. Este script no toca lo que no declara.');
  }

  const aCambiar = casos.filter((c) => c.accion === 'poner' || c.accion === 'cambiar');
  const bloqueados = casos.filter((c) => !['ya-esta', 'poner', 'cambiar'].includes(c.accion));

  if (aplicar && aCambiar.length > 0) {
    console.log('\n--- Aplicando ---\n');
    for (const c of aCambiar) {
      try {
        const escrito = await medplum.updateResource<Bot>({ ...(c.bot as Bot), cronString: c.deseado });
        console.log(`  ✓ ${c.nombre.padEnd(24)} Bot/${escrito.id} → ${escrito.cronString}`);
      } catch (e) {
        console.error(`  ✗ ${c.nombre.padEnd(24)} ${e instanceof Error ? e.message : String(e)}`);
        bloqueados.push(c);
      }
    }
  }

  console.log('\n=== Resumen ===\n');
  const ok = casos.filter((c) => c.accion === 'ya-esta').length;
  console.log(`  ${ok}/${programables.length} ya coinciden con el repo`);
  if (aCambiar.length > 0) {
    console.log(`  ${aCambiar.length} ${aplicar ? 'aplicados' : 'por aplicar (corré con --apply)'}`);
  }
  if (bloqueados.length > 0) {
    console.log(`  ${bloqueados.length} bloqueados: mirá los avisos de arriba`);
  }

  if (!aplicar && aCambiar.length === 0 && bloqueados.length === 0) {
    console.log('\n  ✓ El servidor coincide con el repo. No hay nada que hacer.');
  }

  // Con `--apply` la zona horaria pasa a importar de verdad, así que el aviso va
  // ahí y no antes: es lo único que queda sin confirmar de todo esto.
  if (aplicar) {
    console.log('\n  Zona horaria: no está confirmado en qué TZ evalúa Medplum el cron. Si fuera UTC,');
    console.log('  `0 9 * * *` son las 06:00 de Argentina. El único bot cuyo horario importa es');
    console.log('  bw-cobro-membresias, y como solo actúa los días 1-5 y es idempotente por ciclo,');
    console.log('  correrlo tres horas antes no rompe nada. Confirmalo igual antes de darlo por hecho.');
  }

  console.log('\n  Que el campo esté escrito NO prueba que el tick corra: eso se verifica con el');
  console.log('  fixture, en docs/puesta-en-produccion.md § "Verificar".');

  if (bloqueados.length > 0 || (!aplicar && aCambiar.length > 0)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('bots:cron falló:', err);
  process.exitCode = 1;
});
