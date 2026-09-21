/**
 * Diagnóstico de la auditoría: ¿está activa, y guarda la IP del CLIENTE?
 *
 *   npm run auditoria:check              # los últimos 10 eventos
 *   npm run auditoria:check -- --count 30
 *
 * Solo lectura (no crea ni borra nada). Existe para no tener que hacer clic en
 * el admin ni armar un curl con token a mano: contesta de una las dos preguntas
 * de la puesta en marcha (ver `docs/auditoria.md` §4).
 *
 *   1. ¿`saveAuditEvents` tomó? → si hay eventos, sí. No hay endpoint que
 *      devuelva la config del servidor, así que esta es LA forma de saberlo.
 *   2. ¿La IP es la del cliente o la del proxy? → `agent[0].network.address`.
 *      Si todas dicen `127.0.0.1`, la cadena del proxy está cortada y la
 *      auditoría no sirve para lo único que se la quiere.
 *
 * Sale con código 1 si algo está mal, así que también sirve como chequeo.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { AuditEvent } from '@medplum/fhirtypes';
import { RETENCION_DIAS, RETENCION_FIRMA_DIAS, esDireccionLocal, veredictoIp } from '../lib/auditoria.js';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

function argNumero(bandera: string, defecto: number): number {
  const i = process.argv.indexOf(bandera);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : defecto;
}

const fmt = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});

/** "Patient/abc" → "Patient/abc"; sin entidad, "—". */
function sobreQue(ae: AuditEvent): string {
  const refs = (ae.entity ?? []).map((e) => e.what?.reference).filter(Boolean);
  return refs.length > 0 ? (refs.join(', ') as string) : '—';
}

/**
 * Qué clase de evento es. Los de INTERACCIÓN traen `subtype` (read, update,
 * search…); los de EJECUCIÓN DE BOT no traen ninguno y se reconocen por
 * `type.code = 'execute'` — sin esto salían todos como "?".
 */
function etiqueta(ae: AuditEvent): string {
  return ae.subtype?.[0]?.code ?? ae.type?.code ?? '?';
}

/** ¿El agente es uno de nuestros bots? Todos se llaman `bw-*`. */
function esBot(ae: AuditEvent): boolean {
  return (ae.agent?.[0]?.who?.display ?? '').startsWith('bw-') || etiqueta(ae) === 'execute';
}

function quien(ae: AuditEvent): string {
  const a = ae.agent?.[0];
  return a?.who?.display ?? a?.who?.reference ?? '(sin agente)';
}

