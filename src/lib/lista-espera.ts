/**
 * Lista de espera — lógica pura.
 *
 * El caso del walk-in que quiere venir y **no hay lugar**. Hasta hoy eso no
 * dejaba nada: la persona se iba, y cuando media hora después alguien cancelaba,
 * el hueco quedaba libre sin que nadie se enterara.
 *
 * Dos cosas lo vuelven urgente ahora:
 *
 *  - **Ya lo prometemos.** Cuando el portal no tiene horarios, `bw-disponibilidad`
 *    responde *"escribinos y te avisamos apenas se libere alguno"*. Esa promesa
 *    no tenía ningún mecanismo detrás: no había dónde anotar a quién avisarle.
 *  - **Va a haber más huecos.** Desde el 2026-08-14 R-14 se aplica de verdad y
 *    cancelar con 24 h devuelve la sesión al plan. Cancelar salió de ser un
 *    castigo, así que se va a cancelar más y antes — que es lo que se buscaba,
 *    y también más lugar liberándose en silencio.
 *
 * Acá vive solo lo que hay que decidir: qué es una espera válida, qué hueco le
 * sirve a quién y en qué orden. Dónde se guarda está en `src/fhir/lista-espera.ts`.
 */

import { TZ } from '../config/horario.js';

/** Franjas del día con las que se pide "a la tarde", que es como se pide. */
export const FRANJAS = ['manana', 'tarde', 'noche'] as const;
export type Franja = (typeof FRANJAS)[number];

/**
 * Límites de cada franja en hora local (minutos desde 00:00). Cubren el horario
 * del centro (08–22 · sábados hasta 20) sin huecos ni superposición: un turno
 * cae siempre en exactamente una.
 */
export const LIMITES_FRANJA: Record<Franja, { desde: number; hasta: number }> = {
  manana: { desde: 8 * 60, hasta: 12 * 60 },
  tarde: { desde: 12 * 60, hasta: 18 * 60 },
  noche: { desde: 18 * 60, hasta: 22 * 60 },
};

export const FRANJAS_LABEL: Record<Franja, string> = {
  manana: 'Mañana (8 a 12)',
  tarde: 'Tarde (12 a 18)',
  noche: 'Noche (18 a 22)',
};

/** Días de la semana, con la convención de `Date.getDay()` y `HORARIO_SEMANAL`. */
export const DIAS_LABEL = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'] as const;

/**
 * Cuánto espera por defecto. Dos semanas: es el plazo en el que una cancelación
 * ajena es probable y en el que la persona todavía se acuerda de que preguntó.
 */
export const ESPERA_DIAS_DEFAULT = 14;
/** Tope duro. Más allá, la lista se llena de gente que ya resolvió por otro lado. */
export const ESPERA_DIAS_MAX = 60;
/** La nota es un recordatorio para quien llama, no la crónica de la charla. */
export const ESPERA_NOTA_MAX = 200;
/** Cuántos candidatos entran en el aviso: la recepcionista llama, no lee un listado. */
export const CANDIDATOS_EN_AVISO = 3;

/** Una persona esperando lugar. */
export interface EntradaEspera {
  /** Id del Appointment `waitlist` (existe solo si ya se guardó). */
  id?: string;
  pacienteRef: string;
  /** Nombre para mostrar en el aviso (quién es el que espera). */
  pacienteNombre?: string;
  /** Teléfono al que avisarle; sin él la entrada sirve igual, pero hay que llamar a la ficha. */
  telefono?: string;
  /** Servicio que pidió (código del catálogo). */
  servicioCodigo: string;
  /**
   * Terapia del servicio (`Appointment.serviceCategory`). El match del hueco es
   * por ACÁ y no por el código exacto: monoplaza, biplaza y multiplaza son la
   * misma exposición, y quien espera "cámara hiperbárica" no pidió un puesto.
   */
  categoria: string;
  /** Desde cuándo le sirve (normalmente, ya). */
  desde: Date;
  /** Hasta cuándo espera. Vencida, deja de recibir avisos sin que nadie la borre. */
  hasta: Date;
  /** Días de la semana que le sirven (0=domingo). **Vacío = cualquiera.** */
  dias: number[];
  /** Franjas que le sirven. **Vacío = cualquiera.** */
  franjas: Franja[];
  /** Lo que haya dicho ("después de las 19 no puede", "prefiere con Ana"). */
  nota?: string;
  creadaEn: Date;
}

