/**
 * Modelo de dominio del motor de agenda. Agnóstico de FHIR: acá no entra ni un
 * `Reference` ni un `Appointment`. El mapeo vive en `docs/motor-agenda-fhir.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRINCIPIO DE DISEÑO NO NEGOCIABLE
 *
 * Los tiempos son atributos del **recurso**, no del producto. Cada recurso
 * declara `setup`, `terapia` y `turnaround`. El motor deriva de ahí:
 *
 *   salida del cliente   = setup + terapia   (o el ancla, ver abajo)
 *   recurso liberado     = setup + terapia + turnaround
 *   invariante de config = setup + terapia + turnaround <= slot
 *
 * Un combo NO declara offsets: los offsets se derivan encadenando la salida del
 * cliente de un tramo con la grilla de inicio del recurso del tramo siguiente.
 * Si un combo necesitara una regla escrita a mano, el modelo estaría mal.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Advertencia } from './rechazos.js';

// ═══════════════════════════════════════════════════════════════════════════
// Recursos físicos
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Clase de recurso físico. Es un enum del dominio (las cosas que el centro
 * posee), no un parámetro: la *cantidad* de unidades y sus *tiempos* son
 * configuración, pero incorporar una clase nueva de equipo es un cambio de
 * modelo.
 */
export type TipoRecurso =
  | 'hbot-monoplaza'
  | 'hbot-biplaza'
  | 'hbot-multiplaza'
  | 'ihht'
  | 'recovery-pro'
  | 'tumbona-red-light'
  | 'compresion'
  | 'crioterapia'
  | 'camilla-masajes'
  | 'consultorio'
  | 'sala-tb'
  | 'puesto-iv';

export type Planta = 'baja' | 'alta' | 'sin-asignar';

/**
 * Dónde está físicamente una tumbona Red Light. Determina la direccionalidad
 * del pool: Recovery Pro sólo puede tomar las de su sala, porque el cliente
 * paga un gabinete privado y mandarlo al área común rompe el producto.
 */
export type UbicacionTumbona = 'sala-recovery' | 'standalone';

/** Campos numéricos de `TiemposRecurso`, para marcar cuáles no están ratificados. */
export type CampoTiempo =
  | 'slotMin'
  | 'setupMin'
  | 'terapiaMin'
  | 'turnaroundMin'
  | 'anclaSalidaMin'
  | 'grillaInicioMin';

/**
 * Una etapa de la secuencia interna de un recurso.
 *
 * Sólo los recursos cuya secuencia interna **libera o toma otro recurso a mitad
 * de camino** necesitan declararla. Hoy es únicamente Recovery Pro: el cliente
 * pasa a una tumbona del pool en el minuto 28 y la devuelve en el 48, mientras
 * él sigue ocupando el gabinete hasta el 56 (ducha y vestuario).
 *
 * Esa secuencia no es decorativa: es **lo que hace posible el desfasaje de 30
 * minutos entre gabinetes (R-07)**. Si la ducha se hiciera antes de la luz roja,
 * las dos ventanas de tumbona se solaparían y el desfasaje dejaría de cerrar.
 */
export interface EtapaInterna {
  readonly nombre: string;
  readonly desdeMin: number;
  readonly hastaMin: number;
  /**
   * `'propio'`: la etapa transcurre en el recurso mismo.
   * `{ pool }`: la etapa toma una unidad de otro pool (una tumbona por ocupante)
   * y la devuelve al terminar.
   */
  readonly ocupa: 'propio' | { readonly pool: TipoRecurso };
  /**
   * ¿El cliente sigue adentro durante esta etapa? La última etapa con el cliente
   * presente define el ancla de salida, que es lo que encadena el combo.
   */
  readonly clientePresente: boolean;
}

/**
 * Tiempos de un recurso. Todo en minutos.
 *
 * `anclaSalidaMin` es un override: cuando el momento real de salida del cliente
 * no es `setup + terapia`, se declara acá y **gana**. Existe por dos casos
 * concretos y ninguno es un capricho:
 *
 *  - **HBOT**: el protocolo tiene tres tramos (presurización, isopresión,
 *    descenso) y el operador reparte los minutos según el cliente. El motor no
 *    modela los tramos: modela un único invariante, que el cliente sale del
 *    recinto en el minuto 55. Todo encadenamiento posterior parte de ahí.
 *  - **Recovery Pro**: se deriva de la secuencia interna (el cliente sale a los
 *    56, después de la ducha), así que no hace falta declararlo a mano.
 */
