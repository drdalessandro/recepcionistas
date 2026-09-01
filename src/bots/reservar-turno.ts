/**
 * Bot · Reservar turno.
 *
 * Valida un turno propuesto (R-02 contraindicaciones, R-03 prescripción, R-07
 * capacidad/desfasaje, R-13 ventana) y, si está OK, crea el Appointment + un Slot
 * ocupado (para que la agenda lo refleje). Toda la decisión vive acá; el front
 * solo manda la propuesta.
 *
 * Alcance de este slice: un servicio por turno (los combos con secuencia vienen
 * después). La prescripción de IV/TB se pasa explícita hasta modelar ServiceRequest.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, AppointmentParticipant, Slot } from '@medplum/fhirtypes';
import type { Servicio } from '../domain/types.js';
import { getServicio, nombreServicioRecepcion } from '../config/catalogo.js';
import type { PerfilReserva } from '../config/reglas.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { clasificacionDeServicio } from '../fhir/appointment.js';
import { aptitudDePaciente, cargarReservasDelDia, consumirSesionDePlan, enviarWhatsApp, extraerCodigos, linkSena, resolverSolicitudTurno, scheduleIdDeRecurso, tieneBloqueoPago, type ConsumoPlan } from './_shared.js';
import { vencimientoSena } from '../lib/sena.js';

const fmtFechaHora = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});
const fmtHoraCorta = new Intl.DateTimeFormat('es-AR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});
import {
  combinar,
  recomendarHbotPrevio,
  validarBloqueoAdministrativo,
  validarContraindicaciones,
  validarMinimoGrupal,
  validarAptitudPaciente,
  validarConsentimientoTB,
  validarPrescripcion,
  validarRecursos,
  validarVentanaReserva,
  type ReservaRecurso,
  type ResultadoValidacion,
} from '../lib/reglas-turno.js';
import { RECURSOS_POR_CODIGO } from '../config/recursos.js';

export interface EntradaReserva {
  pacienteRef: string; // "Patient/123"
  servicioCodigo: string;
  recursoCodigo: string;
  /** Inicio del turno en ISO (con offset de Argentina). */
  inicio: string;
  ocupantes?: number;
  /** Perfil para la ventana de reserva (R-13). Si se omite, no se limita. */
  perfil?: PerfilReserva;
  /** IV/TB: prescripción activa (hasta modelar ServiceRequest). */
  prescripcionActiva?: boolean;
  /** TB: consentimiento informado firmado (el documento vive en la HC, no acá). */
  consentimientoFirmado?: boolean;
  /**
   * De dónde salió esa afirmación: `portal` = verificada contra el Consent que
   * firmó el paciente; `declarado-recepcion` = lo declaró el mostrador (firma
   * en papel). Queda en el Appointment: sin esto, ante un reclamo médico-legal
   * por una TB no hay forma de reconstruir quién dijo que había consentimiento.
   */
  origenConsentimiento?: 'portal' | 'declarado-recepcion';
  /** Autorización médica que destraba una contraindicación absoluta (R-02). */
  autorizacionMedica?: boolean;
  /** Coverage (paquete) con el que se paga el turno: consume una sesión y confirma sin seña. */
  coverageId?: string;
  /** Si es false, solo valida (no crea). Default true. */
  confirmar?: boolean;
}

export interface ResultadoReserva extends ResultadoValidacion {
  creado: boolean;
  appointmentId?: string;
  slotId?: string;
  /** Si se usó un plan: sesiones restantes tras consumir esta. */
  planRestantes?: number;
}

export interface ContextoReserva {
  servicio: Servicio;
  inicio: Date;
  fin: Date;
  recursoCodigo: string;
  /** Personas de esta reserva (biplaza 1-2, multiplaza 1-6). Default 1. */
  ocupantes?: number;
  contraindicacionesActivas: string[];
  prescripcionActiva: boolean;
  /** TB: hay consentimiento informado firmado (R-03). */
  consentimientoFirmado: boolean;
  /** R-20: firmó el consentimiento GENERAL. `undefined` = no verificable (bloquea). */
  consentimientoGeneralFirmado?: boolean;
  /** R-20: completó el cuestionario de ingreso. `undefined` = no verificable (bloquea). */
  screeningCompleto?: boolean;
  autorizacionMedica: boolean;
  /** Turnos ya ocupados (de hoy), de todos los recursos, para capacidad/desfasaje. */
  reservasExistentes: ReservaRecurso[];
  perfil?: PerfilReserva;
  /** R-11: el paciente tiene un bloqueo administrativo por pago rechazado. */
  bloqueoAdministrativo?: boolean;
  ahora: Date;
}

