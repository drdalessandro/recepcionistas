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
import { PORTAL_URL } from './onboarding.js';

/** Número productivo de WhatsApp (E.164 sin '+'; el de wa.me). */
export const WHATSAPP_NUMERO = '5491162470002';

/** URL base del portal (fuente de verdad: onboarding.ts — una sola, sin deriva). */
export { PORTAL_URL };

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
/** Sin origen cargado (fichas anteriores a la regla o altas incompletas). */
export const SIN_ORIGEN = '(sin datos)';

export interface PacienteCanal {
  id: string;
  /** Código de origen-lead de la ficha (undefined si no está cargado). */
  origen?: string;
  /** Fecha de alta (valueDate YYYY-MM-DD); undefined en fichas viejas. */
  fechaAlta?: string;
}

export interface FilaCanal {
  origen: string;
  clientes: number;
  /** Clientes del canal con al menos un turno confirmado/realizado. */
  conTurno: number;
  /** Clientes del canal con al menos un pago registrado. */
  conPago: number;
  /** Clientes del canal que se hicieron socios (membresía activa). */
  socios: number;
}

/**
 * Resumen del CRM: clientes por canal con conversión a turno, a pago y a socio.
 * Ordena por volumen (desc) y deja "(sin datos)" siempre al final.
 * Es la misma agregación que hace el kpis-crm de Administración.
 */
export function resumenPorCanal(
  pacientes: PacienteCanal[],
  conTurno: ReadonlySet<string>,
  conPago: ReadonlySet<string>,
  esSocio: ReadonlySet<string> = new Set(),
): FilaCanal[] {
  const filas = new Map<string, FilaCanal>();
  for (const p of pacientes) {
    const origen = p.origen?.trim() || SIN_ORIGEN;
    const fila = filas.get(origen) ?? { origen, clientes: 0, conTurno: 0, conPago: 0, socios: 0 };
    fila.clientes++;
    if (conTurno.has(p.id)) {
      fila.conTurno++;
    }
    if (conPago.has(p.id)) {
      fila.conPago++;
    }
    if (esSocio.has(p.id)) {
      fila.socios++;
    }
    filas.set(origen, fila);
  }
  return [...filas.values()].sort((a, b) => {
    if (a.origen === SIN_ORIGEN) {
      return 1;
    }
    if (b.origen === SIN_ORIGEN) {
      return -1;
    }
    return b.clientes - a.clientes || a.origen.localeCompare(b.origen);
  });
}

/** Sin fecha de alta (fichas anteriores al lanzamiento del 10/08/2026). */
export const SIN_FECHA = '(sin fecha)';

export interface AltasMes {
  /** Mes calendario 'YYYY-MM' (o SIN_FECHA para fichas sin fecha-alta). */
  mes: string;
  total: number;
  /** Desglose por canal, de mayor a menor. */
  porCanal: Array<{ origen: string; clientes: number }>;
}

/**
 * Cohortes mensuales de altas por canal (para el gráfico del AdminDashboard).
 * Meses ascendentes; las fichas sin fecha-alta van juntas al final.
 */
export function altasPorMes(pacientes: PacienteCanal[]): AltasMes[] {
  const meses = new Map<string, Map<string, number>>();
  for (const p of pacientes) {
    const mes = p.fechaAlta?.slice(0, 7) || SIN_FECHA;
    const origen = p.origen?.trim() || SIN_ORIGEN;
    const porCanal = meses.get(mes) ?? new Map<string, number>();
    porCanal.set(origen, (porCanal.get(origen) ?? 0) + 1);
    meses.set(mes, porCanal);
  }
  return [...meses.entries()]
    .sort(([a], [b]) => {
      if (a === SIN_FECHA) {
        return 1;
      }
      if (b === SIN_FECHA) {
        return -1;
      }
      return a.localeCompare(b);
    })
    .map(([mes, porCanal]) => {
      const desglose = [...porCanal.entries()]
        .map(([origen, clientes]) => ({ origen, clientes }))
        .sort((a, b) => b.clientes - a.clientes || a.origen.localeCompare(b.origen));
      return { mes, total: desglose.reduce((acc, d) => acc + d.clientes, 0), porCanal: desglose };
    });
}

export const CANALES_QR: CanalQR[] = [
  { origen: 'instagram', nombre: 'Instagram (bio y stories)', texto: '¡Hola BioWellness! Quiero más info 🌿 (vengo de Instagram)' },
  { origen: 'linkedin', nombre: 'LinkedIn (posts)', texto: '¡Hola BioWellness! Quiero más info (los vi en LinkedIn)' },
  { origen: 'qr-local', nombre: 'QR impreso en el local', texto: '¡Hola! Estoy en BioWellness y quiero más info (QR del local)' },
  { origen: 'qr-evento', nombre: 'QR para eventos y flyers', texto: '¡Hola BioWellness! Quiero más info (los conocí en un evento)' },
  { origen: 'web', nombre: 'Sitio web (botón WhatsApp)', texto: '¡Hola BioWellness! Quiero más info (vengo de la web)' },
  { origen: 'referido', nombre: 'Referidos (link para compartir)', texto: '¡Hola BioWellness! Me los recomendaron y quiero más info' },
  { origen: 'google', nombre: 'Google (ficha del negocio)', texto: '¡Hola BioWellness! Quiero más info (los encontré en Google)' },
];
