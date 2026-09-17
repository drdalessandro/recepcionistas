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

/** Nombre normalizado para matchear variantes ("D'Alessandro" ≈ "Dalessandro"). */
function clave(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function nombreDe(p: Practitioner): string {
  return p.name?.[0]?.text ?? [p.name?.[0]?.given?.join(' '), p.name?.[0]?.family].filter(Boolean).join(' ');
}

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

    if (candidatos.length === 0) {
      console.log(`• ${m.nombre}: sin fichas en el server (el próximo seed la crea).`);
      continue;
    }
    const unica = candidatos[0]!;
    if (candidatos.length === 1 && tieneId(unica) && unica.active !== false) {
      console.log(`• ${m.nombre}: una sola ficha (${unica.id}) — OK.`);
      continue;
    }

    // El id forzado gana sobre la deducción por antigüedad: es una decisión
    // que depende de datos de otro repo (quién tiene la matrícula).
    const forzadoId = forzados.get(m.codigo);
    const forzado = forzadoId ? candidatos.find((p) => p.id === forzadoId) : undefined;
    if (forzadoId && !forzado) {
      // Falla RUIDOSA: elegir otra ficha "porque el id no apareció" es
      // exactamente lo que no se quiere en una operación que desactiva fichas.
      console.log(`• ${m.nombre}: ⚠️  --canonico ${forzadoId} NO está entre sus fichas. Se saltea (no se toca nada).`);
      console.log(`    fichas encontradas: ${candidatos.map((p) => p.id).join(' · ')}`);
      process.exitCode = 1;
      continue;
    }
    const conId = candidatos.filter(tieneId);
    const canonico = forzado ?? (conId.length > 0 ? conId : candidatos)[0]!;
    console.log(
      `• ${m.nombre}: ${candidatos.length} fichas → canónica ${canonico.id}` +
        ` (${canonico.meta?.lastUpdated?.slice(0, 10)})${forzado ? ' [forzada]' : ''}`,
    );

    for (const p of candidatos) {
      if (p.id === canonico.id) {
        const necesitaId = !tieneId(p);
        const necesitaActivar = p.active === false;
        if (necesitaId || necesitaActivar) {
          console.log(`    ↳ ${p.id}: ${necesitaId ? '+identifier ' : ''}${necesitaActivar ? '+active' : ''}`);
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
      console.log(`    ↳ ${p.id} (${p.meta?.lastUpdated?.slice(0, 10)}): active:false${tieneId(p) ? ' y se le quita el identifier' : ''}`);
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
