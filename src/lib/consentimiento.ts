/**
 * Consentimiento informado — lógica pura (sin FHIR ni red).
 *
 * Contexto: hasta 2026-08-13 R-03 funcionaba como AUTODECLARACIÓN — la
 * recepcionista tildaba un switch y ese booleano moría al validar (no quedaba
 * registro de quién declaró qué). Esto es el primer paso para que el sistema
 * lo sepa en vez de preguntarlo (CLAUDE.md, principio 1).
 *
 * Regla de oro de este módulo: **falla CERRADO**. Un error de lectura no puede
 * parecerse a "el paciente firmó". Por eso hay tres estados y no un booleano:
 * un `?? false` haría que un 403 se lea como "no firmó" (y la recepcionista no
 * entiende por qué está bloqueada), y un `?? true` habilitaría una Terapia
 * Biológica sin respaldo — justo lo que R-03 vino a frenar.
 */

export type EstadoConsentimiento =
  /** Hay un consentimiento activo y vigente de esa categoría. */
  | 'firmado'
  /** Se pudo consultar y no hay ninguno: el paciente todavía no firmó. */
  | 'no-registrado'
  /** No se pudo consultar (permisos, red, bot sin deployar). NO es "no firmó". */
  | 'no-verificable';

/** Consentimiento tal como lo necesita esta lógica (proyección de `Consent`). */
export interface RegistroConsentimiento {
  /** `Consent.status`: solo 'active' cuenta como firmado. */
  estado?: string;
  /** `Consent.dateTime`: cuándo se firmó (ISO). */
  fechaISO?: string;
  /** Código dentro de SYSTEM.consentimiento (COD_CONSENTIMIENTO). */
  codigo?: string;
}

export interface ResultadoConsentimiento {
  estado: EstadoConsentimiento;
  /** Fecha de la firma más reciente (ISO), solo cuando está firmado. */
  fechaISO?: string;
}

export interface OpcionesConsentimiento {
  /** Si se pasa, solo cuentan los consentimientos de esa categoría. */
  codigo?: string;
  ahora?: Date;
  /**
   * Vigencia en meses: pasado ese plazo el consentimiento deja de contar.
   * Sin valor, no vence (default hasta que Andrés defina lo contrario).
   */
  vigenciaMeses?: number;
}

/**
 * Estado del consentimiento del paciente.
 *
 * @param registros `undefined` = NO se pudo consultar (→ 'no-verificable').
 *                  Lista vacía = se consultó y no hay nada (→ 'no-registrado').
 */
export function estadoConsentimiento(
  registros: readonly RegistroConsentimiento[] | undefined,
  opts: OpcionesConsentimiento = {},
): ResultadoConsentimiento {
  if (registros === undefined) {
    return { estado: 'no-verificable' };
  }
  const ahora = opts.ahora ?? new Date();
  const vigentes = registros
    .filter((r) => r.estado === 'active')
    .filter((r) => !opts.codigo || r.codigo === opts.codigo)
    .filter((r) => dentroDeVigencia(r.fechaISO, ahora, opts.vigenciaMeses));

  if (vigentes.length === 0) {
    return { estado: 'no-registrado' };
  }
  // La firma más reciente es la que se muestra.
  const fechas = vigentes.map((r) => r.fechaISO).filter((f): f is string => Boolean(f));
  const fechaISO = fechas.sort().at(-1);
  return { estado: 'firmado', ...(fechaISO ? { fechaISO } : {}) };
}

function dentroDeVigencia(fechaISO: string | undefined, ahora: Date, vigenciaMeses?: number): boolean {
  if (!vigenciaMeses) {
    return true; // sin vigencia definida, no vence
  }
  if (!fechaISO) {
    return false; // con vigencia definida, uno sin fecha no se puede validar
  }
  const firma = new Date(fechaISO);
  if (Number.isNaN(firma.getTime())) {
    return false;
  }
  const vence = new Date(firma);
  vence.setMonth(vence.getMonth() + vigenciaMeses);
  return vence.getTime() > ahora.getTime();
}

/**
 * ¿Alcanza para dar por cumplido R-03 sin que la recepcionista declare nada?
 * Solo 'firmado'. 'no-verificable' NO alcanza: ante la duda, que lo declare a
 * mano (y quede registrado quién lo hizo).
 */
export function cumpleR03(estado: EstadoConsentimiento): boolean {
  return estado === 'firmado';
}

/** Texto para la recepcionista. Nunca incluye contenido clínico. */
export function textoConsentimiento(r: ResultadoConsentimiento): string {
  switch (r.estado) {
    case 'firmado':
      return r.fechaISO
        ? `Firmado desde el portal el ${new Intl.DateTimeFormat('es-AR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            timeZone: 'America/Argentina/Buenos_Aires',
          }).format(new Date(r.fechaISO))}`
        : 'Firmado desde el portal';
    case 'no-registrado':
      return 'Sin consentimiento firmado en el portal';
    case 'no-verificable':
      return 'No se pudo verificar contra el portal';
  }
}
