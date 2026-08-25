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
import {
  corridasPorDia,
  decidirCron,
  decidirDesprogramar,
  describirCron,
  estaBloqueado,
  hayQueEscribir,
  type AccionCron,
  type CasoCron,
} from '../lib/cron.js';

/**
 * Umbrales del aviso de frecuencia. No bloquean: avisan.
 *
 * Dos escalas a propósito. Para cualquier bot, más seguido que cada 10 minutos
 * (144/día) es más de lo que ninguno de los nuestros necesita. Para un bot que
 * hace algo irreversible —cobrar, borrar—, ya "más de una vez por hora" da para
 * preguntar si es a propósito. La primera versión de esto solo miraba a los
 * delicados con el umbral alto: como sus horarios reales son diarios/horarios,
 * el aviso era literalmente inalcanzable.
 */
const CORRIDAS_SOSPECHOSAS = 24 * 6;
const CORRIDAS_SOSPECHOSAS_DELICADO = 24;

/** Bots que hacen algo irreversible cada vez que tiquean. */
const DELICADOS = new Set(['bw-cobro-membresias', 'bw-limpiar-demo']);

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/** Un caso, ya decidido, con el bot al que corresponde. */
interface Caso extends CasoCron {
  nombre: string;
  bot?: Bot;
}

