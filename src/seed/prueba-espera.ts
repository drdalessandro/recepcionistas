/**
 * Seed de prueba para la LISTA DE ESPERA (paso 4 del runbook, de punta a punta).
 *
 *   npm run seed:prueba-espera -- --dry-run   → muestra qué crearía (sin red)
 *   npm run seed:prueba-espera                → deja el escenario armado en Medplum
 *
 * Arma el escenario completo con dos pacientes de prueba:
 *
 *   - PACIENTE QUE ESPERA: anotado en la lista por "cámara hiperbárica"
 *     (categoría HBOT), con ventana de 7 días, sin preferencia de día/franja
 *     (así cualquier hueco le sirve).
 *   - PACIENTE QUE CANCELA: un turno HBOT `booked` para MAÑANA.
 *
 * Después, la prueba es **una sola acción humana**: cancelar ese turno desde la
 * app (*Agenda* → clic en el turno → **Cancelar**) y mirar la solapa **Avisos**:
 * tiene que aparecer *"Se liberó un turno y hay alguien esperándolo"* con el
 * paciente que espera como candidato.
 *
 * ## Por qué el turno se recrea en cada corrida
 *
 * El aviso es idempotente por turno **para siempre**: el `Task` se identifica
 * como `hueco-<appointmentId>` y la búsqueda no filtra por status, así que un
 * turno que ya dio aviso no vuelve a darlo nunca (ver
 * docs/puesta-en-produccion.md § "Si el aviso no aparece"). Por eso este seed
 * BORRA el turno de la corrida anterior y su Task, y crea uno nuevo con otro id:
 * cada corrida deja una prueba virgen.
 *
 * ⚠️ "Ofrecer por WhatsApp" desde el aviso manda el mensaje DE VERDAD al
 * teléfono del paciente que espera (PRUEBA_ESPERA_TELEFONO para usar el tuyo).
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Appointment, Patient } from '@medplum/fhirtypes';
import { esperaAAppointment } from '../fhir/lista-espera.js';
import { clasificacionDeServicio } from '../fhir/appointment.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';

/**
 * Los dos pacientes de prueba se encuentran por IDENTIFIER (system de prueba) y
 * se crean con POST si no existen. No se usa un id fijo con PUT porque este
 * servidor **no hace update-as-create**: un PUT a un id inexistente devuelve
 * `Not found` (verificado en la primera corrida real, 2026-08-25). En
 * `prueba-recordatorios` el mismo patrón anda de casualidad: ese paciente ya
 * existía.
 *
 * Con las variables de entorno se puede apuntar a pacientes REALES por id.
 */
const PACIENTE_ESPERA_REAL = process.env.PRUEBA_ESPERA_PATIENT_ID;
const PACIENTE_CANCELA_REAL = process.env.PRUEBA_ESPERA_CANCELA_ID;
const CLAVE_PACIENTE_ESPERA = 'espera-paciente-que-espera';
const CLAVE_PACIENTE_CANCELA = 'espera-paciente-que-cancela';

/** Teléfono del que espera: acá llega el WhatsApp si se toca "Ofrecer". */
const TELEFONO_ESPERA = process.env.PRUEBA_ESPERA_TELEFONO ?? '+5491100000000';

/** Sistema de identifier de los recursos de prueba (para encontrarlos y limpiarlos). */
const PRUEBA = 'https://biowellness.ar/fhir/Identifier/prueba';
const ID_TURNO = 'espera-turno-a-cancelar';
const ID_ESPERA = 'espera-anotacion';

/**
 * El servicio de la prueba. HBOT porque es donde la lista de espera más importa
 * (los cupos escasos) y porque ejercita el match por CATEGORÍA: el que espera
 * pide monoplaza y el turno cancelado puede ser cualquier puesto de la cámara.
 */
const SERVICIO = 'HBOT_MONO';

