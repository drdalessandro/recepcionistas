/**
 * Solicitudes de turno desde el portal del paciente (modelo de "solicitud").
 *
 * El paciente **pide** un turno (terapia + preferencia de horario); Recepción lo
 * **confirma** con los bots de reserva (que aplican las reglas: R-01 HBOT primero,
 * R-07 capacidad/desfasaje, R-13 ventana, seña 50%). El portal nunca escribe la
 * agenda ni decide nada: solo registra la preferencia.
 *
 * Lógica pura (sin FHIR ni red): valida la solicitud y arma los textos. El bot
 * `bw-solicitar-turno` orquesta (crea el `Task` y avisa a Recepción).
 */
export interface SolicitudTurno {
  /** Paciente que pide, ej. "Patient/123". */
  pacienteRef: string;
  /** Terapia elegida (texto que vio el paciente, ej. "Cámara hiperbárica (HBOT)"). */
  terapia: string;
  /** Código de categoría de la terapia, si el portal lo manda (ej. "HBOT"). */
  terapiaCodigo?: string;
  /** Fecha/hora preferida en ISO (opcional). */
  preferenciaInicio?: string;
  /** Preferencia en texto libre (ej. "jueves a la tarde"), si no eligió fecha. */
  preferenciaTexto?: string;
  /** Nota libre del paciente. */
  nota?: string;
}

export interface SolicitudValidacion {
  ok: boolean;
  error?: string;
}

const RE_PATIENT_REF = /^Patient\/[A-Za-z0-9\-.]+$/;
const MAX_TEXTO = 500;

/** Valida una solicitud antes de crear el Task. No decide reglas de agenda. */
export function validarSolicitud(s: SolicitudTurno): SolicitudValidacion {
  if (!s.pacienteRef || !RE_PATIENT_REF.test(s.pacienteRef)) {
    return { ok: false, error: 'Falta el paciente de la solicitud.' };
  }
  if (!s.terapia?.trim()) {
    return { ok: false, error: 'Elegí una terapia para tu solicitud.' };
  }
  if (s.preferenciaInicio && Number.isNaN(new Date(s.preferenciaInicio).getTime())) {
    return { ok: false, error: 'La fecha/hora preferida no es válida.' };
  }
  if ((s.nota?.length ?? 0) > MAX_TEXTO || (s.preferenciaTexto?.length ?? 0) > MAX_TEXTO) {
    return { ok: false, error: 'El texto es demasiado largo.' };
  }
  return { ok: true };
}

/**
 * ¿Qué solicitud pendiente se da por RESUELTA cuando se reserva un turno?
 * Regla determinista (sin adivinar):
 *  - una sola pendiente → esa (el caso normal);
 *  - varias → la primera cuya terapia (código de servicio o categoría) coincida
 *    con lo reservado;
 *  - varias sin coincidencia → ninguna (se resuelve a mano, no cerramos de más).
 * Devuelve el índice en el array, o -1.
 */
export function indiceSolicitudAResolver(
  solicitudes: Array<{ terapiaCodigo?: string }>,
  codigosReservados: string[],
): number {
  if (solicitudes.length === 0) {
    return -1;
  }
  if (solicitudes.length === 1) {
    return 0;
  }
  return solicitudes.findIndex((s) => Boolean(s.terapiaCodigo) && codigosReservados.includes(s.terapiaCodigo as string));
}

const fmtFechaHora = new Intl.DateTimeFormat('es-AR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});

/** Preferencia de horario legible (fecha elegida o texto libre). */
export function preferenciaLegible(s: SolicitudTurno): string | undefined {
  if (s.preferenciaInicio) {
    const d = new Date(s.preferenciaInicio);
    if (!Number.isNaN(d.getTime())) {
      return fmtFechaHora.format(d);
    }
  }
  return s.preferenciaTexto?.trim() || undefined;
}

/** Resumen humano para `Task.description` (lo lee Recepción). */
export function resumenSolicitud(s: SolicitudTurno): string {
  const partes = [`Solicitud de turno: ${s.terapia.trim()}`];
  const pref = preferenciaLegible(s);
  if (pref) {
    partes.push(`Preferencia: ${pref}`);
  }
  if (s.nota?.trim()) {
    partes.push(`Nota: ${s.nota.trim()}`);
  }
  return partes.join('. ') + '.';
}

/** Texto del WhatsApp de aviso a Recepción cuando entra una solicitud. */
export function mensajeWhatsAppRecepcion(s: SolicitudTurno, nombrePaciente?: string): string {
  const quien = nombrePaciente?.trim() || 'Un paciente';
  const pref = preferenciaLegible(s);
  return (
    `Biowellness · Nueva solicitud de turno.\n${quien} pidió: ${s.terapia.trim()}` +
    (pref ? `.\nPreferencia: ${pref}` : '') +
    (s.nota?.trim() ? `.\nNota: ${s.nota.trim()}` : '') +
    `.\nConfirmala desde la app de Recepción (Solicitudes).`
  );
}

// ============================================================================
// Limpieza de solicitudes ya cerradas (`npm run limpiar:solicitudes`).
// ============================================================================

/**
 * Estados en los que una solicitud está CERRADA: nadie la está trabajando.
 *
 * La lista es corta a propósito. `requested`, `received`, `accepted` e
 * `in-progress` son trabajo vivo —están en la bandeja de Recepción y
 * `disponibilidadDePaciente` les reserva el horario— y borrar una sería
 * hacerle desaparecer a alguien el pedido de abajo de las manos.
 *
 * `cancelled` entra porque existe de verdad: `bw-fusionar-paciente` cancela las
 * solicitudes de la ficha que absorbe.
 */
const ESTADOS_CERRADOS = new Set(['completed', 'cancelled']);

export interface SolicitudCerrable {
  status?: string;
  /** `meta.lastUpdated`: la última vez que alguien la tocó. */
  ultimaActividad?: string;
}

/**
 * ¿Esta solicitud se puede borrar?
 *
 * Dos condiciones, las dos necesarias: que esté cerrada y que haga `dias` que
 * nadie la toca.
 *
 * Se mide por **última actividad** y no por `authoredOn` (cuándo pidió el
 * turno) porque lo que importa es hace cuánto se cerró, no hace cuánto se
 * pidió: una solicitud de hace dos meses resuelta ayer todavía es reciente para
 * quien la resolvió.
 *
 * **Sin fecha no se borra.** Un recurso sin `meta.lastUpdated` no se puede
 * juzgar, y ante la duda un script destructivo se abstiene.
 */
export function solicitudBorrable(t: SolicitudCerrable, opts: { ahora: Date; dias: number }): boolean {
  if (!t.status || !ESTADOS_CERRADOS.has(t.status)) {
    return false;
  }
  if (!t.ultimaActividad) {
    return false;
  }
  const cerradaEn = new Date(t.ultimaActividad).getTime();
  if (Number.isNaN(cerradaEn)) {
    return false;
  }
  const corte = opts.ahora.getTime() - Math.max(0, opts.dias) * 24 * 60 * 60 * 1000;
  return cerradaEn <= corte;
}
