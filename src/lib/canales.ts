/**
 * Canales de acceso (docs/canales-acceso.md) — lógica pura de links medibles.
 *
 * Decisión cerrada: **WhatsApp para todo, portal para autogestión**. Cada pieza
 * (bio de Instagram, post de LinkedIn, QR impreso, ficha de Google) apunta al
 * `wa.me` del número productivo con un TEXTO PREFIJADO distinto por canal: el
 * mensaje llega con esa marca y Recepción (y el CRM) saben de dónde vino sin
 * preguntar. Los links al portal, en cambio, se miden con UTM clásico.
 */
import type { OrigenLead } from '../fhir/identifiers.js';

/** Número productivo de WhatsApp (E.164 sin '+'; el de wa.me). */
export const WHATSAPP_NUMERO = '5491162470002';

/** URL base del portal del paciente (autogestión). */
export const PORTAL_URL = 'https://app.biowellness.ar';

/** Link wa.me con texto prefijado (el texto identifica el canal al llegar). */
export function linkWhatsApp(texto: string, numero: string = WHATSAPP_NUMERO): string {
  return `https://wa.me/${numero.replace(/\D/g, '')}?text=${encodeURIComponent(texto)}`;
}

/** Link al portal con UTM del canal (medición en analytics). */
export function linkPortal(origen: OrigenLead, base: string = PORTAL_URL): string {
  return `${base}/?utm_source=${encodeURIComponent(origen)}&utm_medium=qr&utm_campaign=canales`;
}

export interface CanalQR {
  /** Código canónico del canal (mismo que origen-lead). */
  origen: OrigenLead;
  /** Nombre para el archivo/imprenta. */
  nombre: string;
  /** Texto prefijado del wa.me: la "marca" del canal en el primer mensaje. */
  texto: string;
}

/**
 * QRs a generar: uno por canal, todos apuntando a WhatsApp (decisión canónica).
 * El texto arranca igual ("Hola") y termina con la marca entre paréntesis:
 * corto, natural y fácil de detectar a ojo en la bandeja.
 */
export const CANALES_QR: CanalQR[] = [
  { origen: 'instagram', nombre: 'Instagram (bio y stories)', texto: '¡Hola BioWellness! Quiero más info 🌿 (vengo de Instagram)' },
  { origen: 'linkedin', nombre: 'LinkedIn (posts)', texto: '¡Hola BioWellness! Quiero más info (los vi en LinkedIn)' },
  { origen: 'qr-local', nombre: 'QR impreso en el local', texto: '¡Hola! Estoy en BioWellness y quiero más info (QR del local)' },
  { origen: 'qr-evento', nombre: 'QR para eventos y flyers', texto: '¡Hola BioWellness! Quiero más info (los conocí en un evento)' },
  { origen: 'web', nombre: 'Sitio web (botón WhatsApp)', texto: '¡Hola BioWellness! Quiero más info (vengo de la web)' },
  { origen: 'referido', nombre: 'Referidos (link para compartir)', texto: '¡Hola BioWellness! Me los recomendaron y quiero más info' },
  { origen: 'google', nombre: 'Google (ficha del negocio)', texto: '¡Hola BioWellness! Quiero más info (los encontré en Google)' },
];
