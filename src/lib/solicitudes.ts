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
    `BioWellness · Nueva solicitud de turno.\n${quien} pidió: ${s.terapia.trim()}` +
    (pref ? `.\nPreferencia: ${pref}` : '') +
    (s.nota?.trim() ? `.\nNota: ${s.nota.trim()}` : '') +
    `.\nConfirmala desde la app de Recepción (Solicitudes).`
  );
}
