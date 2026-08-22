/**
 * Titularidades de membresía: saldo, vencimiento, pausa y cancelación.
 *
 * Las sesiones **no son acumulables**: vencen el último día del mes o a los 30
 * días de contratado, lo que ocurra primero. Que sea «lo que ocurra primero» no
 * es un detalle: quien contrata un 25 tiene menos de una semana para usar las
 * ocho sesiones del mes, y el modelo tiene que decirlo en vez de disimularlo
 * (ver preguntas abiertas de producto).
 */

import { aceptar, rechazar, rechazo, type Resultado } from '../dominio/rechazos.js';
import {
  anioLocal,
  diasEntre,
  finDeMesLocal,
  mesLocal,
  minutosEntre,
  sumarDias,
  type RelojLocal,
} from '../dominio/tiempo.js';
import type { PausaMembresia, Titularidad } from '../dominio/tipos.js';
import type { ModoRedondeo, ReglasCancelacion, ReglasMembresia, ReglasPausa } from '../config/tipos.js';

// ── Vencimiento del ciclo ───────────────────────────────────────────────────

/**
 * Fin del ciclo: el último día del mes o los N días de contratado, lo que
 * ocurra primero.
 */
export function finDeCiclo(
  inicio: Date,
  reglas: ReglasMembresia,
  reloj: RelojLocal,
): Date {
  const porMes = finDeMesLocal(inicio, reloj);
  const porDias = sumarDias(inicio, reglas.diasVigenciaCiclo);
  return porMes <= porDias ? porMes : porDias;
}

/** Sesiones que le quedan al socio en el ciclo vigente. */
export function saldoDeSesiones(titularidad: Titularidad): number {
  return Math.max(0, titularidad.sesionesAsignadas - titularidad.sesionesUsadas);
}

/**
 * ¿La titularidad está pausada en este instante?
 *
 * La pausa es un **período**, no un interruptor. Se declara con 30 días de
 * anticipación, así que entre la declaración y el arranque el socio sigue
 * usando su membresía con normalidad: si el estado se diera vuelta al declarar,
 * quien avisa en diciembre que pausa en enero perdería diciembre.
 */
export function estaPausadaEn(titularidad: Titularidad, momento: Date): boolean {
  return titularidad.pausas.some((p) => p.inicio <= momento && momento < p.fin);
}

/** ¿Puede consumir una sesión ahora mismo? */
export function puedeConsumirSesion(
  titularidad: Titularidad,
  momento: Date,
): { readonly puede: boolean; readonly motivo?: string } {
  if (titularidad.estado === 'en-mora') {
    return { puede: false, motivo: 'La membresía está en mora.' };
  }
  if (titularidad.estado === 'vencida') {
    return { puede: false, motivo: 'La membresía está vencida.' };
  }
  // Las dos formas de estar pausado: el estado guardado (la pausa ya arrancó y
  // alguien la asentó) y el período declarado (todavía no arrancó, o nadie
  // asentó nada). Alcanza con cualquiera.
  if (titularidad.estado === 'pausada' || estaPausadaEn(titularidad, momento)) {
    return { puede: false, motivo: 'La membresía está pausada en esa fecha.' };
  }
  if (momento > titularidad.finCiclo) {
    return {
      puede: false,
      motivo: 'El ciclo de la membresía ya venció; las sesiones no son acumulables.',
    };
  }
  if (saldoDeSesiones(titularidad) <= 0) {
    return {
      puede: false,
      motivo: `No quedan sesiones en el ciclo (${titularidad.sesionesUsadas} de ${titularidad.sesionesAsignadas} usadas).`,
    };
  }
  return { puede: true };
}

// ── Pausa ───────────────────────────────────────────────────────────────────

/** Días que dura una pausa. */
export function diasDePausa(pausa: PausaMembresia): number {
  return diasEntre(pausa.inicio, pausa.fin);
}

/** Días ya pausados en un año calendario, contando por la fecha de inicio. */
export function diasPausadosEnAnio(
  titularidad: Titularidad,
  anio: number,
  reloj: RelojLocal,
): number {
  return titularidad.pausas
    .filter((p) => anioLocal(p.inicio, reloj) === anio)
    .reduce((total, p) => total + diasDePausa(p), 0);
}

function redondear(valor: number, modo: ModoRedondeo): number {
  if (modo === 'abajo') return Math.floor(valor);
  if (modo === 'arriba') return Math.ceil(valor);
  return Math.round(valor);
}

/**
 * Declara una pausa sobre la titularidad.
 *
 * El efecto es **proporcional**, en las tres puntas a la vez: se suspende el
 * cobro por los días pausados, las sesiones del mes se reducen en la misma
 * proporción, y la fecha de renovación se corre por los días pausados. Una
 * pausa de 15 días sobre una base de 30 deja una membresía Standard en 4
 * sesiones y con la renovación 15 días más tarde.
 *
 * Pero la pausa **no arranca al declararla**. Se declara con 30 días de
 * anticipación, así que el estado sigue siendo `activa` hasta que la ventana
 * empieza; quién está pausado en una fecha lo responde `estaPausadaEn`. Si el
 * estado se diera vuelta acá, quien avisa en diciembre que pausa en enero
 * perdería diciembre, que es justo lo contrario de lo que el beneficio ofrece.
 *
 * `momento` es opcional y sólo sirve para el caso raro de declarar una pausa ya
 * en curso; sin él, la titularidad queda activa con la pausa agendada.
 *
 * (El cobro suspendido no se calcula acá: este módulo registra los días pausados
 * y quien factura los prorratea. El motor de agenda no cobra.)
 */
