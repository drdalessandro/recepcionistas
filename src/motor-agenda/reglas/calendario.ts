/**
 * Reglas de calendario: horario de atención y franja clínica.
 */

import { rechazo, type Rechazo } from '../dominio/rechazos.js';
import {
  diaSemanaLocal,
  horaLocalLegible,
  minutosDesdeMedianocheLocal,
  minutosEntre,
  nombreDia,
} from '../dominio/tiempo.js';
import type { Programa, Servicio } from '../dominio/tipos.js';
import type { ConfigMotor } from '../config/tipos.js';

/** Minutos desde la medianoche del día de inicio, incluso si el plan cruza días. */
function ventanaEnMinutos(
  config: ConfigMotor,
  inicio: Date,
  fin: Date,
): { readonly desde: number; readonly hasta: number } {
  const desde = minutosDesdeMedianocheLocal(inicio, config.reloj);
  return { desde, hasta: desde + minutosEntre(inicio, fin) };
}

/** ¿El centro está abierto y el plan entero entra antes del cierre? */
export function verificarHorario(config: ConfigMotor, inicio: Date, fin: Date): Rechazo[] {
  const dia = diaSemanaLocal(inicio, config.reloj);
  const horario = config.horario.find((h) => h.dia === dia);

  if (!horario) {
    return [
      rechazo('CENTRO_CERRADO', `El centro no abre los ${nombreDia(dia)}.`, {
        detalle: { dia, diaNombre: nombreDia(dia) },
      }),
    ];
  }

  const { desde, hasta } = ventanaEnMinutos(config, inicio, fin);
  const rechazos: Rechazo[] = [];

  if (desde < horario.aperturaMin) {
    rechazos.push(
      rechazo(
        'FUERA_DE_HORARIO',
        `El turno arranca a las ${horaLocalLegible(inicio, config.reloj)} y los ` +
          `${nombreDia(dia)} el centro abre a las ${enHoras(horario.aperturaMin)}.`,
        { detalle: { inicioMin: desde, aperturaMin: horario.aperturaMin } },
      ),
    );
  }

  if (hasta > horario.cierreMin) {
    rechazos.push(
      rechazo(
        'NO_TERMINA_ANTES_DEL_CIERRE',
        `El turno termina a las ${enHoras(hasta)} y los ${nombreDia(dia)} el centro cierra a las ` +
          `${enHoras(horario.cierreMin)}. Faltan ${hasta - horario.cierreMin} minutos.`,
        { detalle: { finMin: hasta, cierreMin: horario.cierreMin } },
      ),
    );
  }

  return rechazos;
}

/** ¿La reserva es del programa clínico? */
export function esReservaClinica(
  programa: Programa | undefined,
  servicios: readonly Servicio[],
): boolean {
  if (programa === 'clinico') return true;
  // Toda IV y toda TB son clínicas sin excepción, se pidan como se pidan.
  return servicios.some((s) => s.soloFranjaClinica);
}

/**
 * Verifica la franja clínica.
 *
 * De 12:00 a 17:00 de lunes a viernes (último turno 16:00–17:00) opera un
 * programa separado, para pacientes con curso prescrito e indicación
 * diagnosticada, y para toda IV y toda Terapia Biológica sin excepción.
 *
 * La franja **no** restringe qué cámara puede usar un paciente: puede usar
 * cualquiera de las tres, multiplaza incluida, según criterio del equipo
 * hiperbárico. Acá no hay ninguna regla sobre cámaras, y no es un olvido.
 */
export function verificarFranjaClinica(
  config: ConfigMotor,
  programa: Programa | undefined,
  servicios: readonly Servicio[],
  inicio: Date,
  fin: Date,
): Rechazo[] {
  const franja = config.franjaClinica;
  const dia = diaSemanaLocal(inicio, config.reloj);
  const { desde, hasta } = ventanaEnMinutos(config, inicio, fin);
  const esClinica = esReservaClinica(programa, servicios);

  const rechazos: Rechazo[] = [];

  if (esClinica) {
    const motivoClinico = servicios.find((s) => s.soloFranjaClinica);
    const porQue = motivoClinico
      ? `${motivoClinico.nombre} sólo se hace en el programa clínico`
      : 'la reserva es del programa clínico';

    if (!franja.dias.includes(dia)) {
      rechazos.push(
        rechazo(
          'FUERA_DE_FRANJA_CLINICA',
          `${capitalizar(porQue)}, y los ${nombreDia(dia)} no hay franja clínica.`,
          { detalle: { dia, diasConFranja: franja.dias } },
        ),
      );
    } else if (desde < franja.desdeMin || desde > franja.ultimoInicioMin) {
      rechazos.push(
        rechazo(
          'FUERA_DE_FRANJA_CLINICA',
          `${capitalizar(porQue)}. La franja clínica va de ${enHoras(franja.desdeMin)} a ` +
            `${enHoras(franja.hastaMin)} y el último turno arranca ` +
            `${enHoras(franja.ultimoInicioMin)}; se pidió a las ` +
            `${horaLocalLegible(inicio, config.reloj)}.`,
          {
            detalle: {
              inicioMin: desde,
              franjaDesde: franja.desdeMin,
              ultimoInicio: franja.ultimoInicioMin,
            },
          },
        ),
      );
    } else if (hasta > franja.hastaMin) {
      rechazos.push(
        rechazo(
          'FUERA_DE_FRANJA_CLINICA',
          `${capitalizar(porQue)}, y el turno terminaría a las ${enHoras(hasta)}, después del ` +
            `cierre de la franja clínica (${enHoras(franja.hastaMin)}).`,
          { detalle: { finMin: hasta, franjaHasta: franja.hastaMin } },
        ),
      );
    }
    return rechazos;
  }

  // Flujo normal dentro de la franja. Apagado por defecto: el enunciado dice que
  // la franja bloquea las reservas clínicas fuera de ella, no que bloquee las de
  // bienestar dentro. Es una decisión de producto pendiente.
  if (
    franja.bloqueaFlujoNormal &&
    franja.dias.includes(dia) &&
    desde < franja.hastaMin &&
    hasta > franja.desdeMin
  ) {
    rechazos.push(
      rechazo(
        'FUERA_DE_FRANJA_CLINICA',
        `De ${enHoras(franja.desdeMin)} a ${enHoras(franja.hastaMin)} los ${nombreDia(dia)} el ` +
          `centro opera sólo el programa clínico.`,
        { detalle: { inicioMin: desde, finMin: hasta } },
      ),
    );
  }

  return rechazos;
}

function enHoras(minutos: number): string {
  const hh = String(Math.floor(minutos / 60)).padStart(2, '0');
  const mm = String(Math.round(minutos % 60)).padStart(2, '0');
  return `${hh}:${mm}`;
}

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}
