/**
 * Datos de demostración (se autodestruyen a las 48 h).
 *
 *   npm run datos-demo                     → limpia demo previa y genera datos nuevos
 *   npm run datos-demo -- --limpiar        → borra TODOS los datos demo
 *   npm run datos-demo -- --limpiar-vencidos → borra solo los demo de > 48 h
 *
 * Todo lo creado lleva `meta.tag = demo`. La limpieza (manual o por el cron
 * `bw-limpiar-demo`) borra SOLO lo etiquetado demo: nunca toca datos reales.
 *
 * Genera pacientes, turnos (varios estados), planes (membresía/paquete), un Flag
 * de contraindicación, cobros y comunicaciones, para ver la app con datos.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Appointment, Coverage, Patient, Slot } from '@medplum/fhirtypes';
import { getServicio } from '../config/catalogo.js';
import { codigoConsulta } from '../config/medicos.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { clasificacionDeServicio } from '../fhir/appointment.js';
import { identificadoresDni } from '../fhir/paciente.js';
import { META_DEMO, borrarRecursosDemo } from '../bots/_shared.js';

const TZ = '-03:00';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/** 'YYYY-MM-DD' en zona Argentina, con offset de días. */
function fechaAR(offsetDias: number): string {
  const d = new Date(Date.now() + offsetDias * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(d);
}

function inicioISO(offsetDias: number, hhmm: string): string {
  return `${fechaAR(offsetDias)}T${hhmm}:00${TZ}`;
}

async function scheduleId(medplum: MedplumClient, recursoCodigo: string): Promise<string | undefined> {
  const sch = await medplum.searchOne('Schedule', `identifier=${SYSTEM.recursoCodigo}|SCH_${recursoCodigo}`);
  return sch?.id;
}

const PACIENTES = [
  { nombre: 'María', apellido: 'González', dni: '28111222', tel: '+5491133334444', email: 'maria.demo@example.com' },
  { nombre: 'Juan', apellido: 'Pérez', dni: '30222333', tel: '+5491144445555', email: 'juan.demo@example.com' },
  { nombre: 'Lucía', apellido: 'Fernández', dni: '25333444', tel: '+5491155556666', email: 'lucia.demo@example.com' },
  { nombre: 'Diego', apellido: 'Martínez', dni: '32444555', tel: '+5491166667777', email: 'diego.demo@example.com' },
  { nombre: 'Sofía', apellido: 'Romero', dni: '27555666', tel: '+5491177778888', email: 'sofia.demo@example.com' },
  { nombre: 'Andrés', apellido: 'López', dni: '29666777', tel: '+5491188889999', email: 'andres.demo@example.com' },
] as const;

interface TurnoDemo {
  paciente: string;
  servicioCodigo: string;
  recursoCodigo: string;
  offsetDias: number;
  hhmm: string;
  status: Appointment['status'];
}

const CONSULTA_DOS_SANTOS = codigoConsulta('MED_DOS_SANTOS');

const TURNOS: TurnoDemo[] = [
  { paciente: 'María', servicioCodigo: 'HBOT_MONO', recursoCodigo: 'R_HBOT_MONO', offsetDias: 0, hhmm: '09:00', status: 'fulfilled' },
  { paciente: 'Juan', servicioCodigo: 'RED_LIGHT', recursoCodigo: 'R_RED_LIGHT', offsetDias: 0, hhmm: '10:00', status: 'arrived' },
  { paciente: 'Lucía', servicioCodigo: 'IHHT', recursoCodigo: 'R_IHHT_1', offsetDias: 0, hhmm: '11:30', status: 'booked' },
  { paciente: 'Diego', servicioCodigo: 'COMPRESION', recursoCodigo: 'R_IPC06', offsetDias: 0, hhmm: '15:00', status: 'pending' },
  { paciente: 'Sofía', servicioCodigo: CONSULTA_DOS_SANTOS, recursoCodigo: 'R_CONSULTORIO', offsetDias: 0, hhmm: '16:00', status: 'booked' },
  { paciente: 'Andrés', servicioCodigo: 'CRIO', recursoCodigo: 'R_COT03', offsetDias: 1, hhmm: '09:30', status: 'booked' },
  { paciente: 'María', servicioCodigo: 'HBOT_MONO', recursoCodigo: 'R_HBOT_MONO', offsetDias: 1, hhmm: '12:00', status: 'pending' },
];

async function generar(medplum: MedplumClient): Promise<void> {
  // Pacientes
  const porNombre = new Map<string, Patient>();
  for (const p of PACIENTES) {
    const creado = await medplum.createResource<Patient>({
      resourceType: 'Patient',
      meta: META_DEMO,
      active: true,
      name: [{ text: `${p.nombre} ${p.apellido}`, given: [p.nombre], family: p.apellido }],
      // Los dos systems del documento, igual que un alta real.
      identifier: identificadoresDni(p.dni),
      telecom: [
        { system: 'phone', value: p.tel, use: 'mobile' },
        { system: 'email', value: p.email },
      ],
      extension: [{ url: EXT.tipoCliente, valueCode: 'PUBLICO' }],
    });
    porNombre.set(p.nombre, creado);
  }
  console.log(`  • Pacientes: ${porNombre.size}`);

  // Flag de contraindicación (banner rojo) para Diego
  const diego = porNombre.get('Diego');
  if (diego) {
    await medplum.createResource({
      resourceType: 'Flag',
      meta: META_DEMO,
      status: 'active',
      category: [{ text: 'Contraindicación' }],
      code: {
        coding: [{ system: SYSTEM.contraindicacion, code: 'HTA_NO_CONTROLADA' }],
        text: 'Contraindicación activa (demo)',
      },
      subject: { reference: `Patient/${diego.id}` },
    });
    console.log('  • Flag de contraindicación: 1 (Diego)');
  }

  // Planes (Coverage)
  const maria = porNombre.get('María');
  const juan = porNombre.get('Juan');
  const cicloMes = fechaAR(0).slice(0, 7);
  if (maria) {
    await medplum.createResource<Coverage>({
      resourceType: 'Coverage',
      meta: META_DEMO,
      status: 'active',
      beneficiary: { reference: `Patient/${maria.id}` },
      subscriber: { reference: `Patient/${maria.id}` },
      payor: [{ reference: `Patient/${maria.id}` }],
      period: { start: inicioISO(0, '00:00') },
      extension: [
        { url: EXT.tipoCobertura, valueCode: 'membresia' },
        { url: EXT.planCodigo, valueString: 'FOCUS_STD_IND' },
        { url: EXT.sesionesMes, valueInteger: 8 },
        { url: EXT.sesionesUsadas, valueInteger: 2 },
        { url: EXT.cicloMes, valueString: cicloMes },
      ],
    });
  }
  if (juan) {
    await medplum.createResource<Coverage>({
      resourceType: 'Coverage',
      meta: META_DEMO,
      status: 'active',
      beneficiary: { reference: `Patient/${juan.id}` },
      subscriber: { reference: `Patient/${juan.id}` },
      payor: [{ reference: `Patient/${juan.id}` }],
      period: { start: inicioISO(0, '00:00'), end: inicioISO(30, '00:00') },
      extension: [
        { url: EXT.tipoCobertura, valueCode: 'paquete' },
        { url: EXT.planCodigo, valueString: 'PAQ_HBOT_MONO_X10' },
        { url: EXT.sesionesTotal, valueInteger: 10 },
        { url: EXT.sesionesUsadas, valueInteger: 3 },
      ],
    });
  }
  console.log('  • Planes (Coverage): 2');

  // Turnos + Slots
  const pract = await medplum.searchOne('Practitioner', `identifier=${SYSTEM.medico}|MED_DOS_SANTOS`);
  let turnos = 0;
  for (const t of TURNOS) {
    const paciente = porNombre.get(t.paciente);
    const sid = await scheduleId(medplum, t.recursoCodigo);
    if (!paciente || !sid) {
      console.warn(`  ! Salteo turno de ${t.paciente} (${t.recursoCodigo}): ${!sid ? 'sin Schedule' : 'sin paciente'}`);
      continue;
    }
    const servicio = getServicio(t.servicioCodigo);
    const inicio = new Date(inicioISO(t.offsetDias, t.hhmm));
    const fin = new Date(inicio.getTime() + servicio.duracionMin * 60_000);

    const slot = await medplum.createResource<Slot>({
      resourceType: 'Slot',
      meta: META_DEMO,
      status: 'busy',
      schedule: { reference: `Schedule/${sid}` },
      start: inicio.toISOString(),
      end: fin.toISOString(),
      extension: [{ url: EXT.recursoFisico, valueString: t.recursoCodigo }],
    });

    const participant: Appointment['participant'] = [
      { actor: { reference: `Patient/${paciente.id}`, display: paciente.name?.[0]?.text }, status: 'accepted' },
    ];
    if (t.recursoCodigo === 'R_CONSULTORIO' && pract?.id) {
      participant.push({ actor: { reference: `Practitioner/${pract.id}`, display: pract.name?.[0]?.text }, status: 'accepted' });
    }

    await medplum.createResource<Appointment>({
      resourceType: 'Appointment',
      meta: META_DEMO,
      status: t.status,
      description: servicio.nombre,
      ...clasificacionDeServicio(t.servicioCodigo),
      start: inicio.toISOString(),
      end: fin.toISOString(),
      slot: [{ reference: `Slot/${slot.id}` }],
      participant,
      extension: [
        { url: EXT.recursoFisico, valueString: t.recursoCodigo },
        { url: EXT.ocupantes, valueInteger: 1 },
        { url: EXT.itemTipo, valueCode: 'servicio' },
        { url: EXT.itemCodigo, valueString: t.servicioCodigo },
      ],
    });
    turnos++;
  }
  console.log(`  • Turnos (con Slot): ${turnos}`);

  // Cobros (Invoice, ARS) para Reportes
  const cobros: Array<{ paciente?: Patient; desc: string; ars: number; sena: boolean; medio: string }> = [
    { paciente: maria, desc: 'Seña 50% · HBOT Monoplaza', ars: 119625, sena: true, medio: 'efectivo' },
    { paciente: porNombre.get('Sofía'), desc: 'Consulta — Dra. Dos Santos', ars: 120000, sena: false, medio: 'tarjeta-credito' },
    { paciente: porNombre.get('Lucía'), desc: 'Seña 50% · IHHT', ars: 65250, sena: true, medio: 'mercadopago' },
  ];
  let invoices = 0;
  for (const c of cobros) {
    if (!c.paciente) {
      continue;
    }
    await medplum.createResource({
      resourceType: 'Invoice',
      meta: META_DEMO,
      status: 'balanced',
      date: new Date().toISOString(),
      subject: { reference: `Patient/${c.paciente.id}` },
      lineItem: [{ chargeItemCodeableConcept: { text: c.desc }, priceComponent: [{ type: 'base', amount: { value: c.ars, currency: 'ARS' } }] }],
      totalGross: { value: c.ars, currency: 'ARS' },
      extension: [
        { url: EXT.esSena, valueBoolean: c.sena },
        { url: EXT.medioPago, valueString: c.medio },
        { url: EXT.tcAplicado, valueDecimal: 1450 },
      ],
    });
    invoices++;
  }
  console.log(`  • Cobros (Invoice): ${invoices}`);

  // Comunicaciones (WhatsApp) para Reportes
  const comms: Array<{ paciente?: Patient; template: string; body: string }> = [
    { paciente: porNombre.get('Lucía'), template: 'reserva-tentativa', body: 'Biowellness: reservamos tu turno (demo).' },
    { paciente: porNombre.get('Sofía'), template: 'turno-confirmado', body: 'Biowellness: ¡tu turno quedó confirmado! (demo)' },
    { paciente: porNombre.get('Andrés'), template: 'recordatorio-48h', body: 'Biowellness: te recordamos tu turno (demo).' },
  ];
  let communications = 0;
  for (const c of comms) {
    if (!c.paciente) {
      continue;
    }
    await medplum.createResource({
      resourceType: 'Communication',
      meta: META_DEMO,
      status: 'completed',
      sent: new Date().toISOString(),
      subject: { reference: `Patient/${c.paciente.id}` },
      recipient: [{ reference: `Patient/${c.paciente.id}` }],
      payload: [{ contentString: c.body }],
      extension: [
        { url: EXT.canal, valueCode: 'whatsapp' },
        { url: EXT.templateUsado, valueString: c.template },
      ],
    });
    communications++;
  }
  console.log(`  • Comunicaciones: ${communications}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));

  if (args.includes('--limpiar')) {
    const r = await borrarRecursosDemo(medplum);
    console.log(`Limpieza demo (todo): ${r.borrados} recursos`, r.porTipo);
    return;
  }
  if (args.includes('--limpiar-vencidos')) {
    const antesDe = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const r = await borrarRecursosDemo(medplum, { antesDe });
    console.log(`Limpieza demo (> 48 h, corte ${antesDe}): ${r.borrados} recursos`, r.porTipo);
    return;
  }

  // Default: limpiar demo previa (para no acumular) y generar.
  console.log('Limpiando datos demo previos…');
  const prev = await borrarRecursosDemo(medplum);
  console.log(`  borrados: ${prev.borrados}`);
  console.log('Generando datos demo (se autodestruyen a las 48 h):');
  await generar(medplum);
  console.log('\n✓ Datos demo cargados. Se borran solos a las 48 h (bot bw-limpiar-demo) o con: npm run datos-demo -- --limpiar');
}

main().catch((err) => {
  console.error('datos-demo falló:', err);
  process.exitCode = 1;
});