/** Validación pura de una reserva (sin FHIR). Reúne las reglas aplicables. */
export function validarReserva(ctx: ContextoReserva): ResultadoValidacion {
  const partes: ResultadoValidacion[] = [];

  // No se puede reservar en el pasado.
  if (ctx.inicio.getTime() <= ctx.ahora.getTime()) {
    partes.push({
      ok: false,
      bloqueos: [{ regla: 'R-13', nivel: 'bloqueo', mensaje: 'El turno está en el pasado.' }],
      advertencias: [],
    });
  }

  partes.push(validarPrescripcion(ctx.servicio, ctx.prescripcionActiva));
  partes.push(validarConsentimientoTB(ctx.servicio, ctx.consentimientoFirmado));
  // R-20 · sin consentimiento general firmado y sin cuestionario de ingreso no
  // se reserva NINGUNA terapia. Sin override: decisión de Andrés (2026-08-14).
  partes.push(
    validarAptitudPaciente({
      consentimientoGeneralFirmado: ctx.consentimientoGeneralFirmado,
      screeningCompleto: ctx.screeningCompleto,
    }),
  );
  partes.push(recomendarHbotPrevio(ctx.servicio.categoria, false));
  partes.push(
    validarContraindicaciones([ctx.servicio.categoria], ctx.contraindicacionesActivas, {
      autorizacionMedica: ctx.autorizacionMedica,
    }),
  );

  const ocupantes = ctx.ocupantes ?? 1;
  const capacidad = RECURSOS_POR_CODIGO.get(ctx.recursoCodigo)?.capacidad ?? 1;
  if (ocupantes > capacidad) {
    partes.push({
      ok: false,
      bloqueos: [{ regla: 'R-07', nivel: 'bloqueo', mensaje: `El recurso ${ctx.recursoCodigo} admite hasta ${capacidad} personas por reserva.` }],
      advertencias: [],
    });
  }

  const nueva: ReservaRecurso = { recursoCodigo: ctx.recursoCodigo, inicio: ctx.inicio, fin: ctx.fin, ocupantes };
  partes.push(validarRecursos([...ctx.reservasExistentes, nueva]));
  // Mínimo operativo de sesiones grupales (Multiplaza 3): advierte, no bloquea.
  partes.push(validarMinimoGrupal([...ctx.reservasExistentes, nueva], nueva));

  if (ctx.perfil) {
    partes.push(validarVentanaReserva(ctx.perfil, ctx.ahora, ctx.inicio));
  }

  partes.push(validarBloqueoAdministrativo(ctx.bloqueoAdministrativo ?? false));

  return combinar(...partes);
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaReserva>,
): Promise<ResultadoReserva> {
  const e = event.input;
  const servicio = getServicio(e.servicioCodigo);
  const inicio = new Date(e.inicio);
  const fin = new Date(inicio.getTime() + servicio.duracionMin * 60_000);
  const ahora = new Date();

  // Contraindicaciones activas del paciente (Flags).
  const flags = await medplum.searchResources('Flag', `subject=${e.pacienteRef}&status=active`);

  // Turnos ocupados de hoy (todos los recursos) para capacidad/desfasaje.
  const reservasExistentes = await cargarReservasDelDia(medplum, inicio);

  // R-20 · consentimiento general + cuestionario de ingreso. Se lee en el server,
  // no se recibe del input: es una regla de seguridad, no puede depender de lo
  // que afirme quien llama al bot.
  const aptitud = await aptitudDePaciente(medplum, e.pacienteRef);

  // R-02 sobre Flags Y sobre lo DECLARADO en el screening: una respuesta de
  // riesgo del cuestionario cuenta como contraindicación (con la severidad de
  // la tabla validada) aunque ningún proceso la haya cargado como Flag. Sin
  // esto, declarar un neumotórax no tratado dejaba reservar HBOT igual.
  const contraindicacionesActivas = [...flags.flatMap(extraerCodigos), ...(aptitud.contraindicacionesDeclaradas ?? [])];

  const resultado = validarReserva({
    servicio,
    inicio,
    fin,
    recursoCodigo: e.recursoCodigo,
    ocupantes: e.ocupantes,
    contraindicacionesActivas,
    prescripcionActiva: e.prescripcionActiva ?? false,
    consentimientoFirmado: e.consentimientoFirmado ?? false,
    ...aptitud,
    autorizacionMedica: e.autorizacionMedica ?? false,
    reservasExistentes,
    perfil: e.perfil,
    bloqueoAdministrativo: tieneBloqueoPago(flags),
    ahora,
  });

  if (!resultado.ok || e.confirmar === false) {
    return { ...resultado, creado: false };
  }

  // Crear Slot ocupado + Appointment.
  const scheduleId = await scheduleIdDeRecurso(medplum, e.recursoCodigo);
  if (!scheduleId) {
    return {
      ok: false,
      bloqueos: [{ regla: 'R-07', nivel: 'bloqueo', mensaje: `El recurso ${e.recursoCodigo} no tiene agenda (Schedule).` }],
      advertencias: resultado.advertencias,
      creado: false,
    };
  }

  // Si se paga con un plan (paquete): consumir una sesión antes de crear (R-10).
  let consumo: ConsumoPlan | undefined;
  if (e.coverageId) {
    try {
      consumo = await consumirSesionDePlan(medplum, e.coverageId, { tipo: 'servicio', codigo: e.servicioCodigo }, ahora);
    } catch (err) {
      return {
        ok: false,
        bloqueos: [{ regla: 'R-10', nivel: 'bloqueo', mensaje: (err as Error).message }],
        advertencias: resultado.advertencias,
        creado: false,
      };
    }
  }

  const slot: Slot = await medplum.createResource<Slot>({
    resourceType: 'Slot',
    status: 'busy',
    schedule: { reference: `Schedule/${scheduleId}` },
    start: inicio.toISOString(),
    end: fin.toISOString(),
    extension: [
      { url: EXT.recursoFisico, valueString: e.recursoCodigo },
      { url: EXT.ocupantes, valueInteger: e.ocupantes ?? 1 },
    ],
  });

  const participant: AppointmentParticipant[] = [{ actor: { reference: e.pacienteRef }, status: 'accepted' }];
  const slotRefs = [{ reference: `Slot/${slot.id}` }];
  // Consultas: sumar al médico como participante (un consultorio, varios médicos).
  if (servicio.practitionerCodigo) {
    const pract = await medplum.searchOne('Practitioner', `identifier=${SYSTEM.medico}|${servicio.practitionerCodigo}`);
    if (pract?.id) {
      participant.push({
        actor: { reference: `Practitioner/${pract.id}`, display: pract.name?.[0]?.text },
        status: 'accepted',
      });
    }
    // Agenda PUBLICADA del médico (portal): si su Schedule tiene un Slot libre
    // en este horario, pasa a busy y viaja en appointment.slot — así el horario
    // desaparece del portal (sin esto habría dobles reservas) y cancelar o
    // completar lo libera solo (los flujos existentes recorren appointment.slot).
    const schMedico = await medplum.searchOne(
      'Schedule',
      `identifier=${SYSTEM.recursoCodigo}|SCH_${servicio.practitionerCodigo}`,
    );
    if (schMedico?.id) {
      const slotMedico = await medplum.searchOne(
        'Slot',
        `schedule=Schedule/${schMedico.id}&start=${inicio.toISOString()}&status=free`,
      );
      if (slotMedico?.id) {
        await medplum.updateResource<Slot>({ ...slotMedico, status: 'busy' });
        slotRefs.push({ reference: `Slot/${slotMedico.id}` });
      }
    }
  }

  // Con plan: turno CONFIRMADO (la sesión ya está paga). Sin plan: TENTATIVO
  // hasta cobrar la seña del 50%, con vencimiento (R-19): si la seña no llega
  // a tiempo, bw-vencer-tentativas libera el lugar.
  const vence = vencimientoSena(ahora, inicio);
  const appointment: Appointment = await medplum.createResource<Appointment>({
    resourceType: 'Appointment',
    status: consumo ? 'booked' : 'pending',
    description: nombreServicioRecepcion(servicio),
    // Qué se HACE, en los campos nativos de FHIR (el Panel Bio cuenta acá).
    ...clasificacionDeServicio(e.servicioCodigo),
    start: inicio.toISOString(),
    end: fin.toISOString(),
    slot: slotRefs,
    participant,
    extension: [
      { url: EXT.recursoFisico, valueString: e.recursoCodigo },
      { url: EXT.ocupantes, valueInteger: e.ocupantes ?? 1 },
      { url: EXT.itemTipo, valueCode: 'servicio' },
      { url: EXT.itemCodigo, valueString: e.servicioCodigo },
      // R-03: en las TB queda registrado de dónde salió la afirmación del
      // consentimiento (verificado en el portal vs declarado en el mostrador).
      // El `meta.author` del Appointment dice QUIÉN lo cargó; esto, sobre qué.
      ...(servicio.categoria === 'TERAPIA_BIOLOGICA' && e.consentimientoFirmado
        ? [{ url: EXT.consentimientoOrigen, valueCode: e.origenConsentimiento ?? 'declarado-recepcion' }]
        : []),
      ...(consumo
        ? [{ url: EXT.coberturaUsada, valueString: `Coverage/${e.coverageId}` }]
        : [{ url: EXT.venceSena, valueDateTime: vence.toISOString() }]),
    ],
  });

  // La solicitud de turno pendiente del paciente (si la hay) queda resuelta sola.
  await resolverSolicitudTurno(medplum, e.pacienteRef, [e.servicioCodigo, servicio.categoria], `Appointment/${appointment.id}`);

  if (consumo) {
    await enviarWhatsApp(medplum, event.secrets, {
      template: 'reserva-plan',
      pacienteRef: e.pacienteRef,
      // Plantilla: {{1}} servicio · {{2}} fecha/hora · {{3}} sesiones restantes.
      variables: [nombreServicioRecepcion(servicio), fmtFechaHora.format(inicio), String(consumo.restantes)],
      body: `Biowellness: ¡tu turno de ${nombreServicioRecepcion(servicio)} quedó confirmado con tu plan para el ${fmtFechaHora.format(inicio)}! Te quedan ${consumo.restantes} sesiones. ¡Te esperamos!`,
    });
  } else {
    // Seña autoservicio (R-19): monto + link de pago + vencimiento en el mismo
    // mensaje. Si MP no está configurado, el mensaje sale igual sin link.
    // SIN variables a propósito: este mensaje viaja por la plantilla GENÉRICA
    // aprobada ({{1}} = cuerpo entero) tras 10 rechazos de Meta a una propia.
    // No cargar nunca el secret TWILIO_CONTENT_SID_RESERVA_TENTATIVA
    // (ver src/seed/crear-plantillas.ts).
    const link = await linkSena(medplum, event.secrets, appointment).catch(() => undefined);
    const monto = link ? `$${link.senaARS.toLocaleString('es-AR')}` : 'del 50%';
    await enviarWhatsApp(medplum, event.secrets, {
      template: 'reserva-tentativa',
      pacienteRef: e.pacienteRef,
      body: `Reservamos tu turno de ${nombreServicioRecepcion(servicio)} para el ${fmtFechaHora.format(inicio)}. Para confirmarlo aboná la seña de ${monto}${
        link?.url ? ` acá: ${link.url}` : ' (recepción te pasa el medio de pago)'
      } — tenés tiempo hasta las ${fmtHoraCorta.format(vence)}; después el lugar se libera.`,
    });
  }

  return {
    ...resultado,
    creado: true,
    appointmentId: appointment.id,
    slotId: slot.id,
    ...(consumo ? { planRestantes: consumo.restantes } : {}),
  };
}