async function main(): Promise<void> {
  const count = argNumero('--count', 10);
  const baseUrl = requireEnv('MEDPLUM_BASE_URL');
  const medplum = new MedplumClient({ baseUrl, fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log(`Auditoría en ${baseUrl}\n`);

  let eventos: AuditEvent[];
  try {
    eventos = await medplum.searchResources('AuditEvent', `_sort=-_lastUpdated&_count=${count}`);
  } catch (err) {
    console.error('No se pudieron leer los AuditEvent (¿permiso del cliente?):', err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  // Cuántos hay en total: es el número que dice si la retención está bien
  // elegida. Best-effort — si el servidor no contesta el conteo, no se frena.
  let total: number | undefined;
  try {
    const bundle = await medplum.search('AuditEvent', '_summary=count');
    total = bundle.total;
  } catch {
    total = undefined;
  }

  console.log(`=== Últimos ${eventos.length} eventos ===`);
  for (const ae of eventos) {
    const ip = ae.agent?.[0]?.network?.address;
    const marca = ip ? (esDireccionLocal(ip) ? `${ip}  ⚠ local` : ip) : '(sin dirección)';
    const cuando = ae.recorded ?? ae.meta?.lastUpdated;
    console.log(
      `  ${cuando ? fmt.format(new Date(cuando)) : '(sin fecha)'} · ` +
        `${etiqueta(ae).padEnd(8)} · ${marca.padEnd(22)} · ${quien(ae)} · ${sobreQue(ae)}`,
    );
  }

  // Desde cuándo se está guardando. Es el dato que dice si la auditoría se
  // activó HOY o si ya venía acumulando sin que nadie lo supiera — y con eso,
  // si la purga es preventiva o si llega tarde.
  let masViejo: string | undefined;
  try {
    const [primero] = await medplum.searchResources('AuditEvent', '_sort=_lastUpdated&_count=1');
    masViejo = primero?.recorded ?? primero?.meta?.lastUpdated;
  } catch {
    masViejo = undefined;
  }

  // Direcciones distintas: contesta de un vistazo "¿está la mía?" mucho mejor
  // que diez filas sueltas.
  const porDireccion = new Map<string, number>();
  for (const ae of eventos) {
    const d = ae.agent?.[0]?.network?.address ?? '(sin dirección)';
    porDireccion.set(d, (porDireccion.get(d) ?? 0) + 1);
  }
  console.log('\n=== Direcciones vistas ===');
  for (const [d, n] of [...porDireccion.entries()].sort((a, b) => b[1] - a[1])) {
    const nota = d === '(sin dirección)' ? ' (ejecución de bot: no lleva IP)' : esDireccionLocal(d) ? '  ⚠ local' : '';
    console.log(`  ${String(n).padStart(3)} × ${d}${nota}`);
  }

  const veredicto = veredictoIp(eventos.map((ae) => ae.agent?.[0]?.network?.address));
  const soloBots = eventos.every((ae) => esBot(ae));
  console.log(`\n=== Veredicto ===`);
  if (total !== undefined) {
    console.log(`  Eventos guardados en total: ${total.toLocaleString('es-AR')}`);
  }
  if (masViejo) {
    console.log(`  El más viejo es del ${fmt.format(new Date(masViejo))} → se está guardando desde entonces.`);
  }
  console.log(`  Retención: ${RETENCION_DIAS} días · ${RETENCION_FIRMA_DIAS} días la evidencia de una firma\n`);

  switch (veredicto) {
    case 'sin-eventos':
      console.log('  ✗ NO hay ningún AuditEvent.');
      console.log('    `saveAuditEvents` no está activo, o el proceso no se reinició después de activarlo.');
      console.log('    → docs/auditoria.md §4, paso 2 (ojo: `pm2 describe` dice de dónde lee la config).');
      process.exitCode = 1;
      break;
    case 'solo-local':
      console.log('  ✗ TODAS las direcciones son locales (127.0.0.1 o ::1).');
      console.log('    La auditoría está activa pero registra el proxy, no al cliente: así no sirve de evidencia.');
      console.log('    → PARAR: poner `saveAuditEvents: false`, reiniciar, y revisar docs/auditoria.md §2');
      console.log('      antes de que se acumulen meses de eventos inservibles.');
      console.log('    (Si el único movimiento reciente fue de bots o crons, que entran por loopback,');
      console.log('     generá tráfico real: abrí una ficha desde el celular con datos móviles y repetí.)');
      process.exitCode = 1;
      break;
    case 'sin-direccion':
      console.log('  ⚠ Hay eventos, pero ninguno trae dirección.');
      console.log('    Suele ser movimiento interno (crons, bots). Generá tráfico real y repetí.');
      break;
    case 'ok':
      console.log('  ✓ Hay direcciones reales: la cadena del proxy funciona.');
      console.log('    La auditoría está activa y sirve como evidencia.');
      if (soloBots) {
        // Un bot llega desde la IP de su Lambda, que TAMBIÉN es externa: prueba
        // que el proxy reenvía, pero no prueba el camino del navegador, que es
        // el que importa para "quién abrió la ficha de esta paciente".
        console.log('');
        console.log('  ⚠ Pero todo lo que se ve es movimiento de BOTS.');
        console.log('    Para cerrar la prueba: abrí una ficha en recepcion.biowellness.ar');
        console.log('    desde el celular con datos móviles (WiFi apagado) y volvé a correr esto.');
        console.log('    Tiene que aparecer esa IP, con tu nombre como agente.');
      }
      break;
  }
}

main().catch((err) => {
  console.error('auditoria:check falló:', err);
  process.exitCode = 1;
});
