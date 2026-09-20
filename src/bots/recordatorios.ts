/**
 * Bot · Recordatorios automáticos de turnos (cron, 48 h y 2 h).
 *
 * Pensado para ejecutarse seguido (cronString, p. ej. cada 30 min). Busca los
 * turnos CONFIRMADOS (`booked`) que arrancan dentro de la ventana máxima (48 h) y,
 * para cada uno, manda el recordatorio que corresponda (48 h → 2 h) por WhatsApp.
 *
 * - Idempotente: registra cada recordatorio como `Communication` con un identifier
 *   único (`recordatorio-{tipo}-{grupo}`); si ya existe, no reenvía.
 * - Combos: un solo recordatorio por combo (el componente que arranca primero),
 *   no uno por cada sesión.
 *
 * La decisión de "qué recordatorio toca" vive en `src/lib/recordatorios.ts` (pura).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment } from '@medplum/fhirtypes';
import { SYSTEM } from '../fhir/identifiers.js';
import { modalidadDeTurno, practitionerCodigoDeTurno } from '../fhir/appointment.js';
import { PORTAL_URL } from '../lib/onboarding.js';
import { avisoProfesionalRecordatorio, emailRecordatorioTeleconsulta, rutaTeleconsulta } from '../lib/teleconsulta.js';
import { recordatorioDue, VENTANA_MAX_MS, type TipoRecordatorio } from '../lib/recordatorios.js';
import { avisarProfesional, dashboardUrl, enviarEmail, enviarWhatsApp, nombrePacienteParaAviso, notificarPortal } from './_shared.js';

export interface EntradaRecordatorios {
  /** Fecha de referencia ISO (default: ahora). Útil para pruebas/reprocesos. */
  ahora?: string;
}

export interface ResultadoRecordatorios {
  ok: boolean;
  /** Recordatorios de 48 h enviados en esta corrida. */
  enviados48: number;
  /** Recordatorios de 2 h enviados en esta corrida. */
  enviados2: number;
  /** Turnos/combos que ya tenían el recordatorio (se omiten). */
  omitidos: number;
}

