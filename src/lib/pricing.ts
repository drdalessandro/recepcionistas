/**
 * Motor de precios (Documento de Requerimientos §6.4, reglas R-04..R-08, R-15..R-17).
 *
 * Principio rector: "Las Recepcionistas nunca calculan ni deciden nada que el
 * sistema pueda calcular o decidir por ellas." Acá vive todo ese cálculo.
 *
 * Funciones puras (sin FHIR ni IO) para poder testearlas de punta a punta.
 */
import type { ModalidadAtencion, Moneda, Servicio, Split } from '../domain/types.js';
import { getServicio } from '../config/catalogo.js';
import { getCombo } from '../config/combos.js';
import { getMembresia } from '../config/membresias.js';
import { getPaquete } from '../config/paquetes.js';
import { getPrograma } from '../config/programas.js';
import { CASCADA_TB, FM, MEMBRESIA } from '../config/reglas.js';
import { resolverTC } from '../config/tipo-cambio.js';
import { redondearUSD, usdAArs } from './money.js';

export interface DistribucionSplit {
  bwUSD: number;
  prescriptoresUSD?: number;
  terapeutaUSD?: number;
  proveedorUSD?: number;
  /** True si el neto de BW quedó por debajo del piso de margen (R-08). */
  bajoMargenMinimo?: boolean;
}

/**
 * Precio de una sesión suelta en USD, aplicando la regla de pricing del recurso.
 * @param ocupantes cantidad de personas (HBOT biplaza/multiplaza, parejas).
 * @param fm aplica el 20% OFF de Founding Member (solo sueltas, si el servicio lo permite).
 */
export function precioSueltoUSD(
  servicio: Servicio,
  opts: { ocupantes?: number; fm?: boolean } = {},
): number {
  const ocupantes = opts.ocupantes ?? 1;
  let base: number;

  switch (servicio.reglaPricing) {
    case 'HBOT_MONO':
      base = servicio.precioUSD;
      break;
    case 'HBOT_BIPLAZA':
      // 2 personas => 100 c/u (200 total); 1 sola => precio monoplaza (165).
      base = ocupantes >= 2 ? servicio.precioUSD * ocupantes : 165;
      break;
    case 'HBOT_MULTIPLAZA':
      // USD 80/persona, mínimo 3.
      base = servicio.precioUSD * Math.max(ocupantes, 3);
      break;
    case 'RECOVERY_PRO_INDIVISIBLE':
      // USD 200 por gabinete, 1 o 2 personas. Indivisible.
      base = servicio.precioUSD;
      break;
    case 'POR_SESION':
    case 'CASCADA_TB':
      base = servicio.precioUSD * ocupantes;
      break;
    default:
      base = servicio.precioUSD * ocupantes;
  }

  // FM: 20% OFF en sueltas, solo si el servicio lo permite (no IV/TB ni combos/membresías).
  if (opts.fm && servicio.fmAplica) {
    base = base * (1 - 0.2);
  }
  return redondearUSD(base);
}

/**
 * Cascada de pricing para IV Therapy + Terapias Biológicas (R-08):
 * neto BW = (precio − 25% costo fiscal − insumo Regenerar − USD 15 enfermería) × 85%.
 * El 15% restante es honorario de los médicos prescriptores. Piso: 25% de margen neto.
 *
 * @param precioUSD precio de lista que paga el cliente.
 * @param insumoUSD costo del insumo (lista Regenerar, sin IVA). Requerido para el neto real.
 */
export function cascadaTB(precioUSD: number, insumoUSD: number): DistribucionSplit {
  const baseImponible = precioUSD * (1 - CASCADA_TB.costoFiscal) - insumoUSD - CASCADA_TB.enfermeriaUSD;
  const bwUSD = redondearUSD(baseImponible * CASCADA_TB.factorBw);
  const prescriptoresUSD = redondearUSD(baseImponible * CASCADA_TB.honorarioMedicos);
  const pisoMinimo = precioUSD * CASCADA_TB.margenNetoMin;
  return {
    bwUSD,
    prescriptoresUSD,
    bajoMargenMinimo: bwUSD < pisoMinimo,
  };
}

/**
 * Distribución de ingresos (split) de un monto cobrado, según el servicio (R-08).
 * Para IV/TB usa la cascada (requiere costo de insumo).
 */
