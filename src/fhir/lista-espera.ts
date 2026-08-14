/**
 * Lista de espera sobre FHIR (transformaciones puras; quien llama hace el I/O).
 *
 * Una espera es un **`Appointment` con `status: 'waitlist'`**, que es
 * exactamente para lo que existe ese estado en FHIR R4 ("el turno está en lista
 * de espera, todavía sin horario asignado"), con la ventana en `requestedPeriod`
 * — el campo que el estándar reserva para "en qué período preferiría el turno".
 * No se inventa un recurso nuevo: quien espera es alguien que quiere un turno.
 *
 * Efecto práctico de usar el recurso estándar: las esperas **no aparecen en la
 * agenda**. Todas las pantallas y bots buscan turnos por `date=ge…`, que en R4
 * es `Appointment.start`, y una espera no tiene `start` — no hay horario todavía.
 * Y cuando la espera se convierte en turno real, es el mismo tipo de recurso.
 *
 * Lo único que FHIR no modela es la preferencia DENTRO de la ventana ("martes o
 * jueves, a la tarde"), y sin eso el aviso se vuelve ruido: por eso los días y
 * las franjas van en dos extensiones propias.
 */
import type { Appointment } from '@medplum/fhirtypes';
import { clasificacionDeServicio } from './appointment.js';
import { EXT, SYSTEM } from './identifiers.js';
import { FRANJAS, type EntradaEspera, type Franja } from '../lib/lista-espera.js';

/** Búsqueda de las esperas vivas (las vencidas se filtran con `vigente`). */
export const BUSQUEDA_ESPERAS = 'status=waitlist&_count=200';

/** Espera → Appointment listo para crear. */
export function esperaAAppointment(e: EntradaEspera): Appointment {
  return {
    resourceType: 'Appointment',
    status: 'waitlist',
    ...clasificacionDeServicio(e.servicioCodigo),
    // La ventana en la que espera. Es el campo estándar para esto y, además, lo
    // que hace que la espera **venza sola**: nadie tiene que pasar a limpiar.
    requestedPeriod: [{ start: e.desde.toISOString(), end: e.hasta.toISOString() }],
    created: e.creadaEn.toISOString(),
    ...(e.nota?.trim() ? { comment: e.nota.trim() } : {}),
    participant: [
      {
        actor: { reference: e.pacienteRef, ...(e.pacienteNombre ? { display: e.pacienteNombre } : {}) },
        // Todavía no hay nada que aceptar: no hay horario.
        status: 'needs-action',
      },
    ],
    extension: [
      ...(e.dias.length > 0 ? [{ url: EXT.esperaDias, valueString: [...e.dias].sort((a, b) => a - b).join(',') }] : []),
      ...(e.franjas.length > 0 ? [{ url: EXT.esperaFranjas, valueString: e.franjas.join(',') }] : []),
    ],
  };
}

/**
 * Appointment → espera. Devuelve `undefined` si no es una espera nuestra o si le
 * falta lo mínimo para poder avisarle a alguien de algo (paciente, servicio y
 * ventana): una entrada a medias no se puede ofrecer y no debe contarse.
 *
 * El teléfono NO viaja acá: está en la ficha del paciente y duplicarlo en el
 * turno sería una copia que envejece. Lo resuelve quien arma el aviso, que son
 * tres lecturas como mucho.
 */
export function appointmentAEspera(a: Appointment): EntradaEspera | undefined {
  if (a.status !== 'waitlist') {
    return undefined;
  }
  const participante = a.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'));
  const pacienteRef = participante?.actor?.reference;
  const servicioCodigo = a.serviceType?.[0]?.coding?.find((c) => c.system === SYSTEM.servicioCodigo)?.code;
  const categoria = a.serviceCategory?.[0]?.coding?.find((c) => c.system === SYSTEM.categoriaServicio)?.code;
  const periodo = a.requestedPeriod?.[0];
  if (!pacienteRef || !servicioCodigo || !categoria || !periodo?.start || !periodo.end) {
    return undefined;
  }
  const desde = new Date(periodo.start);
  const hasta = new Date(periodo.end);
  if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
    return undefined;
  }
  return {
    id: a.id,
    pacienteRef,
    pacienteNombre: participante?.actor?.display,
    servicioCodigo,
    categoria,
    desde,
    hasta,
    dias: leerDias(a),
    franjas: leerFranjas(a),
    nota: a.comment,
    // Sin `created` (no debería pasar) queda al final de la cola: la duda nunca
    // le gana el lugar a alguien que sí registró cuándo pidió.
    creadaEn: a.created ? new Date(a.created) : new Date(8640000000000000),
  };
}

function leerDias(a: Appointment): number[] {
  const csv = a.extension?.find((x) => x.url === EXT.esperaDias)?.valueString;
  if (!csv) {
    return [];
  }
  return [...new Set(csv.split(',').map((d) => Number(d.trim())))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

function leerFranjas(a: Appointment): Franja[] {
  const csv = a.extension?.find((x) => x.url === EXT.esperaFranjas)?.valueString;
  if (!csv) {
    return [];
  }
  return csv
    .split(',')
    .map((f) => f.trim())
    .filter((f): f is Franja => (FRANJAS as readonly string[]).includes(f));
}
