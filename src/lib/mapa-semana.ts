/**
 * Mapa de ocupación semanal (vista "Semana" de la agenda de recepción).
 *
 * Lógica pura: dado un lunes, el horario del centro y los turnos de esa semana,
 * arma la matriz 7 días × horas donde cada celda dice cuántas SALAS DISTINTAS
 * están ocupadas en esa hora. Salas, no turnos: seis personas en la Multiplaza
 * son UNA sala ocupada — la pregunta del mapa es "¿dónde hay lugar?", y un
 * recurso con aforo a medias sigue teniendo lugar.
 *
 * La celda cerrada se distingue de la vacía (`salas: null` vs `0`): un domingo
 * no es un día libre, es un día que no existe para la agenda.
 */
import type { HorarioDia } from '../config/horario.js';

/** Lo mínimo que el mapa necesita saber de un turno. */
export interface TurnoMapa {
  /** Sala/recurso donde ocurre (código de `RECURSOS`). */
  recursoCodigo: string;
  /** Día local "YYYY-MM-DD". */
  fecha: string;
  /** Minutos desde medianoche local. */
  inicioMin: number;
  finMin: number;
}

export interface CeldaMapa {
  /** Hora en punto que representa la celda (la franja es [hora, hora+1)). */
  hora: number;
  /** Salas distintas ocupadas en la franja, o `null` si el centro está cerrado. */
  salas: number | null;
}

export interface DiaMapa {
  /** Día local "YYYY-MM-DD". */
  fecha: string;
  /** Día de semana (0=domingo … 6=sábado, convención de `Date.getDay()`). */
  dia: number;
  /** ¿El centro abre ese día? */
  abierto: boolean;
  celdas: CeldaMapa[];
}

export interface MapaSemana {
  /** Eje de horas compartido por los 7 días (unión de los horarios abiertos). */
  horas: number[];
  /** Lunes a domingo, en orden. */
  dias: DiaMapa[];
}

/** Lunes (medianoche local) de la semana a la que pertenece `d`. */
export function lunesDe(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  // getDay(): 0=domingo … 6=sábado. El domingo pertenece a la semana que TERMINA.
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** "YYYY-MM-DD" del día LOCAL (nunca `toISOString()`: es UTC y adelanta el día a las 21). */
export function fechaLocalISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hhmmAMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** ¿La franja [desdeMin, hastaMin) pisa la celda de la hora `hora`? */
function pisaCelda(desdeMin: number, hastaMin: number, hora: number): boolean {
  return desdeMin < (hora + 1) * 60 && hora * 60 < hastaMin;
}

/**
 * Arma la matriz de la semana que arranca en `lunes`.
 *
 * El eje de horas es la UNIÓN de los horarios de los días abiertos (hoy: 8 a 21,
 * porque L-V cierra 22 y sábado 20): así todos los días comparten columnas y el
 * sábado muestra sus últimas celdas como cerradas en vez de desaparecerlas.
 */
export function armarMapaSemana(turnos: TurnoMapa[], lunes: Date, horario: HorarioDia[]): MapaSemana {
  // Eje de horas común.
  let primeraHora = 24;
  let ultimaHora = 0;
  for (const h of horario) {
    for (const f of h.franjas) {
      primeraHora = Math.min(primeraHora, Math.floor(hhmmAMin(f.desde) / 60));
      // La última celda es la hora en que ARRANCA la última franja de 60'.
      ultimaHora = Math.max(ultimaHora, Math.ceil(hhmmAMin(f.hasta) / 60) - 1);
    }
  }
  const horas: number[] = [];
  for (let h = primeraHora; h <= ultimaHora; h++) {
    horas.push(h);
  }

  // Turnos agrupados por día (una pasada).
  const porFecha = new Map<string, TurnoMapa[]>();
  for (const t of turnos) {
    const arr = porFecha.get(t.fecha) ?? [];
    arr.push(t);
    porFecha.set(t.fecha, arr);
  }

  const dias: DiaMapa[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(lunes);
    d.setDate(d.getDate() + i);
    const fecha = fechaLocalISO(d);
    const dia = d.getDay();
    const hd = horario.find((h) => h.dia === dia);
    const abierto = Boolean(hd?.abierto && hd.franjas.length > 0);
    const delDia = porFecha.get(fecha) ?? [];

    const celdas: CeldaMapa[] = horas.map((hora) => {
      const abre = abierto && hd!.franjas.some((f) => pisaCelda(hhmmAMin(f.desde), hhmmAMin(f.hasta), hora));
      if (!abre) {
        return { hora, salas: null };
      }
      const salas = new Set<string>();
      for (const t of delDia) {
        if (pisaCelda(t.inicioMin, t.finMin, hora)) {
          salas.add(t.recursoCodigo);
        }
      }
      return { hora, salas: salas.size };
    });

    dias.push({ fecha, dia, abierto, celdas });
  }

  return { horas, dias };
}
