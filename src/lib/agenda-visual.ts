/**
 * Cómo se reparte el alto de la grilla de Agenda — lógica pura, sin React.
 *
 * Una fila por sala, y dentro de la fila los turnos que se solapan se apilan en
 * BANDAS. Cuántas bandas tiene una fila, y cuánto alto pide esa fila frente a
 * las demás, es lo que se decide acá.
 *
 * Vivía adentro del componente y no tenía tests, que es raro para un cálculo
 * con tres casos distintos y un modo de fallar silencioso: una banda de 1 px no
 * se puede clickear y nadie reporta un bug de "no puedo tocar el turno", lo
 * reportan como "el turno no está".
 *
 * TRES CLASES DE SALA, y la diferencia importa:
 *
 *  - **Exclusiva o de una persona** (Monoplaza, Biplaza, gabinetes Recovery,
 *    consultorio): una reserva toma el recurso entero. UNA banda, siempre.
 *  - **Compartida con aforo** (Multiplaza, 6 personas): la banda es
 *    proporcional a la gente que trae la reserva, así 3 de 6 se leen como una
 *    columna llena hasta la mitad. El denominador es la capacidad, aunque la
 *    sala esté medio vacía: eso ES la información.
 *  - **Virtual** (videollamada): su `capacidad` es 50 y NO es aforo — son
 *    videollamadas que pueden convivir, no personas en una sala (lo dice
 *    `recursos.ts`). Usarla de denominador daba bandas de 1/50 del alto de la
 *    fila: literalmente 1 px, un turno invisible. Acá el denominador es cuántas
 *    videollamadas hay a la vez, que es lo único que ocupa espacio de verdad.
 */

/** Lo que el reparto necesita saber de una sala. */
export interface SalaLayout {
  capacidad: number;
  reservaExclusiva: boolean;
  /** `VIRTUAL` es el único tipo cuya capacidad no es aforo físico. */
  tipo: string;
}

/** Lo que necesita saber de un turno. */
export interface TurnoUbicable {
  inicioMin: number;
  finMin: number;
  /** Personas de esta reserva. */
  ocupantes: number;
}

export interface Ubicado {
  /** Banda donde arranca, 0 = arriba de todo. */
  asiento: number;
  /** Bandas que ocupa. */
  peso: number;
}

const VIRTUAL = 'VIRTUAL';

/** Tope de videollamadas simultáneas que se apilan antes de superponerse. */
const CUPO_VIRTUAL = 12;

/** ¿Una reserva toma la sala entera? */
function esEntera(sala: SalaLayout): boolean {
  return sala.reservaExclusiva || sala.capacidad <= 1;
}

/** Cuántas bandas caben, como cupo para apilar (no es lo que se dibuja). */
function cupoDe(sala: SalaLayout): number {
  if (esEntera(sala)) {
    return 1;
  }
  return sala.tipo === VIRTUAL ? CUPO_VIRTUAL : Math.max(1, sala.capacidad);
}

/** Bandas que pesa un turno. */
export function pesoTurno(turno: TurnoUbicable, sala: SalaLayout): number {
  if (esEntera(sala) || sala.tipo === VIRTUAL) {
    return 1;
  }
  return Math.max(1, Math.min(turno.ocupantes, Math.max(1, sala.capacidad)));
}

/**
 * Asigna a cada turno su banda. Los que se solapan en el tiempo van a bandas
 * distintas, así ninguno tapa a otro.
 *
 * Si no entran (sobrecupo heredado de datos viejos), el último se superpone al
 * final en vez de desaparecer: un turno mal ubicado se ve y se arregla; uno que
 * no se dibuja, no.
 */
export function posicionarTurnos<T extends TurnoUbicable>(turnos: readonly T[], sala: SalaLayout): Array<T & Ubicado> {
  const cupo = cupoDe(sala);
  const orden = [...turnos].sort((a, b) => a.inicioMin - b.inicioMin || a.finMin - b.finMin);
  const out: Array<T & Ubicado> = [];
  for (const t of orden) {
    const peso = pesoTurno(t, sala);
    const solapados = out
      .filter((o) => o.inicioMin < t.finMin && t.inicioMin < o.finMin)
      .sort((a, b) => a.asiento - b.asiento);
    let asiento = 0;
    for (const o of solapados) {
      if (asiento + peso <= o.asiento) {
        break;
      }
      asiento = Math.max(asiento, o.asiento + o.peso);
    }
    if (asiento + peso > cupo) {
      asiento = Math.max(0, cupo - peso);
    }
    out.push({ ...t, asiento, peso });
  }
  return out;
}

/**
 * El DENOMINADOR de las alturas: en cuántas bandas se divide la fila al
 * dibujarla.
 *
 * En la sala con aforo es la capacidad aunque esté vacía —media fila ocupada
 * significa media sala ocupada, y eso es información—. En la virtual es cuántas
 * hay a la vez, porque ahí la capacidad no significa nada.
 */
export function bandasDeFila(sala: SalaLayout, ubicados: readonly Ubicado[]): number {
  if (esEntera(sala)) {
    return 1;
  }
  if (sala.tipo === VIRTUAL) {
    return Math.max(1, ...ubicados.map((t) => t.asiento + t.peso));
  }
  return Math.max(1, sala.capacidad);
}

/** Alto máximo que puede pedir una fila, en filas simples. */
export const PESO_FILA_MAX = 3;

/**
 * Cuánto alto pide la fila, relativo a una fila simple (1 = lo de siempre).
 *
 * Con todas las filas iguales, el Multiplaza partía su alto en 6 y cada banda
 * quedaba de ~8 px: imposible de clickear, que fue el reporte de Andrés
 * (2026-09-22). Darle alto proporcional a las bandas lo lleva a ~25 px sin
 * dejar a las demás filas cortas — el factor 0,4 y el tope de 3 son eso: que la
 * fila más alta no se coma la pantalla ni empuje el resto fuera del viewport.
 */
export function pesoDeFila(bandas: number): number {
  if (bandas <= 1) {
    return 1;
  }
  return Math.min(PESO_FILA_MAX, 1 + (bandas - 1) * 0.4);
}

/** Personas ocupando la sala en el minuto `m` (para saber si admite más). */
export function ocupacionEn(ubicados: readonly (TurnoUbicable & Ubicado)[], m: number): number {
  return ubicados.filter((t) => m >= t.inicioMin && m < t.finMin).reduce((acc, t) => acc + t.peso, 0);
}
