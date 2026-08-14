/**
 * Leads del mostrador — lógica pura.
 *
 * El caso 1 del recorrido del walk-in: alguien pasa, entra, pregunta y se va.
 * Hoy no deja rastro, así que el local —el canal más caro— es el único que no se
 * puede medir. Y como no todos quieren dar sus datos, el registro tiene que
 * funcionar **aunque no haya nombre**: lo que importa para medir es el evento.
 *
 * Un lead NO es un recurso nuevo: el CRM ya decidió que es un `Patient` con
 * `ciclo-vida-cliente = lead` (ver `src/fhir/identifiers.ts`). Acá vive solo lo
 * que hay que decidir antes de escribirlo.
 */

import { PEDIDO_OTRA_COSA, validarPedido } from './demanda.js';

/** Etiqueta de un lead sin nombre, para que la tarjeta del CRM sea legible. */
const PREFIJO_ANONIMO = 'Consulta en el mostrador';

export interface DatosLead {
  nombre?: string;
  telefono?: string;
  /** Qué vino a preguntar (servicio, categoría o texto libre). */
  interes?: string;
  /**
   * Caso 11: qué pidió, cuando pidió algo que **no ofrecemos** (`interes` =
   * "Otra cosa"). Cambia lo que hay que hacer con el lead: no es "contactar
   * para venderle X", es "avisarle si algún día lo tenemos".
   */
  pedido?: string;
  /**
   * A quién acompañaba, si vino con un paciente. Es el dato de más valor
   * comercial de este lead: le da a quien lo trabaja un ángulo de conversación
   * ("viniste con Julio") y prueba social. Va en el texto, no en un recurso
   * nuevo: el CRM no leería una extensión que no conoce.
   */
  acompanaA?: string;
}

/**
 * Nombre con el que se guarda el lead.
 *
 * Si dejó su nombre, ese. Si no, uno descriptivo con la fecha: en el kanban del
 * CRM una tarjeta sin nombre es indistinguible de otra, y "Consulta en el
 * mostrador · 14/08 15:30" se lee y se ubica. Inventar un nombre falso sería
 * peor: quedaría en la ficha como si fuera el suyo.
 */
export function nombreDeLead(datos: DatosLead, ahora: Date): string {
  const propio = datos.nombre?.trim();
  if (propio) {
    return propio;
  }
  // Se arma por partes y se padea a mano: `es-AR` ignora el `2-digit` del mes
  // (devuelve "14/8") y acá conviene que el formato sea siempre el mismo.
  const partes = new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Argentina/Buenos_Aires',
  }).formatToParts(ahora);
  const parte = (tipo: string): string => partes.find((p) => p.type === tipo)?.value.padStart(2, '0') ?? '';
  return `${PREFIJO_ANONIMO} · ${parte('day')}/${parte('month')} ${parte('hour')}:${parte('minute')}`;
}

/** ¿Se guardó sin identidad? (útil para no ofrecer acciones que necesitan contacto). */
export function esLeadAnonimo(nombre: string | undefined): boolean {
  return Boolean(nombre?.startsWith(PREFIJO_ANONIMO));
}

/**
 * ¿Pidió algo que hoy NO ofrecemos? (caso 11 del walk-in.)
 *
 * Es una pregunta distinta de "qué le interesa": el lead sigue siendo un lead,
 * pero no hay nada que venderle hoy, así que tratarlo como los demás termina en
 * una llamada donde se le vuelve a decir que no.
 */
export function esPedidoNoDisponible(datos: DatosLead): boolean {
  return datos.interes?.trim() === PEDIDO_OTRA_COSA && Boolean(datos.pedido?.trim());
}

/**
 * Qué preguntó, en una línea. Cuando eligió "Otra cosa", "Otra cosa" no dice
 * nada: lo que importa es el texto de lo que realmente pidió.
 */
export function interesDeLead(datos: DatosLead): string | undefined {
  if (esPedidoNoDisponible(datos)) {
    return datos.pedido?.trim();
  }
  return datos.interes?.trim() || undefined;
}

/**
 * Descripción de la tarjeta del pipeline. Es lo que ve el CRM en el kanban, así
 * que dice de dónde salió y qué preguntó — sin eso, "Nuevo" no significa nada.
 */
