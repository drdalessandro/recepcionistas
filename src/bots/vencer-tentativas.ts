/**
 * Bot · Vencimiento de tentativas (cron, R-19 "seña autoservicio").
 *
 * Pensado para ejecutarse seguido (cronTiming, p. ej. cada 10 min). Recorre los
 * turnos TENTATIVOS (`pending`) con vencimiento de seña (`vence-sena`) y:
 *
 *  - **Recordatorio**: si falta menos que la ventana de aviso y todavía no pagó,
 *    manda UN último WhatsApp con el mismo link de pago (idempotente por
 *    Communication `sena-recordatorio-{grupo}`).
 *  - **Vencida**: cancela el/los turno(s) (combos: todos los componentes),
 *    libera las salas (Slot → free) y avisa al paciente (WhatsApp + campanita
 *    del portal) que el lugar se liberó.
 *
 * Antes de cancelar relee cada turno (si la seña entró entre la búsqueda y el
 * tick, ya no está `pending` y no se toca). El pago que llega DESPUÉS de la
 * liberación no confirma nada: `confirmarReserva` lo rechaza y alerta a
 * Recepción para devolver o reagendar.
 *
 * Las tentativas viejas sin `vence-sena` (anteriores a la regla) no se tocan.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment } from '@medplum/fhirtypes';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { estadoSenaPendiente } from '../lib/sena.js';
import { enviarWhatsApp, linkSena, notificarPortal } from './_shared.js';

export interface EntradaVencerTentativas {
  /** Fecha de referencia ISO (default: ahora). Útil para pruebas/reprocesos. */
  ahora?: string;
}

export interface ResultadoVencerTentativas {
  ok: boolean;
  /** Reservas (turnos o combos) liberadas por seña vencida. */
  liberadas: number;
  /** Recordatorios de último aviso enviados. */
  recordatorios: number;
  /** Tentativas que siguen dentro de su ventana (no se tocan). */
  vigentes: number;
}

const fmtFechaHora = new Intl.DateTimeFormat('es-AR', {
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

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaVencerTentativas>,
): Promise<ResultadoVencerTentativas> {
  const ahora = event.input?.ahora ? new Date(event.input.ahora) : new Date();

  const pendientes = await medplum.searchResources('Appointment', 'status=pending&_count=500');

  // Un vencimiento por reserva: los componentes de un combo comparten grupo
  // (mismo criterio que los recordatorios de turnos).
  const grupos = new Map<string, Appointment[]>();
  for (const t of pendientes) {
    if (!t.id) {
      continue;
    }
    const comboId = t.identifier?.find((i) => i.system === SYSTEM.comboCodigo)?.value;
    const key = comboId ?? t.id;
    grupos.set(key, [...(grupos.get(key) ?? []), t]);
  }

  let liberadas = 0;
  let recordatorios = 0;
  let vigentes = 0;
  for (const [groupId, turnos] of grupos) {
    const ordenados = [...turnos].sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
    const rep = ordenados[0];
    const venceIso = rep?.extension?.find((x) => x.url === EXT.venceSena)?.valueDateTime;
    if (!rep?.id || !venceIso) {
      continue; // tentativa anterior a la regla: la gestiona Recepción a mano
    }
    const vence = new Date(venceIso);
    const estado = estadoSenaPendiente(vence, ahora);
    if (estado === 'vigente') {
      vigentes++;
      continue;
    }

    const pacienteRef = rep.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    const descripcion = (rep.description ?? 'tu turno').split(' · ')[0] ?? 'tu turno';
    const cuando = rep.start ? fmtFechaHora.format(new Date(rep.start)) : '';

    if (estado === 'recordatorio') {
      // Último aviso, una sola vez por reserva.
      const clave = `sena-recordatorio-${groupId}`;
      const ya = await medplum.searchOne('Communication', `identifier=${SYSTEM.communication}|${clave}`);
      if (ya) {
        continue;
      }
      const link = await linkSena(medplum, event.secrets, rep).catch(() => undefined);
      const monto = link ? `$${link.senaARS.toLocaleString('es-AR')}` : 'del 50%';
      await enviarWhatsApp(medplum, event.secrets, {
        template: 'sena-recordatorio',
        identifier: { system: SYSTEM.communication, value: clave },
        pacienteRef,
        // Plantilla: {{1}} servicio · {{2}} fecha/hora · {{3}} hora límite ·
        // {{4}} monto · {{5}} link (docs/whatsapp-plantillas.md).
        variables: [descripcion, cuando, fmtHora.format(vence), monto, link?.url ?? 'coordinándolo con recepción'],
        body: `BioWellness: ¡último aviso! Tu reserva de ${descripcion} (${cuando}) se libera a las ${fmtHora.format(vence)} si no abonás la seña de ${monto}${
          link?.url ? `. Pagala acá: ${link.url}` : ' (recepción te pasa el medio de pago)'
        } y quedás confirmado. 💚`,
      });
      recordatorios++;
      continue;
    }

    // Vencida: liberar el lugar. Releer cada turno antes de tocarlo (si la seña
    // entró en el medio, ya no está pending y el grupo queda como estaba).
    let cancelados = 0;
    for (const t of ordenados) {
      const fresco = await medplum.readResource('Appointment', t.id as string);
      if (fresco.status !== 'pending') {
        continue;
      }
      await medplum.updateResource<Appointment>({
        ...fresco,
        status: 'cancelled',
        cancelationReason: { text: 'Seña no abonada a tiempo (R-19)' },
      });
      for (const s of fresco.slot ?? []) {
        const slotId = s.reference?.split('/')[1];
        if (!slotId) {
          continue;
        }
        const slot = await medplum.readResource('Slot', slotId);
        slot.status = 'free';
        await medplum.updateResource(slot);
      }
      cancelados++;
    }
    if (cancelados === 0) {
      continue; // se confirmó en el medio: no hay nada que avisar
    }

    await enviarWhatsApp(medplum, event.secrets, {
      template: 'tentativa-vencida',
      identifier: { system: SYSTEM.communication, value: `sena-vencida-${groupId}` },
      pacienteRef,
      // Plantilla: {{1}} servicio · {{2}} fecha/hora.
      variables: [descripcion, cuando],
      body: `BioWellness: tu reserva de ${descripcion} del ${cuando} se liberó porque no llegó la seña a tiempo. Si todavía querés venir, escribinos por acá y buscamos otro horario. 💚`,
    });
    await notificarPortal(medplum, {
      tipo: 'reserva-vencida',
      pacienteRef,
      about: `Appointment/${rep.id}`,
      identifier: { system: SYSTEM.communication, value: `portal-sena-vencida-${groupId}` },
      texto: `Tu reserva de ${descripcion} del ${cuando} se liberó porque no se abonó la seña a tiempo. Podés volver a reservar cuando quieras.`,
    });
    liberadas++;
  }

  return { ok: true, liberadas, recordatorios, vigentes };
}
