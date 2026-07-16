/**
 * Lógica pura de deduplicación de fichas (sin FHIR ni red).
 * La usa el bot bw-dedup-paciente; se testea en tests/dedup.test.ts.
 */

/** Email normalizado para matching (trim + lowercase). Vacío → undefined. */
export function normalizarEmail(v?: string): string | undefined {
  const e = v?.trim().toLowerCase();
  return e || undefined;
}

/** Solo los dígitos de un valor ("30.123.456" → "30123456"). */
export function soloDigitos(v?: string): string {
  return (v ?? '').replace(/\D/g, '');
}

/** "30123456" → "30.123.456" (formato habitual del DNI argentino, 7-8 dígitos). */
export function formatearDniConPuntos(digitos: string): string {
  if (digitos.length < 7 || digitos.length > 8) {
    return digitos;
  }
  const ultimos3 = digitos.slice(-3);
  const medios3 = digitos.slice(-6, -3);
  const primeros = digitos.slice(0, -6);
  return `${primeros}.${medios3}.${ultimos3}`;
}

/**
 * Variantes de un DNI/identificador para buscar por igualdad exacta (la búsqueda
 * token FHIR no normaliza): el valor tal cual, solo dígitos y con puntos.
 * Cubre fichas cargadas como "30123456" y como "30.123.456" sin importar cómo
 * lo tipearon en cada lado. Devuelve [] si no parece un documento (< 6 dígitos).
 */
export function variantesDni(valor?: string): string[] {
  const crudo = valor?.trim() ?? '';
  const digitos = soloDigitos(crudo);
  if (digitos.length < 6) {
    return [];
  }
  return [...new Set([crudo, digitos, formatearDniConPuntos(digitos)])].filter(Boolean);
}

/**
 * Idempotencia durable del descarte: dados los ids de candidatos ya revisados en
 * tareas anteriores (abiertas, descartadas o completadas), deja solo los NUEVOS.
 * Así "No es duplicado" no se reabre en cada update de la ficha (familiares que
 * comparten teléfono/email), pero un duplicado genuinamente nuevo sí se detecta.
 */
export function candidatosNuevos<T extends { id: string }>(candidatos: T[], yaRevisados: ReadonlySet<string>): T[] {
  return candidatos.filter((c) => !yaRevisados.has(c.id));
}
