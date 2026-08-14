/**
 * Seed de prueba para `bw-recordatorios`.
 *
 *   npm run seed:prueba-recordatorios -- --dry-run   → muestra qué crearía (sin red)
 *   npm run seed:prueba-recordatorios                → upsert en Medplum (.env)
 *
 * Crea/actualiza (idempotente) un paciente de prueba con:
 *   - un TURNO confirmado a ~20 h, que cae en la ventana de **48 h** (las
 *     ventanas son 48 h y 2 h: `RECORDATORIO_HORAS`), y
 *   - una MEMBRESÍA activa con saldo libre.
 * Además limpia las Communication previas de ese paciente, para que cada corrida
 * deje el recordatorio listo para volver a dispararse.
 *
 * Luego, para probar el bot A MANO (el id sale de medplum.config.json):
 *   npx medplum post 'Bot/<id-de-bw-recordatorios>/$execute' '{}'
 *
 * ⚠️ `medplum bot execute` NO existe en el CLI (solo save/deploy/create), y el
 * bot solo acepta `ahora` como input — no hay ventana de saldo: `bw-recordatorios`
 * avisa turnos, no saldo en riesgo (eso vive en el dashboard de la app).
 *
 * ⚠️ Ejecutarlo a mano MANDA EL WHATSAPP DE VERDAD al teléfono del paciente de
 * prueba. Y para probar que el **cron** dispara solo, no hay que ejecutarlo:
 * correr este seed (que borra las Communication previas) y esperar el tick.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Appointment, Coverage, Patient } from '@medplum/fhirtypes';
import { EXT } from '../fhir/identifiers.js';
import { cicloMes } from '../lib/planes.js';

/** Id del paciente de prueba (fijo por defecto; configurable para apuntar a uno real). */
const PATIENT_ID = process.env.PRUEBA_PATIENT_ID ?? '9647fb20-c13a-49c0-b32c-50549bb2c1d9';
/** Sistema de identifier para los recursos de prueba (upsert idempotente). */
const PRUEBA = 'https://biowellness.ar/fhir/Identifier/prueba';
/** PRIME Standard Individual: 8 sesiones/mes, base BIO RECOVERY. */
const PLAN = 'PRIME_STD_IND';
const SESIONES_MES = 8;
const SESIONES_USADAS = 5; // → 3 libres "por agendar"

/** Contacto del paciente (reemplazá por los tuyos para un envío real). */
const TELEFONO = process.env.PRUEBA_TELEFONO ?? '+5491100000000';
const EMAIL = process.env.PRUEBA_EMAIL ?? 'prueba@biowellness.ar';

function construir(ahora: Date) {
  const inicio = new Date(ahora.getTime() + 20 * 60 * 60_000); // +20 h → cae en la ventana de 48 h (RECORDATORIO_HORAS = [48, 2])
  const fin = new Date(inicio.getTime() + 90 * 60_000);
  const ciclo = cicloMes(ahora);

  const coverage: Coverage = {
    resourceType: 'Coverage',
    status: 'active',
    identifier: [{ system: PRUEBA, value: 'recordatorio-membresia' }],
    beneficiary: { reference: `Patient/${PATIENT_ID}` },
    payor: [{ display: 'Biowellness' }],
    extension: [
      { url: EXT.tipoCobertura, valueCode: 'membresia' },
      { url: EXT.planCodigo, valueString: PLAN },
      { url: EXT.sesionesMes, valueInteger: SESIONES_MES },
      { url: EXT.sesionesUsadas, valueInteger: SESIONES_USADAS },
      { url: EXT.cicloMes, valueString: ciclo },
    ],
  };

  const appointment: Appointment = {
    resourceType: 'Appointment',
    status: 'booked',
    description: 'BIO RECOVERY · HBOT',
    start: inicio.toISOString(),
    end: fin.toISOString(),
    identifier: [{ system: PRUEBA, value: 'recordatorio-turno' }],
    participant: [{ actor: { reference: `Patient/${PATIENT_ID}` }, status: 'accepted' }],
    extension: [
      { url: EXT.itemTipo, valueCode: 'combo' },
      { url: EXT.itemCodigo, valueString: 'BIO_RECOVERY' },
    ],
  };

  return { coverage, appointment, inicio, ciclo };
}

/** Upsert por identifier: actualiza si ya existe (PUT con su id) o crea si no (POST). */
async function upsertPorIdentifier<
  T extends { resourceType: string; id?: string; identifier?: { system?: string; value?: string }[] },