function construir(
  ahora: Date,
  esperaRef: string,
  cancelaRef: string,
): { espera: Appointment; turno: Appointment } {
  // La espera: ventana de 7 días desde ahora, sin preferencias — cualquier
  // hueco de la categoría le sirve, que es lo que hace la prueba determinística.
  const espera = esperaAAppointment({
    pacienteRef: esperaRef,
    pacienteNombre: 'Paciente Prueba Espera',
    servicioCodigo: SERVICIO,
    categoria: 'hbot', // lo completa clasificacionDeServicio igual; explícito para el tipo
    desde: ahora,
    hasta: new Date(ahora.getTime() + 7 * 24 * 60 * 60_000),
    dias: [],
    franjas: [],
    creadaEn: ahora,
    nota: 'Fixture de prueba del paso 4 (seed:prueba-espera)',
  });
  espera.identifier = [{ system: PRUEBA, value: ID_ESPERA }];

  // El turno a cancelar: MAÑANA A LAS 15:00 de Argentina (18:00 UTC) — siempre
  // en el futuro, dentro de la ventana del que espera, y a una hora que la
  // grilla de la Agenda muestra: la recepcionista tiene que poder VERLO para
  // cancelarlo. Un turno a las 4 de la mañana no aparece en la grilla y la
  // prueba muere antes de empezar.
  const inicio = new Date(ahora.getTime() + 24 * 60 * 60_000);
  inicio.setUTCHours(18, 0, 0, 0);
  const turno: Appointment = {
    resourceType: 'Appointment',
    status: 'booked',
    ...clasificacionDeServicio(SERVICIO),
    description: 'HBOT (fixture de la lista de espera)',
    start: inicio.toISOString(),
    end: new Date(inicio.getTime() + 60 * 60_000).toISOString(),
    identifier: [{ system: PRUEBA, value: ID_TURNO }],
    participant: [{ actor: { reference: cancelaRef }, status: 'accepted' }],
    // Sin esta extensión el turno NO aparece en ninguna vista de la agenda
    // (timeline.ts y proximos.ts descartan turnos sin recurso): la recepcionista
    // no podría encontrarlo para cancelarlo y la prueba muere invisible.
    extension: [{ url: EXT.recursoFisico, valueString: 'R_HBOT_MONO' }],
  };
  return { espera, turno };
}

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/**
 * Devuelve el paciente de prueba. Con `idReal` (variable de entorno) tiene que
 * EXISTIR: apuntar a un paciente real que no está sería crear uno fantasma con
 * datos de prueba. Sin `idReal`, se busca por identifier y se crea si falta.
 */
