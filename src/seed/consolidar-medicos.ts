/**
 * Consolida los Practitioner DUPLICADOS de los médicos del catálogo.
 *
 *   npm run medicos:consolidar             → muestra el plan, NO toca nada
 *   npm run medicos:consolidar -- --aplicar → lo ejecuta
 *   npm run medicos:consolidar -- --canonico MED_X=<id>  → fuerza cuál ficha gana
 *
 * Por qué existen duplicados: los médicos se crearon a mano en Medplum antes
 * de que el seed les pusiera identifier (`medico|MED_*`); cuando el seed no
 * encuentra el identifier, crea una ficha nueva → dos Practitioner por médico.
 *
 * Regla de consolidación (conservadora, no borra nada):
 *  - CANÓNICO: el que tiene el identifier del catálogo (si hay varios, el más
 *    viejo). Se asegura de que tenga el identifier y active:true. Es el que
 *    referencian el Schedule de su agenda publicada y los turnos nuevos.
 *  - Los demás con el mismo nombre quedan `active:false` y SIN el identifier
 *    (para que ninguna referencia condicional sea ambigua). Las referencias
 *    históricas (turnos viejos) siguen resolviendo.
 *
 * ## Cuándo hace falta `--canonico`
 *
 * La regla de arriba deduce el canónico por antigüedad, y eso alcanza cuando
 * los duplicados son nuestros. **No alcanza cuando la ficha buena es la del
 * Dashboard**: ahí la que gana tiene que ser la que lleva la **matrícula** —sin
 * ella no se firman recetas— y eso no se deduce de una fecha. Con
 * `--canonico MED_DALESSANDRO=b5fd368b-…` se elige a mano, que es lo honesto
 * para una decisión que depende de datos que este repo no ve.
 *
 * El seed **no** le va a borrar la matrícula a la ficha que gane: desde
 * `src/fhir/practitioner.ts` el upsert de `Practitioner` fusiona en vez de
 * reemplazar. Sin eso, consolidar no serviría de nada — la próxima corrida
 * dejaría la ficha buena sin matrícula.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Practitioner } from '@medplum/fhirtypes';
import { MEDICOS } from '../config/medicos.js';
import { SYSTEM } from '../fhir/identifiers.js';
import {
  claveNombre as clave,
  datosNoRegenerables,
  nombreDePractitioner as nombreDe,
  tieneMatricula,
} from '../fhir/practitioner.js';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/**
 * `--canonico MED_X=<id>` (repetible): qué ficha tiene que ganar, por código de
 * médico. Acepta `--canonico MED_X=id` y `--canonico=MED_X=id`.
 */
function canonicosForzados(argv: string[]): Map<string, string> {
  const forzados = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const valor = a.startsWith('--canonico=') ? a.slice('--canonico='.length) : a === '--canonico' ? argv[i + 1] : undefined;
    const [codigo, id] = (valor ?? '').split('=');
    if (codigo && id) {
      forzados.set(codigo, id);
    }
  }
  return forzados;
}

