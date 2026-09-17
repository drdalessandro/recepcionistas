/**
 * Bot · Disponibilidad real para el portal (SOLO LECTURA).
 *
 * El paciente lo ejecuta desde Reservas para ver chips de horarios reales para
 * ÉL: dentro de su ventana R-13 (público 48 h · Standard 72 h · Intensivo 96 h ·
 * FM 7 días), respetando horario del centro, agenda de las salas, capacidad
 * (R-07) y desfasaje Recovery. NO crea ni modifica nada: la reserva sigue siendo
 * solicitud (`bw-solicitar-turno`) y Recepción confirma.
 *
 * DOS fuentes, según el servicio (`fuente` lo dice en la respuesta):
 *  - **terapias** → la grilla de salas calculada acá (capacidad, R-13, etc.);
 *  - **consultas médicas**, presenciales y teleconsultas → los `Slot` libres de
 *    la **agenda publicada** del profesional. Es la misma fuente contra la que
 *    valida `bw-solicitar-turno`; una consulta jamás se mide contra la grilla
 *    de salas (ver el docstring de `chequearHorarioDisponible`).
 *
 * El contrato de salida lo consume el portal tal cual (no renombrar campos):
 * { ok, fuente, perfil, ventanaHoras, grupal, dias: [{ fecha, horarios: [{ inicio, fin,
 * lugares?, ocupantes? }], ocupados?: [{ inicio, fin }] }], mensaje? }.
 * `ocupados` (handoff 2026-08-12): horarios de la grilla ya tomados, que el
 * portal pinta tachados y no deja elegir. Un día puede venir con horarios
 * vacíos y solo ocupados (día completamente tomado).
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
import { agendaPublicadaDeMedico, disponibilidadDePaciente } from './_shared.js';

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
  /**
   * De dónde salieron los horarios. Campo AGREGADO (2026-09-17): los que ya
   * consumen este bot para terapias no lo miran y siguen andando igual.
   *  - `salas` → grilla calculada (horario del centro, capacidad, ventana R-13).
   *    `perfil` y `ventanaHoras` vienen sólo en este caso.
   *  - `agenda-medico` → los `Slot` libres que publicó el profesional. R-13 no
   *    aplica: el médico publica con semanas de anticipación.
   */
  fuente?: 'salas' | 'agenda-medico';
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

  // Consulta médica (presencial o teleconsulta) → la agenda PUBLICADA del
  // profesional, que es contra lo que valida `bw-solicitar-turno`.
  //
  // Sin esta bifurcación este bot le contestaba a una consulta con la grilla de
  // los CONSULTORIOS: `candidatosPara` resuelve por `servicio.categoria` y no
  // mira la modalidad, así que a una teleconsulta —que no ocupa consultorio
  // alguno— le ofrecía los horarios del consultorio físico, filtrados encima
  // por la ventana R-13 de 48 h. Dos errores que se tapan entre sí: horarios
  // que el médico no atiende, y horarios que el médico SÍ atiende escondidos
  // por una ventana que a una consulta no se le aplica (es la puerta de
  // entrada: el paciente nuevo es el de ventana más corta).
  //
  // El docstring de `disponibilidadDePaciente` ya prometía que este bot y
  // `bw-solicitar-turno` miran lo mismo "si divergieran, el portal ofrecería
  // horarios que después se rechazan". Para las consultas divergían.
  if (servicio.practitionerCodigo) {
    const { publicada, dias } = await agendaPublicadaDeMedico(
      medplum,
      servicio.practitionerCodigo,
      servicio.modalidad,
    );
    const vacia = dias.every((d) => d.horarios.length === 0);
    return {
      ok: true,
      fuente: 'agenda-medico',
      dias,
      ...(!publicada
        ? { mensaje: `${servicio.nombre} todavía no tiene horarios publicados. Escribinos y te avisamos apenas se abran.` }
        : vacia
          ? { mensaje: `Por ahora no quedan horarios libres de ${servicio.nombre}. Escribinos y lo resolvemos juntos.` }
          : {}),
    };
  }

  // Perfil R-13 + agenda ocupada + solicitudes pendientes: todo lo arma
  // `disponibilidadDePaciente` (compartido con bw-solicitar-turno, que valida
  // contra ESTA misma disponibilidad — si divergieran, el portal ofrecería
  // horarios que después se rechazan).
  const { perfil, disp } = await disponibilidadDePaciente(medplum, e.pacienteRef, servicio);
  // "Sin opciones" = sin horarios ELEGIBLES. Con `ocupados`, un día puede venir
  // solo con tachados: se muestran igual, pero el mensaje explica que no hay
  // nada para elegir.
  const sinOpciones = disp.dias.every((d) => d.horarios.length === 0)
    ? disp.excluidosPorSolicitudes > 0
      ? // La única razón son horarios ya pedidos: que el paciente lo entienda.
        'Los horarios de este servicio están pedidos y esperando confirmación. Escribinos y te avisamos apenas se libere alguno.'
      : `Por ahora no hay horarios libres de ${servicio.nombre} dentro de tu ventana de reserva (${disp.ventanaHoras} h). Escribinos y lo resolvemos juntos.`
    : undefined;
  return {
    ok: true,
    fuente: 'salas',
    perfil,
    ventanaHoras: disp.ventanaHoras,
    grupal: disp.grupal,
    dias: disp.dias,
    ...(sinOpciones ? { mensaje: sinOpciones } : {}),
  };
}
