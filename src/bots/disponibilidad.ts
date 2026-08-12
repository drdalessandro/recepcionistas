/**
 * Bot · Disponibilidad real para el portal (SOLO LECTURA).
 *
 * El paciente lo ejecuta desde Reservas para ver chips de horarios reales para
 * ÉL: dentro de su ventana R-13 (público 48 h · Standard 72 h · Intensivo 96 h ·
 * FM 7 días), respetando horario del centro, agenda de las salas, capacidad
 * (R-07) y desfasaje Recovery. NO crea ni modifica nada: la reserva sigue siendo
 * solicitud (`bw-solicitar-turno`) y Recepción confirma.
 *
 * El contrato de salida lo consume el portal tal cual (no renombrar campos):
 * { ok, perfil, ventanaHoras, grupal, dias: [{ fecha, horarios: [{ inicio, fin,
 * lugares?, ocupantes? }] }], mensaje? }.
 *
 * Seguridad (nota consciente, docs/portal-integracion.md): `pacienteRef` viene
 * del input, como en bw-solicitar-turno. Solo expone disponibilidad + ventana,
 * sin datos clínicos ni de terceros; el endurecimiento (derivar el paciente del
 * login) va junto con el de los bots de reserva instantánea.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { getServicio } from '../config/catalogo.js';
import type { PerfilReserva } from '../config/reglas.js';
import type { DiaDisponible } from '../lib/disponibilidad.js';
import { disponibilidadDePaciente } from './_shared.js';

export interface EntradaDisponibilidad {
  pacienteRef: string; // "Patient/<id>"
  servicioCodigo: string;
}

export interface ResultadoDisponibilidad {
  ok: boolean;
  perfil?: PerfilReserva;
  ventanaHoras?: number;
  grupal?: boolean;
  dias?: DiaDisponible[];
  mensaje?: string;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaDisponibilidad>,
): Promise<ResultadoDisponibilidad> {
  const e = event.input;
  if (!e?.pacienteRef?.startsWith('Patient/') || !e.servicioCodigo) {
    return { ok: false, mensaje: 'Falta pacienteRef (Patient/<id>) o servicioCodigo.' };
  }

  let servicio;
  try {
    servicio = getServicio(e.servicioCodigo);
  } catch {
    return { ok: false, mensaje: `Servicio desconocido: ${e.servicioCodigo}.` };
  }

  // Perfil R-13 + agenda ocupada + solicitudes pendientes: todo lo arma
  // `disponibilidadDePaciente` (compartido con bw-solicitar-turno, que valida
  // contra ESTA misma disponibilidad — si divergieran, el portal ofrecería
  // horarios que después se rechazan).
  const { perfil, disp } = await disponibilidadDePaciente(medplum, e.pacienteRef, servicio);
  const sinOpciones =
    disp.dias.length === 0
      ? disp.excluidosPorSolicitudes > 0
        ? // La única razón son horarios ya pedidos: que el paciente lo entienda.
          'Los horarios de este servicio están pedidos y esperando confirmación. Escribinos y te avisamos apenas se libere alguno.'
        : `Por ahora no hay horarios libres de ${servicio.nombre} dentro de tu ventana de reserva (${disp.ventanaHoras} h). Escribinos y lo resolvemos juntos.`
      : undefined;
  return {
    ok: true,
    perfil,
    ventanaHoras: disp.ventanaHoras,
    grupal: disp.grupal,
    dias: disp.dias,
    ...(sinOpciones ? { mensaje: sinOpciones } : {}),
  };
}
