/**
 * Tipos de dominio de BioWellness Recepción (Bloque 0).
 *
 * Fuente de verdad de datos: Manual de Protocolos v9 (changelog aplicado sobre v8).
 * Estos tipos describen el catálogo, las membresías, los recursos físicos y las
 * reglas de pricing/agenda. Son agnósticos de FHIR: el seed los traduce a
 * recursos FHIR (ActivityDefinition, PlanDefinition, etc.).
 */

export type Moneda = 'USD' | 'ARS';

/** Categorías de servicio (definen reglas de pricing/agenda y split). */
export type CategoriaServicio =
  | 'HBOT'
  | 'IHHT'
  | 'RED_LIGHT'
  | 'RECOVERY_PRO'
  | 'COMPRESION'
  | 'CRIO'
  | 'IV_THERAPY'
  | 'TERAPIA_BIOLOGICA'
  | 'MASAJE_OSTEOPATIA'
  | 'CONSULTA';

/**
 * Distribución de ingresos (split) por servicio (R-08).
 * Los porcentajes son sobre el monto neto facturable de BW.
 */
export type Split =
  | { tipo: 'BW_100' }
  | { tipo: 'IV_TB_85_15'; bw: 85; prescriptores: 15 }
  | { tipo: 'MASAJE_50_50'; bw: 50; terapeuta: 50 }
  | { tipo: 'FOODBAR_75_25'; bw: 75; proveedor: 25 };

/**
 * Regla de pricing especial por recurso físico, cuando el precio no es un
 * simple "precio por sesión" (HBOT por ocupación, Recovery Pro indivisible, etc.).
 */
export type ReglaPricingRecurso =
  | 'HBOT_MONO' // 1 plaza, precio fijo
  | 'HBOT_BIPLAZA' // 2 personas => 100 c/u; 1 sola => precio mono
  | 'HBOT_MULTIPLAZA' // por persona; mín 3, máx 6
  | 'RECOVERY_PRO_INDIVISIBLE' // 200 por gabinete, 1 o 2 personas
  | 'POR_SESION' // precio fijo por sesión
  | 'CASCADA_TB'; // (precio - 25% fiscal - insumo - 15 enfermería) x 85%, piso 25% margen

export interface Servicio {
  /** Código de negocio estable (p. ej. "HBOT_MONO"). */
  codigo: string;
  nombre: string;
  categoria: CategoriaServicio;
  /** Duración nominal de la sesión, en minutos. */
  duracionMin: number;
  /** Precio de lista en USD (por sesión, salvo regla de pricing). 0 si el precio es en ARS. */
  precioUSD: number;
  /** Precio fijo en ARS (consultas médicas). Si está, el servicio se cobra en pesos sin convertir. */
  precioARS?: number;
  /** Para consultas: código del médico que atiende (ver src/config/medicos.ts). */
  practitionerCodigo?: string;
  /** Requiere prescripción médica activa (IV / Terapias Biológicas). */
  requierePrescripcion: boolean;
  /** Regla de cálculo de precio. */
  reglaPricing: ReglaPricingRecurso;
  /** Distribución de ingresos. */
  split: Split;
  /** ¿Aplica el 20% OFF de Founding Member sobre la sesión suelta? */
  fmAplica: boolean;
  /** Notas / fuente. */
  nota?: string;
}

export type VarianteCombo = 'INDIVIDUAL' | 'PAREJA';

export interface ComponenteCombo {
  servicioCodigo: string;
  duracionMin: number;
  /** Orden de ejecución dentro del combo (1 = primero). */
  orden: number;
  /** Cantidad de ocupantes para este componente (pareja => 2 en algunos). */
  ocupantes: number;
}

export interface Combo {
  codigo: string;
  nombre: string;
  variante: VarianteCombo;
  componentes: ComponenteCombo[];
  /** Suma de precios de lista de los componentes (USD). */
  precioListaUSD: number;
  /** Precio final del combo (USD), ya con descuento aplicado. */
  precioUSD: number;
  /** Descuento sobre lista (fracción, p. ej. 0.20). */
  descuento: number;
  /** Duración total (min). */
  duracionTotalMin: number;
}

export type TierMembresia = 'FOCUS' | 'PRIME' | 'HEALTHSPAN';
export type IntensidadMembresia = 'STANDARD' | 'INTENSIVO';
export type VarianteMembresia = 'INDIVIDUAL' | 'PAREJA';

export interface Membresia {
  codigo: string;
  tier: TierMembresia;
  intensidad: IntensidadMembresia;
  variante: VarianteMembresia;
  /** Combo base que se repite. */
  comboBaseCodigo: string;
  /** Sesiones por mes (8 Standard / 12 Intensivo). */
  sesionesMes: number;
  /** Frecuencia semanal de referencia. */
  frecuenciaSemanal: number;
  /** Precio mensual en USD. */
  precioMesUSD: number;
  /** Descuento por continuidad aplicado vs. lista (fracción). */
  descuentoContinuidad: number;
}

export interface Paquete {
  codigo: string;
  /** Nombre comercial del Manual (p. ej. "HBOT MONO — Starter"). */
  nombre: string;
  servicioBaseCodigo: string;
  /** Cantidad de sesiones (5 / 10 / 20). */
  tamano: number;
  /** Vigencia en días (15 / 30 / 60). */
  vigenciaDias: number;
  /** Descuento por volumen (fracción: 0.05 / 0.10 / 0.15). */
  descuento: number;
  /** Precio por sesión (USD) ya con descuento. */
  precioSesionUSD: number;
  /** Total del paquete (USD). */
  totalUSD: number;
  /** Total para Founding Member (20% adicional, USD). */
  totalFMUSD: number;
}

/** Tipo de recurso físico agendable. */
export type TipoRecurso =
  | 'HBOT'
  | 'IHHT'
  | 'RECOVERY_PRO'
  | 'RED_LIGHT'
  | 'COMPRESION'
  | 'CRIO'
  | 'BOX_CLINICO'
  | 'CONSULTORIO'
  | 'SALA';

export interface RecursoFisico {
  codigo: string;
  nombre: string;
  tipo: TipoRecurso;
  /** Capacidad máxima de personas en simultáneo. */
  capacidad: number;
  /**
   * Códigos de equipos/recursos que comparte (cuello de botella de agenda).
   * Ej.: los gabinetes Recovery Pro comparten las 2 tumbonas Red Light.
   */
  comparteCon?: string[];
  /** Provisional hasta confirmación de Andrés (lista preliminar de 13). */
  provisional?: boolean;
  nota?: string;
}

/** Una contraindicación (borrador para validación médica). */
export interface Contraindicacion {
  codigo: string;
  /** Categorías de servicio afectadas. */
  aplicaA: CategoriaServicio[];
  /** Texto clínico. */
  descripcion: string;
  /** absoluta => bloquea sin autorización médica; relativa => advertencia. */
  severidad: 'absoluta' | 'relativa';
  /** Marca de que necesita validación del Director Médico. */
  borradorPendienteRevision: boolean;
}
