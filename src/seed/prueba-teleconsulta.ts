/**
 * Seed de prueba de la TELECONSULTA, para que el portal y el Dashboard puedan
 * construir contra un turno real sin esperar a que Recepción reserve uno.
 *
 *   npm run seed:prueba-teleconsulta -- --dry-run   → muestra qué crearía (sin red)
 *   npm run seed:prueba-teleconsulta                → deja el turno en Medplum
 *
 * Deja **un turno virtual `booked`** —o sea, pago y confirmado— del paciente de
 * prueba con el Dr. D'Alessandro, con su `appointmentType`, su sala `tc-<uuid>`
 * y los dos `participant`. Es exactamente la forma que arma `bw-reservar-turno`
 * cuando el servicio es virtual; acá se escribe directo porque el objetivo es
 * tener el id AHORA, no ejercitar la reserva.
 *
 * Imprime al final el `id` del turno y el del paciente: eso es lo que hay que
 * pasarle a los dos equipos.
 *
 * ## El turno arranca dentro de un rato, a propósito
 *
 * La ventana de acceso va de 15 minutos ANTES del inicio a 60 DESPUÉS del fin
 * (`TELECONSULTA`), y fuera de ella el bot del token no emite nada. Un turno
 * "mañana a las 10" no sirve para probar: el botón no se habilita y parece que
 * está roto. Por eso este seed lo pone a empezar **en 10 minutos** — la ventana
 * ya está abierta cuando termina de correr, y queda abierta por más de una hora.
 *
 * Volver a correrlo BORRA el turno anterior y crea uno nuevo (con sala nueva):
 * así la prueba siempre arranca de cero, igual que `seed:prueba-espera`.
 *
 * ⚠️ El paciente de prueba tiene que poder loguearse en el portal. Si ya tienen
 * uno, pasarlo en `PRUEBA_TELECONSULTA_PATIENT_ID` y este seed lo usa en vez de
 * crear el suyo (que no tiene usuario y no sirve para probar la página).
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import { randomUUID } from 'node:crypto';
import type { Appointment, Patient, Practitioner } from '@medplum/fhirtypes';
import { clasificacionDeServicio, modalidadAppointmentType } from '../fhir/appointment.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { RECURSO_TELECONSULTA } from '../config/recursos.js';
import { getServicio } from '../config/catalogo.js';
import { codigoTeleconsulta } from '../config/medicos.js';
import { nombreSala, rutaTeleconsulta, TELECONSULTA } from '../lib/teleconsulta.js';
import { PORTAL_URL } from '../lib/onboarding.js';

/** El servicio de la prueba: la teleconsulta de cardiología (la primera que se vendió). */
const MEDICO = 'MED_DALESSANDRO';
const SERVICIO = codigoTeleconsulta(MEDICO);

const PACIENTE_REAL = process.env.PRUEBA_TELECONSULTA_PATIENT_ID;
const PRUEBA = 'https://biowellness.ar/fhir/Identifier/prueba';
const CLAVE_PACIENTE = 'teleconsulta-paciente';
const ID_TURNO = 'teleconsulta-turno';

/** Minutos hasta el inicio: la ventana de acceso ya abierta al terminar el seed. */
const EMPIEZA_EN_MIN = 10;