async function asegurarPaciente(
  medplum: MedplumClient,
  opts: { idReal?: string; clave: string; nombre: { given: string; family: string }; telefono?: string },
): Promise<Patient> {
  if (opts.idReal) {
    const real = await medplum.readResource('Patient', opts.idReal).catch(() => undefined);
    if (!real) {
      throw new Error(
        `El Patient/${opts.idReal} (de la variable de entorno) no existe en este servidor. ` +
          'Corregí el id o quitá la variable para que el seed cree pacientes de prueba propios.',
      );
    }
    return real;
  }
  const existente = await medplum.searchOne('Patient', `identifier=${PRUEBA}|${opts.clave}`);
  if (existente) {
    return existente;
  }
  return medplum.createResource<Patient>({
    resourceType: 'Patient',
    active: true,
    identifier: [{ system: PRUEBA, value: opts.clave }],
    name: [{ given: [opts.nombre.given], family: opts.nombre.family }],
    ...(opts.telefono ? { telecom: [{ system: 'phone' as const, value: opts.telefono }] } : {}),
  });
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const ahora = new Date();
  // Para el dry-run, referencias de mentira: no hay servidor del que sacar ids.
  const { turno } = construir(ahora, 'Patient/(dry-run)', 'Patient/(dry-run)');

  console.log('=== Seed de prueba · lista de espera (paso 4) ===');
  console.log(`  • Espera : ${PACIENTE_ESPERA_REAL ?? '(paciente de prueba propio)'} · ${SERVICIO} · ventana 7 días · tel ${TELEFONO_ESPERA}`);
  const horaAR = new Date(turno.start as string).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false,
  });
  console.log(`  • Turno  : ${PACIENTE_CANCELA_REAL ?? '(paciente de prueba propio)'} · 'booked' mañana a las ${horaAR} (hora argentina)`);

  if (dryRun) {
    console.log('\n[dry-run] No se conecta a Medplum. Recursos construidos OK.');
    return;
  }

  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log('\nConectado a Medplum.');

  const pEspera = await asegurarPaciente(medplum, {
    idReal: PACIENTE_ESPERA_REAL,
    clave: CLAVE_PACIENTE_ESPERA,
    nombre: { given: 'Paciente', family: 'Prueba Espera' },
    telefono: TELEFONO_ESPERA,
  });
  const pCancela = await asegurarPaciente(medplum, {
    idReal: PACIENTE_CANCELA_REAL,
    clave: CLAVE_PACIENTE_CANCELA,
    nombre: { given: 'Paciente', family: 'Prueba Cancela' },
  });
  console.log(`  ✓ Patient que espera  ${pEspera.id}`);
  console.log(`  ✓ Patient que cancela ${pCancela.id}`);
  // Recién acá se arman los recursos de verdad, con los ids que el servidor dio.
  const { espera, turno: turnoReal } = construir(ahora, `Patient/${pEspera.id}`, `Patient/${pCancela.id}`);

  // Limpiar la corrida anterior: el turno viejo (cancelado o no), su Task de
  // hueco, y la espera vieja. El turno se BORRA (no se reusa) porque el aviso es
  // idempotente por appointmentId para siempre.
  const turnosViejos = await medplum.searchResources('Appointment', `identifier=${PRUEBA}|${ID_TURNO}&_count=10`);
  for (const viejo of turnosViejos) {
    if (!viejo.id) {
      continue;
    }
    const tasks = await medplum.searchResources('Task', `identifier=${SYSTEM.task}|hueco-${viejo.id}&_count=10`);
    for (const t of tasks) {
      if (t.id) {
        await medplum.deleteResource('Task', t.id);
      }
    }
    await medplum.deleteResource('Appointment', viejo.id);
  }
  if (turnosViejos.length > 0) {
    console.log(`  ✓ Limpieza: ${turnosViejos.length} turno(s) de corridas anteriores + sus Task de hueco`);
  }
  const esperasViejas = await medplum.searchResources('Appointment', `identifier=${PRUEBA}|${ID_ESPERA}&_count=10`);
  for (const vieja of esperasViejas) {
    if (vieja.id) {
      await medplum.deleteResource('Appointment', vieja.id);
    }
  }

  const esperaCreada = await medplum.createResource(espera);
  console.log(`  ✓ Espera anotada      Appointment/${esperaCreada.id} (status waitlist)`);
  const turnoCreado = await medplum.createResource(turnoReal);
  console.log(`  ✓ Turno a cancelar    Appointment/${turnoCreado.id} (${turnoCreado.start})`);

  console.log('\nListo. La prueba ahora es UNA acción en la app:');
  console.log('  1. Agenda → vista "7 días" (el turno es MAÑANA a las 15:00) → clic en el');
  console.log('     turno "HBOT (fixture…)" → Cancelar.');
  console.log('  2. Solapa Avisos: tiene que aparecer "Se liberó un turno y hay alguien');
  console.log('     esperándolo", con "Paciente Prueba Espera" como candidato.');
  console.log('  3. (Opcional) "Ofrecer por WhatsApp" → manda el mensaje DE VERDAD a');
  console.log(`     ${TELEFONO_ESPERA}; el registro queda en la Communication.`);
  console.log('\n  Si el aviso no aparece: docs/puesta-en-produccion.md § "Si el aviso no');
  console.log('  aparece" — y para repetir la prueba alcanza con volver a correr este seed.');
}

main().catch((err) => {
  console.error('Seed de prueba falló:', err);
  process.exitCode = 1;
});
