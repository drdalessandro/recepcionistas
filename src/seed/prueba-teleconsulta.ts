/**
 * Seed de prueba de la TELECONSULTA, para que el portal y el Dashboard puedan
 * construir contra un turno real sin esperar a que Recepción reserve uno.
 *
 *   npm run seed:prueba-teleconsulta -- --dry-run   → muestra qué crearía (sin red)
 *   npm run seed:prueba-teleconsulta                → deja el turno PAGO, listo para entrar
 *   npm run seed:prueba-teleconsulta -- --con-pago  → deja el turno IMPAGO + link de MercadoPago
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
 * ## `--con-pago`: probar el cobro, no la sala
 *
 * Sin la opción, el turno nace `booked` —pago y confirmado— para poder entrar a
 * la sala enseguida. Con `--con-pago` nace **`pending`**, que es como lo deja una
 * reserva real sin plan (R-19), y el seed pide el link de MercadoPago por el
 * **total**: una teleconsulta se cobra entera por adelantado (Andrés,
 * 2026-09-16), así que el link es por $150.000 y no por la mitad.
 *
 * El circuito que se ejercita es el mismo que el de un paciente de verdad:
 * pagar el link → MercadoPago notifica al webhook → `confirmarReserva` pasa el
 * turno a `booked`, emite el Invoice **sin** Invoice de saldo y manda el
 * WhatsApp y la campanita. Recién ahí el bot del token deja entrar a la sala:
 * un turno impago no entra a la consulta.
 *
 * Por eso con `--con-pago` el turno arranca más tarde (`EMPIEZA_EN_MIN_PAGO`):
 * el vencimiento de la tentativa nunca pasa del inicio del turno, así que con
 * 10 minutos el link vencería antes de que nadie llegue a pagarlo.
 *
 * ⚠️ El paciente de prueba tiene que poder loguearse en el portal. Si ya tienen
 * uno, pasarlo en `PRUEBA_TELECONSULTA_PATIENT_ID` y este seed lo usa en vez de
 * crear el suyo (que no tiene usuario y no sirve para probar la página).
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import { randomUUID } from 'node:crypto';
import type { Appointment, Patient, Practitioner } from '@medplum/fhirtypes';
import type { ResultadoToken } from '../bots/teleconsulta-token.js';
import { clasificacionDeServicio, modalidadAppointmentType } from '../fhir/appointment.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { RECURSO_TELECONSULTA } from '../config/recursos.js';
import { getServicio } from '../config/catalogo.js';
import { codigoTeleconsulta } from '../config/medicos.js';
import { nombreSala, rutaTeleconsulta, TELECONSULTA } from '../lib/teleconsulta.js';
import { PORTAL_URL } from '../lib/onboarding.js';
import { vencimientoSena } from '../lib/sena.js';
import { fraccionAnticipada } from '../lib/pricing.js';
import type { ResultadoLinkMP } from '../bots/link-mercadopago.js';

/** El servicio de la prueba: la teleconsulta de cardiología (la primera que se vendió). */
const MEDICO = 'MED_DALESSANDRO';
const SERVICIO = codigoTeleconsulta(MEDICO);

const PACIENTE_REAL = process.env.PRUEBA_TELECONSULTA_PATIENT_ID;
const PRUEBA = 'https://biowellness.ar/fhir/Identifier/prueba';
const CLAVE_PACIENTE = 'teleconsulta-paciente';
const ID_TURNO = 'teleconsulta-turno';

/** Minutos hasta el inicio: la ventana de acceso ya abierta al terminar el seed. */
const EMPIEZA_EN_MIN = 10;

/**
 * Con `--con-pago`, el turno arranca más lejos. El vencimiento de la tentativa
 * es `min(ahora + 2 h, inicio del turno)` (R-19), así que un turno que empieza
 * en 10 minutos da un link que vence en 10 minutos: no alcanza para abrir
 * MercadoPago y pagar, y `bw-vencer-tentativas` liberaría el lugar en el medio
 * de la prueba.
 */
