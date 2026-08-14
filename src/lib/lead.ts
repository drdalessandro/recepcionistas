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

/** Etiqueta de un lead sin nombre, para que la tarjeta del CRM sea legible. */
const PREFIJO_ANONIMO = 'Consulta en el mostrador';

export interface DatosLead {
  nombre?: string;
  telefono?: string;
  /** Qué vino a preguntar (servicio, categoría o texto libre). */
  interes?: string;
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
 * Descripción de la tarjeta del pipeline. Es lo que ve el CRM en el kanban, así
 * que dice de dónde salió y qué preguntó — sin eso, "Nuevo" no significa nada.
 */
export function descripcionLead(datos: DatosLead): string {
  const partes = [
    datos.acompanaA?.trim()
      ? `Acompañó a ${datos.acompanaA.trim()} y consultó en el local`
      : 'Consulta presencial en el local',
  ];
  if (datos.interes?.trim()) {
    partes.push(`Preguntó por: ${datos.interes.trim()}`);
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
  const porQue = datos.interes?.trim();
  const conQuien = datos.acompanaA?.trim();
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
