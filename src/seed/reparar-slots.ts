/**
 * Reparación: recrear los Slot `busy` de los turnos que se quedaron sin el suyo.
 *
 *   npm run slots:reparar                 → DRY-RUN: lista qué crearía.
 *   npm run slots:reparar -- --apply      → crea los Slot y los enlaza al turno.
 *   npm run slots:reparar -- --dias=30    → ventana a reparar (default 30).
 *
 * Por qué hace falta. Cada reserva escribe DOS cosas: el `Appointment` (lo que
 * dibuja recepción) y un `Slot` en estado `busy` (lo que mira la disponibilidad
 * del portal). Si el Slot se pierde, el turno sigue existiendo y a la vista en
 * recepción, pero su horario **se vuelve a ofrecer** en el portal: la agenda
 * ocupada deja de verlo. Eso fue justamente lo que pasó el 2026-09-11 (los Slot
 * se borraron a mano durante la demo).
 *
 * Qué hace, por turno vivo que tenga sala y no tenga Slot busy:
 *
 *  1. crea el `Slot` busy con los MISMOS datos que escriben los bots de reserva
 *     (`recurso-fisico` + `ocupantes`, tomados del propio turno);
 *  2. lo enlaza en `Appointment.slot` — sin eso el Slot queda huérfano y
 *     cancelar o completar el turno **no liberaría la sala**, porque esos flujos
 *     recorren `appointment.slot`;
 *  3. si el turno es una consulta, deja además en `busy` el Slot de la agenda
 *     publicada del médico (crea uno si no está). Sin este paso, la próxima
 *     corrida de `seed -- --with-slots` republicaría esa hora como LIBRE y el
 *     portal ofrecería un horario que el médico ya tiene dado.
 *
 * Es **idempotente**: un turno que ya tiene su Slot busy se saltea, así que
 * correrla dos veces no duplica nada. Y respeta la cuota FHIR de Medplum
 * (429 → espera lo que pida el limitador): reparar una agenda llena son
 * cientos de escrituras.
 *
 * Los Slot heredan el tag `demo` del turno: si no, la limpieza automática
 * borraría el turno demo y dejaría el Slot bloqueando la sala para siempre.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Appointment, Coding, Slot } from '@medplum/fhirtypes';
import { ESTADOS_SIN_SALA, conEsperaDeCuota, scheduleIdDeRecurso } from '../bots/_shared.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/** Un turno que perdió su Slot, con todo lo necesario para recrearlo. */
export interface Reparacion {
  appointment: Appointment;
  recursoCodigo: string;
  inicio: string;
  fin: string;
  ocupantes: number;
  /** Tags del turno que el Slot tiene que heredar (hoy: `demo`, `demo-hasta`). */
  tags: Coding[];
}

const codigoDe = (r: Appointment | Slot): string | undefined =>
  r.extension?.find((x) => x.url === EXT.recursoFisico)?.valueString;

/**
 * Qué turnos hay que reparar. Puro: no toca red, y por eso se testea.
 *
 * Un turno se repara si está vivo, tiene sala y NINGUNA de sus referencias a
 * Slot apunta a un Slot busy de los que existen. La comparación es por
 * REFERENCIA, no por horario: dos turnos legítimos pueden compartir hora en la
 * misma sala (la Multiplaza es grupal) y emparejarlos por horario inventaría
 * Slots de más o de menos.
 */
export function planDeReparacion(citas: Appointment[], slotsBusy: Slot[]): Reparacion[] {
  const idsBusy = new Set(slotsBusy.map((s) => s.id).filter(Boolean) as string[]);
  const plan: Reparacion[] = [];
  for (const a of citas) {
    const recursoCodigo = codigoDe(a);
    if (!recursoCodigo || !a.start || !a.end || ESTADOS_SIN_SALA.has(a.status ?? '')) {
      continue;
    }
    if ((a.slot ?? []).some((ref) => idsBusy.has(ref.reference?.split('/')[1] ?? ''))) {
      continue; // ya tiene el suyo
    }
    plan.push({
      appointment: a,
      recursoCodigo,
      inicio: a.start,
      fin: a.end,
      ocupantes: a.extension?.find((x) => x.url === EXT.ocupantes)?.valueInteger ?? 1,
      tags: a.meta?.tag ?? [],
    });
  }
  return plan;
}