/** Un turno que se liberó y hay que ofrecer. */
export interface HuecoLiberado {
  inicio: Date;
  fin: Date;
  /** Terapia que se liberó (la dimensión por la que se matchea). */
  categoria: string;
  /** Servicio concreto, para el texto del aviso. */
  servicioCodigo?: string;
  /**
   * Quién dejó el hueco. Se excluye de los candidatos: ofrecerle a alguien el
   * turno que acaba de cancelar es el aviso que hace desconfiar del sistema.
   */
  pacienteRef?: string;
}

/** Día de la semana y minuto del día **en hora de Argentina**. */
export function momentoArgentino(f: Date): { dia: number; minutos: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(f);
  const parte = (tipo: string): string => partes.find((p) => p.type === tipo)?.value ?? '';
  const dias = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // `hour: '2-digit'` con hour12:false devuelve "24" a la medianoche en algunos
  // runtimes: se normaliza para que las 00:xx no caigan fuera de todo.
  const hora = Number(parte('hour')) % 24;
  return { dia: Math.max(0, dias.indexOf(parte('weekday'))), minutos: hora * 60 + Number(parte('minute')) };
}

/** En qué franja cae un horario. `undefined` = fuera del horario del centro. */
export function franjaDe(f: Date): Franja | undefined {
  const { minutos } = momentoArgentino(f);
  return FRANJAS.find((n) => minutos >= LIMITES_FRANJA[n].desde && minutos < LIMITES_FRANJA[n].hasta);
}

/** ¿La espera sigue viva? Vence sola: nadie tiene que pasar a limpiar la lista. */
export function vigente(e: EntradaEspera, ahora: Date): boolean {
  return e.hasta.getTime() >= ahora.getTime();
}

/**
 * ¿Este hueco le sirve a esta persona?
 *
 * Se filtra de MÁS a propósito en una sola dimensión —la terapia, no el código
 * exacto de servicio— y de menos en las otras: si dijo "martes a la tarde", un
 * jueves a la mañana no es un aviso útil, es ruido que enseña a ignorar los
 * avisos. Quien lo mira igual es la recepcionista, que llama y confirma.
 */
export function sirveElHueco(e: EntradaEspera, hueco: HuecoLiberado, ahora: Date): boolean {
  if (!vigente(e, ahora)) {
    return false;
  }
  // Un hueco que ya pasó (o que arranca en minutos) no se ofrece: para cuando
  // la recepcionista llame, ya no existe.
  if (hueco.inicio.getTime() <= ahora.getTime()) {
    return false;
  }
  if (hueco.pacienteRef && hueco.pacienteRef === e.pacienteRef) {
    return false;
  }
  if (hueco.categoria !== e.categoria) {
    return false;
  }
  const t = hueco.inicio.getTime();
  if (t < e.desde.getTime() || t > e.hasta.getTime()) {
    return false;
  }
  const { dia } = momentoArgentino(hueco.inicio);
  if (e.dias.length > 0 && !e.dias.includes(dia)) {
    return false;
  }
  const franja = franjaDe(hueco.inicio);
  if (e.franjas.length > 0 && (!franja || !e.franjas.includes(franja))) {
    return false;
  }
  return true;
}

/**
 * A quiénes avisarles del hueco, en orden.
 *
 * **Orden de llegada (FIFO)**: el que pidió primero, primero. Es la única regla
 * que no hay que explicarle a nadie y la única que no se puede discutir en el
 * mostrador. El Manual v9 menciona "prioridad de reserva" para los miembros
 * Pareja de Prime/Healthspan, pero es cualitativo y sin definir (está anotado en
 * `docs/decisiones-pendientes.md`): mientras no haya una regla escrita, meter
 * una prioridad por plan sería inventarla acá.
 */
export function candidatosParaHueco(
  entradas: EntradaEspera[],
  hueco: HuecoLiberado,
  ahora: Date,
  max = CANDIDATOS_EN_AVISO,
): EntradaEspera[] {
  return entradas
    .filter((e) => sirveElHueco(e, hueco, ahora))
    .sort((a, b) => a.creadaEn.getTime() - b.creadaEn.getTime())
    .slice(0, max);
}

/**
 * ¿Alcanza para anotar la espera? Se valida poco: la persona está enfrente y
 * cada campo que rebota es una espera que no se anota. Lo único innegociable es
 * qué espera y hasta cuándo — sin eso no hay a quién avisarle de qué.
 */
export function validarEspera(datos: {
  servicioCodigo?: string;
  hasta?: Date;
  nota?: string;
}): { ok: true } | { ok: false; error: string } {
  if (!datos.servicioCodigo?.trim()) {
    return { ok: false, error: 'Elegí qué está esperando.' };
  }
  if (!datos.hasta || Number.isNaN(datos.hasta.getTime())) {
    return { ok: false, error: 'Poné hasta cuándo espera.' };
  }
  if ((datos.nota ?? '').length > ESPERA_NOTA_MAX) {
    return { ok: false, error: `La nota tiene que entrar en ${ESPERA_NOTA_MAX} caracteres.` };
  }
  return { ok: true };
}