export function calcularSplit(
  servicio: Servicio,
  montoUSD: number,
  opts: { insumoUSD?: number } = {},
): DistribucionSplit {
  const split: Split = servicio.split;
  switch (split.tipo) {
    case 'BW_100':
      return { bwUSD: redondearUSD(montoUSD) };
    case 'IV_TB_85_15':
      return cascadaTB(montoUSD, opts.insumoUSD ?? 0);
    case 'MASAJE_50_50':
      return {
        bwUSD: redondearUSD(montoUSD * 0.5),
        terapeutaUSD: redondearUSD(montoUSD * 0.5),
      };
    case 'FOODBAR_75_25':
      return {
        bwUSD: redondearUSD(montoUSD * 0.75),
        proveedorUSD: redondearUSD(montoUSD * 0.25),
      };
  }
}

export type TipoItemCobro = 'servicio' | 'combo' | 'membresia' | 'paquete' | 'programa';

export interface ItemCobro {
  tipo: TipoItemCobro;
  codigo: string;
  /** Para servicios: cantidad de personas. */
  ocupantes?: number;
  /** Para servicios sueltos: aplica FM. */
  fm?: boolean;
  /** Para IV/TB: costo de insumo (USD). */
  insumoUSD?: number;
  /** Cantidad de unidades del ítem (default 1). */
  cantidad?: number;
}

/**
 * Descuentos por tipo de cliente (los resuelve el bot leyendo Patient/Coverage;
 * la recepción nunca los elige a mano).
 * - `fm`: Founding Member → 20% en sueltas (si el servicio lo permite) y paquetes.
 * - `aLaCartePct`: miembro con membresía activa comprando sueltas a la carte →
 *   Standard 10% / Intensivo 15% (Manual v9).
 * ⚠️ PROVISORIO (pendiente Andrés): NO acumulan — se aplica EL MAYOR de los dos.
 */
export interface DescuentosCliente {
  fm?: boolean;
  aLaCartePct?: number;
}

/** % a la carte según la intensidad de la membresía activa (Manual v9). */
export function descuentoALaCarteDe(intensidad: 'STANDARD' | 'INTENSIVO' | undefined): number {
  if (intensidad === 'STANDARD') {
    return MEMBRESIA.descuentoALaCarteStandard;
  }
  if (intensidad === 'INTENSIVO') {
    return MEMBRESIA.descuentoALaCarteIntensivo;
  }
  return 0;
}

export interface LineaCobro {
  tipo: TipoItemCobro;
  codigo: string;
  descripcion: string;
  cantidad: number;
  /** Moneda de lista de la línea: USD (se convierte) o ARS (consultas, precio fijo). */
  moneda: Moneda;
  precioUnitarioUSD: number;
  subtotalUSD: number;
  /** Subtotal de la línea en ARS (lo que efectivamente se cobra). */
  subtotalARS: number;
  split: DistribucionSplit;
  /** Descuento aplicado a la línea (fracción) y su origen, si hubo. */
  descuentoPct?: number;
  descuentoOrigen?: 'fm' | 'a-la-carte';
}

export interface ResultadoCobro {
  lineas: LineaCobro[];
  /** Total en USD de las líneas en USD (informativo). */
  totalUSD: number;
  /** Total a cobrar en ARS (todas las líneas). */
  totalARS: number;
  tcAplicado: number;
}