export function aplicarPausa(
  titularidad: Titularidad,
  pausa: PausaMembresia,
  reglas: ReglasPausa,
  reloj: RelojLocal,
  momento?: Date,
): Resultado<Titularidad> {
  const dias = diasDePausa(pausa);
  const problemas = [];

  if (dias < reglas.bloqueMinimoDias) {
    problemas.push(
      rechazo(
        'MEMBRESIA_INACTIVA',
        `La pausa es de ${dias} día(s) y el bloque mínimo es de ${reglas.bloqueMinimoDias}.`,
        { detalle: { dias, minimo: reglas.bloqueMinimoDias } },
      ),
    );
  }

  const mes = mesLocal(pausa.inicio, reloj);
  if (!reglas.mesesVentana.includes(mes)) {
    const nombres = reglas.mesesVentana.join(' y ');
    problemas.push(
      rechazo(
        'MEMBRESIA_INACTIVA',
        `La pausa arranca en el mes ${mes} y sólo se puede pausar dentro de las ventanas de los ` +
          `meses ${nombres}.`,
        { detalle: { mes, ventanas: reglas.mesesVentana } },
      ),
    );
  }

  const anticipacion = diasEntre(pausa.declaradaEn, pausa.inicio);
  if (anticipacion < reglas.anticipacionMinimaDias) {
    problemas.push(
      rechazo(
        'MEMBRESIA_INACTIVA',
        `La pausa se declaró con ${anticipacion} día(s) de anticipación y hacen falta ` +
          `${reglas.anticipacionMinimaDias}.`,
        { detalle: { anticipacion, minima: reglas.anticipacionMinimaDias } },
      ),
    );
  }

  const yaUsados = diasPausadosEnAnio(titularidad, anioLocal(pausa.inicio, reloj), reloj);
  if (yaUsados + dias > reglas.diasPorAnioCalendario) {
    problemas.push(
      rechazo(
        'MEMBRESIA_INACTIVA',
        `La pausa de ${dias} día(s) supera el cupo anual: ya se usaron ${yaUsados} de ` +
          `${reglas.diasPorAnioCalendario} días este año.`,
        { detalle: { dias, yaUsados, cupo: reglas.diasPorAnioCalendario } },
      ),
    );
  }

  if (titularidad.estado !== 'activa') {
    problemas.push(
      rechazo(
        'MEMBRESIA_INACTIVA',
        `Sólo se puede pausar una membresía activa; ésta está ${titularidad.estado}.`,
      ),
    );
  }

  if (problemas.length > 0) return rechazar(...problemas);

  const proporcionRestante = Math.max(0, 1 - dias / reglas.baseProporcionalDias);
  const sesionesAsignadas = redondear(
    titularidad.sesionesAsignadas * proporcionRestante,
    reglas.redondeoSesiones,
  );

  const pausas = [...titularidad.pausas, pausa];
  const yaEmpezo = momento !== undefined && pausa.inicio <= momento && momento < pausa.fin;

  return aceptar({
    ...titularidad,
    estado: yaEmpezo ? 'pausada' : titularidad.estado,
    sesionesAsignadas,
    finCiclo: sumarDias(titularidad.finCiclo, dias),
    pausas,
  });
}

// ── Cancelación de turno ────────────────────────────────────────────────────

/**
 * Fuerza mayor médica. Autorizable **sólo por un médico**: sin el profesional
 * que la autoriza, la excepción no existe.
 */
export interface FuerzaMayorMedica {
  readonly motivoDocumentado: string;
  readonly autorizadaPorMedico: string;
}

export interface EvaluacionDeCancelacion {
  readonly devuelveSesionAlSaldo: boolean;
  readonly horasDeAnticipacion: number;
  readonly motivo: string;
}

/**
 * Decide si una cancelación devuelve la sesión al saldo o la consume.
 *
 * Con 24 horas o más, vuelve al saldo. Con menos, se consume, salvo fuerza mayor
 * médica documentada y autorizada por un médico.
 */
export function evaluarCancelacion(pedido: {
  readonly inicioDelTurno: Date;
  readonly momentoDeCancelacion: Date;
  readonly reglas: ReglasCancelacion;
  readonly fuerzaMayor?: FuerzaMayorMedica;
}): EvaluacionDeCancelacion {
  const { inicioDelTurno, momentoDeCancelacion, reglas, fuerzaMayor } = pedido;
  const horas = minutosEntre(momentoDeCancelacion, inicioDelTurno) / 60;

  if (horas >= reglas.horasParaDevolverSesion) {
    return {
      devuelveSesionAlSaldo: true,
      horasDeAnticipacion: horas,
      motivo: `Cancelada con ${horas.toFixed(1)} h de anticipación: la sesión vuelve al saldo.`,
    };
  }

  if (fuerzaMayor?.autorizadaPorMedico) {
    return {
      devuelveSesionAlSaldo: true,
      horasDeAnticipacion: horas,
      motivo:
        `Cancelada con ${horas.toFixed(1)} h de anticipación, pero se aplicó la excepción por ` +
        `fuerza mayor médica autorizada por ${fuerzaMayor.autorizadaPorMedico}.`,
    };
  }

  const sinMedico = fuerzaMayor && !fuerzaMayor.autorizadaPorMedico;
  return {
    devuelveSesionAlSaldo: false,
    horasDeAnticipacion: horas,
    motivo: sinMedico
      ? `Cancelada con ${horas.toFixed(1)} h de anticipación. Se invocó fuerza mayor médica pero ` +
        `no la autorizó ningún médico, así que la sesión se consume.`
      : `Cancelada con ${horas.toFixed(1)} h de anticipación, menos de las ` +
        `${reglas.horasParaDevolverSesion} h requeridas: la sesión se consume.`,
  };
}
