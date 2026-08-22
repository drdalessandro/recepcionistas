/**
 * El motor de reglas: recibe una solicitud y devuelve el plan de reserva o
 * **todos** los motivos por los que no se puede hacer.
 *
 * Que devuelva todos y no el primero es deliberado. Recepción tiene al cliente
 * enfrente: descubrir de a una que el turno está fuera de ventana, después que
 * falta la autorización y después que no hay lugar es tres llamadas en vez de
 * una conversación.
 */

import {
  aceptar,
  rechazar,
  type Advertencia,
  type Rechazo,
  type Resultado,
} from '../dominio/rechazos.js';
import type { PlanDeReserva, Servicio, SolicitudDeReserva } from '../dominio/tipos.js';
import type { MotorCompilado } from '../validacion/validar-config.js';
import { advertenciasDeTiempos, expandir } from '../agenda/expansor.js';
import { cotizarServicio } from '../comercial/precios.js';
import { esReservaClinica, verificarFranjaClinica, verificarHorario } from './calendario.js';
import {
  verificarAutorizacionMedica,
  verificarMora,
  verificarSaldoDeMembresia,
} from './acceso.js';
import { verificarVentanaDeReserva } from './acceso.js';
import type { AgendaOcupada } from '../dominio/tipos.js';

export interface PedidoDeEvaluacion {
  readonly motor: MotorCompilado;
  readonly solicitud: SolicitudDeReserva;
  readonly agenda: AgendaOcupada;
}

/**
 * Evalúa una reserva contra todas las reglas y arma el plan.
 *
 * El orden importa sólo para la calidad del mensaje, no para el veredicto: las
 * reglas que no dependen de qué recurso toque se evalúan siempre, aunque la
 * expansión falle, para que el rechazo salga completo de una sola vez.
 */
export function evaluarReserva(pedido: PedidoDeEvaluacion): Resultado<PlanDeReserva> {
  const { motor, solicitud, agenda } = pedido;
  const config = motor.config;

  // ── 1. Reglas que no dependen de qué recurso se asigne ──
  const previos: Rechazo[] = [
    ...verificarVentanaDeReserva(config, solicitud.cliente, solicitud.inicio, solicitud.ahora),
  ];

  if (solicitud.consumeSesionDeMembresia) {
    previos.push(...verificarMora(solicitud.cliente));
    previos.push(...verificarSaldoDeMembresia(solicitud.cliente, solicitud.inicio));
  }

  // ── 2. Expansión: recursos, offsets y ocupaciones ──
  const expansion = expandir({
    motor,
    producto: solicitud.producto,
    inicio: solicitud.inicio,
    ocupantes: solicitud.ocupantes,
    agenda,
    ...(solicitud.seleccion ? { seleccion: solicitud.seleccion } : {}),
  });

  if (!expansion.ok) {
    // Aunque no haya plan, las reglas de catálogo se pueden evaluar contra los
    // servicios que el producto podría llegar a usar. Es información que a
    // recepción le sirve ahora, no en el próximo intento.
    const posibles = serviciosPosiblesDelProducto(motor, solicitud);
    return rechazar(
      ...previos,
      ...expansion.rechazos,
      // Sin plan no se sabe cuánto dura, pero sí si el centro abre ese día y a
      // esa hora. Callarlo obliga a recepción a chocar dos veces: primero
      // resuelve lo del recurso y recién entonces descubre que era domingo.
      ...verificarHorario(config, solicitud.inicio, solicitud.inicio),
      ...verificarAutorizacionMedica(
        solicitud.cliente,
        posibles,
        solicitud.inicio,
        config.reloj,
      ),
      ...(esReservaClinica(solicitud.programa, posibles)
        ? verificarFranjaClinica(
            config,
            solicitud.programa,
            posibles,
            solicitud.inicio,
            solicitud.inicio,
          )
        : []),
    );
  }

  const cadena = expansion.valor;
  const serviciosDelPlan = cadena.tramos
    .map((t) => motor.servicioPorCodigo.get(t.servicio))
    .filter((s): s is Servicio => s !== undefined);

  // ── 3. Reglas que necesitan saber cuánto dura el plan ──
  const posteriores: Rechazo[] = [
    ...verificarHorario(config, cadena.inicio, cadena.fin),
    ...verificarFranjaClinica(
      config,
      solicitud.programa,
      serviciosDelPlan,
      cadena.inicio,
      cadena.fin,
    ),
    ...verificarAutorizacionMedica(
      solicitud.cliente,
      serviciosDelPlan,
      solicitud.inicio,
      config.reloj,
    ),
  ];

  const todos = [...previos, ...posteriores];
  if (todos.length > 0) return rechazar(...todos);

  // ── 4. Cotización ──
  // Una sesión con cargo a la membresía no se cotiza: ya está paga.
  const advertencias: Advertencia[] = [...advertenciasDeTiempos(motor, cadena.tramos)];
  let cotizacion;

  if (!solicitud.consumeSesionDeMembresia && solicitud.producto.tipo === 'suelta') {
    const cotizado = cotizarServicio({
      motor,
      servicio: solicitud.producto.codigo,
      ocupantes: solicitud.ocupantes,
      cliente: solicitud.cliente,
      ahora: solicitud.ahora,
    });
    if (cotizado.ok) {
      cotizacion = cotizado.valor;
    } else {
      // No cotizar no impide reservar: impide cobrar sin saber cuánto. El turno
      // se agenda y recepción ve por qué falta el precio.
      for (const r of cotizado.rechazos) {
        advertencias.push({
          codigo: 'SIN_COTIZACION',
          mensaje: `El turno se puede agendar pero no se pudo cotizar: ${r.mensaje}`,
          detalle: { codigoRechazo: r.codigo },
        });
      }
    }
  }

  const plan: PlanDeReserva = {
    producto: solicitud.producto,
    cliente: solicitud.cliente.id,
    ocupantes: solicitud.ocupantes,
    programa: solicitud.programa ?? (esReservaClinica(undefined, serviciosDelPlan) ? 'clinico' : 'bienestar'),
    inicio: cadena.inicio,
    fin: cadena.fin,
    salidaCliente: cadena.salidaCliente,
    tramos: cadena.tramos,
    ocupaciones: cadena.ocupaciones,
    ...(cotizacion ? { cotizacion } : {}),
    advertencias,
  };

  return aceptar(plan, advertencias);
}

/** Todos los servicios que el producto podría llegar a usar. */
function serviciosPosiblesDelProducto(
  motor: MotorCompilado,
  solicitud: SolicitudDeReserva,
): Servicio[] {
  const codigos =
    solicitud.producto.tipo === 'suelta'
      ? [solicitud.producto.codigo]
      : (motor.comboPorCodigo.get(solicitud.producto.codigo)?.tramos.flatMap((t) => t.servicios) ??
        []);

  return codigos
    .map((c) => motor.servicioPorCodigo.get(c))
    .filter((s): s is Servicio => s !== undefined);
}
