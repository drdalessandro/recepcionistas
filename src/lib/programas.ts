/**
 * Ciclos de cobro de un programa (handoff PB100D §6.10).
 *
 * Un programa mensual **no se cobra por mes calendario**: se renueva **cada 30
 * días desde el alta** (brief §6.10, «renovación cada 30 días, cancelable»). Es
 * la diferencia con las membresías, que cobran los días 1-5 del mes (R-11), y es
 * la razón por la que `bw-cobro-membresias` los saltea a propósito.
 *
 * Por qué 30 días y no el mes calendario: el programa dura 100 días y arranca el
 * día que la paciente lo compra. Con mes calendario, alguien que entra un 28
 * pagaría el segundo mes a los tres días.
 *
 * Puro: sin FHIR ni red.
 */

/** Cada cuántos días se renueva un programa mensual. */
export const DIAS_CICLO_PROGRAMA = 30;

/**
 * Tope de ciclos que una corrida puede emitir de una vez.
 *
 * Existe para que un `period.start` disparatado —una fecha de 2019 cargada a
 * mano— no genere cuarenta Invoices en una sola corrida. Con el tope, emite los
 * últimos y deja el resto; alguien lo va a ver antes de que se vuelva plata.
 */
export const MAXIMO_CICLOS_POR_CORRIDA = 6;

export interface CicloPrograma {
  /** 1 es el ciclo del alta: ése lo cobra `bw-asignar-plan`, no el cron. */
  readonly numero: number;
  /** Inicio del ciclo, ISO completo. */
  readonly desde: string;
}

/** La clave de ciclo que va en el identifier del Invoice: `plan-{coverage}-c3`. */
export function claveCicloPrograma(numero: number): string {
  return `c${numero}`;
}

/** El número de ciclo de una clave `c3`, o `undefined` si no lo es. */
export function numeroDeCiclo(clave: string): number | undefined {
  const m = /^c(\d+)$/.exec(clave);
  return m ? Number(m[1]) : undefined;
}

/**
 * En qué ciclo cae `hoy`, contando desde el inicio de la cobertura.
 *
 * El ciclo 1 son los días 0 a 29; el 2 arranca el día 30. Una fecha anterior al
 * inicio devuelve `undefined` en vez de un ciclo 0 o negativo: cobrar antes de
 * que el plan empiece no es un caso, es un dato mal cargado.
 */
export function cicloDePrograma(inicio: string | undefined, hoy: Date): CicloPrograma | undefined {
  if (!inicio) {
    return undefined;
  }
  const desde = new Date(inicio).getTime();
  if (Number.isNaN(desde)) {
    return undefined;
  }
  const transcurridos = Math.floor((hoy.getTime() - desde) / 86_400_000);
  if (transcurridos < 0) {
    return undefined;
  }
  const numero = Math.floor(transcurridos / DIAS_CICLO_PROGRAMA) + 1;
  return { numero, desde: new Date(desde + (numero - 1) * DIAS_CICLO_PROGRAMA * 86_400_000).toISOString() };
}

/**
 * Los ciclos que el cron tiene que emitir hoy, del más viejo al más nuevo.
 *
 * Devuelve **todos** los pendientes, no sólo el actual: si el bot estuvo caído
 * un mes, el ciclo que pasó igual se cobra. Con «sólo el actual», ese ciclo no
 * se cobraría nunca y nadie se enteraría —que es exactamente el modo de fallar
 * contra el que avisa el comentario de `bw-cobro-membresias`—.
 *
 * El ciclo 1 nunca entra: lo cobra el alta.
 */
export function ciclosACobrar(inicio: string | undefined, hoy: Date): CicloPrograma[] {
  const actual = cicloDePrograma(inicio, hoy);
  if (!actual || actual.numero < 2) {
    return [];
  }
  const primero = Math.max(2, actual.numero - MAXIMO_CICLOS_POR_CORRIDA + 1);
  const ciclos: CicloPrograma[] = [];
  for (let n = primero; n <= actual.numero; n++) {
    ciclos.push(cicloDePrograma(inicio, new Date(new Date(inicio as string).getTime() + (n - 1) * DIAS_CICLO_PROGRAMA * 86_400_000)) as CicloPrograma);
  }
  return ciclos;
}
