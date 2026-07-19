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

import { createHmac } from 'node:crypto';

/** Secret de la plantilla genérica de una variable: "{{1}}" con marca. */
export const SECRET_CONTENT_SID_GENERICO = 'TWILIO_CONTENT_SID_GENERICO';

/** Nombre del Project Secret que guarda el Content SID de una plantilla. */
export function nombreSecretContentSid(template: string): string {
  return `TWILIO_CONTENT_SID_${template.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * ContentVariables de Twilio: JSON con claves posicionales "1", "2", …
 * (los placeholders {{1}}, {{2}}… de la plantilla aprobada).
 *
 * WhatsApp NO acepta saltos de línea, tabs ni 4+ espacios seguidos dentro de una
 * variable, ni valores vacíos (error 21656): se aplana todo a espacios simples y
 * un valor vacío se reemplaza por un guion.
 */
export function contentVariables(vars: string[]): string {
  const limpiar = (v: string): string => v.replace(/\s+/g, ' ').trim() || '—';
  return JSON.stringify(Object.fromEntries(vars.map((v, i) => [String(i + 1), limpiar(v)])));
}

/**
 * Variantes de un teléfono para buscar la ficha por igualdad exacta en telecom
 * (la búsqueda FHIR no normaliza). Acepta el "From" de Twilio ("whatsapp:+549…").
 * Para móviles argentinos (+54 9 …) genera las formas habituales de carga:
 * con/sin "+", con/sin el 9, y el área+línea pelado (10 dígitos).
 */
export function variantesTelefono(valor?: string): string[] {
  const crudo = (valor ?? '').replace(/^whatsapp:/i, '').trim();
  const digitos = crudo.replace(/\D/g, '');
  if (digitos.length < 8) {
    return [];
  }
  const set = new Set<string>();
  if (crudo) {
    set.add(crudo);
  }
  set.add(`+${digitos}`);
  set.add(digitos);
  if (digitos.startsWith('549') && digitos.length === 13) {
    const diez = digitos.slice(3); // área + línea (ej. 1169315830)
    set.add(diez);
    set.add(`9${diez}`);
    set.add(`54${diez}`);
    set.add(`+54${diez}`);
  }
  set.add(digitos.slice(-10));
  return [...set].filter(Boolean);
}

/** Un adjunto entrante de Twilio (foto, PDF, audio) tal como llega en el form. */
export interface MedioTwilio {
  url: string;
  contentType: string;
}

/**
 * Extrae los adjuntos del form de un webhook de Twilio: `NumMedia` indica la
 * cantidad y cada uno viene como `MediaUrl0`/`MediaContentType0`, `MediaUrl1`/…
 * Las URLs requieren la autenticación Basic de la cuenta para descargarse.
 */
export function mediosTwilio(params: Record<string, unknown>, maximo = 5): MedioTwilio[] {
  const n = Math.min(Number(params['NumMedia'] ?? '0') || 0, maximo);
  const medios: MedioTwilio[] = [];
  for (let i = 0; i < n; i++) {
    const url = params[`MediaUrl${i}`];
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      const tipo = params[`MediaContentType${i}`];
      medios.push({ url, contentType: typeof tipo === 'string' && tipo ? tipo : 'application/octet-stream' });
    }
  }
  return medios;
}

/** Extensión de archivo para un content-type de WhatsApp (para nombrar el adjunto). */
export function extensionDeMime(contentType?: string): string {
  const mapa: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/amr': 'amr',
    'video/mp4': 'mp4',
    'text/vcard': 'vcf',
  };
  return mapa[(contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''] ?? 'bin';
}

/**
 * Valida la firma `X-Twilio-Signature` de un webhook: HMAC-SHA1 en base64 del
 * URL público + los parámetros del form ordenados alfabéticamente (clave+valor),
 * con el Auth Token como clave. https://www.twilio.com/docs/usage/security
 */
export function validarFirmaTwilio(
  urlPublica: string,
  params: Record<string, unknown>,
  firma: string | undefined,
  authToken: string,
): boolean {
  if (!firma) {
    return false;
  }
  const data =
    urlPublica +
    Object.keys(params)
      .sort()
      .map((k) => `${k}${String(params[k] ?? '')}`)
      .join('');
  const esperada = createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  return esperada === firma;
}

/**
 * Normaliza un teléfono de la ficha al E.164 que exige Twilio para ENVIAR
 * ("whatsapp:+549..."). Es el espejo de `variantesTelefono`: para entrar
 * probamos todas las formas; para salir hay que mandar UNA, la canónica.
 * Heurística para móviles argentinos; los internacionales con "+" pasan tal cual.
 * Devuelve undefined si el valor no alcanza para armar un número válido.
 */
export function aE164Argentino(valor?: string): string | undefined {
  const crudo = (valor ?? '').replace(/^whatsapp:/i, '').trim();
  if (!crudo) {
    return undefined;
  }
  let d = crudo.replace(/\D/g, '');
  if (d.startsWith('00')) {
    d = d.slice(2);
  }
  if (d.length < 8) {
    return undefined;
  }
  if (d.startsWith('549') && d.length === 13) {
    return `+${d}`;
  }
  if (d.startsWith('54') && d.length === 12) {
    return `+549${d.slice(2)}`; // móvil cargado sin el 9
  }
  if (d.startsWith('9') && d.length === 11) {
    return `+54${d}`;
  }
  if (d.startsWith('0') && d.length === 11) {
    return `+549${d.slice(1)}`; // "011 6931-5830"
  }
  if (d.length === 10) {
    return `+549${d}`; // área + línea pelado ("1169315830")
  }
  if (crudo.startsWith('+') || d.length >= 11) {
    return `+${d}`; // internacional
  }
  return undefined;
}
