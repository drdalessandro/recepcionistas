/**
 * Diagnóstico de la disponibilidad del portal: agenda ocupada vs. lo que se ofrece.
 *
 *   npm run disponibilidad:check                       # HBOT_MONO, primer paciente demo
 *   npm run disponibilidad:check -- --servicio=IHHT
 *   npm run disponibilidad:check -- --paciente=Patient/abc123
 *
 * Por qué existe: el 2026-08-12 recepción reportó que el portal ofrecía
 * horarios ya ocupados, y el 2026-09-11 volvió a pasar con la agenda de la demo
 * al 100 %. El síntoma es idéntico desde afuera, pero las causas son opuestas y
 * viven en repos distintos:
 *
 *  - **Nuestra**: `bw-disponibilidad` no ve la agenda y devuelve los horarios
 *    como LIBRES.
 *  - **Del portal**: el bot devuelve bien —`horarios: []` y todo en
 *    `ocupados`— y el portal los pinta igual como elegibles (una grilla fija de
 *    fallback, o rendereando `ocupados` como si fueran chips libres).
 *
 * Desde afuera no se distinguen, y por eso este chequeo existe: ejecuta el bot
 * DE VERDAD y muestra, lado a lado, lo que responde y los datos crudos con los
 * que lo decidió. La primera corrida (2026-09-11) contestó la pregunta y de
 * paso corrigió la hipótesis con la que se escribió: el bot devolvía `libres
 * 22 · ocupados 0`, o sea era NUESTRA.
 *
 * Lo que lo destapó fue comparar las dos fuentes en la misma ventana: recepción
 * dibuja Appointments y la disponibilidad decidía con Slots, y un turno vivo sin
 * su Slot es invisible para el portal — su horario se vuelve a ofrecer. Esa
 * cuenta sigue acá porque la deriva puede volver: los `ocupantes` viven en las
 * dos y basta con que una sola escritura se saltee una para que reaparezca.
 *
 * SOLO LECTURA: no crea, no modifica y no borra nada.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Appointment, Slot } from '@medplum/fhirtypes';
import { getServicio } from '../config/catalogo.js';
import { ESTADOS_SIN_SALA } from '../bots/_shared.js';
import { slotsHuerfanos } from './reparar-slots.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import type { DiaDisponible } from '../lib/disponibilidad.js';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

function arg(nombre: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${nombre}=`))?.split('=')[1];
}

/** Fecha/hora argentina legible a partir de un ISO cualquiera. */
function horaAR(iso: string): string {
  const d = new Date(iso);
  const local = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return `${local.toISOString().slice(0, 10)} ${local.toISOString().slice(11, 16)}`;
}

interface RespuestaDisponibilidad {
  ok: boolean;
  perfil?: string;
  ventanaHoras?: number;
  dias?: DiaDisponible[];
  mensaje?: string;
}

