/**
 * Lista de espera (app): leer, anotar y dar de baja.
 *
 * La espera es un `Appointment` con `status: 'waitlist'` (ver
 * `src/fhir/lista-espera.ts`), así que se escribe directo con la policy de
 * recepción — igual que los movimientos de caja. La lógica de qué es una espera
 * válida y a quién le sirve un hueco vive en `src/lib/lista-espera.ts`, que es
 * la misma que usan los bots al liberarse un lugar.
 */
import type { Appointment } from '@medplum/fhirtypes';
import { BUSQUEDA_ESPERAS, appointmentAEspera, esperaAAppointment } from '@bw/fhir/lista-espera';
import { vigente, type EntradaEspera } from '@bw/lib/lista-espera';
import { medplum } from '../medplum';

/**
 * Esperas vivas, las más viejas primero (que es el orden en el que se llama).
 * Las vencidas se filtran acá y no se borran: el recurso queda como registro de
 * que esa persona pidió algo que no había.
 */
export async function cargarEsperas(opts: { pacienteRef?: string; ahora?: Date } = {}): Promise<EntradaEspera[]> {
  const ahora = opts.ahora ?? new Date();
  const query = opts.pacienteRef ? `${BUSQUEDA_ESPERAS}&actor=${opts.pacienteRef}` : BUSQUEDA_ESPERAS;
  const encontrados = await medplum.searchResources('Appointment', query, { cache: 'no-cache' });
  return encontrados
    .map(appointmentAEspera)
    .filter((e): e is EntradaEspera => Boolean(e) && vigente(e as EntradaEspera, ahora))
    .sort((a, b) => a.creadaEn.getTime() - b.creadaEn.getTime());
}

/** Anota a alguien en la lista. Devuelve la entrada con su id. */
export async function anotarEspera(entrada: EntradaEspera): Promise<EntradaEspera> {
  const creado = await medplum.createResource<Appointment>(esperaAAppointment(entrada));
  return { ...entrada, id: creado.id };
}

/**
 * Da de baja la espera (ya vino, ya no le interesa, se resolvió).
 *
 * Se cancela, no se borra: el turno cancelado deja el rastro de que esa persona
 * estuvo esperando, que es justamente el dato que decía cuánta demanda no
 * estamos pudiendo atender.
 */
export async function quitarEspera(id: string, motivo?: string): Promise<void> {
  const actual = await medplum.readResource('Appointment', id);
  await medplum.updateResource<Appointment>({
    ...actual,
    status: 'cancelled',
    ...(motivo ? { cancelationReason: { text: motivo } } : {}),
  });
}