const EMPIEZA_EN_MIN_PAGO = 90;

function construirTurno(
  ahora: Date,
  pacienteRef: string,
  profesional: Practitioner | undefined,
  conPago: boolean,
): Appointment {
  const servicio = getServicio(SERVICIO);
  const inicio = new Date(ahora.getTime() + (conPago ? EMPIEZA_EN_MIN_PAGO : EMPIEZA_EN_MIN) * 60_000);
  const fin = new Date(inicio.getTime() + servicio.duracionMin * 60_000);
  return {
    resourceType: 'Appointment',
    // `booked` = confirmado y pagado. Con cobro total anticipado, un turno
    // `pending` no entra a la sala: el bot del token lo rechaza — que es
    // justamente lo que `--con-pago` deja probar.
    status: conPago ? 'pending' : 'booked',
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
      // Vencimiento de la tentativa (R-19). Lo lee `linkSena` para que el link
      // de MercadoPago expire con el turno, y `bw-vencer-tentativas` para
      // liberar el lugar si no se paga.
      ...(conPago ? [{ url: EXT.venceSena, valueDateTime: vencimientoSena(ahora, inicio).toISOString() }] : []),
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
  const conPago = process.argv.includes('--con-pago');
  const ahora = new Date();
  const servicio = getServicio(SERVICIO);

  console.log(`=== Seed de prueba · teleconsulta${conPago ? ' (con cobro)' : ''} ===`);
  console.log(`  • Servicio : ${SERVICIO} (${servicio.nombre})`);
  console.log(
    `  • Turno    : ${conPago ? 'pending (impago)' : 'booked (pago)'}, empieza en ` +
      `${conPago ? EMPIEZA_EN_MIN_PAGO : EMPIEZA_EN_MIN} min`,
  );
  if (conPago) {
    const total = (servicio.precioARS ?? 0) * fraccionAnticipada(servicio.modalidad);
    console.log(`  • Cobro    : $${total.toLocaleString('es-AR')} — el TOTAL, no la seña (virtual)`);
  }
  console.log(
    `  • Ventana  : se entra desde ${TELECONSULTA.accesoAntesMin} min antes hasta ` +
      `${TELECONSULTA.accesoDespuesMin} min después del fin`,
  );

  if (dryRun) {
    construirTurno(ahora, 'Patient/(dry-run)', undefined, conPago);
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

  const turno = await medplum.createResource(construirTurno(ahora, `Patient/${paciente.id}`, profesional, conPago));
  const sala = turno.extension?.find((e) => e.url === EXT.teleconsultaSala)?.valueString;
  console.log(`  ✓ Turno        Appointment/${turno.id}`);
  console.log(`    sala ${sala} · empieza ${turno.start}`);

  // --------------------------------------------------------------------
  // La ÚNICA forma de verificar los Project Secrets es ejecutar el bot:
  // Medplum no los expone por API (a propósito). Así que el seed cierra el
  // lazo — crea el turno y acto seguido pide el token, que es exactamente lo
  // que va a hacer el portal. Si algo de la configuración está mal, se entera
  // acá y no la primera paciente.
  // --------------------------------------------------------------------
  if (conPago) {
    // Camino del cobro. El link lo pide el MISMO bot que usa Recepción desde el
    // mostrador, así que lo que se prueba acá es lo que se usa en producción.
    const botLink = await medplum.searchOne('Bot', { name: 'bw-link-mercadopago' });
    if (!botLink?.id) {
      console.log('\n  ⚠️  No existe el Bot bw-link-mercadopago: correr `npm run deploy:bots`.');
    } else {
      const r = (await medplum
        .executeBot(botLink.id, { appointmentId: turno.id, concepto: 'sena' })
        .catch((err) => ({ ok: false, mensaje: err instanceof Error ? err.message : String(err) }))) as ResultadoLinkMP;
      const monto = r?.montoARS ?? r?.senaARS;
      if (r?.ok && r.url) {
        console.log(`\n  ✓ Link de pago por $${(monto ?? 0).toLocaleString('es-AR')}:`);
        console.log(`    ${r.url}`);
        console.log(`    vence: ${turno.extension?.find((e) => e.url === EXT.venceSena)?.valueDateTime}`);
      } else {
        console.log(`\n  ✗ No se pudo generar el link: ${r?.mensaje ?? 'sin mensaje'}`);
        console.log('    Falta MERCADOPAGO_ACCESS_TOKEN o MP_WEBHOOK_URL en los Project Secrets.');
      }
    }
    console.log('\n  El turno está IMPAGO y el bot del token NO deja entrar a la sala hasta que');
    console.log('  se pague: ese rechazo es parte de lo que esta prueba verifica.');
    console.log('  Al pagar, MercadoPago llama al webhook → el turno pasa a `booked`, sale el');
    console.log('  Invoice (sin saldo pendiente) y el WhatsApp de confirmación.');
  }

  const bot = conPago ? undefined : await medplum.searchOne('Bot', { name: 'bw-teleconsulta-token' });
  if (!conPago && !bot?.id) {
    console.log('\n  ⚠️  No existe el Bot bw-teleconsulta-token: correr `npm run deploy:bots`.');
  } else if (bot?.id) {
    const r = (await medplum
      .executeBot(bot.id, { appointmentId: turno.id, rol: 'paciente', pacienteRef: `Patient/${paciente.id}` })
      .catch((err) => ({ ok: false, mensaje: err instanceof Error ? err.message : String(err) }))) as ResultadoToken;

    if (r?.ok && r.jwt) {
      const claims = JSON.parse(Buffer.from(r.jwt.split('.')[1] as string, 'base64url').toString()) as {
        iss: string;
        sub: string;
        room: string;
      };
      console.log('\n  ✓ Los secrets JITSI_* están bien: el bot emitió un token.');
      console.log(`    dominio (claim sub) : ${claims.sub}`);
      console.log(`    app id  (claim iss) : ${claims.iss}`);
      console.log(`    sala    (claim room): ${claims.room}`);
      // El `sub` tiene que ser el HOST pelado o Prosody rechaza el token: es el
      // error más caro de diagnosticar porque aparece del lado del servidor.
      if (claims.sub.includes('/')) {
        console.log(`\n  ⚠️  El claim \`sub\` trae una URL y Prosody espera el host pelado.`);
        console.log('     Corregir el Project Secret JITSI_BASE_URL a `meet.biowellness.ar`.');
      }
      console.log(`\n    Link directo para probar la sala a mano (vence con el turno):`);
      console.log(`    https://${r.dominio}/${r.sala}?jwt=${r.jwt}`);
    } else {
      console.log(`\n  ✗ El bot NO emitió token: ${r?.mensaje ?? 'sin mensaje'}`);
      console.log('    "La videollamada no está configurada" = falta alguno de los tres Project Secrets:');
      console.log('    JITSI_BASE_URL (el host pelado, `meet.biowellness.ar`) · JITSI_APP_ID · JITSI_JWT_SECRET.');
    }
  }

  console.log('\nPasale esto a los dos equipos:');
  console.log(`  • Portal    → ${PORTAL_URL}${rutaTeleconsulta(turno.id as string)}`);
  console.log(`                appointmentId: ${turno.id} · pacienteRef: Patient/${paciente.id}`);
  console.log(`  • Dashboard → appointmentId: ${turno.id} · practitionerRef: Practitioner/${profesional.id}`);
  console.log('\nY del lado del servidor: `frame-ancestors` con los dos dominios en el');
  console.log('nginx de meet.biowellness.ar (runbook §5). Sin eso el token sale igual,');
  console.log('pero el navegador se niega a mostrar el iframe dentro del portal.');
}

main().catch((err) => {
  console.error('Seed de prueba falló:', err);
  process.exitCode = 1;
});