/** Construye una línea de cobro, manejando moneda (USD se convierte; ARS es fijo). */
function construirLinea(item: ItemCobro, tc?: number, desc: DescuentosCliente = {}): LineaCobro {
  const cantidad = item.cantidad ?? 1;
  const esFm = desc.fm || item.fm || false;

  if (item.tipo === 'servicio') {
    const s = getServicio(item.codigo);
    // Consultas u otros servicios con precio fijo en ARS (no se convierte ni descuenta).
    if (s.precioARS != null) {
      return {
        tipo: 'servicio',
        codigo: item.codigo,
        descripcion: s.nombre,
        cantidad,
        moneda: 'ARS',
        precioUnitarioUSD: 0,
        subtotalUSD: 0,
        subtotalARS: Math.round(s.precioARS * cantidad),
        split: { bwUSD: 0 },
      };
    }
    // Descuentos de cliente sobre la suelta: FM 20% (si el servicio lo permite)
    // vs a la carte de miembros 10/15%. PROVISORIO: el MAYOR, no acumulan.
    const base = precioSueltoUSD(s, { ocupantes: item.ocupantes ?? 1, fm: false });
    const fmPct = esFm && s.fmAplica ? FM.descuento : 0;
    const alcPct = desc.aLaCartePct ?? 0;
    const pct = Math.max(fmPct, alcPct);
    const precio = redondearUSD(base * (1 - pct));
    const subtotalUSD = redondearUSD(precio * cantidad);
    return {
      tipo: 'servicio',
      codigo: item.codigo,
      descripcion: s.nombre,
      cantidad,
      moneda: 'USD',
      precioUnitarioUSD: precio,
      subtotalUSD,
      subtotalARS: usdAArs(subtotalUSD, tc),
      split: calcularSplit(s, subtotalUSD, { insumoUSD: item.insumoUSD }),
      ...(pct > 0 ? { descuentoPct: pct, descuentoOrigen: pct === fmPct && fmPct >= alcPct ? ('fm' as const) : ('a-la-carte' as const) } : {}),
    };
  }

  // Combos / membresías / paquetes: siempre en USD.
  // Combos y membresías ya traen su descuento estructural (no aplica FM ni a la carte).
  let precio: number;
  let descripcion: string;
  let descuento: Pick<LineaCobro, 'descuentoPct' | 'descuentoOrigen'> = {};
  if (item.tipo === 'combo') {
    const c = getCombo(item.codigo);
    precio = c.precioUSD;
    descripcion = c.nombre;
  } else if (item.tipo === 'membresia') {
    const m = getMembresia(item.codigo);
    precio = m.precioMesUSD;
    descripcion = `Membresía ${m.tier} ${m.intensidad} ${m.variante}`;
  } else if (item.tipo === 'programa') {
    // Programas (PB100D): precio de catálogo, sin descuentos. El 20% de FM es
    // de sueltas y paquetes (R-09) y el a la carte es de socios: ninguno aplica.
    const p = getPrograma(item.codigo);
    precio = p.precioUSD;
    descripcion = p.nombre;
  } else {
    const p = getPaquete(item.codigo);
    // Paquetes: FM 20% adicional (Manual). El a la carte NO aplica a paquetes.
    precio = esFm ? p.totalFMUSD : p.totalUSD;
    descripcion = `Paquete ${p.codigo}`;
    if (esFm) {
      descuento = { descuentoPct: 0.2, descuentoOrigen: 'fm' };
    }
  }
  const subtotalUSD = redondearUSD(precio * cantidad);
  return {
    tipo: item.tipo,
    codigo: item.codigo,
    descripcion,
    cantidad,
    moneda: 'USD',
    precioUnitarioUSD: precio,
    subtotalUSD,
    subtotalARS: usdAArs(subtotalUSD, tc),
    split: { bwUSD: subtotalUSD },
    ...descuento,
  };
}

/**
 * Calcula el cobro completo de una lista de ítems. La recepción solo elige el
 * medio de pago: el sistema calcula montos, descuentos, splits y conversión a ARS.
 */
export function calcularCobro(items: ItemCobro[], opts: { tc?: number; descuentos?: DescuentosCliente } = {}): ResultadoCobro {
  const lineas = items.map((item) => construirLinea(item, opts.tc, opts.descuentos));
  const totalUSD = redondearUSD(lineas.reduce((acc, l) => acc + l.subtotalUSD, 0));
  const totalARS = lineas.reduce((acc, l) => acc + l.subtotalARS, 0);
  return {
    lineas,
    totalUSD,
    totalARS,
    tcAplicado: resolverTC(opts.tc),
  };
}

/** Fracción de seña por defecto (50%) para confirmar un turno. */
export const FRACCION_SENA = 0.5;

/** Cobro total por adelantado: no queda saldo. */
export const FRACCION_TOTAL = 1;

/**
 * Qué fracción del total se cobra por adelantado para confirmar un turno.
 *
 * Presencial: la seña del 50% (R-19); el resto se cobra en el mostrador el día
 * de la sesión. **Virtual: el 100%** (Andrés, 2026-09-16) — no hay mostrador
 * donde cobrar el resto, y perseguir un saldo a distancia es trabajo de
 * Recepción que el sistema puede evitar.
 *
 * Ausente = `presencial`: todo el catálogo v9 lo es.
 */
export function fraccionAnticipada(modalidad?: ModalidadAtencion): number {
  return modalidad === 'virtual' ? FRACCION_TOTAL : FRACCION_SENA;
}

/** Total a cobrar y seña (50%) de una reserva, en ARS. */
export function calcularSenaARS(
  items: ItemCobro[],
  opts: { tc?: number; fraccion?: number } = {},
): { totalARS: number; senaARS: number } {
  const { totalARS } = calcularCobro(items, { tc: opts.tc });
  return { totalARS, senaARS: Math.round(totalARS * (opts.fraccion ?? FRACCION_SENA)) };
}