async function main(): Promise<void> {
  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log(`Conectado a ${process.env.MEDPLUM_BASE_URL}\n`);

  const servicioCodigo = arg('servicio') ?? 'HBOT_MONO';
  const servicio = getServicio(servicioCodigo);

  // Paciente de prueba: el que pidan, o el primero que haya (alcanza para ver
  // la grilla; la ventana R-13 puede cambiar según su plan y se informa abajo).
  let pacienteRef = arg('paciente');
  if (!pacienteRef) {
    const p = await medplum.searchOne('Patient', { _count: 1 });
    if (!p?.id) {
      console.log('✗ No hay ningún Patient en el proyecto: pasar --paciente=Patient/<id>.');
      process.exitCode = 1;
      return;
    }
    pacienteRef = `Patient/${p.id}`;
    console.log(`Paciente de prueba: ${pacienteRef} (${p.name?.[0]?.text ?? 'sin nombre'})`);
  }
  console.log(`Servicio: ${servicio.codigo} · ${servicio.nombre} (${servicio.duracionMin} min)\n`);

  // ---------------------------------------------------------------- datos crudos
  // La MISMA ventana que mira `disponibilidadDePaciente`: desde las 00:00 de hoy
  // hasta 7 días (el techo de R-13, para clientes FM).
  const ahora = new Date();
  const desde = new Date(ahora);
  desde.setHours(0, 0, 0, 0);
  const hasta = new Date(ahora.getTime() + 7 * 24 * 60 * 60 * 1000);

  const slots: Slot[] = [];
  for await (const pagina of medplum.searchResourcePages('Slot', [
    ['status', 'busy'],
    ['start', `ge${desde.toISOString()}`],
    ['start', `le${hasta.toISOString()}`],
    ['_count', '1000'],
  ])) {
    slots.push(...pagina);
  }

  const citas: Appointment[] = [];
  for await (const pagina of medplum.searchResourcePages('Appointment', [
    ['date', `ge${desde.toISOString()}`],
    ['date', `le${hasta.toISOString()}`],
    ['_count', '1000'],
  ])) {
    citas.push(...pagina);
  }
  // La MISMA lista que usa la ocupación (y que oculta el timeline de recepción).
  // Con otra lista el diagnóstico inventa deriva: las esperas son Appointments
  // `waitlist` y no llevan Slot **a propósito** — contarlas acá exageraba el
  // desbalance y mandaba a buscar un Slot que nunca tuvo que existir.
  const citasVivas = citas.filter((a) => !ESTADOS_SIN_SALA.has(a.status ?? ''));

  const codigoDe = (r: Slot | Appointment): string | undefined =>
    r.extension?.find((x) => x.url === EXT.recursoFisico)?.valueString;
  const sinRecurso = slots.filter((s) => !codigoDe(s));

  console.log(`=== Agenda cruda (hoy 00:00 → +7 días) ===`);
  console.log(`  Slots busy:            ${slots.length}`);
  console.log(`  ...sin recurso-fisico: ${sinRecurso.length}${sinRecurso.length ? '  ← invisibles para la disponibilidad' : ''}`);
  console.log(`  Appointments vivos:    ${citasVivas.length} (de ${citas.length}; se excluyen cancelados, entered-in-error y esperas)`);

  // Recepción dibuja Appointments; el portal decide con Slots. Si no coinciden,
  // una pantalla muestra ocupado y la otra libre — sin que ningún bot falle.
  const porRecursoSlots = new Map<string, number>();
  for (const s of slots) {
    const c = codigoDe(s);
    if (c) {
      porRecursoSlots.set(c, (porRecursoSlots.get(c) ?? 0) + 1);
    }
  }
  const porRecursoCitas = new Map<string, number>();
  for (const a of citasVivas) {
    const c = codigoDe(a);
    if (c) {
      porRecursoCitas.set(c, (porRecursoCitas.get(c) ?? 0) + 1);
    }
  }
  // La pregunta que importa: ¿qué turno vivo NO tiene su Slot busy? Ése es
  // invisible para la disponibilidad y su horario se vuelve a ofrecer. Se
  // resuelve por referencia (`Appointment.slot`), no por horario, así que no
  // hay falsos positivos.
  const idsBusy = new Set(slots.map((s) => s.id).filter(Boolean) as string[]);
  const huerfanos = citasVivas.filter(
    (a) => codigoDe(a) && !(a.slot ?? []).some((ref) => idsBusy.has(ref.reference?.split('/')[1] ?? '')),
  );
  const sinReferencia = huerfanos.filter((a) => (a.slot ?? []).length === 0);
  console.log(`\n=== Turnos vivos SIN Slot busy: ${huerfanos.length} de ${citasVivas.length} ===`);
  if (huerfanos.length > 0) {
    console.log(`  ...sin ninguna referencia a Slot: ${sinReferencia.length}`);
    console.log(`  ...con Slot referenciado que ya no está busy: ${huerfanos.length - sinReferencia.length}`);
    for (const a of huerfanos.slice(0, 5)) {
      console.log(
        `    Appointment/${a.id}  ${a.start ? horaAR(a.start) : '(sin start)'}  ${codigoDe(a)}  status=${a.status}` +
          `  slots=[${(a.slot ?? []).map((r) => r.reference).join(', ') || '—'}]`,
      );
    }
  }

  // El problema inverso: Slot busy que ningún turno vivo reclama. Bloquea la
  // sala para nadie y NO se ve en recepción (que dibuja Appointments): se nota
  // solo como un horario que nunca aparece libre en el portal.
  const sueltos = slotsHuerfanos(citas, slots);
  if (sueltos.length > 0) {
    console.log(`\n=== Slots busy que ningún turno reclama: ${sueltos.length} ===`);
    console.log('  Bloquean la sala sin turno detrás. Revisar y, si no corresponden, darlos de baja.');
    for (const s of sueltos.slice(0, 10)) {
      console.log(`    Slot/${s.id}  ${s.start ? horaAR(s.start) : '(sin start)'}  ${codigoDe(s)}`);
    }
  }

  const recursos = [...new Set([...porRecursoSlots.keys(), ...porRecursoCitas.keys()])].sort();
  console.log(`\n=== Slots busy vs. Appointments, por sala ===`);
  console.log(`  ${'sala'.padEnd(22)}${'slots'.padStart(6)}${'citas'.padStart(7)}`);
  let desbalance = 0;
  for (const r of recursos) {
    const ns = porRecursoSlots.get(r) ?? 0;
    const na = porRecursoCitas.get(r) ?? 0;
    if (ns !== na) {
      desbalance++;
    }
    console.log(`  ${ns === na ? ' ' : '!'} ${r.padEnd(20)}${String(ns).padStart(6)}${String(na).padStart(7)}`);
  }
  if (desbalance > 0) {
    console.log(`  → ${desbalance} sala(s) con distinto conteo: recepción y portal NO están mirando lo mismo.`);
  }

  // ------------------------------------------------------------------- el bot
  const bot = await medplum.searchOne('Bot', { name: 'bw-disponibilidad' });
  if (!bot?.id) {
    console.log('\n✗ No existe el Bot bw-disponibilidad en el servidor (correr `npm run deploy:bots`).');
    process.exitCode = 1;
    return;
  }
  const r = (await medplum.executeBot(bot.id, { pacienteRef, servicioCodigo })) as RespuestaDisponibilidad;

  console.log(`\n=== Lo que responde bw-disponibilidad (esto ve el portal) ===`);
  if (!r?.ok) {
    console.log(`  ✗ ok:false — ${r?.mensaje ?? 'sin mensaje'}`);
    console.log('  → El portal debe mostrar un error y NO ofrecer nada.');
    process.exitCode = 1;
    return;
  }
  console.log(`  perfil: ${r.perfil} · ventana R-13: ${r.ventanaHoras} h`);
  let libres = 0;
  let ocupados = 0;
  for (const d of r.dias ?? []) {
    libres += d.horarios.length;
    ocupados += d.ocupados?.length ?? 0;
    console.log(`  ${d.fecha}`);
    console.log(`     libres   (${String(d.horarios.length).padStart(2)}): ${d.horarios.map((h) => h.inicio.slice(11, 16)).join(' ') || '—'}`);
    console.log(`     ocupados (${String(d.ocupados?.length ?? 0).padStart(2)}): ${(d.ocupados ?? []).map((h) => h.inicio.slice(11, 16)).join(' ') || '—'}`);
  }
  if (r.mensaje) {
    console.log(`  mensaje: ${r.mensaje}`);
  }

  // --------------------------------------------------------------- veredicto
  console.log(`\n=== Veredicto ===`);
  const hayAgenda = slots.some((s) => codigoDe(s));
  if (!hayAgenda) {
    console.log('  No hay agenda ocupada en la ventana: que el portal ofrezca todo es CORRECTO.');
    return;
  }
  if (sinRecurso.length > 0) {
    console.log(`✗ ${sinRecurso.length} Slot(s) busy sin la extensión recurso-fisico.`);
    console.log('  La disponibilidad los ignora: esas salas se ofrecen como libres. Ejemplos:');
    for (const s of sinRecurso.slice(0, 5)) {
      console.log(`    Slot/${s.id}  ${s.start ? horaAR(s.start) : '(sin start)'}`);
    }
  }
  console.log(`  El bot ofrece ${libres} horario(s) libre(s) y marca ${ocupados} como ocupado(s).`);
  if (libres === 0 && ocupados > 0) {
    console.log('✓ NUESTRO LADO ESTÁ BIEN: el bot no ofrece nada elegible.');
    console.log('  Si el portal igual deja elegir esos horarios, el bug es del portal:');
    console.log('    · los chips elegibles son SOLO `dias[].horarios[]`;');
    console.log('    · `dias[].ocupados[]` se pinta tachado y no se puede elegir;');
    console.log('    · nunca caer a una grilla fija de fallback (handoff 2026-08-12 §1).');
  } else if (libres > 0 && huerfanos.length > 0) {
    console.log('✗ EL BUG ES NUESTRO: hay turnos vivos que la disponibilidad no ve.');
    console.log(`  ${huerfanos.length} turno(s) sin Slot busy = ${huerfanos.length} franja(s) que se vuelven a ofrecer.`);
    console.log('  Se arregla deployando los bots (la disponibilidad ya mira Slots + Appointments):');
    console.log('    npm run deploy:bots');
    console.log('  Si después de deployar SIGUE ofreciendo horarios tomados, ahí sí mirar el portal.');
  } else if (libres > 0) {
    console.log('  Hay horarios ofrecidos y ningún turno huérfano. Verificar contra la agenda de');
    console.log('  recepción si alguno está tomado — ojo con el matiz del handoff: un horario sigue');
    console.log('  libre si CUALQUIER sala de la categoría está libre (HBOT individual entra en');
    console.log('  monoplaza o en biplaza).');
  }
  if (sueltos.length > 0) {
    console.log(`  ${sueltos.length} Slot(s) busy sin turno: esas salas están bloqueadas para nadie (arriba, con su id).`);
  }
  if (desbalance > 0 || sinRecurso.length > 0 || huerfanos.length > 0 || sueltos.length > 0) {
    process.exitCode = 1;
  }
}

// El import desde los tests no debe ejecutar el CLI (ni intentar conectarse).
if (process.argv[1]?.endsWith('diagnostico-disponibilidad.ts')) {
  main().catch((err) => {
    console.error('Diagnóstico de disponibilidad falló:', err);
    process.exitCode = 1;
  });
}
