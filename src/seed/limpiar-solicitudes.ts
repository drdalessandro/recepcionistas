/**
 * Borra las solicitudes de turno YA CERRADAS que nadie toca hace rato.
 *
 *   npm run limpiar:solicitudes                      → muestra qué borraría, NO toca nada
 *   npm run limpiar:solicitudes -- --dias=60         → cambia el umbral (default 30)
 *   npm run limpiar:solicitudes -- --paciente=<id>   → acota a UNA ficha
 *   npm run limpiar:solicitudes -- --apply           → borra de verdad
 *
 * ## Por qué existe
 *
 * El portal lista en "Mis solicitudes" TODOS los `Task` de solicitud del
 * paciente, también los ya resueltos, y se le apilan (Andrés, 2026-09-17). La
 * bandeja de Recepción no tiene ese problema porque filtra `status=requested`.
 *
 * ## Qué se lleva puesto, y qué no
 *
 * Solo `Task` con el código `solicitud-turno`. Nada de las tareas del PB100D,
 * de los leads del CRM ni de ninguna otra cosa que viva en `Task`.
 *
 * Y de esas, solo las **cerradas** (`completed` / `cancelled`) con más de
 * `--dias` sin actividad. El criterio vive en `solicitudBorrable`
 * (`src/lib/solicitudes.ts`), que se testea: una solicitud en curso no se
 * borra aunque sea vieja, porque está en la bandeja de alguien y
 * `disponibilidadDePaciente` le está reservando el horario.
 *
 * ## Lo que se pierde
 *
 * Es un borrado de verdad, no un archivado, y el `Task` es el único lugar
 * donde queda **qué pidió** el paciente (jueves 17:00) frente a **qué se le
 * dio**. Por eso cada línea que se borra se imprime entera, con el pedido y el
 * turno que salió de él: la corrida es el último registro que queda. Conviene
 * guardarse la salida.
 *
 * No rompe nada funcional: ningún bot lee las solicitudes cerradas —
 * `resolverSolicitudTurno` busca `status=requested` y `disponibilidadDePaciente`
 * solo cuenta las vivas.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Task } from '@medplum/fhirtypes';
import { COD } from '../fhir/identifiers.js';
import { solicitudBorrable } from '../lib/solicitudes.js';

const DIAS_DEFAULT = 30;

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/** `--dias=N`. Default 30. Un valor inválido no se adivina: corta. */
function parseDias(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith('--dias='));
  if (!arg) {
    return DIAS_DEFAULT;
  }
  const n = Number(arg.slice('--dias='.length));
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--dias tiene que ser un número >= 0 (recibí "${arg}").`);
  }
  return n;
}

/** `--paciente=<id>`: acota a una ficha (sirve para limpiar datos de prueba). */
function parsePaciente(argv: string[]): string | undefined {
  const arg = argv.find((a) => a.startsWith('--paciente='));
  return arg?.slice('--paciente='.length) || undefined;
}

/** Lo que pidió el paciente, reconstruido de los `input` del Task. */
function queHabiaPedido(t: Task): string {
  const input = (tipo: string): string | undefined =>
    t.input?.find((i) => i.type?.text === tipo)?.valueString ??
    t.input?.find((i) => i.type?.text === tipo)?.valueDateTime;
  const partes = [
    input('terapia') ?? input('terapia-codigo'),
    input('preferencia-inicio') ?? input('preferencia-texto'),
  ].filter(Boolean);
  return partes.length > 0 ? partes.join(' · ') : (t.description ?? '(sin detalle)');
}

/** El turno que salió de esta solicitud, si lo hubo. */
function turnoResultante(t: Task): string | undefined {
  return t.output?.find((o) => o.type?.text === 'appointment')?.valueReference?.reference;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dias = parseDias(process.argv);
  const paciente = parsePaciente(process.argv);
  const ahora = new Date();

  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));

  console.log('=== Limpieza de solicitudes de turno cerradas ===');
  console.log(`  Modo: ${apply ? 'APLICAR (borra)' : 'dry-run (no toca nada)'}`);
  console.log(`  Umbral: cerradas hace más de ${dias} día(s)${paciente ? ` · solo Patient/${paciente}` : ''}`);
  if (dias < 7 && apply) {
    console.log('  ⚠️  Umbral corto: vas a borrar solicitudes que se resolvieron esta semana.');
  }
  console.log('');

  // La búsqueda ya acota por código y por estado cerrado; `solicitudBorrable`
  // vuelve a decidir sobre cada una. Redundante a propósito: el criterio que
  // manda es el testeado, no el string de la query.
  const filtros: string[][] = [
    ['code', COD.solicitudTurno],
    ['status', 'completed,cancelled'],
    ['_count', '200'],
  ];
  if (paciente) {
    filtros.push(['patient', paciente]);
  }

  const cerradas: Task[] = [];
  for await (const pagina of medplum.searchResourcePages('Task', filtros)) {
    cerradas.push(...pagina);
  }

  const aBorrar = cerradas.filter((t) =>
    solicitudBorrable({ status: t.status, ultimaActividad: t.meta?.lastUpdated }, { ahora, dias }),
  );

  console.log(`  Solicitudes cerradas encontradas: ${cerradas.length}`);
  console.log(`  De esas, con más de ${dias} día(s) sin actividad: ${aBorrar.length}\n`);

  if (aBorrar.length === 0) {
    console.log('Nada para borrar.');
    return;
  }

  let borradas = 0;
  for (const t of aBorrar) {
    const cuando = t.meta?.lastUpdated?.slice(0, 10) ?? '?';
    const quien = t.for?.reference ?? '(sin paciente)';
    const turno = turnoResultante(t);
    console.log(`  - ${cuando} · ${quien} · ${t.status}`);
    console.log(`      pidió: ${queHabiaPedido(t)}`);
    console.log(`      turno: ${turno ?? '(no se reservó ninguno)'}   [Task/${t.id}]`);
    if (!apply || !t.id) {
      continue;
    }
    try {
      await medplum.deleteResource('Task', t.id);
      borradas++;
    } catch (e) {
      console.warn(`      ! No se pudo borrar: ${(e as Error).message}`);
    }
  }

  console.log('');
  if (!apply) {
    const extra = [dias === DIAS_DEFAULT ? '' : ` --dias=${dias}`, paciente ? ` --paciente=${paciente}` : ''].join('');
    console.log(`[dry-run] No se borró nada. Corré \`npm run limpiar:solicitudes --${extra} --apply\`.`);
    console.log('          Guardate esta salida: es el último registro de lo que el paciente pidió.');
  } else {
    console.log(`Listo: ${borradas} solicitud(es) borrada(s).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
