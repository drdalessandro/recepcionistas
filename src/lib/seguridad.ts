/**
 * Banner de seguridad de Recepción — lógica pura (sin FHIR ni red).
 *
 * El problema que resuelve: hasta 2026-08-14 el banner tenía dos estados y los
 * derivaba SOLO de los `Flag` activos. Sin Flags pintaba verde y afirmaba
 * "Paciente apto para atención" — incluso para un paciente creado hace treinta
 * segundos en el mostrador, que nunca contestó una pregunta de screening. Eso no
 * es conocimiento: es **ausencia de datos**, y la recepcionista no tenía cómo
 * distinguir un caso del otro. Peor: un error de lectura también pintaba verde.
 *
 * Regla de oro de este módulo, la misma que `consentimiento.ts`: **falla
 * CERRADO**. "No sé" nunca puede parecerse a "está todo bien". Acá el costo del
 * error no es administrativo: es meter a alguien en una cámara hiperbárica con
 * una contraindicación absoluta (R-02).
 *
 * Qué NO hace: la recepción sigue sin ver el detalle clínico. De este módulo sale
 * un color y una frase, nunca qué contraindicación tiene ni qué contestó
 * (CLAUDE.md, principio 3).
 */

export type EstadoSeguridad =
  /** Hay al menos una contraindicación activa. No avanzar sin el equipo médico. */
  | 'contraindicado'
  /**
   * El cuestionario de ingreso tiene respuestas de riesgo (declaró una
   * condición descalificante). Requiere revisión médica antes de HBOT/IHHT.
   */
  | 'riesgo-declarado'
  /** Completó el screening sin riesgos y no tiene contraindicaciones: apto. */
  | 'apto'
  /** Nunca completó el cuestionario de ingreso: NO se sabe si es apto. */
  | 'sin-screening'
  /** No se pudo consultar (permisos, red, bot sin deployar). NO es "apto". */
  | 'no-verificable';

/** Color del banner. `gris` = no hay señal (sin screening o no verificable). */
export type ColorSeguridad = 'verde' | 'rojo' | 'gris';

export interface ResultadoSeguridad {
  estado: EstadoSeguridad;
  color: ColorSeguridad;
  /** ¿Se puede seguir sin intervención? Solo 'apto'. */
  puedeAvanzar: boolean;
}

export interface EntradaSeguridad {
  /**
   * Códigos de contraindicación activos del paciente.
   * `undefined` = no se pudieron leer (→ 'no-verificable'), distinto de `[]`,
   * que significa "se leyeron y no hay ninguna".
   */
  contraindicacionesActivas?: readonly string[];
  /**
   * ¿Completó el cuestionario de ingreso (que incluye el screening HBOT/IHHT)?
   * `undefined` = no se pudo averiguar (→ 'no-verificable').
   */
  screeningCompleto?: boolean;
  /**
   * Cuántas preguntas de RIESGO del screening contestó afirmativamente.
   * `undefined` = no se pudo evaluar (→ 'no-verificable'). El bug que cierra
   * este campo (2026-08-28): el screening se daba por bueno con solo EXISTIR —
   * declarar un neumotórax no tratado producía el mismo "apto" que negar todo.
   */
  riesgosScreening?: number;
}

/**
 * Estado de seguridad del paciente para el banner de Recepción.
 *
 * El orden de evaluación importa y es deliberado:
 *  1. Una contraindicación conocida manda sobre todo lo demás (aunque falte el
 *     screening: si ya sabemos que hay un problema, no hace falta saber más).
 *  2. Un riesgo DECLARADO en el screening también manda: es conocimiento, no
 *     ausencia de datos.
 *  3. Si algo no se pudo leer → 'no-verificable'.
 *  4. Sin screening → 'sin-screening': no afirmamos nada que no sepamos.
 *  5. Recién ahí, 'apto'.
 */
export function estadoSeguridad(entrada: EntradaSeguridad): ResultadoSeguridad {
  const { contraindicacionesActivas, screeningCompleto, riesgosScreening } = entrada;

  if (contraindicacionesActivas && contraindicacionesActivas.length > 0) {
    return { estado: 'contraindicado', color: 'rojo', puedeAvanzar: false };
  }
  if (riesgosScreening !== undefined && riesgosScreening > 0) {
    return { estado: 'riesgo-declarado', color: 'rojo', puedeAvanzar: false };
  }
  if (contraindicacionesActivas === undefined || screeningCompleto === undefined) {
    return { estado: 'no-verificable', color: 'gris', puedeAvanzar: false };
  }
  if (!screeningCompleto) {
    return { estado: 'sin-screening', color: 'gris', puedeAvanzar: false };
  }
  // Screening completo pero SIN evaluar: un caller viejo que no mire las
  // respuestas no puede producir un "apto" por omisión — ese era el bug.
  if (riesgosScreening === undefined) {
    return { estado: 'no-verificable', color: 'gris', puedeAvanzar: false };
  }
  return { estado: 'apto', color: 'verde', puedeAvanzar: true };
}

/** Título del banner. Nunca incluye contenido clínico. */
export function tituloSeguridad(estado: EstadoSeguridad): string {
  switch (estado) {
    case 'contraindicado':
      return 'Atención: contraindicación activa';
    case 'riesgo-declarado':
      return 'Atención: el cuestionario declara riesgos';
    case 'apto':
      return 'Sin contraindicaciones';
    case 'sin-screening':
      return 'Falta el cuestionario de ingreso';
    case 'no-verificable':
      return 'No se pudo verificar la seguridad';
  }
}

/**
 * Qué tiene que hacer la recepcionista. La diferencia entre 'sin-screening' y
 * 'no-verificable' importa en el mostrador: en el primer caso la acción es del
 * paciente (completar el cuestionario, se le manda el link); en el segundo es
 * nuestra (un problema del sistema que hay que escalar).
 */
export function accionSeguridad(estado: EstadoSeguridad): string {
  switch (estado) {
    case 'contraindicado':
      return 'Consultar con el equipo médico antes de continuar.';
    case 'riesgo-declarado':
      return 'En el cuestionario de ingreso el paciente declaró condiciones que requieren revisión médica. No reserves HBOT ni IHHT sin autorización del equipo médico.';
    case 'apto':
      return 'Paciente apto para atención.';
    case 'sin-screening':
      return 'Todavía no completó el cuestionario de ingreso, así que no sabemos si puede recibir HBOT o IHHT. Mandale el link desde "Invitar al portal" y esperá a que lo complete antes de reservar.';
    case 'no-verificable':
      return 'No pudimos consultar el estado de seguridad del paciente. No avances con terapias sin confirmarlo con el equipo médico.';
  }
}
