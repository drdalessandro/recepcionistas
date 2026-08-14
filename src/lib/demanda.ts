/**
 * Demanda no cubierta — "esto nos lo piden y no lo tenemos".
 *
 * Caso 11 del recorrido del walk-in: alguien entra y pregunta por algo que
 * Biowellness **no ofrece**. Hasta ahora eso caía en "Otra cosa" del selector,
 * sin texto libre: quedaba el evento y se perdía el dato — que es justamente el
 * más valioso que produce el mostrador. Ningún otro canal nos dice qué producto
 * nos están pidiendo y no vendemos: el que pregunta por Instagram y no lo
 * encuentra se va sin escribir. A los tres meses, esa lista convierte una
 * decisión de catálogo en una decisión con evidencia.
 *
 * Acá vive solo lo que hay que decidir: cómo se valida el texto y cómo se
 * agrupa para poder contarlo. Dónde se guarda está en `src/fhir/demanda.ts`.
 */

/** Opción del selector que significa "algo que no está en el catálogo". */
export const PEDIDO_OTRA_COSA = 'Otra cosa';

/** Mínimo de la clave normalizada: "x" o "??" es ruido, no un pedido. */
export const PEDIDO_MIN = 3;
/** Máximo del texto: es una etiqueta para contar, no la crónica de la charla. */
export const PEDIDO_MAX = 200;

/** Un pedido tal como quedó registrado. */
export interface PedidoRegistrado {
  /** Tal como lo dijo la persona. Es lo que se muestra. */
  texto: string;
  /** Clave de agregación. Si falta, se recalcula desde el texto. */
  clave?: string;
  /** Cuándo lo pidió (YYYY-MM-DD o ISO completo). */
  fechaISO?: string;
}

/** Un pedido y cuántas veces lo pidieron. */
export interface DemandaAgrupada {
  clave: string;
  /** Forma más usada del pedido: es la que se muestra en el reporte. */
  etiqueta: string;
  n: number;
  ultimaFechaISO?: string;
}

/**
 * Clave con la que se agrupan dos pedidos que son **el mismo pedido**.
 *
 * Sin esto, "Nutricionista", "nutricionista " y "NUTRICIÓN" son tres filas de
 * uno en el reporte, y un listado de 60 filas de uno no se lee: el dato existe
 * pero no se puede ver. Se normaliza mayúsculas, tildes, signos y espacios.
 *
 * La ñ se pisa a n (`niño` → `nino`) como efecto de sacar tildes: es a
 * propósito, porque la clave **nunca se muestra** —la etiqueta sale del texto
 * original— y en el mostrador se escribe de las dos formas.
 *
 * Lo que NO hace: sinónimos ni singular/plural. "masaje deportivo" y "masajes
 * deportivos" quedan separados. Adivinar equivalencias con 20 datos inventa
 * agrupaciones falsas; con este volumen las junta a ojo quien lee el reporte.
 */
export function normalizarPedido(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:"'()[\]\-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ¿Sirve como pedido? Se valida poco a propósito: el mostrador tiene a la
 * persona enfrente y cada campo que rebota es un registro que no se hace.
 * Solo se rechaza lo que no se podría contar después.
 */
export function validarPedido(
  texto: string | undefined,
): { ok: true; texto: string; clave: string } | { ok: false; error: string } {
  const t = (texto ?? '').trim().replace(/\s+/g, ' ');
  if (!t) {
    return { ok: false, error: 'Escribí qué pidió: "Otra cosa" sin el detalle no sirve para nada.' };
  }
  if (t.length > PEDIDO_MAX) {
    return { ok: false, error: `Resumilo en menos de ${PEDIDO_MAX} caracteres (es una etiqueta, no la charla).` };
  }
  const clave = normalizarPedido(t);
  if (clave.length < PEDIDO_MIN) {
    return { ok: false, error: 'Escribí qué pidió, aunque sea en dos palabras.' };
  }
  return { ok: true, texto: t, clave };
}

/**
 * El reporte: qué nos piden, cuántas veces y cuándo fue la última.
 *
 * Ordenado por cantidad —lo que más nos piden primero, que es la pregunta que
 * se le hace a esta lista— y a igual cantidad, lo más reciente arriba: dos
 * pedidos de este mes pesan más que dos de marzo.
 */
export function agruparDemanda(pedidos: PedidoRegistrado[]): DemandaAgrupada[] {
  const grupos = new Map<string, Grupo>();

  for (const p of pedidos) {
    const texto = p.texto?.trim();
    if (!texto) {
      continue;
    }
    const clave = p.clave?.trim() || normalizarPedido(texto);
    if (!clave) {
      continue;
    }
    const g: Grupo = grupos.get(clave) ?? { n: 0, formas: new Map() };
    g.n += 1;
    g.ultima = masReciente(g.ultima, p.fechaISO);
    const f: Forma = g.formas.get(texto) ?? { n: 0 };
    f.n += 1;
    f.ultima = masReciente(f.ultima, p.fechaISO);
    g.formas.set(texto, f);
    grupos.set(clave, g);
  }

  return [...grupos.entries()]
    .map(([clave, g]) => ({ clave, etiqueta: etiquetaDe(g.formas), n: g.n, ultimaFechaISO: g.ultima }))
    .sort(
      (a, b) =>
        b.n - a.n ||
        (b.ultimaFechaISO ?? '').localeCompare(a.ultimaFechaISO ?? '') ||
        a.clave.localeCompare(b.clave),
    );
}

/** Una forma concreta de escribir el pedido, y cuántas veces se escribió así. */
interface Forma {
  n: number;
  ultima?: string;
}

/** Todos los pedidos que comparten clave. */
interface Grupo {
  n: number;
  ultima?: string;
  formas: Map<string, Forma>;
}

/**
 * De todas las formas en que se escribió el pedido, la más frecuente: si cinco
 * personas pidieron "nutricionista" y una escribió "NUTRI", el reporte tiene
 * que decir "nutricionista". A igual frecuencia gana la más reciente.
 */
function etiquetaDe(formas: Map<string, Forma>): string {
  let mejor = '';
  let mejorN = -1;
  let mejorFecha = '';
  for (const [texto, f] of formas) {
    const fecha = f.ultima ?? '';
    if (f.n > mejorN || (f.n === mejorN && fecha > mejorFecha)) {
      mejor = texto;
      mejorN = f.n;
      mejorFecha = fecha;
    }
  }
  return mejor;
}

function masReciente(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return b > a ? b : a;
}
