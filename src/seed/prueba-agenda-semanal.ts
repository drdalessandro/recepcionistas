/**
 * Prueba de punta a punta de la AGENDA SEMANAL de membresías (R-21).
 *
 *   npm run seed:prueba-agenda-semanal -- --dry-run  → muestra el plan (sin red)
 *   npm run seed:prueba-agenda-semanal               → corre la prueba completa
 *   npm run seed:prueba-agenda-semanal -- --limpiar  → desarma el escenario
 *
 * Todo pasa por los bots REALES (los mismos que usan el portal y el cron):
 *
 *   1. Paciente de prueba con tag `demo` (modo avión: ningún WhatsApp sale).
 *   2. Aptitud R-20 con `bw-ingreso-presencial` (consentimiento + screening).
 *   3. Membresía FOCUS Standard con `bw-asignar-plan` (sin cobro inicial).
 *   4. Preferencia semanal con `bw-preferencia-semanal` — probando ANTES que
 *      una membresía ajena se rechaza (la defensa que protege al portal).
 *   5. `bw-agenda-semanal` a mano (exactamente lo que hace el cron cada hora) y
 *      verificación contra la MISMA lógica pura (`candidatosSemana`): fechas
 *      asignadas, turnos con su plan, campanita del portal y saldo consumido.
 *   6. Segunda corrida → idempotente (no duplica nada).
 *   7. Si una semana quedó llena, intento extra con `perfil` → bloqueo R-21.
 *
 * La preferencia se arma con los PRÓXIMOS DOS DÍAS ABIERTOS a las 09:00: los dos
 * caen dentro de la ventana Standard (72 h), así la corrida asigna algo YA y la
 * prueba no depende del día en que se corra.
 *
 * ⚠️ Los turnos creados ocupan salas DE VERDAD (con sus Slots). Después de
 * mirar la Agenda / el portal, correr `-- --limpiar`: el tag demo borra al
 * paciente a las 48 h, pero los turnos que creó el cron no llevan tag — los
 * borra (turnos + slots + avisos + campanitas + membresía) este script.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Appointment, Bot, Communication, Coverage, Patient, Task } from '@medplum/fhirtypes';
import { HORARIO_SEMANAL } from '../config/horario.js';
import { getMembresia } from '../config/membresias.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { esPlanBW } from '../fhir/coverage.js';
import { fechaLocalISO } from '../lib/mapa-semana.js';
import { candidatosSemana, claveSemana, perteneceASemana } from '../lib/semana-membresia.js';
import { META_DEMO, fechaCivilAR } from '../bots/_shared.js';

const PRUEBA = 'https://biowellness.ar/fhir/Identifier/prueba';
const CLAVE_PACIENTE = 'agenda-semanal-paciente';
const PLAN_CODIGO = 'FOCUS_STD_IND'; // 2x/semana, combo base BIO_ENERGY
const HORA = '09:00';
const PACIENTE_FALSO = 'Patient/00000000-0000-0000-0000-000000000000';

const esDiaAbierto = (dia: number): boolean => HORARIO_SEMANAL.find((h) => h.dia === dia)?.abierto ?? false;

let fallas = 0;
function check(ok: boolean, etiqueta: string, detalle?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!ok) {
    fallas++;
  }
}

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/** Los próximos `cantidad` días ABIERTOS empezando mañana (números getDay). */
function proximosDiasAbiertos(ahora: Date, cantidad: number): { dias: number[]; fechas: string[] } {
  const dias: number[] = [];
  const fechas: string[] = [];
  for (let i = 1; i <= 8 && dias.length < cantidad; i++) {
    const f = new Date(ahora.getTime() + i * 24 * 60 * 60_000);
    const civil = fechaCivilAR(f);
    const [y, m, d] = civil.split('-').map(Number);
    const dow = new Date(y!, m! - 1, d!).getDay();
    if (esDiaAbierto(dow) && !dias.includes(dow)) {
      dias.push(dow);
      fechas.push(civil);
    }
  }
  return { dias: [...dias].sort((a, b) => a - b), fechas };
}