export interface TiemposRecurso {
  readonly slotMin: number;
  readonly setupMin: number;
  readonly terapiaMin: number;
  readonly turnaroundMin: number;
  readonly anclaSalidaMin?: number;
  /** Múltiplo al que se alinean los inicios de este recurso. */
  readonly grillaInicioMin: number;
  /** Secuencia interna, sólo si toma o libera otro recurso a mitad de camino. */
  readonly etapas?: readonly EtapaInterna[];
  /**
   * Campos cuyo valor todavía **no está ratificado**, con el motivo. El motor
   * los usa igual, pero los reporta como advertencia en cada plan que los toca,
   * para que nadie los confunda con un número acordado.
   */
  readonly noRatificado?: Partial<Record<CampoTiempo, string>>;
}

/** Una unidad física concreta: un gabinete, un puesto, una tumbona. */
export interface UnidadRecurso {
  readonly id: string;
  readonly tipo: TipoRecurso;
  readonly nombre: string;
  /** Cuántas personas entran a la vez (multiplaza 6, gabinete 2, puesto 1). */
  readonly capacidad: number;
  /**
   * ¿Pueden convivir **reservas distintas** en la unidad al mismo tiempo?
   *
   * Tener lugar no alcanza. La multiplaza sí se comparte: R-06 dice que un
   * cliente puede sumarse a una sesión ya reservada hasta el inicio, sin piso de
   * sesión. La biplaza no: R-04 le cobra el precio de monoplaza al que va solo,
   * o sea que está pagando la cámara entera, y meterle un desconocido después
   * obligaría a recotizarle el turno. El gabinete de Recovery Pro tampoco: es
   * privado, que es la misma razón por la que nunca recibe la tumbona del área
   * común.
   *
   * Obligatorio en toda unidad con capacidad mayor a 1 — el validador no deja
   * arrancar sin él, porque el default silencioso en cualquiera de las dos
   * direcciones rompe un producto.
   */
  readonly compartible?: boolean;
  readonly planta: Planta;
  /** Sólo en tumbonas: define la direccionalidad del pool. */
  readonly ubicacion?: UbicacionTumbona;
  /** Identidad del equipo físico (`JAY-20H #1`, `COT03`). Informativo. */
  readonly equipo?: string;
}

/**
 * Una clase de recurso: sus tiempos más las unidades que el centro tiene.
 *
 * `tiempos` es opcional a propósito. La camilla de masajes, el consultorio, la
 * sala TB y los puestos IV todavía no tienen tiempos medidos, y **inventarlos
 * sería peor que no tenerlos**: un slot mal supuesto genera atraso acumulativo a
 * lo largo del día. Cuando faltan, el recurso se declara con `sinTiempos`
 * explicando por qué, el validador lo reporta al arrancar y cualquier intento de
 * agendarlo devuelve `RECURSO_SIN_TIEMPOS`. Nunca hay un default silencioso.
 */