const MARCA: Record<AccionCron, string> = {
  'ya-esta': '✓',
  poner: '·',
  cambiar: '·',
  desprogramar: '·',
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
  // Con una sola página, "no apareció" y "no existe" serían lo mismo: un bot
  // real se reportaría como `falta`. Con más de 200 bots, se busca dirigido.
  const paginaLlena = delServidor.length >= 200;
  if (paginaLlena) {
    console.log('  ⚠ El servidor tiene 200+ bots: la lista global puede estar truncada. Se busca');
    console.log('    cada bot por nombre para no confundir "no apareció" con "no existe".\n');
  }
  const candidatosDe = async (nombre: string): Promise<Bot[]> => {
    if (!paginaLlena) {
      return delServidor.filter((b) => b.name === nombre);
    }
    const directos = await medplum.searchResources('Bot', `name=${encodeURIComponent(nombre)}&_count=10`);
    return directos.filter((b) => b.name === nombre);
  };

  const programables = BOTS.filter((b) => b.cron);
  const casos: Caso[] = [];
  for (const def of programables) {
    const candidatos = await candidatosDe(def.name);
    casos.push({ nombre: def.name, bot: candidatos[0], ...decidirCron(def.cron as string, candidatos) });
  }
  // El camino inverso: bots del repo a los que se les SACÓ el `cron` y en el
  // servidor siguen programados. Sacar el cron de bots-def tiene que
  // desprogramar de verdad, no solo dejar de mirarlo.
  for (const def of BOTS.filter((b) => !b.cron)) {
    const candidatos = await candidatosDe(def.name);
    const caso = decidirDesprogramar(candidatos);
    if (caso) {
      casos.push({ nombre: def.name, bot: candidatos[0], ...caso });
    }
  }

  for (const c of casos) {
    const linea = c.accion === 'desprogramar'
      ? `  · ${c.nombre.padEnd(24)} ${'(sin cron)'.padEnd(14)} hoy el servidor lo corre solo`
      : `  ${MARCA[c.accion]} ${c.nombre.padEnd(24)} ${c.deseado.padEnd(14)} ${describirCron(c.deseado)}`;
    switch (c.accion) {
      case 'ya-esta':
        console.log(`${linea}`);
        break;
      case 'poner':
        console.log(`${linea}\n      → sin horario en el servidor; se le pone este.`);
        break;
      case 'cambiar':
        if (c.actual === c.deseado) {
          console.log(`${linea}\n      → el horario coincide, pero arrastra un \`cronTiming\` de la configuración`);
          console.log('        vieja por UI. Los dos campos conviven y Medplum no documenta cuál gana:');
          console.log('        se borra el cronTiming en la misma escritura.');
        } else {
          console.log(`${linea}\n      → el servidor tiene "${c.actual ?? '(nada)'}" (${describirCron(c.actual ?? '')}); se reemplaza.`);
          if (c.conTiming) {
            console.log('        Además arrastra un `cronTiming`: se borra en la misma escritura.');
          }
        }
        break;
      case 'desprogramar':
        console.log(`${linea}`);
        console.log(`      → el servidor tiene "${c.actual ?? '(cronTiming)'}" pero el repo dice que este bot NO corre`);
        console.log('        solo (no tiene `cron` en bots-def.ts). Se le borra el horario: si tiene que');
        console.log('        correr, el lugar de decirlo es bots-def, versionado.');
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

    // Avisos de frecuencia, con dos umbrales: cualquier bot por encima de "cada
    // 10 minutos" se marca; uno delicado, ya con "más de una vez por hora".
    if (c.deseado) {
      const porDia = corridasPorDia(c.deseado);
      const umbral = DELICADOS.has(c.nombre) ? CORRIDAS_SOSPECHOSAS_DELICADO : CORRIDAS_SOSPECHOSAS;
      if (porDia !== undefined && porDia > umbral) {
        console.log(
          `      ⚠ ${porDia} corridas por día${DELICADOS.has(c.nombre) ? ' en un bot que hace algo irreversible' : ''}. ¿Es a propósito?`,
        );
      }
    }
  }

  // La deriva que no es de este repo: bots ajenos (portal u otra app) con
  // horario. Solo se reporta — desprogramar lo que no es nuestro no es decisión
  // de este script. Los bots del repo sin `cron` ya entraron como `desprogramar`.
  const nombresDelRepo = new Set(BOTS.map((b) => b.name));
  const ajenos = delServidor.filter((b) => b.cronString && !nombresDelRepo.has(b.name ?? ''));
  if (ajenos.length > 0) {
    console.log('\n  Bots AJENOS a este repo con horario en el servidor (no se tocan):');
    for (const b of ajenos) {
      console.log(`    - ${(b.name ?? '?').padEnd(24)} ${b.cronString}`);
    }
  }

  const aCambiar = casos.filter((c) => hayQueEscribir(c.accion));
  const bloqueados = casos.filter((c) => estaBloqueado(c.accion));
  let aplicados = 0;

  if (aplicar && aCambiar.length > 0) {
    console.log('\n--- Aplicando ---\n');
    for (const c of aCambiar) {
      try {
        const bot = c.bot as Bot;
        // `cronString: undefined` desaparece del JSON: así se BORRA el campo en
        // un PUT. Y el If-Match hace que, si alguien tocó el bot entre nuestra
        // lectura y esta escritura, el servidor rechace en vez de pisar: este
        // PUT manda el recurso entero, y sin la condición se llevaría puesto lo
        // que otro haya cambiado en el medio.
        const escrito = await medplum.updateResource<Bot>(
          { ...bot, cronString: c.deseado || undefined, cronTiming: undefined },
          bot.meta?.versionId ? { headers: { 'If-Match': `W/"${bot.meta.versionId}"` } } : undefined,
        );
        // La respuesta del PUT tiene la verdad en la mano: se mira, no se asume.
        // La premisa de todo este slice es que Medplum puede aceptar y descartar.
        const quedo = escrito.cronString ?? '';
        if (quedo !== c.deseado || (c.deseado === '' && escrito.cronTiming)) {
          console.error(`  ✗ ${c.nombre.padEnd(24)} el servidor contestó 200 pero guardó "${quedo || '(nada)'}"`);
          console.error(`      en vez de "${c.deseado || '(desprogramado)'}". Revisalo en la UI antes de confiar.`);
          bloqueados.push(c);
          continue;
        }
        aplicados++;
        console.log(`  ✓ ${c.nombre.padEnd(24)} Bot/${escrito.id} → ${escrito.cronString ?? '(desprogramado)'}`);
      } catch (e) {
        const mensaje = e instanceof Error ? e.message : String(e);
        console.error(`  ✗ ${c.nombre.padEnd(24)} ${mensaje}`);
        if (/precondition|412|conflict/i.test(mensaje)) {
          console.error('      El bot cambió en el servidor entre la lectura y la escritura (¿otro deploy');
          console.error('      u otra persona?). No se pisó nada: volvé a correr el comando.');
        }
        bloqueados.push(c);
      }
    }
  }

  console.log('\n=== Resumen ===\n');
  const ok = casos.filter((c) => c.accion === 'ya-esta').length;
  console.log(`  ${ok}/${programables.length} ya coinciden con el repo`);
  if (aplicar && aCambiar.length > 0) {
    // Se cuentan los ÉXITOS, no los intentos: "3 aplicados" con un PUT fallido
    // en el medio era mentirle al operador justo donde no se puede.
    console.log(`  ${aplicados}/${aCambiar.length} aplicados`);
  } else if (aCambiar.length > 0) {
    console.log(`  ${aCambiar.length} por aplicar (corré con --apply)`);
  }
  if (bloqueados.length > 0) {
    console.log(`  ${bloqueados.length} bloqueados: mirá los avisos de arriba`);
  }

  if (!aplicar && aCambiar.length === 0 && bloqueados.length === 0) {
    console.log('\n  ✓ El servidor coincide con el repo. No hay nada que hacer.');
  }

  // En el dry-run también: el operador decide LEYENDO esta salida, y "a las
  // 09:00" sin la salvedad de zona horaria es afirmar una hora de pared que no
  // está confirmada.
  console.log('\n  Zona horaria: no está confirmado en qué TZ evalúa Medplum el cron. Si fuera UTC,');
  console.log('  `0 9 * * *` son las 06:00 de Argentina. El único bot cuyo horario importa es');
  console.log('  bw-cobro-membresias, y como solo actúa los días 1-5 y es idempotente por ciclo,');
  console.log('  correrlo tres horas antes no rompe nada. Confirmalo igual antes de darlo por hecho.');

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
