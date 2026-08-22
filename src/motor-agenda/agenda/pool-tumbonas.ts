/**
 * Asignador del pool de tumbonas Red Light.
 *
 * Las tres tumbonas no tienen dueño fijo: el motor las asigna por
 * disponibilidad. Pero la asignación es **direccional**, y esa es la única regla
 * del archivo:
 *
 *   Recovery Pro   sólo puede tomar las tumbonas de su sala. Nunca la standalone,
 *                  ni siquiera cuando es la única libre: el cliente paga un
 *                  gabinete privado y mandarlo al área común rompe el producto.
 *
 *   Todo lo demás  (BIO ENERGY, BIO COMPRESS, Red Light suelta) prefiere la
 *                  standalone y recién si no está libre toma una de la sala. La
 *                  preferencia no es un capricho: deja las de la sala para
 *                  Recovery Pro, que no tiene alternativa.
 *
 * Notar lo que este archivo **no** hace: no sabe nada del desfasaje de 30
 * minutos entre gabinetes. Ese desfasaje no está escrito en ninguna parte —
 * emerge de que Recovery Pro toma una tumbona del minuto 28 al 48 y de que el
 * pool de la sala tiene dos. Dos gabinetes con dos personas cada uno arrancando
 * a la misma hora pedirían cuatro tumbonas de un pool de dos y el pedido se cae
 * solo; a media hora de distancia, las ventanas 28-48 y 58-78 no se tocan.
 */

import { rechazar, rechazo, aceptar, type Resultado } from '../dominio/rechazos.js';
import { horaLocalLegible, type RelojLocal } from '../dominio/tiempo.js';
import type { AgendaOcupada, UbicacionTumbona, UnidadRecurso } from '../dominio/tipos.js';
import { estaDisponible } from './ocupacion.js';

/** Quién pide las tumbonas. Define la direccionalidad. */
export type ConsumidorDeTumbona = 'recovery-pro' | 'externo';

/** Orden de preferencia de ubicación según quién pide. */
const PREFERENCIA: Record<ConsumidorDeTumbona, readonly UbicacionTumbona[]> = {
  // Recovery Pro: sólo la sala. La ausencia de 'standalone' en esta lista ES la regla.
  'recovery-pro': ['sala-recovery'],
  // Externos: la standalone primero, para no quitarle a Recovery Pro su única opción.
  externo: ['standalone', 'sala-recovery'],
};

export interface PedidoDeTumbonas {
  readonly consumidor: ConsumidorDeTumbona;
  /** Una tumbona por ocupante. */
  readonly cantidad: number;
  readonly inicio: Date;
  readonly fin: Date;
  readonly tumbonas: readonly UnidadRecurso[];
  readonly agenda: AgendaOcupada;
  readonly reloj: RelojLocal;
}

/**
 * Asigna `cantidad` tumbonas respetando la direccionalidad, o explica por qué no
 * pudo.
 */
export function asignarTumbonas(pedido: PedidoDeTumbonas): Resultado<UnidadRecurso[]> {
  const { consumidor, cantidad, inicio, fin, tumbonas, agenda, reloj } = pedido;

  if (cantidad <= 0) return aceptar([]);

  const libres = tumbonas.filter((t) => estaDisponible(agenda, t, inicio, fin, 1));
  const habilitadas = PREFERENCIA[consumidor];

  const elegibles: UnidadRecurso[] = [];
  for (const ubicacion of habilitadas) {
    for (const tumbona of libres) {
      if (tumbona.ubicacion === ubicacion) elegibles.push(tumbona);
    }
  }

  if (elegibles.length >= cantidad) {
    return aceptar(elegibles.slice(0, cantidad));
  }

  const ventana = `${horaLocalLegible(inicio, reloj)}–${horaLocalLegible(fin, reloj)}`;

  // Caso específico y frecuente: Recovery Pro se queda corto y la standalone
  // estaba libre. Vale la pena decirlo con todas las letras, porque desde el
  // mostrador parece que hay una tumbona disponible y el sistema la rechaza.
  const standaloneLibres = libres.filter((t) => t.ubicacion === 'standalone').length;
  if (consumidor === 'recovery-pro' && standaloneLibres > 0) {
    return rechazar(
      rechazo(
        'TUMBONA_STANDALONE_PROHIBIDA',
        `Recovery Pro necesita ${cantidad} tumbona(s) de su sala entre ${ventana} y quedan ` +
          `${elegibles.length}. La tumbona del área común está libre pero no se puede usar: ` +
          `el cliente paga un gabinete privado.`,
        {
          regla: 'R-07',
          detalle: {
            solicitadas: cantidad,
            libresEnSala: elegibles.length,
            standaloneLibres,
            ventana,
          },
        },
      ),
    );
  }

  return rechazar(
    rechazo(
      'SIN_TUMBONA_DISPONIBLE',
      `No hay ${cantidad} tumbona(s) Red Light libres entre ${ventana}: quedan ${elegibles.length}.`,
      {
        detalle: {
          solicitadas: cantidad,
          disponibles: elegibles.length,
          consumidor,
          ventana,
        },
      },
    ),
  );
}