async function botPorNombre(medplum: MedplumClient, nombre: string): Promise<Bot> {
  const bot = await medplum.searchOne('Bot', `name=${nombre}`);
  if (!bot?.id) {
    throw new Error(`El bot "${nombre}" no existe en el servidor. ¿Corriste npm run deploy:bots?`);
  }
  return bot;
}

/** Turnos vivos del paciente (no cancelados), con su fecha civil AR. */
async function turnosDelPaciente(
  medplum: MedplumClient,
  pacienteRef: string,
  coverageId: string,
): Promise<{ turnos: Appointment[]; fechas: Set<string> }> {
  const todos = await medplum.searchResources('Appointment', `patient=${pacienteRef}&_count=200`);
  const turnos = todos.filter(
    (t) =>
      t.start &&
      !['cancelled', 'entered-in-error', 'noshow'].includes(t.status ?? '') &&
      t.extension?.some((x) => x.url === EXT.coberturaUsada && x.valueString === `Coverage/${coverageId}`),
  );
  return { turnos, fechas: new Set(turnos.map((t) => fechaCivilAR(new Date(t.start as string)))) };
}

async function limpiar(medplum: MedplumClient, despedida = true): Promise<void> {
  const paciente = await medplum.searchOne('Patient', `identifier=${PRUEBA}|${CLAVE_PACIENTE}`);
  if (!paciente?.id) {
    console.log('No hay paciente de prueba: nada que limpiar.');
    return;
  }
  const ref = `Patient/${paciente.id}`;

  // Turnos y sus Slots (la reserva crea un Slot busy por componente).
  const turnos = await medplum.searchResources('Appointment', `patient=${ref}&_count=200`);
  let slots = 0;
  for (const t of turnos) {
    for (const s of t.slot ?? []) {
      const id = s.reference?.split('/')[1];
      if (id) {
        await medplum.deleteResource('Slot', id).catch(() => undefined);
        slots++;
      }
    }
    if (t.id) {
      await medplum.deleteResource('Appointment', t.id);
    }
  }
  console.log(`  ✓ ${turnos.length} turno(s) + ${slots} slot(s)`);

  // Avisos de la agenda semanal (Tasks) y campanitas (Communications).
  const tasks = await medplum.searchResources('Task', `patient=${ref}&_count=100`);
  let borradas = 0;
  for (const t of tasks as Task[]) {
    if (t.id && t.identifier?.some((i) => i.system === SYSTEM.task && i.value?.startsWith('agenda-semanal-'))) {
      await medplum.deleteResource('Task', t.id);
      borradas++;
    }
  }
  const comms = await medplum.searchResources('Communication', `subject=${ref}&_count=200`);
  let campanitas = 0;
  for (const c of comms as Communication[]) {
    if (c.id && c.identifier?.some((i) => i.system === SYSTEM.communication && i.value?.startsWith('agenda-semanal'))) {
      await medplum.deleteResource('Communication', c.id);
      campanitas++;
    }
  }
  console.log(`  ✓ ${borradas} aviso(s) de Recepción + ${campanitas} campanita(s)`);

  // La membresía de prueba (y cualquier plan BW del paciente de prueba).
  const coverages = await medplum.searchResources('Coverage', `beneficiary=${ref}&_count=20`);
  for (const c of coverages) {
    if (c.id && esPlanBW(c)) {
      await medplum.deleteResource('Coverage', c.id);
      console.log(`  ✓ Coverage/${c.id} (membresía de prueba)`);
    }
  }

  // Consentimiento / screening / documento del ingreso de prueba.
  for (const [tipo, query] of [
    ['Consent', `patient=${ref}&_count=20`],
    ['QuestionnaireResponse', `subject=${ref}&_count=20`],
    ['DocumentReference', `patient=${ref}&_count=20`],
  ] as const) {
    const recursos = await medplum.searchResources(tipo, query);
    for (const r of recursos) {
      if (r.id) {
        await medplum.deleteResource(tipo, r.id).catch(() => undefined);
      }
    }
  }
  console.log('  ✓ Consentimiento y screening del ingreso de prueba');
  if (despedida) {
    console.log(`\nListo. El Patient de prueba (${ref}) queda para reusar; el tag demo lo borra solo a las 48 h.`);
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const modoLimpiar = process.argv.includes('--limpiar');
  const ahora = new Date();
  const membresia = getMembresia(PLAN_CODIGO);
  const { dias, fechas: fechasElegidas } = proximosDiasAbiertos(ahora, membresia.frecuenciaSemanal);

  console.log('=== Prueba de punta a punta · Agenda semanal de membresías (R-21) ===');
  console.log(`  • Plan        : ${PLAN_CODIGO} (${membresia.frecuenciaSemanal}x/semana · combo ${membresia.comboBaseCodigo})`);
  console.log(`  • Preferencia : días ${dias.join(',')} a las ${HORA} → próximas fechas ${fechasElegidas.join(' y ')}`);

  if (dryRun) {
    const esperados = candidatosSemana({
      preferencia: { dias, hora: HORA },
      perfil: 'STANDARD',
      ahora,
      hoyISO: fechaCivilAR(ahora),
      fechasAsignadas: new Set(),
      saldoRestante: membresia.sesionesMes,
      frecuenciaSemanal: membresia.frecuenciaSemanal,
      esDiaAbierto,
    });
    console.log(`  • El cron debería asignar HOY: ${esperados.map((c) => c.fecha).join(', ') || '(nada: ventana cerrada)'}`);
    console.log('\n[dry-run] No se conecta a Medplum.');
    return;
  }

  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log('\nConectado a Medplum.');

  if (modoLimpiar) {
    await limpiar(medplum);
    return;
  }

  // Los cinco bots que la prueba ejercita, antes de tocar nada.
  const [botIngreso, botAsignar, botPreferencia, botAgenda, botCombo] = await Promise.all([
    botPorNombre(medplum, 'bw-ingreso-presencial'),
    botPorNombre(medplum, 'bw-asignar-plan'),
    botPorNombre(medplum, 'bw-preferencia-semanal'),
    botPorNombre(medplum, 'bw-agenda-semanal'),
    botPorNombre(medplum, 'bw-reservar-combo'),
  ]);
  console.log('  ✓ Los 5 bots están deployados.');

  // 1 · Paciente de prueba (tag demo: modo avión, sin WhatsApp reales).
  let paciente = await medplum.searchOne('Patient', `identifier=${PRUEBA}|${CLAVE_PACIENTE}`);
  if (!paciente) {
    paciente = await medplum.createResource<Patient>({
      resourceType: 'Patient',
      meta: META_DEMO,
      active: true,
      identifier: [{ system: PRUEBA, value: CLAVE_PACIENTE }],
      name: [{ given: ['Paciente Prueba'], family: 'AgendaSemanal' }],
      telecom: [{ system: 'phone', value: '+5491100000001' }],
    });
  }
  const pacienteRef = `Patient/${paciente.id}`;
  console.log(`  ✓ Paciente de prueba ${pacienteRef} (tag demo)`);

  // Corrida anterior: desarmar antes de armar (fechas y avisos vírgenes).
  console.log('\n— Limpieza de la corrida anterior —');
  await limpiar(medplum, false);

  // 2 · Aptitud R-20 por el bot real del kiosco.
  console.log('\n— Escenario —');
  const ingreso = (await medplum.executeBot(botIngreso.id as string, {
    pacienteRef,
    nombreFirma: 'Paciente Prueba AgendaSemanal',
    dni: '99999999',
    respuestasScreening: [{ linkId: 'prueba-fixture', text: 'Fixture R-21', answer: [{ valueString: 'ok' }] }],
  })) as { ok: boolean; mensaje?: string };
  check(ingreso.ok, 'R-20: consentimiento + screening registrados (bw-ingreso-presencial)', ingreso.mensaje);

  // 3 · Membresía sin cobro inicial (la prueba es de agenda, no de caja).
  const asignado = (await medplum.executeBot(botAsignar.id as string, {
    pacienteRef,
    tipo: 'membresia',
    planCodigo: PLAN_CODIGO,
    cobrar: false,
  })) as { ok: boolean; coverageId?: string; mensaje?: string };
  check(Boolean(asignado.ok && asignado.coverageId), `Membresía ${PLAN_CODIGO} asignada (bw-asignar-plan)`, asignado.mensaje);
  if (!asignado.coverageId) {
    throw new Error('Sin Coverage no hay prueba.');
  }
  const coverageId = asignado.coverageId;
  // Tag demo también en el Coverage (bw-asignar-plan no sabe que es de prueba).
  const cov = await medplum.readResource('Coverage', coverageId);
  await medplum.updateResource<Coverage>({ ...cov, meta: { ...cov.meta, tag: [...(cov.meta?.tag ?? []), ...META_DEMO.tag] } });

  // 4 · La defensa del portal: una membresía ajena se rechaza sin delatar nada.
  const ajena = (await medplum.executeBot(botPreferencia.id as string, {
    coverageId,
    pacienteRef: PACIENTE_FALSO,
    dias,
    hora: HORA,
    activa: true,
  })) as { ok: boolean; mensaje?: string };
  check(
    !ajena.ok && (ajena.mensaje ?? '').includes('No encontramos'),
    'Seguridad: pacienteRef ajeno → rechazado',
    ajena.mensaje,
  );

  // …y la preferencia real, como la manda el portal (con pacienteRef propio).
  const pref = (await medplum.executeBot(botPreferencia.id as string, {
    coverageId,
    pacienteRef,
    dias,
    hora: HORA,
    activa: true,
  })) as { ok: boolean; activa?: boolean; mensaje?: string; aviso?: string };
  check(Boolean(pref.ok && pref.activa), 'Preferencia guardada y asignación automática activa', pref.mensaje ?? pref.aviso);
  const covConPref = await medplum.readResource('Coverage', coverageId);
  check(
    covConPref.extension?.some((x) => x.url === EXT.agendaSemanalActiva && x.valueBoolean === true) === true &&
      covConPref.extension?.some((x) => x.url === EXT.preferenciaHora && x.valueString === HORA) === true,
    'Las extensiones quedaron escritas en el Coverage',
  );

  // 5 · Lo que hace el cron cada hora, a mano — y el resultado esperado según
  //     la MISMA lógica pura que usa el bot.
  console.log('\n— Corrida del cron (bw-agenda-semanal) —');
  const esperados = candidatosSemana({
    preferencia: { dias, hora: HORA },
    perfil: 'STANDARD',
    ahora: new Date(),
    hoyISO: fechaCivilAR(new Date()),
    fechasAsignadas: new Set(),
    saldoRestante: membresia.sesionesMes,
    frecuenciaSemanal: membresia.frecuenciaSemanal,
    esDiaAbierto,
  }).map((c) => c.fecha);
  console.log(`  Esperado para este paciente: ${esperados.join(', ') || '(nada entra hoy en la ventana)'}`);

  const corrida = (await medplum.executeBot(botAgenda.id as string, {})) as {
    ok: boolean;
    planes: number;
    asignados: number;
    conAlternativa: number;
    sinLugar: number;
    detalle: string[];
  };
  const mias = corrida.detalle.filter((l) => l.startsWith(pacienteRef));
  console.log(`  Corrida: ${corrida.planes} plan(es) · ${corrida.asignados} asignados · ${corrida.conAlternativa} con alternativa · ${corrida.sinLugar} sin lugar`);
  for (const linea of mias) {
    console.log(`    · ${linea}`);
  }

  const { turnos, fechas } = await turnosDelPaciente(medplum, pacienteRef, coverageId);
  for (const f of esperados) {
    if (fechas.has(f)) {
      const delDia = turnos.filter((t) => fechaCivilAR(new Date(t.start as string)) === f);
      const horas = delDia
        .map((t) => new Date(t.start as string).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false }))
        .sort();
      check(true, `Sesión del ${f} reservada`, `${delDia.length} componente(s) desde las ${horas[0]}`);
    } else {
      // Día lleno: el camino correcto es aviso a Recepción + campanita al socio.
      const aviso = await medplum.searchOne('Task', `identifier=${SYSTEM.task}|agenda-semanal-sin-lugar-${coverageId}-${f}`);
      check(Boolean(aviso), `Sesión del ${f}: sin lugar, PERO con aviso en Avisos + campanita`, aviso ? 'camino "día lleno" OK' : 'ni turno ni aviso');
    }
  }

  // Campanita del portal por cada fecha asignada (idempotente por identifier).
  for (const f of [...fechas]) {
    const noti = await medplum.searchOne('Communication', `identifier=${SYSTEM.communication}|agenda-semanal-${coverageId}-${f}`);
    check(Boolean(noti), `Campanita del portal para el ${f}`, noti?.payload?.[0]?.contentString?.slice(0, 90));
  }

  // Saldo consumido: una sesión del plan por fecha asignada.
  const covDespues = await medplum.readResource('Coverage', coverageId);
  const usadas = covDespues.extension?.find((x) => x.url === EXT.sesionesUsadas)?.valueInteger ?? 0;
  check(usadas === fechas.size, `Saldo del plan: ${usadas} usada(s) de ${membresia.sesionesMes}`, `fechas asignadas: ${fechas.size}`);

  // 6 · Idempotencia: la corrida siguiente no duplica nada.
  const antes = turnos.length;
  await medplum.executeBot(botAgenda.id as string, {});
  const despues = await turnosDelPaciente(medplum, pacienteRef, coverageId);
  check(despues.turnos.length === antes, 'Segunda corrida idempotente (no duplicó turnos)', `${antes} → ${despues.turnos.length}`);

  // 7 · R-21: si una semana quedó llena, un intento extra CON perfil se bloquea.
  const porSemana = new Map<string, number>();
  for (const f of despues.fechas) {
    const [y, m, d] = f.split('-').map(Number);
    const clave = claveSemana(new Date(y!, m! - 1, d!));
    porSemana.set(clave, (porSemana.get(clave) ?? 0) + 1);
  }
  const semanaLlena = [...porSemana.entries()].find(([, n]) => n >= membresia.frecuenciaSemanal)?.[0];
  if (semanaLlena) {
    // Otro día abierto de ESA semana, sin sesión todavía.
    const [y, m, d] = semanaLlena.split('-').map(Number);
    let fechaExtra: string | undefined;
    for (let i = 0; i < 7; i++) {
      const f = new Date(y!, m! - 1, d! + i);
      const civil = fechaLocalISO(f); // f viene de componentes civiles: fechaCivilAR acá correría el día en un server UTC
      if (esDiaAbierto(f.getDay()) && !despues.fechas.has(civil) && perteneceASemana(civil, semanaLlena)) {
        fechaExtra = civil;
        break;
      }
    }
    if (fechaExtra) {
      const extra = (await medplum.executeBot(botCombo.id as string, {
        pacienteRef,
        comboCodigo: membresia.comboBaseCodigo,
        inicio: `${fechaExtra}T15:00:00-03:00`,
        perfil: 'STANDARD',
        coverageId,
        notificar: false,
      })) as { creado: boolean; bloqueos: { regla?: string; mensaje: string }[] };
      const r21 = extra.bloqueos.find((b) => b.regla === 'R-21');
      check(!extra.creado && Boolean(r21), `Tope semanal: 3.ª sesión en la semana del ${semanaLlena} → bloqueada`, r21?.mensaje);
    }
  } else {
    console.log('  · R-21: las fechas quedaron repartidas en dos semanas (1 y 1), así que el tope');
    console.log('    no se ejercita hoy — el caso está cubierto por los tests (semana-membresia).');
  }

  // Resumen y pasos manuales.
  console.log(fallas === 0 ? '\n✅ Prueba automática: TODO OK.' : `\n❌ Prueba automática: ${fallas} check(s) fallaron.`);
  console.log('\nPara mirar con los ojos:');
  console.log('  1. App de Recepción → Agenda: los turnos de "Paciente Prueba AgendaSemanal"');
  console.log(`     (BIO ENERGY a las ${HORA}, o el horario alternativo si estaba ocupado).`);
  console.log('  2. Atender → buscar al paciente → Planes: el badge y "Preferencia semanal"');
  console.log('     con los días/hora precargados.');
  console.log('  3. Si hubo "sin lugar": solapa Avisos con el aviso de la agenda semanal.');
  console.log('  4. (Opcional) Invitar al paciente al portal y ver la campanita + la sección');
  console.log('     "Agenda semanal" en Mi cuenta → Membresía.');
  console.log('\n⚠️ Cuando termines: npm run seed:prueba-agenda-semanal -- --limpiar');
  console.log('   (libera las salas: borra turnos, slots, avisos, campanitas y la membresía).');
  if (fallas > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('La prueba falló:', err);
  process.exitCode = 1;
});