/**
 * El problema INVERSO: Slots `busy` de una sala que ningún turno vivo reclama.
 *
 * Bloquean la sala para nadie — el horario deja de ofrecerse y no hay a quién
 * atender. Salen de un turno borrado (o cancelado) sin liberar su Slot, y a
 * diferencia del turno sin Slot este no se nota en ninguna pantalla: recepción
 * dibuja Appointments, así que un Slot suelto es invisible ahí y solo se ve
 * como un horario que nunca aparece libre en el portal.
 *
 * Solo mira Slots CON `recurso-fisico`: los de la agenda de médicos viven en
 * otro Schedule y no llevan esa extensión, así que no son huérfanos acá.
 *
 * No se borran solos: puede haber un motivo legítimo (un bloqueo de sala puesto
 * a mano) y borrar datos del servidor lo decide una persona.
 */
export function slotsHuerfanos(citas: Appointment[], slotsBusy: Slot[]): Slot[] {
  const reclamados = new Set<string>();
  for (const a of citas) {
    if (ESTADOS_SIN_SALA.has(a.status ?? '')) {
      continue;
    }
    for (const ref of a.slot ?? []) {
      const id = ref.reference?.split('/')[1];
      if (id) {
        reclamados.add(id);
      }
    }
  }
  return slotsBusy.filter((s) => codigoDe(s) && s.id && !reclamados.has(s.id));
}

/** Código del médico del turno, si es una consulta con agenda publicada. */
function medicoDe(a: Appointment): string | undefined {
  const ref = a.participant?.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor?.reference;
  return ref ? ref.split('/')[1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dias = Number(process.argv.find((a) => a.startsWith('--dias='))?.split('=')[1] ?? 30);
  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));

  console.log('=== Reparación · Slot busy de los turnos ===');
  console.log(apply ? '  MODO: aplicar cambios' : '  MODO: dry-run (no escribe nada)');
  console.log(`  Ventana: desde las 00:00 de hoy, ${dias} días\n`);

  const desde = new Date();
  desde.setHours(0, 0, 0, 0);
  const hasta = new Date(desde.getTime() + dias * 24 * 60 * 60 * 1000);

  const citas: Appointment[] = [];
  for await (const pagina of medplum.searchResourcePages('Appointment', [
    ['date', `ge${desde.toISOString()}`],
    ['date', `le${hasta.toISOString()}`],
    ['_count', '1000'],
  ])) {
    citas.push(...pagina);
  }
  const slotsBusy: Slot[] = [];
  for await (const pagina of medplum.searchResourcePages('Slot', [
    ['status', 'busy'],
    ['start', `ge${desde.toISOString()}`],
    ['start', `le${hasta.toISOString()}`],
    ['_count', '1000'],
  ])) {
    slotsBusy.push(...pagina);
  }

  const plan = planDeReparacion(citas, slotsBusy);
  console.log(`Appointments en la ventana: ${citas.length}`);
  console.log(`Slot busy existentes:       ${slotsBusy.length}`);
  console.log(`Turnos SIN su Slot busy:    ${plan.length}\n`);

  if (plan.length === 0) {
    console.log('✓ No hay nada que reparar: cada turno vivo tiene su Slot busy.');
    return;
  }

  // Resumen por sala antes de tocar nada: es lo que se mira para decidir.
  const porSala = new Map<string, number>();
  for (const r of plan) {
    porSala.set(r.recursoCodigo, (porSala.get(r.recursoCodigo) ?? 0) + 1);
  }
  console.log('Por sala:');
  for (const [sala, n] of [...porSala].sort()) {
    console.log(`  ${sala.padEnd(22)} ${String(n).padStart(4)}`);
  }

  if (!apply) {
    console.log('\n[dry-run] No se escribió nada. Para aplicarlo:');
    console.log('    npm run slots:reparar -- --apply');
    return;
  }

  // Un Schedule por sala, resuelto una sola vez (no por turno).
  const scheduleDeSala = new Map<string, string | undefined>();
  for (const sala of porSala.keys()) {
    scheduleDeSala.set(sala, await conEsperaDeCuota(() => scheduleIdDeRecurso(medplum, sala)));
  }

  console.log('');
  let creados = 0;
  let medicosOcupados = 0;
  const sinSchedule = new Set<string>();
  const fallados: string[] = [];

  for (const r of plan) {
    const scheduleId = scheduleDeSala.get(r.recursoCodigo);
    if (!scheduleId) {
      sinSchedule.add(r.recursoCodigo);
      continue;
    }
    try {
      const slot = await conEsperaDeCuota(() =>
        medplum.createResource<Slot>({
          resourceType: 'Slot',
          ...(r.tags.length ? { meta: { tag: r.tags } } : {}),
          status: 'busy',
          schedule: { reference: `Schedule/${scheduleId}` },
          start: r.inicio,
          end: r.fin,
          extension: [
            { url: EXT.recursoFisico, valueString: r.recursoCodigo },
            { url: EXT.ocupantes, valueInteger: r.ocupantes },
          ],
        }),
      );

      // Enlazarlo al turno: sin esto, cancelar o completar no libera la sala.
      //
      // Y si el enlace falla, DESHACER el Slot. Son dos escrituras y la segunda
      // puede fallar sola (cuota, turno modificado entremedio): dejar el Slot
      // creado y suelto convierte esta reparación en el problema inverso —una
      // sala bloqueada sin turno detrás, invisible en recepción—. Preferimos
      // volver a dejarlo sin Slot: eso al menos se ve y se repara corriendo
      // esto de nuevo.
      const refs = [...(r.appointment.slot ?? []), { reference: `Slot/${slot.id}` }];
      try {
        await conEsperaDeCuota(() => medplum.updateResource<Appointment>({ ...r.appointment, slot: refs }));
      } catch (err) {
        await conEsperaDeCuota(() => medplum.deleteResource('Slot', slot.id!)).catch(() => undefined);
        throw err;
      }
      creados++;

      // Consulta: la agenda publicada del médico también tiene que quedar tomada,
      // o `seed -- --with-slots` republicaría esa hora como libre.
      const medicoId = medicoDe(r.appointment);
      if (medicoId && (await ocuparAgendaMedico(medplum, medicoId, r))) {
        medicosOcupados++;
      }
    } catch (err) {
      fallados.push(`Appointment/${r.appointment.id}: ${(err as Error).message}`);
    }
    if (creados % 25 === 0 && creados > 0) {
      console.log(`  ... ${creados}/${plan.length}`);
    }
  }

  console.log(`\n✓ Slot busy creados y enlazados: ${creados}`);
  if (medicosOcupados > 0) {
    console.log(`✓ Horas de agenda de médico marcadas ocupadas: ${medicosOcupados}`);
  }
  if (sinSchedule.size > 0) {
    console.log(`\n✗ Sin Schedule canónico (no se reparó): ${[...sinSchedule].join(', ')}`);
    console.log('  → `npm run seed` los recrea; después volver a correr esta reparación.');
  }
  if (fallados.length > 0) {
    console.log(`\n✗ ${fallados.length} turno(s) fallaron:`);
    for (const f of fallados.slice(0, 10)) {
      console.log(`    ${f}`);
    }
    process.exitCode = 1;
  }
  console.log('\nVerificar con: npm run disponibilidad:check');
}

