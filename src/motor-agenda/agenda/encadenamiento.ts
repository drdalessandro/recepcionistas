/**
 * Derivación de tiempos a partir de los atributos del recurso.
 *
 * Este archivo es el corazón del principio de diseño: **ningún offset se
 * declara, todos se derivan**. Un combo dice qué servicios y en qué orden; los
 * minutos salen de acá.
 *
 * Las tres magnitudes que todo lo demás usa:
 *
 *   salidaCliente   cuándo el cliente sale de este recurso. Es lo único que
 *                   encadena con el tramo siguiente.
 *   bloqueoRecurso  cuánto queda el recurso tomado, turnaround incluido. Es lo
 *                   que se escribe en la agenda.
 *   inicio del tramo siguiente = alinearAGrilla(salidaCliente, grilla del recurso siguiente)
 *
 * Que BIO ENERGY dure 60 y no 55, y que BIO LONGEVITY dure 150, no está escrito
 * en ningún lado: sale de aplicar estas tres reglas.
 */

import { alinearAGrilla } from '../dominio/tiempo.js';
import type { EtapaInterna, TiemposRecurso, TipoRecurso } from '../dominio/tipos.js';

/**
 * Minuto en que el cliente sale del recurso, contado desde el inicio del tramo.
 *
 * Por defecto `setup + terapia`. Dos recursos lo corren:
 *  - HBOT declara un ancla explícita (minuto 55), porque el operador reparte los
 *    tres tramos del protocolo según el cliente y el motor no los modela.
 *  - Recovery Pro lo deriva de su secuencia interna: el cliente sale a los 56,
 *    después de la ducha, aunque la terapia propiamente dicha terminó a los 48.
 */
export function salidaClienteMin(tiempos: TiemposRecurso): number {
  if (tiempos.anclaSalidaMin !== undefined) return tiempos.anclaSalidaMin;
  const porEtapas = anclaDerivadaDeEtapas(tiempos.etapas);
  if (porEtapas !== undefined) return porEtapas;
  return tiempos.setupMin + tiempos.terapiaMin;
}

/** Última etapa en la que el cliente todavía está adentro, o `undefined`. */
export function anclaDerivadaDeEtapas(
  etapas: readonly EtapaInterna[] | undefined,
): number | undefined {
  if (!etapas || etapas.length === 0) return undefined;
  const conCliente = etapas.filter((e) => e.clientePresente);
  if (conCliente.length === 0) return undefined;
  return Math.max(...conCliente.map((e) => e.hastaMin));
}

/**
 * Minutos que el recurso queda bloqueado.
 *
 * Es el máximo de tres cotas, porque las tres describen algo real:
 *
 *  - `setup + terapia + turnaround`, el caso normal.
 *  - El fin de la secuencia interna: el recurso no puede liberarse antes de que
 *    termine su propia coreografía (Recovery Pro llega justo a 60).
 *  - **El ancla más el turnaround.** Cuando un ancla explícita corre la salida
 *    del cliente más allá del fin nominal de la terapia, la limpieza arranca
 *    cuando el cliente sale, no antes. Sin esta cota, la cámara hiperbárica
 *    quedaría publicada como libre entre el minuto 58 y el 60 mientras todavía
 *    se está higienizando.
 *
 * El ancla derivada de las etapas no entra en la tercera cota a propósito: ahí
 * el turnaround ya incluye tiempo del cliente (los 12 minutos de Recovery Pro
 * cubren la ducha, que es la etapa 48–56), así que sumarlo otra vez lo contaría
 * dos veces.
 */
export function bloqueoRecursoMin(tiempos: TiemposRecurso): number {
  const porTiempos = tiempos.setupMin + tiempos.terapiaMin + tiempos.turnaroundMin;
  const finEtapas = tiempos.etapas?.reduce((max, e) => Math.max(max, e.hastaMin), 0) ?? 0;
  const porAncla =
    tiempos.anclaSalidaMin !== undefined ? tiempos.anclaSalidaMin + tiempos.turnaroundMin : 0;
  return Math.max(porTiempos, finEtapas, porAncla);
}

/** Sub-ocupaciones de otros pools que dispara la secuencia interna del recurso. */
export interface TomaDePool {
  readonly pool: TipoRecurso;
  readonly etapa: string;
  readonly desdeMin: number;
  readonly hastaMin: number;
}

