/**
 * Tipos de dominio de Biowellness Recepción (Bloque 0).
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
  /** Descripción en voz de paciente: el portal la muestra tal cual (ActivityDefinition.description). */
  descripcion?: string;
  /**
   * Posición en la góndola del portal (extensión `orden`, valueInteger; el
   * portal ordena ascendente y sin la extensión cae al final). Valores de a 10
   * para poder intercalar; los grupos comparten valor y desempatan alfabético.
   */
  orden?: number;
  /**
   * Sección comercial PROPIA en la góndola (→ `topic`), cuando difiere de la
   * etiqueta de su categoría (addendum 2.1: las consultas se separan —
   * "Consulta Evaluación" vs. "Consulta Director Médico").
   */
  categoriaComercial?: string;
  /**
   * Familia comercial dentro de la sección: la viñeta bajo la que el portal
   * agrupa varios servicios (feedback de Andrés 2026-09-11 — "Terapias
   * Biológicas" mostraba 18 tarjetas repitiendo el mismo texto; va como título
   * con seis viñetas debajo). Viaja en las extensiones `familia` y
   * `familia-orden`. Sin familia, el servicio se muestra suelto como siempre.
   */
  familia?: string;
  /**
   * Retirado del catálogo: NO se ofrece más (ni en el portal ni en el
   * mostrador), pero el código sigue resolviendo para los turnos, cobros y
   * reportes que ya lo referencian. Se publica como `status: 'retired'`.
   *
   * Es a propósito que no se borre la entrada: `getServicio` tira si el código
   * no existe, y se llama sin `try` en los cobros y la clasificación de turnos.
   * Borrarlo rompería el histórico.
   */
  retirado?: boolean;
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
  /** Lo que costarían esas mismas sesiones sueltas (USD/mes). Es el ancla que vende el plan. */
  precioListaMesUSD: number;
  /** Descuento por continuidad aplicado vs. el combo (fracción). */
  descuentoContinuidad: number;
  /**
   * Descuento del socio sobre las sesiones sueltas que compre **fuera** del
   * plan, en porcentaje (10 Standard / 15 Intensivo). Sin esto el portal le
   * muestra el precio de lista a un socio que en realidad paga menos.
   */
  descuentoALaCarte: number;
  /** Bajada comercial, en voz de paciente. Vive en el dato, no en el front. */
  descripcion: string;
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
  /** Lo que costarían las mismas sesiones sueltas (USD). Es el ancla del descuento. */
  totalListaUSD: number;
  /** Total del paquete (USD). */
  totalUSD: number;
  /** Total para Founding Member (20% adicional, USD). */
  totalFMUSD: number;
}

/**
 * Modalidad de cobro de un programa (PB100D): 'mensual' es suscripción
 * renovable cada 30 días y cancelable; '100-dias' es un pago único por el
 * programa completo. Los programas venden TIEMPO, no sesiones.
 */
export type ModalidadPrograma = 'mensual' | '100-dias';

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
   * Una reserva ocupa el recurso COMPLETO aunque traiga menos personas que la
   * capacidad (Biplaza y gabinetes Recovery: 1 o 2 personas de la MISMA reserva;
   * nunca desconocidos compartiendo).
   */
  reservaExclusiva?: boolean;
  /**
   * Mínimo de personas para que la sesión opere (Multiplaza: 3, del Manual).
   * Reservar por debajo NO bloquea: genera advertencia para la recepción.
   */
  minimoPersonas?: number;
  /**
   * Códigos de equipos/recursos que comparte (cuello de botella de agenda).
   * Ej.: los gabinetes Recovery Pro comparten las 2 tumbonas Red Light.
   */
  comparteCon?: string[];
  /** Provisional hasta confirmación de Andrés (lista preliminar de 13). */
  provisional?: boolean;
  nota?: string;
}

/** Una contraindicación (tabla validada por el Director Médico, 2026-08-09). */
export interface Contraindicacion {
  codigo: string;
  /** Categorías de servicio afectadas. */
  aplicaA: CategoriaServicio[];
  /** Texto clínico. */
  descripcion: string;
  /** absoluta => bloquea sin autorización médica; relativa => advertencia. */
  severidad: 'absoluta' | 'relativa';
  /**
   * Entrada nueva/modificada aún sin validar por el Director Médico. Mientras
   * alguna lo tenga, el CodeSystem vuelve a `draft` y el seed avisa.
   */
  borradorPendienteRevision?: boolean;
}
