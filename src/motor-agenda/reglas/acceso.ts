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

    const delServicio = cliente.autorizaciones.filter(
      (a) => a.servicio === servicio.codigo || a.servicio === '*',
    );

    const autoriza = delServicio.some(
      (a) => a.vigenteDesde <= inicio && inicio <= a.vigenteHasta,
    );
    if (autoriza) continue;

    // Para el mensaje interesa la que estuvo vigente hasta hace menos —no la
    // primera del arreglo— y, si no hay ninguna vencida, la que arranca antes:
    // «todavía no empezó» es una situación muy distinta de «venció», y la
    // diferencia le cambia a recepción lo que tiene que hacer.
    const vencida = delServicio
      .filter((a) => a.vigenteHasta < inicio)
      .sort((a, b) => b.vigenteHasta.getTime() - a.vigenteHasta.getTime())[0];
    const futura = delServicio
      .filter((a) => a.vigenteDesde > inicio)
      .sort((a, b) => a.vigenteDesde.getTime() - b.vigenteDesde.getTime())[0];

    let detalleDelMotivo: string;
    if (vencida) {
      detalleDelMotivo = `La que hay venció el ${fechaHoraLocalLegible(vencida.vigenteHasta, reloj)}.`;
    } else if (futura) {
      detalleDelMotivo =
        `La que hay recién entra en vigencia el ` +
        `${fechaHoraLocalLegible(futura.vigenteDesde, reloj)}, después de este turno.`;
    } else {
      detalleDelMotivo = 'El cliente no tiene ninguna registrada.';
    }

    rechazos.push(
      rechazo(
        'SIN_AUTORIZACION_MEDICA',
        `${servicio.nombre} necesita autorización médica activa. ${detalleDelMotivo}`,
        {
          regla: 'R-03',
          detalle: {
            servicio: servicio.codigo,
            autorizacionesRegistradas: cliente.autorizaciones.length,
            ...(vencida ? { vencioEl: vencida.vigenteHasta } : {}),
            ...(futura ? { entraEnVigenciaEl: futura.vigenteDesde } : {}),
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
