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
import { getMembresia } from '../config/membresias.js';
import type { PerfilReserva } from '../config/reglas.js';
import type { IntensidadMembresia } from '../domain/types.js';
import { EXT } from '../fhir/identifiers.js';
import { esPlanBW, estadoDeCoverage, planCodigoDeCoverage } from '../fhir/coverage.js';
import {
  calcularDisponibilidad,
  perfilDeReserva,
  type DiaDisponible,
} from '../lib/disponibilidad.js';
import { cargarReservasEnRango } from './_shared.js';

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

  // Perfil R-13 (derivado en el server, nunca client-side): tag-fm → FM;
  // si no, la intensidad de la membresía activa; si no, público.
  let tagFm = false;
  const intensidades: IntensidadMembresia[] = [];
  try {
    const pacienteId = e.pacienteRef.split('/')[1]!;
    const paciente = await medplum.readResource('Patient', pacienteId);
    tagFm = paciente.extension?.find((x) => x.url === EXT.tagFm)?.valueBoolean === true;
  } catch {
    // ficha ilegible: se degrada a público (la ventana más corta)
  }
  const coberturas = await medplum.searchResources('Coverage', {
    beneficiary: e.pacienteRef,
    status: 'active',
    _count: 20,
  });
  for (const c of coberturas) {
    if (!esPlanBW(c) || estadoDeCoverage(c).tipo !== 'membresia') {
      continue;
    }
    const codigo = planCodigoDeCoverage(c);
    if (!codigo) {
      continue;
    }
    try {
      intensidades.push(getMembresia(codigo).intensidad);
    } catch {
      // plan desconocido: no cambia la ventana
    }
  }
  const perfil = perfilDeReserva(tagFm, intensidades);

  // Agenda ocupada de toda la ventana, en una sola búsqueda. Desde las 00:00
  // de hoy: una sesión EN CURSO (arrancó antes de "ahora") también pesa contra
  // la capacidad de los próximos horarios.
  const ahora = new Date();
  const inicioHoy = new Date(ahora);
  inicioHoy.setHours(0, 0, 0, 0);
  const limite = new Date(ahora.getTime() + 7 * 24 * 60 * 60 * 1000); // techo FM
  const reservas = await cargarReservasEnRango(medplum, inicioHoy, limite);

  const disp = calcularDisponibilidad({ servicio, perfil, ahora, reservas });
  return {
    ok: true,
    perfil,
    ventanaHoras: disp.ventanaHoras,
    grupal: disp.grupal,
    dias: disp.dias,
    ...(disp.dias.length === 0
      ? {
          mensaje: `Por ahora no hay horarios libres de ${servicio.nombre} dentro de tu ventana de reserva (${disp.ventanaHoras} h). Escribinos y lo resolvemos juntos.`,
        }
      : {}),
  };
}