export interface Recurso {
  readonly tipo: TipoRecurso;
  readonly nombre: string;
  readonly tiempos?: TiemposRecurso;
  /** Por qué este recurso no tiene tiempos. Obligatorio si `tiempos` falta. */
  readonly sinTiempos?: string;
  readonly unidades: readonly UnidadRecurso[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Catálogo: servicios y combos
// ═══════════════════════════════════════════════════════════════════════════

/** Un servicio vendible que se ejecuta sobre un recurso. */
export interface Servicio {
  readonly codigo: string;
  readonly nombre: string;
  readonly tipoRecurso: TipoRecurso;
  /** R-03: IV Therapy y Terapia Biológica no se ejecutan sin autorización. */
  readonly requiereAutorizacionMedica: boolean;
  /** Sólo puede agendarse dentro de la franja clínica (toda IV, toda TB). */
  readonly soloFranjaClinica: boolean;
}

/**
 * Un tramo del catálogo de un combo. Declara **qué** servicio y en **qué orden**.
 *
 * No declara offset a propósito: el offset se deriva del encadenamiento de los
 * tiempos de los recursos. El tramo con offset ya resuelto es
 * `TramoPlanificado`, que sale del expansor.
 */
export interface TramoCombo {
  readonly orden: number;
  /**
   * Servicios que pueden cubrir el tramo, en orden de preferencia.
   *
   * Casi todos los tramos tienen uno solo. Los tramos de HBOT tienen tres —
   * monoplaza, biplaza y multiplaza — porque el producto comercial es el mismo
   * y la cámara la decide la cantidad de ocupantes y la disponibilidad. El
   * expansor prueba en orden y se queda con la primera que cierra; recepción
   * puede forzar una con `SolicitudDeReserva.seleccion`.
   *
   * Así emerge sin regla escrita a mano que la combinación que encadena sin
   * fricción sea biplaza (2 personas) hacia los 2 puestos de IHHT.
   */
  readonly servicios: readonly string[];
}

export interface Combo {
  readonly codigo: string;
  readonly nombre: string;
  readonly tramos: readonly TramoCombo[];
  /**
   * Duración publicada en el Manual y en el sitio. El validador de
   * configuración la contrasta con la duración **derivada** y avisa si difieren:
   * una diferencia significa que el modelo y el catálogo comercial discrepan, y
   * eso es una decisión de producto, no un ajuste de código.
   */
  readonly duracionPublicadaMin?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Comercial: membresías, titularidades y listas de precios
// ═══════════════════════════════════════════════════════════════════════════

export type ModalidadMembresia = 'standard' | 'intensivo';
export type FormatoMembresia = 'individual' | 'pareja';
export type PlazoMembresia = 'mensual' | 'trimestral';

/** Definición comercial de una membresía. */
export interface Membresia {
  readonly codigo: string;
  readonly nombre: string;
  /** Combo que la membresía habilita. */
  readonly comboBase: string;
  /** Sesiones mensuales por modalidad. */
  readonly sesionesPorModalidad: Readonly<Record<ModalidadMembresia, number>>;
}

/** Precio de una combinación concreta, dentro de una versión de lista. */
export interface PrecioMembresia {
  readonly membresia: string;
  readonly modalidad: ModalidadMembresia;
  readonly formato: FormatoMembresia;
  /** Precio base en USD, correspondiente al plazo trimestral. */
  readonly precioBaseUsd: number;
}

/** Precio de una sesión suelta, dentro de una versión de lista. */
export interface PrecioServicio {
  readonly servicio: string;
  /**
   * Precio por persona en USD. Puede depender de la cantidad de ocupantes:
   * la biplaza sale 100 por persona con dos, y 165 con una (R-04).
   */
  readonly precioPorOcupantesUsd: Readonly<Record<number, number>>;
  /** Precio por persona cuando la cantidad de ocupantes no está tabulada. */
  readonly precioPorPersonaUsd?: number;
}

/**
 * Una versión completa e **inmutable** de la lista de precios.
 *
 * El Founding Member no congela el precio de su membresía: congela la lista
 * entera vigente el día de su inscripción. Por eso el `Patient` guarda una
 * `version` y toda cotización se resuelve contra ella. Un FM que entró en
 * agosto 2026 con FOCUS y pasa a HEALTHSPAN en 2028 paga el HEALTHSPAN de
 * agosto 2026.
 *
 * Regla de oro: una versión publicada **nunca se edita**. Se publica otra.
 */
export interface VersionListaPrecios {
  /** Identificador estable, formato `AAAA-MM` (ej. `'2026-08'`). */
  readonly version: string;
  readonly vigenteDesde: Date;
  /** `undefined` mientras es la vigente. */
  readonly vigenteHasta?: Date;
  readonly membresias: readonly PrecioMembresia[];
  readonly servicios: readonly PrecioServicio[];
  /** Recargo del plazo mensual sobre el precio base (0.20 = +20 %). */
  readonly recargoPlazoMensual: number;
}

/** Una pausa de membresía declarada. */
export interface PausaMembresia {
  readonly inicio: Date;
  readonly fin: Date;
  /** Cuándo se declaró: la anticipación mínima se mide contra esta fecha. */
  readonly declaradaEn: Date;
}

export type EstadoTitularidad = 'activa' | 'pausada' | 'vencida' | 'en-mora';

/**
 * La titularidad viva de un cliente sobre una membresía: qué contrató, cuántas
 * sesiones le quedan y hasta cuándo.
 */
export interface Titularidad {
  readonly membresia: string;
  readonly modalidad: ModalidadMembresia;
  readonly formato: FormatoMembresia;
  readonly plazo: PlazoMembresia;
  readonly estado: EstadoTitularidad;
  readonly inicioCiclo: Date;
  /**
   * Fin del ciclo vigente. Las sesiones **no son acumulables**: vencen el último
   * día del mes o a los 30 días de contratado, lo que ocurra primero.
   */
  readonly finCiclo: Date;
  readonly sesionesAsignadas: number;
  readonly sesionesUsadas: number;
  readonly pausas: readonly PausaMembresia[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Cliente
// ═══════════════════════════════════════════════════════════════════════════

/** Categoría comercial, que fija la ventana de reserva. */
export type CategoriaCliente = 'publico' | 'miembro-standard' | 'miembro-intensivo';

/**
 * Perfil clínico asignado por el médico en el onboarding.
 *
 * Capa **separada** de la comercial: sirve para protocolos y segmentación
 * interna, nunca para decidir precios ni habilitaciones. El ruteo a membresía
 * es una sugerencia, no una regla del motor.
 */
export type PerfilClinico =
  | 'fatiga-cronica'
  | 'atleta'
  | 'anti-aging'
  | 'estres-cronico';

/** Una autorización médica registrada (R-03). */
export interface AutorizacionMedica {
  /** Servicio autorizado, o `'*'` para una autorización general. */
  readonly servicio: string;
  readonly vigenteDesde: Date;
  readonly vigenteHasta: Date;
  readonly autorizadaPor: string;
}

export interface Cliente {
  readonly id: string;
  readonly categoria: CategoriaCliente;
  /**
   * El tag Founding Member. Ojo: tenerlo no alcanza — R-09 exige membresía
   * vigente y sin mora. Usá `fmVigente()` en vez de leer este campo suelto.
   */
  readonly tagFoundingMember: boolean;
  /** Versión de lista de precios congelada al inscribirse como FM. */
  readonly fmVersionListaPrecios?: string;
  readonly enMora: boolean;
  readonly titularidad?: Titularidad;
  readonly autorizaciones: readonly AutorizacionMedica[];
  readonly perfilClinico?: PerfilClinico;
}

// ═══════════════════════════════════════════════════════════════════════════
// Solicitud y plan
// ═══════════════════════════════════════════════════════════════════════════

export type TipoProducto = 'suelta' | 'combo';

/** Programa asistencial bajo el que se agenda. */
export type Programa = 'bienestar' | 'clinico';

/** Lo que pide recepción. */
export interface SolicitudDeReserva {
  readonly producto: { readonly tipo: TipoProducto; readonly codigo: string };
  /** Inicio pretendido. */
  readonly inicio: Date;
  readonly ocupantes: number;
  readonly cliente: Cliente;
  /** El instante en que se está reservando; fija la ventana de anticipación. */
  readonly ahora: Date;
  readonly programa?: Programa;
  /** ¿Se descuenta de la membresía del cliente? */
  readonly consumeSesionDeMembresia?: boolean;
  /**
   * Fuerza un servicio concreto para un tramo del combo, por número de orden.
   * Es como recepción pide «BIO OXYGEN, pero en la multiplaza».
   */
  readonly seleccion?: Readonly<Record<number, string>>;
}

/** Una unidad física bloqueada en una ventana concreta. */
export interface Ocupacion {
  readonly unidadId: string;
  readonly tipoRecurso: TipoRecurso;
  readonly inicio: Date;
  readonly fin: Date;
  /** Qué la generó: `'IHHT'`, `'Recovery Pro · luz roja'`. */
  readonly motivo: string;
  /** Cuántas plazas de la unidad consume (multiplaza puede llevar varias). */
  readonly plazas: number;
}

/** Un tramo ya resuelto: recurso asignado, offset derivado y ventanas reales. */
export interface TramoPlanificado {
  readonly orden: number;
  readonly servicio: string;
  readonly tipoRecurso: TipoRecurso;
  /** Minutos desde el inicio del producto. **Derivado**, nunca declarado. */
  readonly offsetMin: number;
  /** Unidades asignadas al tramo (una por ocupante, salvo recursos multiplaza). */
  readonly unidades: readonly string[];
  readonly inicio: Date;
  /** Cuándo se libera el recurso, turnaround incluido. */
  readonly finRecurso: Date;
  /** Cuándo sale el cliente. Es lo que encadena con el tramo siguiente. */
  readonly salidaCliente: Date;
  /** Ocupaciones de otros pools que dispara la secuencia interna del recurso. */
  readonly subReservas: readonly Ocupacion[];
}

/** Cotización de una reserva. */
export interface Cotizacion {
  readonly totalUsd: number;
  readonly porPersonaUsd: number;
  readonly ocupantes: number;
  /** Versión de lista contra la que se cotizó. */
  readonly versionLista: string;
  /** Por qué se usó esa versión y no la vigente. */
  readonly motivoVersion: 'vigente' | 'lista-congelada-fm';
}

/** El plan completo: qué se bloquea, cuándo y por qué. */
export interface PlanDeReserva {
  readonly producto: { readonly tipo: TipoProducto; readonly codigo: string };
  readonly cliente: string;
  readonly ocupantes: number;
  readonly programa: Programa;
  readonly inicio: Date;
  /** Fin del último tramo, turnaround incluido. */
  readonly fin: Date;
  /** Cuándo se va el cliente del centro. */
  readonly salidaCliente: Date;
  readonly tramos: readonly TramoPlanificado[];
  /** Todo lo que hay que bloquear, aplanado y listo para escribir en la agenda. */
  readonly ocupaciones: readonly Ocupacion[];
  readonly cotizacion?: Cotizacion;
  readonly advertencias: readonly Advertencia[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Estado de la agenda
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lo que ya está reservado. El motor no sabe de dónde sale (en producción, de
 * los `Slot` busy de Medplum): recibe la foto y decide contra ella.
 */
export interface AgendaOcupada {
  readonly ocupaciones: readonly Ocupacion[];
}