/**
 * Qué otros pools toma este recurso y en qué ventana.
 *
 * Hoy sólo Recovery Pro: toma una tumbona del minuto 28 al 48. Que la devuelva
 * a los 48 —mientras el cliente todavía se ducha— es exactamente lo que permite
 * el desfasaje de 30 minutos entre gabinetes.
 */
export function tomasDePool(tiempos: TiemposRecurso): TomaDePool[] {
  if (!tiempos.etapas) return [];
  return tiempos.etapas
    .filter((e): e is EtapaInterna & { ocupa: { pool: TipoRecurso } } => e.ocupa !== 'propio')
    .map((e) => ({
      pool: e.ocupa.pool,
      etapa: e.nombre,
      desdeMin: e.desdeMin,
      hastaMin: e.hastaMin,
    }));
}

/** Un tramo con sus minutos ya resueltos, todavía sin unidades asignadas. */
export interface TramoDerivado {
  readonly orden: number;
  readonly servicio: string;
  readonly tipoRecurso: TipoRecurso;
  readonly offsetMin: number;
  readonly salidaClienteMin: number;
  readonly finRecursoMin: number;
  readonly tomasDePool: readonly TomaDePool[];
}

/** Lo que la derivación necesita saber de cada tramo. */
export interface TramoAEncadenar {
  readonly orden: number;
  readonly servicio: string;
  readonly tipoRecurso: TipoRecurso;
  readonly tiempos: TiemposRecurso;
}

/**
 * Encadena los tramos: el primero arranca en 0, y cada siguiente en el primer
 * inicio de grilla igual o posterior a la salida del cliente del anterior.
 *
 * Ejemplos que salen solos, sin una sola regla escrita a mano:
 *
 *   BIO ENERGY    IHHT 0-30 (sale a los 25) → tumbona 30-60           = 60
 *   BIO OXYGEN    HBOT 0-58 (sale a los 55) → IHHT 60-90              = 90
 *   BIO RECOVERY  HBOT 0-58 (sale a los 55) → Recovery Pro 60-120     = 120
 *   BIO LONGEVITY HBOT (sale 55) → IHHT 60-90 (sale 85) → RP 90-150   = 150
 *   BIO COMPRESS  Compresión 0-30 (sale a los 27) → tumbona 30-60     = 60
 */
export function derivarCadena(
  tramos: readonly TramoAEncadenar[],
  minutoInicialDelDia = 0,
): TramoDerivado[] {
  const derivados: TramoDerivado[] = [];
  let salidaAnterior: number | undefined;

  for (const tramo of tramos) {
    // La grilla se aplica sobre el reloj de pared, no sobre el inicio del
    // producto. Con todos los recursos en grilla de 30 da lo mismo, pero un
    // recurso que abre en hora en punto tiene que abrir en hora en punto aunque
    // el combo haya arrancado a y media.
    const offsetMin =
      salidaAnterior === undefined
        ? 0
        : alinearAGrilla(minutoInicialDelDia + salidaAnterior, tramo.tiempos.grillaInicioMin) -
          minutoInicialDelDia;

    const salida = offsetMin + salidaClienteMin(tramo.tiempos);

    derivados.push({
      orden: tramo.orden,
      servicio: tramo.servicio,
      tipoRecurso: tramo.tipoRecurso,
      offsetMin,
      salidaClienteMin: salida,
      finRecursoMin: offsetMin + bloqueoRecursoMin(tramo.tiempos),
      tomasDePool: tomasDePool(tramo.tiempos).map((t) => ({
        ...t,
        desdeMin: t.desdeMin + offsetMin,
        hastaMin: t.hastaMin + offsetMin,
      })),
    });

    salidaAnterior = salida;
  }

  return derivados;
}

/** Duración total de una cadena: hasta que se libera el último recurso. */
export function duracionCadenaMin(cadena: readonly TramoDerivado[]): number {
  return cadena.reduce((max, t) => Math.max(max, t.finRecursoMin), 0);
}

/** Cuándo se va el cliente del centro: la última salida de la cadena. */
export function salidaFinalCadenaMin(cadena: readonly TramoDerivado[]): number {
  return cadena.reduce((max, t) => Math.max(max, t.salidaClienteMin), 0);
}