const fmtFechaHora = new Intl.DateTimeFormat('es-AR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});
const fmtHora = new Intl.DateTimeFormat('es-AR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});

function cuerpo(tipo: TipoRecordatorio, descripcion: string, inicio: Date, linkSala?: string): string {
  if (tipo === '2h') {
    // Virtual: el de 2 h es el mensaje que TRAE el link. Es el único momento en
    // que el paciente recibe por dónde entrar, así que además le pide probar
    // cámara y micrófono — descubrir que el micrófono no anda a la hora en punto
    // es perder la consulta entera.
    if (linkSala) {
      return (
        `Biowellness: ¡tu videollamada de ${descripcion} es hoy a las ${fmtHora.format(inicio)}! ` +
        `Entrá desde acá: ${linkSala} — podés entrar 15 minutos antes para probar cámara y micrófono.`
      );
    }
    return `Biowellness: ¡tu turno de ${descripcion} es hoy a las ${fmtHora.format(inicio)}! Te esperamos en un rato.`;
  }
  if (linkSala) {
    return `Biowellness: te recordamos tu videollamada de ${descripcion} el ${fmtFechaHora.format(inicio)}. El link para entrar te lo mandamos 2 horas antes.`;
  }
  return `Biowellness: te recordamos tu turno de ${descripcion} el ${fmtFechaHora.format(inicio)}. ¡Te esperamos!`;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaRecordatorios>,
): Promise<ResultadoRecordatorios> {
  const ahora = event.input?.ahora ? new Date(event.input.ahora) : new Date();
  const fin = new Date(ahora.getTime() + VENTANA_MAX_MS);

  const turnos = await medplum.searchResources(
    'Appointment',
    `status=booked&date=ge${ahora.toISOString()}&date=le${fin.toISOString()}&_count=500`,
  );

  // Un recordatorio por turno o por combo: nos quedamos con el que arranca primero.
  const grupos = new Map<string, Appointment>();
  for (const t of turnos) {
    if (!t.start || !t.id) {
      continue;
    }
    const comboId = t.identifier?.find((i) => i.system === SYSTEM.comboCodigo)?.value;
    const groupId = comboId ?? t.id;
    const actual = grupos.get(groupId);
    if (!actual || (actual.start && t.start < actual.start)) {
      grupos.set(groupId, t);
    }
  }

  let enviados48 = 0;
  let enviados2 = 0;
  let omitidos = 0;
  for (const [groupId, appt] of grupos) {
    const inicio = new Date(appt.start!);
    const tipo = recordatorioDue(inicio, ahora);
    if (!tipo) {
      continue;
    }

    // Idempotencia: un recordatorio por (tipo, grupo).
    const key = `recordatorio-${tipo}-${groupId}`;
    const existente = await medplum.searchOne('Communication', `identifier=${SYSTEM.communication}|${key}`);
    if (existente) {
      omitidos++;
      continue;
    }

    const pacienteRef = appt.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    const descripcion = (appt.description ?? 'tu turno').split(' · ')[0] ?? 'tu turno';

    // Videollamada: el link va SIEMPRE al portal, nunca a la sala de Jitsi. La
    // sala solo se abre con un token que se emite a pedido y que caduca; un link
    // directo por WhatsApp sería un link que no funciona, y encima reenviable.
    const esVirtual = modalidadDeTurno(appt) === 'virtual';
    const linkSala = esVirtual ? `${PORTAL_URL}${rutaTeleconsulta(appt.id!)}` : undefined;
    const texto = cuerpo(tipo, descripcion, inicio, linkSala);

    await enviarWhatsApp(medplum, event.secrets, {
      // Las plantillas aprobadas de recordatorio dicen "turno" y no llevan link.
      // Para las videollamadas se usa un nombre SIN secret cargado, que cae a la
      // genérica con el cuerpo entero (mismo camino que `reserva-tentativa`).
      template: esVirtual ? `recordatorio-${tipo}-virtual` : `recordatorio-${tipo}`,
      identifier: { system: SYSTEM.communication, value: key },
      pacienteRef,
      // Plantillas: {{1}} servicio · {{2}} hora (2h) / fecha y hora (48h).
      variables: [descripcion, tipo === '2h' ? fmtHora.format(inicio) : fmtFechaHora.format(inicio)],
      body: texto,
    });

    // Campanita del portal (misma idempotencia que el WhatsApp, con su propia
    // clave). El de 2 h de una videollamada va con su tipo propio: es el que el
    // portal manda a la sala y el que el web push titula "Tu videollamada".
    await notificarPortal(medplum, {
      tipo: esVirtual && tipo === '2h' ? 'teleconsulta-lista' : 'recordatorio',
      pacienteRef,
      about: `Appointment/${appt.id}`,
      identifier: { system: SYSTEM.communication, value: `portal-${key}` },
      texto,
    });

    // Email, SOLO para la videollamada de 2 h. Una consulta por video sale
    // mejor en una computadora, y el WhatsApp llega al teléfono: el email es el
    // canal que lleva el link a la pantalla donde conviene atenderse. Para un
    // turno presencial no agrega nada —el paciente viene igual— y sumar un
    // canal por las dudas es ruido que después nadie apaga.
    //
    // Best-effort: el WhatsApp y la campanita ya salieron. Que SES falle no
    // puede dejar el recordatorio sin mandar, y la guardia de idempotencia de
    // arriba cubre todo el bloque.
    if (esVirtual && tipo === '2h' && linkSala) {
      const mail = emailRecordatorioTeleconsulta({
        hora: fmtHora.format(inicio),
        servicio: descripcion,
        link: linkSala,
      });
      await enviarEmail(medplum, {
        asunto: mail.asunto,
        cuerpo: mail.cuerpo,
        template: 'recordatorio-2h-virtual',
        pacienteRef,
        about: `Appointment/${appt.id}`,
      }).catch(() => undefined);
    }

    // Al PROFESIONAL, solo el de 2 h (Andrés, 2026-09-20): el de 48 h existe
    // para que el paciente se organice; al médico le alcanza con el del día,
    // con el acceso a su Dashboard. Best-effort e idempotente por su propia
    // clave, como todo lo de arriba.
    const practitionerCodigo = practitionerCodigoDeTurno(appt);
    if (tipo === '2h' && practitionerCodigo) {
      await avisarProfesional(medplum, event.secrets, {
        practitionerCodigo,
        clave: `recordatorio-2h-prof-${groupId}`,
        template: 'profesional-recordatorio-2h',
        about: `Appointment/${appt.id}`,
        aviso: avisoProfesionalRecordatorio({
          paciente: await nombrePacienteParaAviso(medplum, pacienteRef),
          hora: fmtHora.format(inicio),
          servicio: descripcion,
          modalidad: esVirtual ? 'virtual' : 'presencial',
          link: dashboardUrl(event.secrets),
        }),
      }).catch(() => undefined);
    }

    if (tipo === '2h') {
      enviados2++;
    } else {
      enviados48++;
    }
  }

  return { ok: true, enviados48, enviados2, omitidos };
}