/**
 * Deja tomada la hora en la agenda PUBLICADA del médico: pasa a `busy` el Slot
 * libre que haya en ese instante, o crea uno si no quedó ninguno. Devuelve si
 * hizo algo. Best-effort: un fallo acá no invalida la reparación de la sala.
 */
async function ocuparAgendaMedico(medplum: MedplumClient, medicoId: string, r: Reparacion): Promise<boolean> {
  try {
    const pract = await conEsperaDeCuota(() => medplum.readResource('Practitioner', medicoId));
    const codigo = pract.identifier?.find((i) => i.system === SYSTEM.medico)?.value;
    if (!codigo) {
      return false;
    }
    const sch = await conEsperaDeCuota(() =>
      medplum.searchOne('Schedule', `identifier=${SYSTEM.recursoCodigo}|SCH_${codigo}`),
    );
    if (!sch?.id) {
      return false;
    }
    // Por INSTANTE: en el servidor conviven los dos formatos de `start`
    // (`-03:00` y `Z` con milisegundos) y comparar como texto fallaría mudo.
    const pedido = new Date(r.inicio).getTime();
    const delMedico = await conEsperaDeCuota(() =>
      medplum.searchResources('Slot', `schedule=Schedule/${sch.id}&_count=200`),
    );
    const enEseInstante = delMedico.filter((s) => s.start && new Date(s.start).getTime() === pedido);
    if (enEseInstante.some((s) => s.status === 'busy')) {
      return false; // ya estaba tomada
    }
    const libre = enEseInstante.find((s) => s.status === 'free');
    if (libre) {
      await conEsperaDeCuota(() => medplum.updateResource<Slot>({ ...libre, status: 'busy' }));
      return true;
    }
    await conEsperaDeCuota(() =>
      medplum.createResource<Slot>({
        resourceType: 'Slot',
        ...(r.tags.length ? { meta: { tag: r.tags } } : {}),
        status: 'busy',
        schedule: { reference: `Schedule/${sch.id}` },
        start: r.inicio,
        end: r.fin,
      }),
    );
    return true;
  } catch {
    return false; // la sala ya quedó reparada, que es lo que importa
  }
}

// El import desde los tests no debe ejecutar el CLI (ni intentar conectarse).
if (process.argv[1]?.endsWith('reparar-slots.ts')) {
  main().catch((err) => {
    console.error('Reparación de Slots falló:', err);
    process.exitCode = 1;
  });
}
