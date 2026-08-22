/**
 * Aritmética de tiempo del motor de agenda. Lógica pura: sin FHIR, sin red,
 * sin `Date.now()`.
 *
 * Todo el motor razona en **minutos desde el inicio del producto** (offsets) y
 * sólo convierte a `Date` en los bordes. Eso mantiene la expansión de combos
 * testeable sin husos horarios y hace que los offsets del plan sean legibles.
 *
 * Zona horaria: el motor trabaja con instantes (`Date`) y con la hora local del
 * centro. `America/Argentina/Buenos_Aires` no tiene horario de verano desde
 * 2009, así que la conversión usa un offset fijo configurable en vez de arrastrar
 * una librería de zonas. Si algún día Argentina vuelve al DST, este es el único
 * archivo que hay que tocar (ver `docs/motor-agenda-preguntas-abiertas.md`).
 */

/** Minutos de un día completo. */
export const MINUTOS_POR_DIA = 24 * 60;

/** Día de la semana, con la convención de `Date.getUTCDay()`. */
export type DiaSemana = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const DOMINGO = 0 as const;
export const SABADO = 6 as const;

/** Nombre legible del día, para los mensajes de rechazo que lee recepción. */
const NOMBRE_DIA: Record<DiaSemana, string> = {
  0: 'domingo',
  1: 'lunes',
  2: 'martes',
  3: 'miércoles',
  4: 'jueves',
  5: 'viernes',
  6: 'sábado',
};

export function nombreDia(dia: DiaSemana): string {
  return NOMBRE_DIA[dia];
}

/** Suma minutos a un instante sin mutarlo. */
export function sumarMinutos(instante: Date, minutos: number): Date {
  return new Date(instante.getTime() + minutos * 60_000);
}

/** Minutos entre dos instantes (`hasta - desde`). Puede ser negativo. */
export function minutosEntre(desde: Date, hasta: Date): number {
  return (hasta.getTime() - desde.getTime()) / 60_000;
}

/**
 * Redondea `minuto` hacia arriba hasta el siguiente múltiplo de `grilla`.
 *
 * Es la pieza que hace emerger los offsets de un combo: el tramo siguiente no
 * arranca cuando el cliente sale del anterior, sino en el primer inicio de
 * grilla igual o posterior. De ahí sale, por ejemplo, que BIO ENERGY dure 60 y
 * no 55: el cliente sale del IHHT en el minuto 25 y la tumbona recién abre a
 * los 30.
 */
export function alinearAGrilla(minuto: number, grilla: number): number {
  if (grilla <= 0) {
    throw new RangeError(`La grilla de inicio debe ser positiva, se recibió ${grilla}.`);
  }
  return Math.ceil(minuto / grilla) * grilla;
}

/** ¿Se superponen dos intervalos semiabiertos `[inicio, fin)`? */
export function seSuperponen(
  unInicio: Date,
  unFin: Date,
  otroInicio: Date,
  otroFin: Date,
): boolean {
  return unInicio.getTime() < otroFin.getTime() && otroInicio.getTime() < unFin.getTime();
}

// ── Hora local del centro ───────────────────────────────────────────────────

/**
 * Reloj del centro: traduce entre instantes y la hora de pared de San Isidro.
 *
 * `offsetHorasUtc` es negativo al oeste de Greenwich (Buenos Aires: −3).
 */
export interface RelojLocal {
  readonly offsetHorasUtc: number;
}

function aLocal(instante: Date, reloj: RelojLocal): Date {
  return new Date(instante.getTime() + reloj.offsetHorasUtc * 60 * 60_000);
}

/** Día de la semana local del instante. */
export function diaSemanaLocal(instante: Date, reloj: RelojLocal): DiaSemana {
  return aLocal(instante, reloj).getUTCDay() as DiaSemana;
}

/** Minutos transcurridos desde la medianoche local. */
export function minutosDesdeMedianocheLocal(instante: Date, reloj: RelojLocal): number {
  const local = aLocal(instante, reloj);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** Construye un instante a partir de una fecha y hora locales. */
export function instanteLocal(
  anio: number,
  mes: number,
  dia: number,
  hora: number,
  minuto: number,
  reloj: RelojLocal,
): Date {
  const utc = Date.UTC(anio, mes - 1, dia, hora, minuto, 0, 0);
  return new Date(utc - reloj.offsetHorasUtc * 60 * 60_000);
}

/** `"HH:MM"` local, para los mensajes que lee recepción. */
export function horaLocalLegible(instante: Date, reloj: RelojLocal): string {
  const minutos = minutosDesdeMedianocheLocal(instante, reloj);
  const hh = String(Math.floor(minutos / 60)).padStart(2, '0');
  const mm = String(minutos % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** `"DD/MM/AAAA HH:MM"` local, para los mensajes que lee recepción. */
export function fechaHoraLocalLegible(instante: Date, reloj: RelojLocal): string {
  const local = aLocal(instante, reloj);
  const dd = String(local.getUTCDate()).padStart(2, '0');
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${local.getUTCFullYear()} ${horaLocalLegible(instante, reloj)}`;
}

// ── Calendario ──────────────────────────────────────────────────────────────

/** Suma días calendario a un instante. */
export function sumarDias(instante: Date, dias: number): Date {
  return new Date(instante.getTime() + dias * MINUTOS_POR_DIA * 60_000);
}

/** Días enteros entre dos instantes, redondeando hacia abajo. */
export function diasEntre(desde: Date, hasta: Date): number {
  return Math.floor(minutosEntre(desde, hasta) / MINUTOS_POR_DIA);
}

/**
 * Último instante del mes local al que pertenece `instante` (23:59 del último día).
 *
 * Lo usa el vencimiento de las sesiones de membresía, que caen el último día del
 * mes o a los 30 días de contratado, lo que ocurra primero.
 */
export function finDeMesLocal(instante: Date, reloj: RelojLocal): Date {
  const local = aLocal(instante, reloj);
  const anio = local.getUTCFullYear();
  const mes = local.getUTCMonth() + 1;
  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return instanteLocal(anio, mes, ultimoDia, 23, 59, reloj);
}

/** Año calendario local, para el cupo anual de pausa de membresía. */
export function anioLocal(instante: Date, reloj: RelojLocal): number {
  return aLocal(instante, reloj).getUTCFullYear();
}

/** Mes local (1-12), para las ventanas de pausa de enero y julio. */
export function mesLocal(instante: Date, reloj: RelojLocal): number {
  return aLocal(instante, reloj).getUTCMonth() + 1;
}
