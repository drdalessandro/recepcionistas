/**
 * Paquetes de sesiones — Manual de Protocolos v9 (Sección 2).
 * Nombres comerciales por tramo: x5 = Starter · x10 = Core · x20 = Pro.
 * Descuento por volumen: x5 = 5% · x10 = 10% · x20 = 15%.
 * Vigencias: 15 / 30 / 60 días. Founding Member: 20% adicional sobre el paquete.
 *
 * **No se redondea** (decisión del PO, 2026-08-15). Los USD se cobran en pesos
 * al cambio del día, así que el número redondo no aporta nada y el exacto sí:
 * con el total exacto, el precio Founding Member se DERIVA (`total × 0,80`) sin
 * error, y alcanza con guardar un número por producto en vez de dos que se
 * pueden desfasar.
 *
 * Cambia 4 de los 24 totales, y sólo en el tramo x5: 784 → 783,75 · 428 → 427,5
 * · 238 → 237,5 · 428 → 427,5. **Ningún precio FM se mueve** (783,75 × 0,80 =
 * 627, que es lo mismo que daba redondeando). El Manual v9 trae los redondeados
 * y por convención del repo le gana al código; ésta es una decisión posterior y
 * explícita, no una diferencia que haya que "arreglar" contra el Manual.
 */
import type { Paquete } from '../domain/types.js';

interface BasePaquete {
  servicioBaseCodigo: string;
  etiqueta: string;
  /** Nombre comercial de la base, como figura en el Manual. */
  nombreBase: string;
  /** Precio base por sesión para el paquete (USD). */
  precioBaseUSD: number;
}

const BASES: BasePaquete[] = [
  { servicioBaseCodigo: 'HBOT_MONO', etiqueta: 'HBOT_MONO', nombreBase: 'HBOT MONO', precioBaseUSD: 165 },
  { servicioBaseCodigo: 'HBOT_BIPLAZA', etiqueta: 'HBOT_BIPLAZA', nombreBase: 'HBOT BIPLAZA', precioBaseUSD: 200 }, // por pareja
  { servicioBaseCodigo: 'IHHT', etiqueta: 'IHHT', nombreBase: 'IHHT', precioBaseUSD: 90 },
  { servicioBaseCodigo: 'RED_LIGHT', etiqueta: 'RED_LIGHT', nombreBase: 'RED LIGHT', precioBaseUSD: 50 },
  { servicioBaseCodigo: 'COMPRESION', etiqueta: 'BOTAS_COMP', nombreBase: 'BOTAS COMP', precioBaseUSD: 60 },
  { servicioBaseCodigo: 'CRIO', etiqueta: 'BOTAS_CRYO', nombreBase: 'BOTAS CRYO', precioBaseUSD: 90 },
  // Los dos que faltaban (Andrés, 2026-08-15): eran los únicos servicios sin
  // paquete, sin una razón. El Multiplaza es POR PERSONA (80); el Recovery Pro
  // es por gabinete e indivisible (200), o sea que su paquete también.
  { servicioBaseCodigo: 'HBOT_MULTIPLAZA', etiqueta: 'HBOT_MULTIPLAZA', nombreBase: 'HBOT MULTIPLAZA', precioBaseUSD: 80 },
  { servicioBaseCodigo: 'RECOVERY_PRO', etiqueta: 'RECOVERY_PRO', nombreBase: 'RECOVERY PRO', precioBaseUSD: 200 },
];

const TRAMOS: Array<{ tamano: number; nombre: string; descuento: number; vigenciaDias: number }> = [
  { tamano: 5, nombre: 'Starter', descuento: 0.05, vigenciaDias: 15 },
  { tamano: 10, nombre: 'Core', descuento: 0.1, vigenciaDias: 30 },
  { tamano: 20, nombre: 'Pro', descuento: 0.15, vigenciaDias: 60 },
];

const FM_DESC = 0.2;

/**
 * Cuatro decimales alcanzan para cualquier precio y matan el ruido de coma
 * flotante (`783.75 * 0.8` no da 627 exacto en binario).
 */
function exacto(n: number): number {
  return Number(n.toFixed(4));
}

export const PAQUETES: Paquete[] = BASES.flatMap((base) =>
  TRAMOS.map((t): Paquete => {
    // Se deriva TODO del total, en este orden, para que los tres números sean
    // consistentes entre sí por construcción y no por coincidencia.
    const totalListaUSD = exacto(base.precioBaseUSD * t.tamano);
    const totalUSD = exacto(totalListaUSD * (1 - t.descuento));
    return {
      codigo: `PAQ_${base.etiqueta}_X${t.tamano}`,
      nombre: `${base.nombreBase} — ${t.nombre}`,
      servicioBaseCodigo: base.servicioBaseCodigo,
      tamano: t.tamano,
      vigenciaDias: t.vigenciaDias,
      descuento: t.descuento,
      precioSesionUSD: exacto(totalUSD / t.tamano),
      totalListaUSD,
      totalUSD,
      totalFMUSD: exacto(totalUSD * (1 - FM_DESC)),
    };
  }),
);

/**
 * Paquetes RETIRADOS: su servicio base ya no existe, así que no se venden más.
 *
 * `IHHT_EXPRESS` se descartó con el Manual v9 (IHHT volvió a una única sesión),
 * pero sus tres paquetes siguieron `active` en Medplum con precio real — USD
 * 285 / 540 / 1020 por sesiones de un servicio que no se puede reservar. Como
 * con los servicios: no se borran (un paquete vendido tiene que seguir
 * resolviendo para consumirse y reportarse) y el seed los publica `retired`,
 * porque omitirlos los dejaría `active` en el servidor para siempre.
 */
export const PAQUETES_RETIRADOS: Paquete[] = TRAMOS.map((t): Paquete => {
  const totalListaUSD = exacto(60 * t.tamano);
  const totalUSD = exacto(totalListaUSD * (1 - t.descuento));
  return {
    codigo: `PAQ_IHHT_EXPRESS_X${t.tamano}`,
    nombre: `IHHT EXPRESS — ${t.nombre}`,
    servicioBaseCodigo: 'IHHT_EXPRESS',
    tamano: t.tamano,
    vigenciaDias: t.vigenciaDias,
    descuento: t.descuento,
    precioSesionUSD: exacto(totalUSD / t.tamano),
    totalListaUSD,
    totalUSD,
    totalFMUSD: exacto(totalUSD * (1 - FM_DESC)),
    retirado: true,
  };
});

/** Los que se venden + los retirados. Lo usan el seed y el índice por código. */
export const TODOS_LOS_PAQUETES: Paquete[] = [...PAQUETES, ...PAQUETES_RETIRADOS];

export const PAQUETES_POR_CODIGO: ReadonlyMap<string, Paquete> = new Map(
  TODOS_LOS_PAQUETES.map((p) => [p.codigo, p]),
);

export function getPaquete(codigo: string): Paquete {
  const p = PAQUETES_POR_CODIGO.get(codigo);
  if (!p) {
    throw new Error(`Paquete desconocido: ${codigo}`);
  }
  return p;
}