export function descripcionLead(datos: DatosLead): string {
  const partes = [
    datos.acompanaA?.trim()
      ? `Acompañó a ${datos.acompanaA.trim()} y consultó en el local`
      : 'Consulta presencial en el local',
  ];
  const que = interesDeLead(datos);
  if (que && esPedidoNoDisponible(datos)) {
    // Que quede escrito en la tarjeta que la respuesta fue "no": si no, alguien
    // lo llama para venderle algo que no existe.
    partes.push(`Pidió: ${que} — NO está en el catálogo hoy`);
  } else if (que) {
    partes.push(`Preguntó por: ${que}`);
  }
  if (!datos.telefono?.trim()) {
    // Que el CRM sepa de entrada que a este no lo puede contactar: evita que
    // alguien lo trabaje como si fuera un lead accionable.
    partes.push('Sin datos de contacto: no se le puede escribir.');
  }
  return partes.join('. ');
}

/**
 * ¿Alcanza para registrar el lead? Prácticamente siempre: el registro tiene que
 * ser de un clic. Solo se rechaza el caso vacío absoluto —ni nombre, ni
 * teléfono, ni interés—, que no aporta nada ni para medir.
 */
export function validarLead(datos: DatosLead): { ok: true } | { ok: false; error: string } {
  // El vínculo cuenta como dato: "acompañó a Julio" ya es un lead trabajable
  // aunque no haya dicho a qué vino.
  const algo = [datos.nombre, datos.telefono, datos.interes, datos.acompanaA].some((v) => v?.trim());
  if (!algo) {
    return { ok: false, error: 'Elegí al menos qué vino a consultar.' };
  }
  // La ÚNICA cosa obligatoria además de eso: si eligió "Otra cosa", hay que
  // escribir qué. "Otra cosa" sola es el registro que teníamos hasta hoy —
  // sabíamos que alguien pidió algo y nunca qué—, o sea, ningún dato.
  if (datos.interes?.trim() === PEDIDO_OTRA_COSA) {
    const v = validarPedido(datos.pedido);
    if (!v.ok) {
      return { ok: false, error: v.error };
    }
  }
  return { ok: true };
}

/**
 * Texto de la sub-extensión `fuente` del `Provenance` del CRM.
 *
 * Es **texto para mostrar** (va como chip en la tarjeta del kanban), no un
 * código: el canal canónico para métricas sigue siendo `origen-lead`. Sale del
 * mapa de etiquetas que ya existe, así que agregar un canal nuevo no requiere
 * tocar nada acá — y no queda un string suelto que se desincronice.
 */
export function fuenteDeLead(origen: string | undefined, etiquetas: Record<string, string>): string | undefined {
  if (!origen) {
    return undefined;
  }
  return etiquetas[origen] ?? origen;
}

/**
 * Texto de la sub-entrada `próxima-acción` del Task, que es **lo que el kanban
 * del CRM muestra en la tarjeta**.
 *
 * Existe porque su tarjeta renderiza nombre + chip de fuente + `próxima-acción`
 * + responsable, y **no muestra `Task.description`** — que era donde estaba el
 * "preguntó por X". Sin esto, quien trabaja el lead ve un nombre suelto y no
 * sabe a qué vino, que es justo el dato que hace vendible al lead.
 *
 * Dice la acción y el motivo juntos, porque en una tarjeta hay una sola línea:
 * si no dejó cómo contactarlo, la acción honesta es ninguna y hay que decirlo.
 */
export function proximaAccionLead(datos: DatosLead): string {
  const porQue = interesDeLead(datos);
  const conQuien = datos.acompanaA?.trim();
  // Si pidió algo que no tenemos, la acción honesta NO es "contactar": no hay
  // qué venderle. Lo que sí se puede prometer es avisarle si lo sumamos, y para
  // eso el lead tiene que quedar marcado como tal.
  if (esPedidoNoDisponible(datos) && porQue) {
    const con = conQuien ? ` (vino con ${conQuien})` : '';
    if (!datos.telefono?.trim()) {
      return `Pidió ${porQue}, que hoy no ofrecemos${con} — no dejó datos de contacto`;
    }
    return `Avisarle si sumamos ${porQue} — hoy no lo ofrecemos${con}`;
  }
  // El acompañante va primero: "vino con Julio" es lo que abre la conversación,
  // más que el servicio por el que preguntó.
  const contexto = conQuien
    ? `acompañó a ${conQuien}${porQue ? ` y preguntó por ${porQue}` : ''}`
    : porQue
      ? `preguntó por ${porQue}`
      : 'consultó en el local';
  if (!datos.telefono?.trim()) {
    return `${mayuscula(contexto)} — no dejó datos de contacto`;
  }
  return `Contactar — ${contexto}`;
}

function mayuscula(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
