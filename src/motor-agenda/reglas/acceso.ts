/**
 * Reglas de acceso del cliente: ventana de reserva, autorización médica (R-03)
 * y saldo de membresía.
 */

import { rechazo, type Rechazo } from '../dominio/rechazos.js';
import { fechaHoraLocalLegible, minutosEntre, type RelojLocal } from '../dominio/tiempo.js';
import type { Cliente, Servicio } from '../dominio/tipos.js';
import type { ConfigMotor } from '../config/tipos.js';
import { evaluarFoundingMember } from '../comercial/founding.js';
import { puedeConsumirSesion } from '../comercial/membresias.js';

/**
 * Anticipación máxima con la que este cliente puede reservar, y de dónde sale.
 *
 * El Founding Member vigente lleva 7 días, por encima de cualquier tier. Un tag
 * caduco no: cae a la ventana de su categoría, que es exactamente lo que hace
 * que R-09 tenga consecuencias.
 */
export function ventanaDelCliente(
  config: ConfigMotor,
  cliente: Cliente,
): { readonly horas: number; readonly origen: string } {
  const v = config.ventanasReservaHoras;

  if (evaluarFoundingMember(cliente).vigente) {
    return { horas: v.foundingMember, origen: 'Founding Member' };
  }
  switch (cliente.categoria) {
    case 'miembro-intensivo':
      return { horas: v.miembroIntensivo, origen: 'Miembro Intensivo' };
    case 'miembro-standard':
      return { horas: v.miembroStandard, origen: 'Miembro Standard' };
    case 'publico':
      return { horas: v.publico, origen: 'Público general' };
  }
}

/**
 * Verifica la anticipación con la que se está reservando.
 *
 * Es el mecanismo por el cual la franja de alta demanda se raciona sola: quien
 * más paga, más lejos puede mirar la agenda. No hay ninguna restricción horaria
 * explícita, y no hace falta.
 */
export function verificarVentanaDeReserva(
  config: ConfigMotor,
  cliente: Cliente,
  inicio: Date,
  ahora: Date,
): Rechazo[] {
  const horasHastaElTurno = minutosEntre(ahora, inicio) / 60;

  if (horasHastaElTurno < 0) {
    return [
      rechazo(
        'RESERVA_EN_PASADO',
        `El turno pedido (${fechaHoraLocalLegible(inicio, config.reloj)}) ya pasó.`,
        { detalle: { horasHastaElTurno } },
      ),
    ];
  }

  const { horas, origen } = ventanaDelCliente(config, cliente);
  if (horasHastaElTurno > horas) {
    const dias = (horas / 24).toFixed(horas % 24 === 0 ? 0 : 1);
    return [
      rechazo(
        'VENTANA_RESERVA_EXCEDIDA',
        `${origen} puede reservar hasta ${horas} h de anticipación (${dias} día(s)) y este turno ` +
          `está a ${horasHastaElTurno.toFixed(1)} h. Se puede reservar a partir del ` +
          `${fechaHoraLocalLegible(
            new Date(inicio.getTime() - horas * 60 * 60_000),
            config.reloj,
          )}.`,
        {
          detalle: {
            categoria: cliente.categoria,
            origen,
            ventanaHoras: horas,
            horasHastaElTurno,
          },
        },
      ),
    ];
  }

  return [];
}

/**
 * R-03 — El sistema no permite ejecutar IV Therapy ni Terapia Biológica sin
 * autorización médica activa registrada.
 *
 * «Activa» se mide contra la fecha **del turno**, no contra la de hoy: una
 * autorización que vence antes del turno no autoriza ese turno.
 */
export function verificarAutorizacionMedica(
  cliente: Cliente,
  servicios: readonly Servicio[],
  inicio: Date,
  reloj: RelojLocal,
): Rechazo[] {
  const rechazos: Rechazo[] = [];

  for (const servicio of servicios) {
    if (!servicio.requiereAutorizacionMedica) continue;

    const autoriza = cliente.autorizaciones.some(
      (a) =>
        (a.servicio === servicio.codigo || a.servicio === '*') &&
        a.vigenteDesde <= inicio &&
        inicio <= a.vigenteHasta,
    );
    if (autoriza) continue;

    const vencida = cliente.autorizaciones.find(
      (a) => (a.servicio === servicio.codigo || a.servicio === '*') && a.vigenteHasta < inicio,
    );

    rechazos.push(
      rechazo(
        'SIN_AUTORIZACION_MEDICA',
        vencida
          ? `${servicio.nombre} necesita autorización médica activa. La que hay venció el ` +
            `${fechaHoraLocalLegible(vencida.vigenteHasta, reloj)}.`
          : `${servicio.nombre} necesita autorización médica activa y el cliente no tiene ninguna ` +
            `registrada.`,
        {
          regla: 'R-03',
          detalle: {
            servicio: servicio.codigo,
            autorizacionesRegistradas: cliente.autorizaciones.length,
            vencioEl: vencida?.vigenteHasta,
          },
        },
      ),
    );
  }

  return rechazos;
}

/** Verifica que la membresía pueda cubrir la sesión que se está reservando. */
export function verificarSaldoDeMembresia(cliente: Cliente, inicio: Date): Rechazo[] {
  const titularidad = cliente.titularidad;
  if (!titularidad) {
    return [
      rechazo(
        'MEMBRESIA_INACTIVA',
        'El turno se pidió con cargo a la membresía, pero el cliente no tiene ninguna.',
      ),
    ];
  }

  const evaluacion = puedeConsumirSesion(titularidad, inicio);
  if (evaluacion.puede) return [];

  const esFaltaDeSaldo = evaluacion.motivo?.startsWith('No quedan sesiones');
  return [
    rechazo(
      esFaltaDeSaldo ? 'MEMBRESIA_SIN_SALDO' : 'MEMBRESIA_INACTIVA',
      evaluacion.motivo ?? 'La membresía no puede cubrir esta sesión.',
      {
        detalle: {
          membresia: titularidad.membresia,
          estado: titularidad.estado,
          sesionesUsadas: titularidad.sesionesUsadas,
          sesionesAsignadas: titularidad.sesionesAsignadas,
        },
      },
    ),
  ];
}

/** Bloqueo por mora, independiente de la membresía. */
export function verificarMora(cliente: Cliente): Rechazo[] {
  if (!cliente.enMora) return [];
  return [
    rechazo('CLIENTE_EN_MORA', 'El cliente está en mora.', {
      detalle: { cliente: cliente.id },
    }),
  ];
}
