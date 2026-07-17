/**
 * Lógica pura de plantillas de WhatsApp (Twilio Content API, sin red).
 *
 * En producción, los mensajes que inicia BioWellness fuera de la ventana de 24 h
 * requieren plantillas aprobadas por Meta. Cada plantilla aprobada en Twilio tiene
 * un Content SID (`HX...`) que se carga como Project Secret; el nombre del secret
 * se deriva del nombre de la plantilla interna del bot:
 *   'turno-confirmado'  → TWILIO_CONTENT_SID_TURNO_CONFIRMADO
 *   'recordatorio-48h'  → TWILIO_CONTENT_SID_RECORDATORIO_48H
 * Si no hay secret específico, se usa el genérico (plantilla de una variable con
 * el texto completo), y si tampoco está, texto libre (sandbox / ventana de 24 h).
 * Ver docs/whatsapp-plantillas.md.
 */

/** Secret de la plantilla genérica de una variable: "{{1}}" con marca. */
export const SECRET_CONTENT_SID_GENERICO = 'TWILIO_CONTENT_SID_GENERICO';

/** Nombre del Project Secret que guarda el Content SID de una plantilla. */
export function nombreSecretContentSid(template: string): string {
  return `TWILIO_CONTENT_SID_${template.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * ContentVariables de Twilio: JSON con claves posicionales "1", "2", …
 * (los placeholders {{1}}, {{2}}… de la plantilla aprobada).
 */
export function contentVariables(vars: string[]): string {
  return JSON.stringify(Object.fromEntries(vars.map((v, i) => [String(i + 1), v])));
}
