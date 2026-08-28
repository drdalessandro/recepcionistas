/**
 * Agenda semanal de membresías (R-21) — lógica pura (sin FHIR ni red).
 *
 * Las sesiones del plan se gestionan por SEMANA CALENDARIO (lunes a domingo,
 * hora de Argentina): el socio deja una preferencia (días con nombre + hora) y
 * la asignación automática (`bw-agenda-semanal`) reserva cada sesión apenas su
 * ventana R-13 se abre. Como la ventana de cada perfil es distinta (FM 7 días,
 * Intensivo 96 h, Standard 72 h), la prioridad de acceso a la semana se da sola.
 *
 * Acá viven las decisiones puras: qué fechas tocan esta semana, cuántas entran
 * (tope = frecuencia del plan, sin recupero) y qué horarios alternativos probar
 * si el preferido está ocupado. El bot solo orquesta.
 */
import { SEMANA_MEMBRESIA, VENTANA_RESERVA_HORAS, type PerfilReserva } from '../config/reglas.js';
import type { FranjaHoraria } from '../config/horario.js';
import { fechaLocalISO, lunesDe } from './mapa-semana.js';
import { validarVentanaReserva, type ResultadoValidacion } from './reglas-turno.js';

/** Preferencia semanal del socio (vive en el Coverage como extensiones). */
export interface PreferenciaSemanal {
  /** Días de la semana elegidos (0=domingo … 6=sábado), ordenados. */
  dias: number[];
  /** Hora "HH:mm" (hora de Argentina), la misma para todos los días. */
  hora: string;
}

const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Parsea la preferencia guardada ("1,4" + "18:00"). Inválida o vacía → undefined. */
export function parsePreferencia(diasCsv?: string, hora?: string): PreferenciaSemanal | undefined {
  if (!diasCsv?.trim() || !hora || !RE_HORA.test(hora)) {
    return undefined;
  }
  const dias = [
    ...new Set(
      diasCsv
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    ),
  ].sort((a, b) => a - b);
  return dias.length > 0 ? { dias, hora } : undefined;
}

/** Serializa la preferencia para las extensiones del Coverage. */
export function serializarDias(dias: number[]): string {
  return [...new Set(dias)].sort((a, b) => a - b).join(',');
}

/** Clave de la semana calendario a la que pertenece la fecha: su lunes "YYYY-MM-DD". */
export function claveSemana(d: Date): string {
  return fechaLocalISO(lunesDe(d));
}

/** ¿La fecha civil "YYYY-MM-DD" cae en la semana cuyo lunes es `lunesISO`? */
export function perteneceASemana(fecha: string, lunesISO: string): boolean {
  const [y, m, d] = fecha.split('-').map(Number);
  return claveSemana(new Date(y!, m! - 1, d!)) === lunesISO;
}

/**
 * R-21 — Tope semanal: la membresía usa a lo sumo su frecuencia (2x/3x) por
 * semana calendario, sin recupero. `enSemana` = sesiones del plan que esa semana
 * ya tiene (agendadas o realizadas).
 */
export function validarTopeSemanal(enSemana: number, frecuenciaSemanal: number): ResultadoValidacion {
  const tope = frecuenciaSemanal + SEMANA_MEMBRESIA.recuperoSesiones;
  if (enSemana >= tope) {
    return {
      ok: false,
      bloqueos: [
        {
          regla: 'R-21',
          nivel: 'bloqueo',
          mensaje: `La membresía ya tiene ${enSemana} sesión(es) esta semana (tope semanal: ${tope}). Las sesiones del plan se usan semana a semana.`,
        },
      ],
      advertencias: [],
    };
  }
  return { ok: true, bloqueos: [], advertencias: [] };
}

/** Inicio ISO del turno con el offset fijo de Argentina (sin DST). */
export function inicioTurnoISO(fecha: string, hora: string): string {
  return `${fecha}T${hora}:00-03:00`;
}

/** Las fechas civiles de la semana de `lunesISO` que caen en los días elegidos. */
export function fechasPreferidasDeSemana(lunesISO: string, dias: number[]): string[] {
  const [y, m, d] = lunesISO.split('-').map(Number);
  const lunes = new Date(y!, m! - 1, d!);
  const fechas: string[] = [];
  for (let i = 0; i < 7; i++) {
    const f = new Date(lunes);
    f.setDate(lunes.getDate() + i);
    if (dias.includes(f.getDay())) {
      fechas.push(fechaLocalISO(f));
    }
  }
  return fechas;
}

export interface CandidatoSemana {
  /** Día civil "YYYY-MM-DD". */
  fecha: string;
  /** Inicio ISO con offset de Argentina (preferencia.hora). */
  inicioISO: string;
}