>(medplum: MedplumClient, recurso: T): Promise<T> {
  const id = recurso.identifier?.[0];
  const existente = id
    ? await medplum.searchOne(recurso.resourceType as 'Coverage', `identifier=${id.system}|${id.value}`)
    : undefined;
  if (existente?.id) {
    return (await medplum.updateResource({ ...recurso, id: existente.id } as never)) as T;
  }
  return (await medplum.createResource(recurso as never)) as T;
}

/**
 * Devuelve el paciente de prueba SIN pisar datos reales: si ya existe, lo respeta
 * (solo le agrega teléfono/email si le faltan, para poder notificar); si no existe,
 * crea uno de prueba con el id fijo.
 */
async function obtenerPaciente(medplum: MedplumClient): Promise<Patient> {
  const existente = await medplum.readResource('Patient', PATIENT_ID).catch(() => undefined);
  if (existente) {
    const tieneTel = existente.telecom?.some((t) => t.system === 'phone' || t.system === 'sms');
    const tieneMail = existente.telecom?.some((t) => t.system === 'email');
    if (tieneTel && tieneMail) {
      return existente;
    }
    const telecom = [...(existente.telecom ?? [])];
    if (!tieneTel) {
      telecom.push({ system: 'phone', value: TELEFONO });
    }
    if (!tieneMail) {
      telecom.push({ system: 'email', value: EMAIL });
    }
    return medplum.updateResource({ ...existente, telecom });
  }
  return medplum.updateResource({
    resourceType: 'Patient',
    id: PATIENT_ID,
    name: [{ given: ['Paciente'], family: 'Prueba Recordatorios' }],
    telecom: [
      { system: 'phone', value: TELEFONO },
      { system: 'email', value: EMAIL },
    ],
  });
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const ahora = new Date();
  const { coverage, appointment, inicio, ciclo } = construir(ahora);

  console.log('=== Seed de prueba · bw-recordatorios ===');
  console.log(`  • Patient ${PATIENT_ID} (tel/email de respaldo: ${TELEFONO} / ${EMAIL})`);
  console.log(`  • Membresía ${PLAN}: ${SESIONES_MES - SESIONES_USADAS} de ${SESIONES_MES} libres · ciclo ${ciclo}`);
  console.log(`  • Turno BIO RECOVERY 'booked' a las ${inicio.toLocaleString('es-AR')} (~20 h → recordatorio de 48 h)`);

  if (dryRun) {
    console.log('\n[dry-run] No se conecta a Medplum. Recursos construidos OK.');
    return;
  }

  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log('\nConectado a Medplum.');

  const p = await obtenerPaciente(medplum);
  const destinatario = [
    p.telecom?.find((t) => t.system === 'phone' || t.system === 'sms')?.value,
    p.telecom?.find((t) => t.system === 'email')?.value,
  ].filter(Boolean);
  console.log(`  ✓ Patient ${p.id} → ${destinatario.join(' / ') || '(sin teléfono/email!)'}`);
  const cov = await upsertPorIdentifier(medplum, coverage);
  console.log(`  ✓ Coverage ${cov.id}`);
  // Vincular el turno a la membresía (consumo de cobertura), para realismo.
  appointment.extension = [...(appointment.extension ?? []), { url: EXT.coberturaUsada, valueString: `Coverage/${cov.id}` }];
  const appt = await upsertPorIdentifier(medplum, appointment);
  console.log(`  ✓ Appointment ${appt.id} (${appt.start})`);

  // Limpiar Communication previas de este paciente, para re-disparar los avisos.
  const previas = await medplum.searchResources('Communication', `recipient=Patient/${PATIENT_ID}&_count=200`);
  for (const c of previas) {
    if (c.id) {
      await medplum.deleteResource('Communication', c.id);
    }
  }
  console.log(`  ✓ Communication previas borradas (${previas.length})`);

  console.log('\nListo.');
  console.log('  · Para probar que el CRON dispara solo: NO ejecutes nada más, esperá el tick');
  console.log('    y buscá una Communication con identifier recordatorio-48h-…');
  console.log('  · Para probar el bot a mano (manda el WhatsApp de verdad):');
  console.log("      npx medplum post 'Bot/<id-de-bw-recordatorios>/$execute' '{}'");
}

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

main().catch((err) => {
  console.error('Seed de prueba falló:', err);
  process.exitCode = 1;
});