async function main(): Promise<void> {
  const aplicar = process.argv.includes('--aplicar');
  const forzados = canonicosForzados(process.argv);
  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log(`Conectado. Modo: ${aplicar ? 'APLICAR' : 'dry-run (usá -- --aplicar para ejecutar)'}\n`);

  const todos = await medplum.searchResources('Practitioner', { _count: 200 });

  for (const m of MEDICOS) {
    const k = clave(m.nombre);
    const tieneId = (p: Practitioner): boolean =>
      Boolean(p.identifier?.some((i) => i.system === SYSTEM.medico && i.value === m.codigo));
    const candidatos = todos
      .filter((p) => clave(nombreDe(p)) === k || tieneId(p))
      .sort((a, b) => (a.meta?.lastUpdated ?? '').localeCompare(b.meta?.lastUpdated ?? ''));

    // El forzado se resuelve ANTES de cualquier atajo: si el operador nombró
    // una ficha, hay trabajo que hacer aunque la búsqueda por nombre haya
    // encontrado una sola.
    const forzadoId = forzados.get(m.codigo);
    let forzado = forzadoId ? candidatos.find((p) => p.id === forzadoId) : undefined;

    if (forzadoId && !forzado) {
      // No apareció en la búsqueda por nombre. Antes de rendirse hay que leerlo
      // directo: la diferencia entre "no lo vemos" y "existe pero no matcheó"
      // es la diferencia entre un problema de proyecto/permisos y uno de
      // nombre, y se arreglan en lugares distintos.
      const suelto = await medplum.readResource('Practitioner', forzadoId).catch(() => undefined);
      if (!suelto) {
        console.log(`• ${m.nombre}: ⚠️  Practitioner/${forzadoId} NO existe o no es visible con estas credenciales.`);
        console.log('    Casi siempre significa que está en OTRO proyecto de Medplum: los identifier');
        console.log('    no cruzan proyectos, así que no alcanza con agregarlo — hay que decidir cuál');
        console.log('    de los dos proyectos es el dueño de la ficha del profesional.');
        console.log(`    fichas visibles acá: ${candidatos.map((p) => p.id).join(' · ') || '(ninguna)'}`);
        process.exitCode = 1;
        continue;
      }
      // Existe y lo nombraron explícitamente: entra como candidato. El match por
      // nombre es una heurística para DESCUBRIR duplicados, no una barrera para
      // una orden directa del operador.
      console.log(`• ${m.nombre}: Practitioner/${forzadoId} existe pero no matcheó por nombre — se usa igual.`);
      console.log(`    en el server: "${nombreDe(suelto)}" → clave "${clave(nombreDe(suelto))}"`);
      console.log(`    en el catálogo: "${m.nombre}" → clave "${clave(m.nombre)}"`);
      candidatos.push(suelto);
      forzado = suelto;
    }

    if (candidatos.length === 0) {
      console.log(`• ${m.nombre}: sin fichas en el server (el próximo seed la crea).`);
      continue;
    }
    const unica = candidatos[0]!;
    if (!forzado && candidatos.length === 1 && tieneId(unica) && unica.active !== false) {
      console.log(`• ${m.nombre}: una sola ficha (${unica.id}) — OK.`);
      continue;
    }
    const conId = candidatos.filter(tieneId);
    const canonico = forzado ?? (conId.length > 0 ? conId : candidatos)[0]!;
    console.log(
      `• ${m.nombre}: ${candidatos.length} fichas → canónica ${canonico.id}` +
        ` (${canonico.meta?.lastUpdated?.slice(0, 10)})${forzado ? ' [forzada]' : ''}`,
    );

    // SALVAGUARDA. Si una ficha que se va a desactivar tiene datos que este repo
    // no puede regenerar —la matrícula, sobre todo— y la canónica no los tiene,
    // el script está por elegir la ficha equivocada. No puede saber cuál es la
    // buena: la matrícula la carga el Dashboard y acá no se modela. Así que
    // **no elige**: lo dice y frena, salvo que el operador ya haya decidido con
    // `--canonico`, que es la forma de afirmar "sé cuál quiero".
    if (!forzado) {
      const perdibles = candidatos.filter((p) => p.id !== canonico.id && datosNoRegenerables(p).length > 0);
      if (perdibles.length > 0 && datosNoRegenerables(canonico).length === 0) {
        // El mensaje nombra lo que DE VERDAD encontró. Decir "matrícula" cuando
        // lo perdible son identifier de otro sistema manda a revisar el
        // Dashboard por una matrícula que no existe, y deja creer que el otro
        // caso es menos grave de lo que es.
        const hayMatricula = perdibles.some(tieneMatricula);
        console.log(
          hayMatricula
            ? '    ⚠️  FRENO: la ficha que quedaría activa NO tiene matrícula y alguna de las otras SÍ.'
            : '    ⚠️  FRENO: alguna de las otras fichas tiene datos que el seed no puede regenerar, y la que quedaría activa no.',
        );
        for (const p of perdibles) {
          console.log(`        ${p.id} (${p.meta?.lastUpdated?.slice(0, 10)}): ${datosNoRegenerables(p).join(' · ')}`);
        }
        console.log(`    → Decidí vos cuál gana:  --canonico ${m.codigo}=<id>`);
        console.log(
          hayMatricula
            ? '      (desactivar la ficha con la matrícula deja al profesional sin poder recetar)'
            : '      (desactivarla tira identifier que cargó otro sistema; el seed no los vuelve a escribir)',
        );
        process.exitCode = 1;
        continue;
      }
    }

    for (const p of candidatos) {
      if (p.id === canonico.id) {
        const necesitaId = !tieneId(p);
        const necesitaActivar = p.active === false;
        if (necesitaId || necesitaActivar) {
          const señales = datosNoRegenerables(p);
          console.log(
            `    ↳ ${p.id}: ${necesitaId ? '+identifier ' : ''}${necesitaActivar ? '+active' : ''}` +
              (señales.length > 0 ? `  (conserva ${señales.join(' · ')})` : ''),
          );
          if (aplicar) {
            await medplum.updateResource<Practitioner>({
              ...p,
              active: true,
              identifier: [
                ...(p.identifier ?? []).filter((i) => i.system !== SYSTEM.medico),
                { system: SYSTEM.medico, value: m.codigo },
              ],
            });
          }
        }
        continue;
      }
      const señales = datosNoRegenerables(p);
      console.log(
        `    ↳ ${p.id} (${p.meta?.lastUpdated?.slice(0, 10)}): active:false${tieneId(p) ? ' y se le quita el identifier' : ''}` +
          (señales.length > 0 ? `  ⚠️ tiene ${señales.join(' · ')}` : ''),
      );
      if (aplicar) {
        await medplum.updateResource<Practitioner>({
          ...p,
          active: false,
          identifier: (p.identifier ?? []).filter((i) => i.system !== SYSTEM.medico),
        });
      }
    }
  }

  console.log(
    aplicar
      ? '\nConsolidación aplicada. Verificá en el admin: un solo Practitioner activo por médico.'
      : '\nDry-run: nada se tocó. Reejecutá con `npm run medicos:consolidar -- --aplicar`.',
  );
}

main().catch((err) => {
  console.error('medicos:consolidar falló:', err);
  process.exitCode = 1;
});