export interface OpcionesCandidatos {
  preferencia: PreferenciaSemanal;
  perfil: PerfilReserva;
  ahora: Date;
  /**
   * Día civil "YYYY-MM-DD" de HOY en Argentina. En el bot (Lambda, UTC) los
   * métodos locales de Date corren 3 h adelantados; este ancla evita que entre
   * las 21 y las 24 de un domingo la "semana actual" salte antes de tiempo.
   * Si no se pasa, se deriva de `ahora` con los métodos locales (tests, front).
   */
  hoyISO?: string;
  /** Fechas "YYYY-MM-DD" que YA tienen sesión de ESTE plan (esta y la próxima semana). */
  fechasAsignadas: ReadonlySet<string>;
  /** Sesiones restantes del ciclo (R-10). */
  saldoRestante: number;
  frecuenciaSemanal: number;
  esDiaAbierto: (dia: number) => boolean;
}

/**
 * Qué sesiones tocan asignar AHORA: recorre esta semana y la próxima (más allá
 * no llega ninguna ventana: FM = 7 días) y devuelve, en orden cronológico, las
 * fechas preferidas que (1) el centro abre, (2) no están ya asignadas, (3) no
 * pasan el tope semanal ni el saldo del ciclo, (4) están en el futuro y
 * (5) **ya entraron en la ventana R-13 del perfil** — lo que todavía no entró
 * queda para una corrida futura del cron, y así el FM llega antes que nadie.
 */
export function candidatosSemana(o: OpcionesCandidatos): CandidatoSemana[] {
  const candidatos: CandidatoSemana[] = [];
  let saldo = o.saldoRestante;

  const anclaHoy = o.hoyISO
    ? (() => {
        const [y, m, d] = o.hoyISO.split('-').map(Number);
        return new Date(y!, m! - 1, d!);
      })()
    : o.ahora;
  const lunesActual = lunesDe(anclaHoy);
  for (const offsetSemanas of [0, 1]) {
    const lunes = new Date(lunesActual);
    lunes.setDate(lunesActual.getDate() + offsetSemanas * 7);
    const lunesISO = fechaLocalISO(lunes);

    const yaEnSemana = [...o.fechasAsignadas].filter((f) => perteneceASemana(f, lunesISO)).length;
    let cupo = o.frecuenciaSemanal + SEMANA_MEMBRESIA.recuperoSesiones - yaEnSemana;

    for (const fecha of fechasPreferidasDeSemana(lunesISO, o.preferencia.dias)) {
      if (cupo <= 0 || saldo <= 0) {
        break;
      }
      const [y, m, d] = fecha.split('-').map(Number);
      const dia = new Date(y!, m! - 1, d!).getDay();
      if (!o.esDiaAbierto(dia) || o.fechasAsignadas.has(fecha)) {
        continue;
      }
      const inicio = new Date(inicioTurnoISO(fecha, o.preferencia.hora));
      if (inicio.getTime() <= o.ahora.getTime()) {
        continue;
      }
      if (!validarVentanaReserva(o.perfil, o.ahora, inicio).ok) {
        continue; // todavía no entró en la ventana: la asigna una corrida futura
      }
      candidatos.push({ fecha, inicioISO: inicioTurnoISO(fecha, o.preferencia.hora) });
      cupo--;
      saldo--;
    }
  }
  return candidatos;
}

function hhmmAMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minAHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * Horarios alternativos del MISMO día si el preferido está ocupado: la grilla de
 * las franjas abiertas, ordenada por cercanía a la hora preferida (más cerca
 * primero; a igual distancia, el más temprano). Solo entran los inicios donde la
 * sesión completa (`duracionMin`) termina antes del cierre.
 */
export function horariosAlternativos(
  horaPreferida: string,
  franjas: FranjaHoraria[],
  duracionMin: number,
  granularidadMin = 30,
  max: number = SEMANA_MEMBRESIA.maxAlternativasDia,
): string[] {
  const preferidaMin = hhmmAMin(horaPreferida);
  const opciones: number[] = [];
  for (const f of franjas) {
    const desde = hhmmAMin(f.desde);
    const hasta = hhmmAMin(f.hasta);
    for (let t = desde; t + duracionMin <= hasta; t += granularidadMin) {
      if (t !== preferidaMin) {
        opciones.push(t);
      }
    }
  }
  opciones.sort((a, b) => {
    const da = Math.abs(a - preferidaMin);
    const db = Math.abs(b - preferidaMin);
    return da - db || a - b;
  });
  return opciones.slice(0, max).map(minAHhmm);
}

/** Horas de la ventana del perfil (para leyendas y avisos). */
export function ventanaDelPerfil(perfil: PerfilReserva): number {
  return VENTANA_RESERVA_HORAS[perfil];
}
