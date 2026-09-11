/**
 * Demo de ocupación (producción; se autodestruye sola).
 *
 *   npm run demo:ocupacion                          → limpia demo previa y llena HOY + MAÑANA al 100 % (vive 48 h)
 *   npm run demo:ocupacion -- --dias 3              → llena hoy + 2 días más
 *   npm run demo:ocupacion -- --hasta 2026-09-15    → llena desde hoy hasta esa fecha y la mantiene VIVA hasta ese día
 *   npm run demo:ocupacion -- --ocupacion 0.6       → 60 % de la agenda: deja huecos reales para probar reservas
 *   npm run demo:ocupacion -- --dry-run             → muestra el plan sin tocar el servidor
 *   npm run demo:ocupacion -- --limpiar             → borra TODOS los datos demo ya (vigentes o no)
 *
 * Qué genera: las salas ocupadas el día entero (o al porcentaje pedido, con
 * huecos deterministas: combos encadenados, Multiplaza grupal, gabinetes
 * Recovery desfasados 30' — la demo respeta R-07 y R-22, hay tests),
 * mensajes entrantes de WhatsApp y del portal (badge de Mensajes), solicitudes
 * de turno como las que crea la web (badge de Solicitudes), avisos del sistema
 * (badge de Avisos) y cobros para que Reportes/Caja se vean vivos. La
 * campanita cuenta todo sola.
 *
 * R-22: los turnos arrancan a la hora en punto (Recovery Pro también a la
 * media). Una sesión de 30' deja la media hora siguiente libre — exactamente
 * lo que Recepción va a ver en la agenda real.
 *
 * SEGURIDAD: todo lleva `meta.tag = demo`. Los pacientes demo tienen MODO
 * AVIÓN (ver `pacienteEsDemo` en src/bots/_shared.ts): los crons reales
 * (recordatorios 48 h/2 h, vencimientos, cobros) van a actuar sobre estos
 * turnos y sus mensajes aparecen en el hilo — pero NADA sale por Twilio ni
 * SES. La limpieza (cron `bw-limpiar-demo` o `--limpiar`) borra todo,
 * solicitudes y avisos incluidos. Con `--hasta`, cada recurso lleva además el
 * tag `demo-hasta` y el cron lo respeta hasta esa fecha (ver src/lib/demo.ts).
 *
 * Correrlo un viernes a la mañana llena viernes + sábado y el domingo (centro
 * cerrado) la limpieza de 48 h se lleva todo: lunes arranca limpio.
 *
 * ⚠️ EFECTO REAL mientras la demo viva: los turnos demo ocupan la agenda DE
 * VERDAD para el sistema — un paciente real que entre al portal ve esas
 * franjas tomadas y sus solicitudes sobre ellas rebotan con "horario ocupado".
 * Al 100 % el centro está lleno; con `--ocupacion` quedan huecos reales.
 * Reportes y Caja también muestran los números demo. Es el precio de la demo
 * en producción: si hace falta cortarla antes, `--limpiar` la borra ya.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Appointment, Coverage, Patient, Slot, Task } from '@medplum/fhirtypes';
import { getServicio } from '../config/catalogo.js';
import { grillaTurnoMin } from '../config/reglas.js';
import { HORARIO_SEMANAL } from '../config/horario.js';
import { MEDICOS, codigoConsulta } from '../config/medicos.js';
import { COD, EXT, SYSTEM, TIPO_AVISO } from '../fhir/identifiers.js';
import { clasificacionDeServicio } from '../fhir/appointment.js';
import { identificadoresDni, nombreLegal } from '../fhir/paciente.js';
import { borrarRecursosDemo, conEsperaDeCuota } from '../bots/_shared.js';
import { metaDemo } from '../lib/demo.js';

const TZ = '-03:00';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/** 'YYYY-MM-DD' en zona Argentina, con offset de días. */
export function fechaAR(offsetDias: number, desde: Date = new Date()): string {
  const d = new Date(desde.getTime() + offsetDias * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(d);
}

// ---------------------------------------------------------------------------
// Parte PURA: el plan de ocupación de un día. Sin FHIR ni red — se testea.
// ---------------------------------------------------------------------------

export interface TurnoPlan {
  recursoCodigo: string;
  servicioCodigo: string;
  inicio: Date;
  fin: Date;
  /** Personas de ESTA reserva (biplaza = 2; multiplaza: una reserva por persona). */
  ocupantes: number;
  status: 'fulfilled' | 'arrived' | 'booked' | 'pending';
  /** Índice de paciente demo (round-robin determinístico). */
  pacienteIdx: number;
  /** Solo consultorio: el médico del turno. */
  practitionerCodigo?: string;
}

interface EspecSala {
  recursoCodigo: string;
  /** Servicios que rotan en la sala (la duración sale del catálogo). */
  servicios: string[];
  /** Personas por reserva (biplaza/gabinetes: la reserva toma todo). */
  ocupantes?: number;
  /** Corrimiento del arranque (R-07: G2 desfasado 30' de G1). */
  offsetMin?: number;
  /** Sesión grupal (Multiplaza): tamaños de tanda que rotan, tope 6. */
  grupal?: number[];
}

/**
 * Una entrada por sala física. El consultorio NO está acá: se llena aparte,
 * solo en las franjas reales de cada médico (`MEDICOS[].agenda`).
 */
const SALAS: EspecSala[] = [
  { recursoCodigo: 'R_HBOT_MONO', servicios: ['HBOT_MONO'] },
  { recursoCodigo: 'R_HBOT_BIPLAZA', servicios: ['HBOT_BIPLAZA'], ocupantes: 2 },
  { recursoCodigo: 'R_HBOT_MULTIPLAZA', servicios: ['HBOT_MULTIPLAZA'], grupal: [5, 3, 6, 4] },
  { recursoCodigo: 'R_IHHT_1', servicios: ['IHHT'] },
  { recursoCodigo: 'R_IHHT_2', servicios: ['IHHT'] },
  { recursoCodigo: 'R_RECOVERY_G1', servicios: ['RECOVERY_PRO'], ocupantes: 2 },
  // R-07: comparte las tumbonas con G1 → arranca 30' corrido, nunca juntos.
  { recursoCodigo: 'R_RECOVERY_G2', servicios: ['RECOVERY_PRO'], ocupantes: 1, offsetMin: 30 },
  { recursoCodigo: 'R_RED_LIGHT', servicios: ['RED_LIGHT'] },
  { recursoCodigo: 'R_IPC06', servicios: ['COMPRESION'] },
  { recursoCodigo: 'R_COT03', servicios: ['CRIO'] },
  { recursoCodigo: 'R_CAMILLA_MASAJES', servicios: ['MASAJE_DEPORTIVO', 'OSTEOPATIA'] },
  { recursoCodigo: 'R_SALA_TB', servicios: ['IV_HIDRATACION', 'IV_NAD', 'IV_PERFORMANCE'] },
  { recursoCodigo: 'R_IV_2', servicios: ['IV_HIDRATACION', 'IV_PERFORMANCE'] },
];

export const CANTIDAD_PACIENTES = 28;

function aFecha(fecha: string, hhmm: string): Date {
  return new Date(`${fecha}T${hhmm}:00${TZ}`);
}

/** Día de semana (0=domingo…6=sábado) de una fecha calendario 'YYYY-MM-DD'. */
function diaSemana(fecha: string): number {
  return new Date(`${fecha}T12:00:00Z`).getUTCDay();
}

export interface OpcionesPlan {
  /**
   * Fracción de la agenda que se ocupa (0–1, default 1 = llena). Con menos de
   * 1, se saltean turnos con un patrón determinista que deja huecos repartidos
   * en todas las salas y franjas: sirve para probar reservas, propuestas del
   * asistente y solicitudes del portal contra una agenda con lugar.
   */
  ocupacion?: number;
}

/** R-22: el próximo arranque válido para un servicio, a partir de un instante. */
function alinearAGrilla(t: Date, grillaMin: number): Date {
  const minutoDelDia = Math.floor((t.getTime() - 3 * 60 * 60_000) / 60_000) % 1440;
  const resto = minutoDelDia % grillaMin;
  return resto === 0 ? t : new Date(t.getTime() + (grillaMin - resto) * 60_000);
}

/**
 * ¿Este turno entra en la demo con la ocupación pedida? Patrón determinista
 * (no aleatorio: la demo tiene que ser reproducible y testeable) que reparte
 * los huecos entre salas y horas en vez de vaciar una punta del día.
 */
function entra(ocupacion: number, salaIdx: number, i: number): boolean {
  const decimas = Math.round(Math.min(1, Math.max(0, ocupacion)) * 10);
  return (i * 7 + salaIdx * 3) % 10 < decimas;
}

/**
 * Plan de ocupación de un día: cada sala encadena sesiones del catálogo de
 * punta a punta del horario real, arrancando en la grilla comercial de cada
 * servicio (R-22: en punto; Recovery Pro también a la media). Estados según el
 * reloj (`ahora`): lo que terminó está completado, lo de ahora mismo "llegó",
 * lo futuro confirmado — con algún tentativo suelto para que la leyenda
 * amarilla también se vea. Con `ocupacion` < 1 quedan huecos.
 */
export function planDia(fecha: string, ahora: Date, opts: OpcionesPlan = {}): TurnoPlan[] {
  const horario = HORARIO_SEMANAL.find((h) => h.dia === diaSemana(fecha));
  if (!horario?.abierto) {
    return [];
  }
  const ocupacion = opts.ocupacion ?? 1;

  const plan: TurnoPlan[] = [];
  let paciente = 0;
  let contadorFuturos = 0;

  const estado = (inicio: Date, fin: Date, permitePendiente: boolean): TurnoPlan['status'] => {
    if (fin.getTime() <= ahora.getTime()) {
      return 'fulfilled';
    }
    if (inicio.getTime() <= ahora.getTime()) {
      return 'arrived';
    }
    contadorFuturos++;
    // Un tentativo cada tanto, nunca en sesiones grupales ni consultas.
    return permitePendiente && contadorFuturos % 11 === 0 ? 'pending' : 'booked';
  };

  for (const [salaIdx, sala] of SALAS.entries()) {
    let iServicio = 0;
    let iTanda = 0;
    let iTurno = 0;
    for (const franja of horario.franjas) {
      let t = new Date(aFecha(fecha, franja.desde).getTime() + (sala.offsetMin ?? 0) * 60_000);
      const cierre = aFecha(fecha, franja.hasta);
      for (;;) {
        const servicioCodigo = sala.servicios[iServicio % sala.servicios.length]!;
        const servicio = getServicio(servicioCodigo);
        // R-22: cada turno arranca en la grilla comercial de SU servicio. Una
        // sesión de 30' deja la media hora siguiente libre: así es la agenda real.
        t = alinearAGrilla(t, grillaTurnoMin(servicio.categoria));
        const fin = new Date(t.getTime() + servicio.duracionMin * 60_000);
        if (fin.getTime() > cierre.getTime()) {
          break;
        }
        const incluir = entra(ocupacion, salaIdx, iTurno++);
        if (incluir && sala.grupal) {
          // Sesión compartida: una reserva POR PERSONA, mismas horas (así la
          // agenda la apila como columna y el aforo se cuenta por personas).
          const personas = sala.grupal[iTanda % sala.grupal.length]!;
          iTanda++;
          const st = estado(t, fin, false);
          for (let p = 0; p < personas; p++) {
            plan.push({
              recursoCodigo: sala.recursoCodigo,
              servicioCodigo,
              inicio: t,
              fin,
              ocupantes: 1,
              status: st,
              pacienteIdx: paciente++ % CANTIDAD_PACIENTES,
            });
          }
        } else if (incluir) {
          plan.push({
            recursoCodigo: sala.recursoCodigo,
            servicioCodigo,
            inicio: t,
            fin,
            ocupantes: sala.ocupantes ?? 1,
            status: estado(t, fin, true),
            pacienteIdx: paciente++ % CANTIDAD_PACIENTES,
          });
        }
        iServicio++;
        t = fin;
      }
    }
  }

  // Consultorio: solo cuando hay médico publicado (agenda real de config).
  let iConsulta = 0;
  for (const medico of MEDICOS) {
    const servicioCodigo = codigoConsulta(medico.codigo);
    const duracionMin = getServicio(servicioCodigo).duracionMin;
    for (const franja of (medico.agenda ?? []).filter((f) => f.dia === diaSemana(fecha))) {
      let t = aFecha(fecha, franja.desde);
      const cierre = aFecha(fecha, franja.hasta);
      while (t.getTime() + duracionMin * 60_000 <= cierre.getTime()) {
        const fin = new Date(t.getTime() + duracionMin * 60_000);
        if (!entra(ocupacion, SALAS.length, iConsulta++)) {
          t = fin;
          continue;
        }
        plan.push({
          recursoCodigo: 'R_CONSULTORIO',
          servicioCodigo,
          inicio: t,
          fin,
          ocupantes: 1,
          status: estado(t, fin, false),
          pacienteIdx: paciente++ % CANTIDAD_PACIENTES,
          practitionerCodigo: medico.codigo,
        });
        t = fin;
      }
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Pacientes demo (datos únicos entre sí: bw-dedup-paciente es una Subscription
// real sobre Patient y teléfonos/DNI repetidos abrirían Tasks de duplicado).
// ---------------------------------------------------------------------------

const NOMBRES: Array<[string, string]> = [
  ['Valentina', 'Ferrari'], ['Martín', 'Aguirre'], ['Camila', 'Bengoa'], ['Julián', 'Paz'],
  ['Renata', 'Sosa'], ['Nicolás', 'Rey'], ['Paula', 'Duarte'], ['Tomás', 'Ortiz'],
  ['Agustina', 'Vidal'], ['Facundo', 'Lema'], ['Malena', 'Iriarte'], ['Bruno', 'Correa'],
  ['Josefina', 'Roldán'], ['Ignacio', 'Vera'], ['Carolina', 'Ríos'], ['Santiago', 'Salas'],
  ['Milagros', 'Funes'], ['Pedro', 'Acosta'], ['Delfina', 'Bruno'], ['Lautaro', 'Gil'],
  ['Antonia', 'Luna'], ['Ramiro', 'Silva'], ['Emilia', 'Torres'], ['Gonzalo', 'Vega'],
  ['Catalina', 'Moro'], ['Federico', 'Ponce'], ['Bianca', 'Sala'], ['Joaquín', 'Nieto'],
];

interface PacienteDemo {
  nombre: string;
  apellido: string;
  dni: string;
  tel: string;
  email: string;
}

export function pacientesDemo(): PacienteDemo[] {
  return NOMBRES.map(([nombre, apellido], i) => ({
    nombre,
    apellido,
    // Rango propio (20.xxx.xxx) para no chocar con datos-demo ni fichas reales.
    dni: String(20_100_000 + i * 111_111),
    tel: `+54911${40_000_000 + i * 11_111}`,
    email: `${nombre.toLowerCase()}.${apellido.toLowerCase()}.demo@example.com`,
  }));
}

// ---------------------------------------------------------------------------
// Bandeja: mensajes entrantes, solicitudes de la web y avisos del sistema.
// ---------------------------------------------------------------------------

/** Mensajes entrantes sin leer (encienden el badge de Mensajes y la campanita). */
const MENSAJES: Array<{ pacienteIdx: number; canal: 'whatsapp' | 'portal'; texto: string }> = [
  { pacienteIdx: 0, canal: 'whatsapp', texto: 'Hola! ¿Puedo pasar mi turno de mañana para más tarde? Me surgió algo del trabajo.' },
  { pacienteIdx: 1, canal: 'whatsapp', texto: '¿Qué precio tiene el paquete de 10 sesiones de cámara hiperbárica?' },
  { pacienteIdx: 2, canal: 'whatsapp', texto: 'Me interesa la membresía PRIME. ¿Me contás cómo es el pago mensual?' },
  { pacienteIdx: 3, canal: 'whatsapp', texto: 'Les mandé el comprobante de la seña por acá, ¿me confirman que llegó?' },
  { pacienteIdx: 4, canal: 'whatsapp', texto: '¿El combo BIO OXYGEN se puede hacer en pareja? Queremos ir el sábado.' },
  { pacienteIdx: 5, canal: 'portal', texto: '¿Tienen turnos de masajes para esta semana? Prefiero después de las 18.' },
  { pacienteIdx: 6, canal: 'portal', texto: 'Quería saber si el chequeo Biowellness incluye la consulta médica.' },
  { pacienteIdx: 7, canal: 'portal', texto: '¿Cómo hago para congelar mi paquete mientras estoy de viaje?' },
];

/** Solicitudes como las que crea `bw-solicitar-turno` desde la web (reserva.html). */
const SOLICITUDES: Array<{
  pacienteIdx: number;
  terapia: string;
  terapiaCodigo?: string;
  /** Horario exacto elegido (offset en días + hora), si eligió uno. */
  preferencia?: { offsetDias: number; hhmm: string };
  preferenciaTexto?: string;
  nota?: string;
}> = [
  { pacienteIdx: 8, terapia: 'Cámara Hiperbárica Monoplaza', terapiaCodigo: 'HBOT_MONO', preferencia: { offsetDias: 2, hhmm: '10:00' } },
  { pacienteIdx: 9, terapia: 'IHHT', terapiaCodigo: 'IHHT', preferenciaTexto: 'Cualquier día después de las 18' },
  { pacienteIdx: 10, terapia: 'Combo BIO OXYGEN', nota: 'Pregunta si el combo se puede pagar en cuotas.' },
  { pacienteIdx: 11, terapia: 'Combo BIO RECOVERY — Pareja', preferenciaTexto: 'Sábado a la mañana', nota: 'Vienen los dos, primera vez.' },
  { pacienteIdx: 12, terapia: 'Membresía PRIME (consulta)', nota: 'Quiere arrancar el mes que viene; pide que la llamen.' },
  { pacienteIdx: 13, terapia: 'Paquete RED LIGHT x10', terapiaCodigo: 'RED_LIGHT', preferenciaTexto: 'Mediodías' },
  { pacienteIdx: 14, terapia: 'Chequeo Biowellness', terapiaCodigo: 'CHEQUEO_BW', preferencia: { offsetDias: 3, hhmm: '17:00' } },
];

// ---------------------------------------------------------------------------
// Generación contra el servidor.
// ---------------------------------------------------------------------------

async function scheduleId(medplum: MedplumClient, recursoCodigo: string): Promise<string | undefined> {
  const sch = await conEsperaDeCuota(() => medplum.searchOne('Schedule', `identifier=${SYSTEM.recursoCodigo}|SCH_${recursoCodigo}`));
  return sch?.id;
}

/** Corre `fn` sobre `items` de a `tamano` en paralelo (crea ~600 recursos/día). */
async function enLotes<T>(items: T[], tamano: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += tamano) {
    await Promise.all(items.slice(i, i + tamano).map(fn));
  }
}

interface OpcionesDemo extends OpcionesPlan {
  /** Fecha civil AR ("YYYY-MM-DD") hasta la que la demo sigue viva (tag `demo-hasta`). */
  hasta?: string;
}

async function generar(medplum: MedplumClient, dias: number, opts: OpcionesDemo = {}): Promise<void> {
  const ahora = new Date();
  const meta = metaDemo(opts.hasta);

  // Cuota FHIR de Medplum: cada escritura cuesta 100 puntos de 50.000/min
  // (500 escrituras/min) y este generador hace ~1.400. TODAS las escrituras
  // pasan por la espera de cuota: cuando el limitador se llena, el script
  // espera lo que el 429 le pide y sigue — no muere a mitad de camino.
  const crear = <T extends Parameters<MedplumClient['createResource']>[0]>(recurso: T) =>
    conEsperaDeCuota(() => medplum.createResource(recurso));

  // Pacientes
  const defs = pacientesDemo();
  const pacientes: Patient[] = [];
  for (const p of defs) {
    pacientes.push(
      await crear<Patient>({
        resourceType: 'Patient',
        meta,
        active: true,
        name: [nombreLegal({ texto: `${p.nombre} ${p.apellido}`, given: p.nombre, family: p.apellido })],
        identifier: identificadoresDni(p.dni),
        telecom: [
          { system: 'phone', value: p.tel, use: 'mobile' },
          { system: 'email', value: p.email },
        ],
        extension: [{ url: EXT.tipoCliente, valueCode: 'PUBLICO' }],
      }),
    );
  }
  console.log(`  • Pacientes: ${pacientes.length}`);

  // Planes: dos socios de membresía y un paquete, para que los modales muestren "con plan".
  const planes: Array<{ idx: number; ext: Coverage['extension'] }> = [
    {
      idx: 0,
      ext: [
        { url: EXT.tipoCobertura, valueCode: 'membresia' },
        { url: EXT.planCodigo, valueString: 'PRIME_STD_IND' },
        { url: EXT.sesionesMes, valueInteger: 8 },
        { url: EXT.sesionesUsadas, valueInteger: 3 },
        { url: EXT.cicloMes, valueString: fechaAR(0).slice(0, 7) },
      ],
    },
    {
      idx: 1,
      ext: [
        { url: EXT.tipoCobertura, valueCode: 'membresia' },
        { url: EXT.planCodigo, valueString: 'FOCUS_STD_IND' },
        { url: EXT.sesionesMes, valueInteger: 8 },
        { url: EXT.sesionesUsadas, valueInteger: 6 },
        { url: EXT.cicloMes, valueString: fechaAR(0).slice(0, 7) },
      ],
    },
    {
      idx: 2,
      ext: [
        { url: EXT.tipoCobertura, valueCode: 'paquete' },
        { url: EXT.planCodigo, valueString: 'PAQ_HBOT_MONO_X10' },
        { url: EXT.sesionesTotal, valueInteger: 10 },
        { url: EXT.sesionesUsadas, valueInteger: 4 },
      ],
    },
  ];
  for (const plan of planes) {
    const p = pacientes[plan.idx]!;
    await crear<Coverage>({
      resourceType: 'Coverage',
      meta,
      status: 'active',
      beneficiary: { reference: `Patient/${p.id}` },
      subscriber: { reference: `Patient/${p.id}` },
      payor: [{ reference: `Patient/${p.id}` }],
      period: { start: `${fechaAR(0)}T00:00:00${TZ}` },
      extension: plan.ext,
    });
  }
  console.log(`  • Planes (Coverage): ${planes.length}`);

  // Banner de seguridad: una contraindicación activa para mostrar el circuito.
  await crear({
    resourceType: 'Flag',
    meta,
    status: 'active',
    category: [{ text: 'Contraindicación' }],
    code: {
      coding: [{ system: SYSTEM.contraindicacion, code: 'HTA_NO_CONTROLADA' }],
      text: 'Contraindicación activa (demo)',
    },
    subject: { reference: `Patient/${pacientes[3]!.id}` },
  });
  console.log('  • Flag de contraindicación: 1');

  // Schedules por recurso (una sola vez).
  const schedules = new Map<string, string>();
  for (const codigo of [...SALAS.map((s) => s.recursoCodigo), 'R_CONSULTORIO']) {
    const sid = await scheduleId(medplum, codigo);
    if (sid) {
      schedules.set(codigo, sid);
    } else {
      console.warn(`  ! ${codigo} sin Schedule: sus turnos se saltean (¿falta npm run seed?)`);
    }
  }
  const practitioners = new Map<string, { id: string; nombre: string }>();
  for (const m of MEDICOS) {
    const pract = await conEsperaDeCuota(() => medplum.searchOne('Practitioner', `identifier=${SYSTEM.medico}|${m.codigo}`));
    if (pract?.id) {
      practitioners.set(m.codigo, { id: pract.id, nombre: pract.name?.[0]?.text ?? m.nombre });
    }
  }

  // Ocupación al 100 % por día.
  for (let d = 0; d < dias; d++) {
    const fecha = fechaAR(d);
    const plan = planDia(fecha, ahora, opts).filter((t) => schedules.has(t.recursoCodigo));
    let creados = 0;
    await enLotes(plan, 5, async (t) => {
      const paciente = pacientes[t.pacienteIdx]!;
      const servicio = getServicio(t.servicioCodigo);
      const slot = await crear<Slot>({
        resourceType: 'Slot',
        meta,
        status: 'busy',
        schedule: { reference: `Schedule/${schedules.get(t.recursoCodigo)}` },
        start: t.inicio.toISOString(),
        end: t.fin.toISOString(),
        // Las MISMAS extensiones que escriben los bots de reserva: la
        // disponibilidad del portal lee los ocupantes del Slot, no del
        // Appointment. Sin `ocupantes` toda reserva pesa 1 persona y una sala
        // compartida se ofrecería con lugares que no tiene.
        extension: [
          { url: EXT.recursoFisico, valueString: t.recursoCodigo },
          { url: EXT.ocupantes, valueInteger: t.ocupantes },
        ],
      });
      const pract = t.practitionerCodigo ? practitioners.get(t.practitionerCodigo) : undefined;
      await crear<Appointment>({
        resourceType: 'Appointment',
        meta,
        status: t.status,
        description: servicio.nombre,
        ...clasificacionDeServicio(t.servicioCodigo),
        start: t.inicio.toISOString(),
        end: t.fin.toISOString(),
        slot: [{ reference: `Slot/${slot.id}` }],
        participant: [
          { actor: { reference: `Patient/${paciente.id}`, display: paciente.name?.[0]?.text }, status: 'accepted' },
          ...(pract ? [{ actor: { reference: `Practitioner/${pract.id}`, display: pract.nombre }, status: 'accepted' as const }] : []),
        ],
        extension: [
          { url: EXT.recursoFisico, valueString: t.recursoCodigo },
          { url: EXT.ocupantes, valueInteger: t.ocupantes },
          { url: EXT.itemTipo, valueCode: 'servicio' },
          { url: EXT.itemCodigo, valueString: t.servicioCodigo },
          // Tentativos con vencimiento REAL adelante: bw-vencer-tentativas los va
          // a procesar como siempre (modo avión: sus avisos no salen del edificio).
          ...(t.status === 'pending'
            ? [{ url: EXT.venceSena, valueDateTime: new Date(ahora.getTime() + 3 * 60 * 60 * 1000).toISOString() }]
            : []),
        ],
      });
      creados++;
    });
    console.log(`  • ${fecha}: ${creados} turnos (con Slot)`);
  }

  // Mensajes entrantes sin leer (sin `received`): badge de Mensajes + campanita.
  for (const [i, m] of MENSAJES.entries()) {
    const p = pacientes[m.pacienteIdx]!;
    await crear({
      resourceType: 'Communication',
      meta,
      status: 'completed',
      // Escalonados hacia atrás para que la bandeja tenga cronología creíble.
      sent: new Date(ahora.getTime() - (i + 1) * 17 * 60_000).toISOString(),
      subject: { reference: `Patient/${p.id}` },
      sender: { reference: `Patient/${p.id}` },
      payload: [{ contentString: m.texto }],
      ...(m.canal === 'whatsapp' ? { extension: [{ url: EXT.canal, valueCode: 'whatsapp' }] } : {}),
    });
  }
  console.log(`  • Mensajes entrantes sin leer: ${MENSAJES.length}`);

  // Solicitudes de turno (mismo shape que bw-solicitar-turno): badge de Solicitudes.
  for (const s of SOLICITUDES) {
    const p = pacientes[s.pacienteIdx]!;
    await crear<Task>({
      resourceType: 'Task',
      meta,
      status: 'requested',
      intent: 'proposal',
      authoredOn: ahora.toISOString(),
      code: { coding: [{ system: SYSTEM.taskTipo, code: COD.solicitudTurno }], text: 'Solicitud de turno' },
      requester: { reference: `Patient/${p.id}` },
      for: { reference: `Patient/${p.id}` },
      description: `${s.terapia}${s.preferenciaTexto ? ` · ${s.preferenciaTexto}` : ''}`,
      input: [
        { type: { text: 'terapia' }, valueString: s.terapia },
        ...(s.terapiaCodigo ? [{ type: { text: 'terapia-codigo' }, valueString: s.terapiaCodigo }] : []),
        ...(s.preferencia
          ? [{ type: { text: 'preferencia-inicio' }, valueDateTime: `${fechaAR(s.preferencia.offsetDias)}T${s.preferencia.hhmm}:00${TZ}` }]
          : []),
        ...(s.preferenciaTexto ? [{ type: { text: 'preferencia-texto' }, valueString: s.preferenciaTexto }] : []),
        ...(s.nota ? [{ type: { text: 'nota' }, valueString: s.nota }] : []),
      ],
    });
  }
  console.log(`  • Solicitudes de turno: ${SOLICITUDES.length}`);

  // Avisos del sistema (vista Avisos + campanita), con el shape real.
  const avisos: Array<Partial<Task> & { titulo: string; detalle: string; tipo?: string; datos?: Record<string, string> }> = [
    {
      titulo: 'WhatsApp de un número desconocido',
      detalle: 'Escribió un número que no coincide con ninguna ficha. Responder por WhatsApp o crear la ficha.',
      tipo: TIPO_AVISO.whatsappDesconocido,
      datos: { telefono: '+5491169998877', texto: 'Hola, ¿tienen turno de crioterapia para hoy a la tarde?' },
    },
    {
      titulo: 'Se liberó un lugar con lista de espera',
      detalle: 'Se canceló Recovery Pro de mañana 10:00 y hay 2 personas en la lista de espera a las que les sirve.',
      tipo: TIPO_AVISO.huecoLiberado,
    },
    {
      titulo: 'Pago sin registro interno',
      detalle: 'MercadoPago acreditó un pago que no matchea con ninguna seña ni cuota pendiente. Revisar en el panel de MP.',
    },
  ];
  for (const [i, a] of avisos.entries()) {
    await crear<Task>({
      resourceType: 'Task',
      meta,
      status: 'requested',
      intent: 'order',
      priority: 'urgent',
      code: { coding: [{ system: SYSTEM.taskTipo, code: COD.avisoRecepcion }], text: a.titulo },
      description: a.detalle,
      authoredOn: new Date(ahora.getTime() - (i + 1) * 23 * 60_000).toISOString(),
      identifier: [{ system: SYSTEM.task, value: `demo-aviso-${i}` }],
      input: [
        ...(a.tipo ? [{ type: { text: 'tipo' }, valueString: a.tipo }] : []),
        ...Object.entries(a.datos ?? {}).map(([k, v]) => ({ type: { text: k }, valueString: v })),
      ],
    });
  }
  console.log(`  • Avisos del sistema: ${avisos.length}`);

  // Cobros del día (Invoice balanced) para que Reportes y Caja se vean vivos.
  const cobros = [
    { idx: 0, desc: 'Cuota membresía PRIME STANDARD', ars: 1_905_000, medio: 'mercadopago' },
    { idx: 2, desc: 'Seña 50% · HBOT Monoplaza', ars: 119_625, medio: 'mercadopago' },
    { idx: 4, desc: 'Combo BIO OXYGEN', ars: 290_000, medio: 'tarjeta-credito' },
    { idx: 5, desc: 'Red Light — sesión', ars: 72_500, medio: 'efectivo' },
    { idx: 6, desc: 'Consulta médica', ars: 120_000, medio: 'transferencia' },
    { idx: 7, desc: 'Seña 50% · IHHT', ars: 65_250, medio: 'mercadopago' },
  ];
  for (const c of cobros) {
    await crear({
      resourceType: 'Invoice',
      meta,
      status: 'balanced',
      date: ahora.toISOString(),
      subject: { reference: `Patient/${pacientes[c.idx]!.id}` },
      lineItem: [
        { chargeItemCodeableConcept: { text: c.desc }, priceComponent: [{ type: 'base', amount: { value: c.ars, currency: 'ARS' } }] },
      ],
      totalGross: { value: c.ars, currency: 'ARS' },
      extension: [
        { url: EXT.esSena, valueBoolean: c.desc.startsWith('Seña') },
        { url: EXT.medioPago, valueString: c.medio },
        { url: EXT.tcAplicado, valueDecimal: 1450 },
      ],
    });
  }
  console.log(`  • Cobros (Invoice): ${cobros.length}`);
}

function imprimirPlan(dias: number, opts: OpcionesPlan): void {
  const ahora = new Date();
  for (let d = 0; d < dias; d++) {
    const fecha = fechaAR(d);
    const plan = planDia(fecha, ahora, opts);
    const porSala = new Map<string, number>();
    for (const t of plan) {
      porSala.set(t.recursoCodigo, (porSala.get(t.recursoCodigo) ?? 0) + 1);
    }
    console.log(`\n${fecha} — ${plan.length} turnos${plan.length === 0 ? ' (cerrado)' : ''}`);
    for (const [sala, n] of [...porSala.entries()].sort()) {
      console.log(`  ${sala.padEnd(22)} ${n}`);
    }
  }
  console.log(`\nAdemás: ${MENSAJES.length} mensajes · ${SOLICITUDES.length} solicitudes · 3 avisos · 6 cobros · ${CANTIDAD_PACIENTES} pacientes`);
}

/** Días calendario desde hoy (AR) hasta `hastaISO`, ambos incluidos. */
export function diasHasta(hastaISO: string, desde: Date = new Date()): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hastaISO)) {
    throw new Error(`--hasta tiene que ser una fecha "YYYY-MM-DD": ${hastaISO}`);
  }
  const hoy = new Date(`${fechaAR(0, desde)}T00:00:00Z`).getTime();
  const hasta = new Date(`${hastaISO}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((hasta - hoy) / 86_400_000) + 1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valor = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const hasta = valor('--hasta');
  const dias = hasta ? diasHasta(hasta) : Math.max(1, Number(valor('--dias')) || 2);
  const ocupacionArg = valor('--ocupacion');
  const ocupacion = ocupacionArg === undefined ? 1 : Number(ocupacionArg);
  if (!(ocupacion > 0 && ocupacion <= 1)) {
    throw new Error(`--ocupacion tiene que ser un número entre 0 y 1 (fracción de la agenda): ${ocupacionArg}`);
  }
  const opts: OpcionesDemo = { ocupacion, ...(hasta ? { hasta } : {}) };

  if (args.includes('--dry-run')) {
    console.log(`Plan de ocupación al ${Math.round(ocupacion * 100)} % (sin conectarse al servidor):`);
    imprimirPlan(dias, opts);
    return;
  }

  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));

  if (args.includes('--limpiar')) {
    const r = await borrarRecursosDemo(medplum);
    console.log(`Limpieza demo (todo): ${r.borrados} recursos`, r.porTipo);
    return;
  }

  console.log('Limpiando datos demo previos…');
  const prev = await borrarRecursosDemo(medplum);
  console.log(`  borrados: ${prev.borrados}`);
  const vida = hasta ? `viva hasta el ${hasta}` : 'se autodestruye a las 48 h';
  console.log(`Generando ocupación al ${Math.round(ocupacion * 100)} % (${dias} día(s), ${vida}):`);
  await generar(medplum, dias, opts);
  console.log(
    `\n✓ Demo de ocupación cargada. ${hasta ? `bw-limpiar-demo la respeta hasta el ${hasta} y la borra después` : 'Se borra sola a las 48 h (bw-limpiar-demo)'}, o antes con: npm run demo:ocupacion -- --limpiar`,
  );
}

// El import de tests no debe ejecutar el CLI.
if (process.argv[1]?.endsWith('demo-ocupacion.ts')) {
  main().catch((err) => {
    console.error('demo-ocupacion falló:', err);
    process.exitCode = 1;
  });
}