function construirTurno(ahora: Date, pacienteRef: string, profesional: Practitioner | undefined): Appointment {
  const servicio = getServicio(SERVICIO);
  const inicio = new Date(ahora.getTime() + EMPIEZA_EN_MIN * 60_000);
  const fin = new Date(inicio.getTime() + servicio.duracionMin * 60_000);
  return {
    resourceType: 'Appointment',
    // `booked` = confirmado y pagado. Con cobro total anticipado, un turno
    // `pending` no entra a la sala: el bot del token lo rechaza.
    status: 'booked',
    description: servicio.nombre,
    ...clasificacionDeServicio(SERVICIO),
    appointmentType: modalidadAppointmentType('virtual'),
    start: inicio.toISOString(),
    end: fin.toISOString(),
    identifier: [{ system: PRUEBA, value: ID_TURNO }],
    participant: [
      { actor: { reference: pacienteRef }, status: 'accepted' },
      // Sin el profesional, el Dashboard no puede pedir token: el bot verifica
      // que quien pide sea `participant` del turno.
      ...(profesional?.id
        ? [
            {
              actor: { reference: `Practitioner/${profesional.id}`, display: profesional.name?.[0]?.text },
              status: 'accepted' as const,
            },
          ]
        : []),
    ],
    extension: [
      { url: EXT.recursoFisico, valueString: RECURSO_TELECONSULTA },
      { url: EXT.itemTipo, valueCode: 'servicio' },
      { url: EXT.itemCodigo, valueString: SERVICIO },
      { url: EXT.teleconsultaSala, valueString: nombreSala(randomUUID()) },
    ],
  };
}

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const ahora = new Date();

  console.log('=== Seed de prueba · teleconsulta ===');
  console.log(`  • Servicio : ${SERVICIO} (${getServicio(SERVICIO).nombre})`);
  console.log(`  • Turno    : booked, empieza en ${EMPIEZA_EN_MIN} min`);
  console.log(
    `  • Ventana  : se entra desde ${TELECONSULTA.accesoAntesMin} min antes hasta ` +
      `${TELECONSULTA.accesoDespuesMin} min después del fin`,
  );

  if (dryRun) {
    construirTurno(ahora, 'Patient/(dry-run)', undefined);
    console.log('\n[dry-run] No se conecta a Medplum. Turno construido OK.');
    return;
  }

  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log('\nConectado a Medplum.');

  // El profesional: el MISMO recurso que creó el seed. Si el usuario del
  // Dashboard apunta a otro Practitioner con el mismo nombre, el bot del token
  // va a rechazar todo (ver handoff-dashboard-teleconsulta.md §1).
  const profesional = await medplum.searchOne('Practitioner', `identifier=${SYSTEM.medico}|${MEDICO}`);
  if (!profesional?.id) {
    throw new Error(`No existe el Practitioner ${MEDICO} en este servidor. Corré \`npm run seed\` primero.`);
  }
  console.log(`  ✓ Profesional  Practitioner/${profesional.id} (${profesional.name?.[0]?.text})`);

  let paciente: Patient | undefined;
  if (PACIENTE_REAL) {
    paciente = await medplum.readResource('Patient', PACIENTE_REAL).catch(() => undefined);
    if (!paciente) {
      throw new Error(
        `El Patient/${PACIENTE_REAL} (de la variable de entorno) no existe en este servidor. ` +
          'Corregí el id o quitá la variable para que el seed cree uno de prueba.',
      );
    }
  } else {
    paciente =
      (await medplum.searchOne('Patient', `identifier=${PRUEBA}|${CLAVE_PACIENTE}`)) ??
      (await medplum.createResource<Patient>({
        resourceType: 'Patient',
        active: true,
        identifier: [{ system: PRUEBA, value: CLAVE_PACIENTE }],
        name: [{ given: ['Paciente'], family: 'Prueba Teleconsulta' }],
      }));
  }
  console.log(`  ✓ Paciente     Patient/${paciente.id}`);

  // Limpieza de la corrida anterior: el turno viejo y su Encounter. El turno se
  // BORRA y no se reusa porque la sala es parte de lo que se prueba — reusarla
  // escondería un bug de generación de sala.
  const viejos = await medplum.searchResources('Appointment', `identifier=${PRUEBA}|${ID_TURNO}&_count=20`);
  for (const viejo of viejos) {
    if (!viejo.id) {
      continue;
    }
    const encs = await medplum.searchResources('Encounter', `appointment=Appointment/${viejo.id}&_count=10`);
    for (const enc of encs) {
      if (enc.id) {
        await medplum.deleteResource('Encounter', enc.id);
      }
    }
    await medplum.deleteResource('Appointment', viejo.id);
  }
  if (viejos.length > 0) {
    console.log(`  ✓ Limpieza     ${viejos.length} turno(s) de corridas anteriores + sus Encounter`);
  }

  const turno = await medplum.createResource(construirTurno(ahora, `Patient/${paciente.id}`, profesional));
  const sala = turno.extension?.find((e) => e.url === EXT.teleconsultaSala)?.valueString;
  console.log(`  ✓ Turno        Appointment/${turno.id}`);
  console.log(`    sala ${sala} · empieza ${turno.start}`);

  console.log('\nPasale esto a los dos equipos:');
  console.log(`  • Portal    → ${PORTAL_URL}${rutaTeleconsulta(turno.id as string)}`);
  console.log(`                appointmentId: ${turno.id} · pacienteRef: Patient/${paciente.id}`);
  console.log(`  • Dashboard → appointmentId: ${turno.id} · practitionerRef: Practitioner/${profesional.id}`);
  console.log('\nHace falta además, del lado del servidor:');
  console.log('  1. `npm run deploy:bots` y los Project Secrets JITSI_BASE_URL / JITSI_APP_ID / JITSI_JWT_SECRET.');
  console.log('  2. `frame-ancestors` con los dos dominios en el nginx de meet.biowellness.ar.');
  console.log('  Sin (1) el token no sale; sin (2) el navegador no muestra el iframe.');
}

main().catch((err) => {
  console.error('Seed de prueba falló:', err);
  process.exitCode = 1;
});