/** Fecha límite por defecto (hoy + `ESPERA_DIAS_DEFAULT`), al cierre de ese día. */
export function vencimientoPorDefecto(ahora: Date, dias = ESPERA_DIAS_DEFAULT): Date {
  return finDelDia(new Date(ahora.getTime() + dias * 24 * 60 * 60 * 1000));
}

/**
 * Fin del día en hora de Argentina. La espera se anota "hasta el 30/08" y eso
 * incluye el 30 entero: con la medianoche del 30 se perdería justo el último día.
 */
export function finDelDia(f: Date): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(f);
  // Argentina no tiene horario de verano desde 2009: el offset es fijo -03:00.
  return new Date(`${ymd}T23:59:59-03:00`);
}

/** "hasta el 30/08" para la UI y los textos. */
export function fechaCorta(f: Date): string {
  const partes = new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
  }).formatToParts(f);
  const parte = (tipo: string): string => partes.find((p) => p.type === tipo)?.value.padStart(2, '0') ?? '';
  return `${parte('day')}/${parte('month')}`;
}

/** "martes 19/08 a las 17:00" — cómo se nombra un turno cuando se lo ofrece. */
export function cuandoLargo(f: Date): string {
  const partes = new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(f);
  const parte = (tipo: string): string => partes.find((p) => p.type === tipo)?.value ?? '';
  return `${parte('weekday')} ${parte('day').padStart(2, '0')}/${parte('month').padStart(2, '0')} a las ${parte(
    'hour',
  ).padStart(2, '0')}:${parte('minute').padStart(2, '0')}`;
}

/**
 * La espera en una línea: qué, cuándo le sirve y hasta cuándo. Es lo que se ve
 * en la lista y lo que tiene que alcanzar para decidir a quién llamar primero.
 */
export function resumenEspera(e: EntradaEspera, nombreServicio?: string): string {
  const partes = [nombreServicio ?? e.servicioCodigo];
  partes.push(
    e.dias.length === 0
      ? 'cualquier día'
      : [...e.dias]
          .sort((a, b) => a - b)
          .map((d) => DIAS_LABEL[d] ?? '')
          .join(' · '),
  );
  if (e.franjas.length > 0) {
    partes.push(e.franjas.map((f) => FRANJAS_LABEL[f].split(' (')[0]?.toLowerCase() ?? f).join(' · '));
  }
  partes.push(`hasta el ${fechaCorta(e.hasta)}`);
  return partes.join(' · ');
}

/**
 * El WhatsApp que se le ofrece a quien espera.
 *
 * No dice "te lo reservamos": el lugar NO queda tomado hasta que Recepción lo
 * reserva, y prometer una reserva que otro puede llevarse en el medio es peor
 * que no avisar. Pide una respuesta, que es lo que la recepcionista necesita
 * para actuar.
 */
export function textoOfertaHueco(hueco: HuecoLiberado, nombreServicio: string): string {
  return (
    `Biowellness: se liberó un lugar de ${nombreServicio} el ${cuandoLargo(hueco.inicio)}. ` +
    'Estabas en la lista de espera: respondé este mensaje y te lo reservamos. ' +
    'Si ya no te sirve, avisanos y seguimos buscándote otro.'
  );
}

/** Título del aviso a Recepción (lo que se lee en la campanita). */
export function tituloAvisoHueco(candidatos: EntradaEspera[]): string {
  return candidatos.length === 1
    ? 'Se liberó un turno y hay alguien esperándolo'
    : `Se liberó un turno y hay ${candidatos.length} esperándolo`;
}

/**
 * El detalle del aviso: cuándo se liberó y a quién llamar, en orden. Va en texto
 * porque es lo que se lee de un vistazo; los datos para los botones viajan
 * aparte, en `Task.input`.
 */
export function detalleAvisoHueco(
  hueco: HuecoLiberado,
  candidatos: EntradaEspera[],
  nombreServicio: string,
): string {
  const quienes = candidatos
    .map((c, i) => `${i + 1}. ${c.pacienteNombre ?? 'Paciente'}${c.telefono ? ` · ${c.telefono}` : ' · sin teléfono'}`)
    .join('\n');
  return (
    `Se liberó ${nombreServicio} del ${cuandoLargo(hueco.inicio)}. ` +
    `Por orden de llegada a la lista de espera:\n${quienes}`
  );
}
