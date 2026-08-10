/**
 * Sistemas (URLs canónicas) e identificadores FHIR de Biowellness.
 *
 * Convención: kebab-case para los nombres de extensión, bajo el namespace
 * `https://biowellness.ar/fhir/...`. Centralizado acá para que el seed, los
 * bots y los tests usen exactamente los mismos strings.
 */

const BASE = 'https://biowellness.ar/fhir';

/** URLs base de StructureDefinition de extensiones custom. */
export const EXT = {
  // Patient
  tipoCliente: `${BASE}/StructureDefinition/tipo-cliente`,
  tagFm: `${BASE}/StructureDefinition/tag-fm`,
  tcBloqueoFm: `${BASE}/StructureDefinition/tc-bloqueo-fm`,
  perfilClinico: `${BASE}/StructureDefinition/perfil-clinico`,
  origenLead: `${BASE}/StructureDefinition/origen-lead`,
  /** Fecha de alta de la ficha (valueDate): cohortes mensuales del CRM. */
  fechaAlta: `${BASE}/StructureDefinition/fecha-alta`,
  // Practitioner
  splitPorcentaje: `${BASE}/StructureDefinition/split-porcentaje`,
  tipoContrato: `${BASE}/StructureDefinition/tipo-contrato`,
  // Schedule / Slot
  recursoFisico: `${BASE}/StructureDefinition/recurso-fisico`,
  comparteTumbona: `${BASE}/StructureDefinition/comparte-tumbona`,
  // Appointment
  ordenProtocolo: `${BASE}/StructureDefinition/orden-protocolo`,
  requiereHbotPrevio: `${BASE}/StructureDefinition/requiere-hbot-previo`,
  ocupantes: `${BASE}/StructureDefinition/ocupantes`,
  /** Tipo de ítem del turno (servicio/combo/paquete/membresia), para calcular la seña. */
  itemTipo: `${BASE}/StructureDefinition/item-tipo`,
  /** Código de catálogo del ítem del turno. */
  itemCodigo: `${BASE}/StructureDefinition/item-codigo`,
  /** Coverage (plan) que cubre el turno: si está, no requiere seña. */
  coberturaUsada: `${BASE}/StructureDefinition/cobertura-usada`,
  /** Vencimiento de la tentativa (R-19): si la seña no llega antes, se libera. */
  venceSena: `${BASE}/StructureDefinition/vence-sena`,
  // ActivityDefinition (catálogo)
  precioUsd: `${BASE}/StructureDefinition/precio-usd`,
  precioArs: `${BASE}/StructureDefinition/precio-ars`,
  /** Posición del servicio en la góndola del portal (menor = más arriba). */
  orden: `${BASE}/StructureDefinition/orden`,
  reglaPricingRecurso: `${BASE}/StructureDefinition/regla-pricing-recurso`,
  splitBw: `${BASE}/StructureDefinition/split-bw`,
  requierePrescripcion: `${BASE}/StructureDefinition/requiere-prescripcion`,
  // PlanDefinition (combos)
  secuenciaOrdenada: `${BASE}/StructureDefinition/secuencia-ordenada`,
  descuentoCombo: `${BASE}/StructureDefinition/descuento-combo`,
  // Coverage / Contract (membresía)
  tier: `${BASE}/StructureDefinition/tier`,
  version: `${BASE}/StructureDefinition/version`,
  sesionesMes: `${BASE}/StructureDefinition/sesiones-mes`,
  sesionesUsadas: `${BASE}/StructureDefinition/sesiones-usadas`,
  precioBloqueadoFm: `${BASE}/StructureDefinition/precio-bloqueado-fm`,
  /** Tipo de cobertura: 'membresia' | 'paquete'. */
  tipoCobertura: `${BASE}/StructureDefinition/tipo-cobertura`,
  /** Código del plan (membresía o paquete) del catálogo. */
  planCodigo: `${BASE}/StructureDefinition/plan-codigo`,
  /** Sesiones totales del paquete. */
  sesionesTotal: `${BASE}/StructureDefinition/sesiones-total`,
  /** Ciclo facturado (YYYY-MM) de la membresía. */
  cicloMes: `${BASE}/StructureDefinition/ciclo-mes`,
  // Invoice / ChargeItem
  montoSplitBw: `${BASE}/StructureDefinition/monto-split-bw`,
  montoSplitProfesional: `${BASE}/StructureDefinition/monto-split-profesional`,
  tcAplicado: `${BASE}/StructureDefinition/tc-aplicado`,
  /** Marca de que el Invoice es una seña (depósito). */
  esSena: `${BASE}/StructureDefinition/es-sena`,
  /**
   * Medio de pago del Invoice. CONTRATO con Administración: se escribe como
   * **valueString** con uno de los 5 códigos de MEDIOS_PAGO (nunca texto libre).
   */
  medioPago: `${BASE}/StructureDefinition/medio-pago`,
  // Coverage — cobro recurrente MercadoPago (tokenización; nunca datos de tarjeta)
  /** Id de customer de MercadoPago asociado al paciente. */
  mpCustomerId: `${BASE}/StructureDefinition/mp-customer-id`,
  /** Id de la tarjeta guardada en MercadoPago (token del lado de MP). */
  mpCardId: `${BASE}/StructureDefinition/mp-card-id`,
  // Communication
  canal: `${BASE}/StructureDefinition/canal`,
  templateUsado: `${BASE}/StructureDefinition/template-usado`,
  // Onboarding / invitación al portal
  /** Canal elegido para invitar al paciente al portal (whatsapp / email / qr). */
  canalInvitacion: `${BASE}/StructureDefinition/canal-invitacion`,
  // Caja chica (Basic movimiento / PaymentReconciliation arqueo)
  /** Monto del movimiento en ARS (valueDecimal, siempre positivo). */
  cajaMontoArs: `${BASE}/StructureDefinition/caja-monto-ars`,
  /** Categoría del gasto (valueCode de CATEGORIAS_GASTO). */
  cajaCategoria: `${BASE}/StructureDefinition/caja-categoria`,
  /** Foto/PDF del comprobante (valueAttachment → Binary). */
  cajaComprobante: `${BASE}/StructureDefinition/caja-comprobante`,
  /** Gasto sobre el tope: marcado como autorizado por Administración (valueBoolean). */
  cajaAutorizado: `${BASE}/StructureDefinition/caja-autorizado`,
  /** Arqueo: saldo esperado en ARS (valueDecimal). */
  cajaEsperado: `${BASE}/StructureDefinition/caja-esperado`,
  /** Arqueo: diferencia contado − esperado en ARS (valueDecimal). */
  cajaDiferencia: `${BASE}/StructureDefinition/caja-diferencia`,
} as const;

/** Sistemas de codificación / identificadores de negocio. */
export const SYSTEM = {
  servicioCodigo: `${BASE}/CodeSystem/servicio`,
  /**
   * Categoría (terapia) del servicio: `Appointment.serviceCategory`. Agrupa los
   * códigos que son la MISMA exposición (mono/biplaza/multiplaza → `HBOT`). Lo
   * lee el Panel Bio para el acumulado de sesiones. Ver src/fhir/appointment.ts.
   */
  categoriaServicio: `${BASE}/CodeSystem/categoria-servicio`,
  comboCodigo: `${BASE}/CodeSystem/combo`,
  membresiaCodigo: `${BASE}/CodeSystem/membresia`,
  paqueteCodigo: `${BASE}/CodeSystem/paquete`,
  recursoCodigo: `${BASE}/CodeSystem/recurso-fisico`,
  /**
   * Namespace PUBLICADO que el portal usa para encontrar agendas de médicos
   * (Schedule `bw-sched-{medico}` y sus Slot `bw-slot-*`). Contrato con
   * portal/consulta-medica: no renombrar.
   */
  sidRecurso: `${BASE}/sid/recurso`,
  contraindicacion: `${BASE}/CodeSystem/contraindicacion`,
  medico: `${BASE}/CodeSystem/medico`,
  /** Identifier de Invoice (para deduplicar señas: manual o por pago MP). */
  invoice: `${BASE}/Identifier/invoice`,
  /** Identifier de Communication (para deduplicar recordatorios automáticos). */
  communication: `${BASE}/Identifier/communication`,
  /** Documento (DNI) del paciente, para deduplicar altas. */
  dni: `${BASE}/Identifier/dni`,
  /**
   * Número de Founding Member (R-09): "1".."100". El value ubica la cohorte
   * (1–50 el 1 a 1 de Andrés, 51–100 la Web founding.html). Es un Identifier
   * y no solo la extensión tag-fm porque los identifiers SÍ son buscables:
   * `Patient?identifier=<system>|` trae el padrón completo para contar cupos.
   */
  fm: `${BASE}/Identifier/fm`,
  /** Tag de datos de demostración (se autodestruyen a las 48 h). */
  demo: `${BASE}/demo`,
  /** Bloqueos administrativos (R-11: pago rechazado → no se reserva). */
  bloqueo: `${BASE}/CodeSystem/bloqueo`,
  config: `${BASE}/Identifier/config`,
  /**
   * Caja chica de recepción: código de los movimientos (`Basic.code`:
   * egreso/reposicion/ajuste) e identifier de los arqueos
   * (`PaymentReconciliation.identifier`: arqueo-YYYY-MM-DD…). La AccessPolicy
   * de recepción da escritura de Basic SOLO con este code (el config del TC
   * también es Basic y no debe ser tocable desde el mostrador).
   */
  caja: `${BASE}/CodeSystem/caja`,
  /** Tipo de Task (p. ej. solicitud de turno desde el portal). */
  taskTipo: `${BASE}/CodeSystem/task-tipo`,
  /** Identifier de Task (para deduplicar alertas automáticas a Recepción). */
  task: `${BASE}/Identifier/task`,
} as const;

/** Códigos de negocio puntuales. */
export const COD = {
  /** Task.code de una solicitud de turno creada desde el portal del paciente. */
  solicitudTurno: 'solicitud-turno',
  /** Task de revisión de fichas duplicadas (bw-dedup-paciente → vista Duplicados). */
  posibleDuplicado: 'posible-duplicado',
} as const;

/**
 * Canales de origen del lead (lista CERRADA, docs/canales-acceso.md): se guarda
 * en `Patient.extension` origen-lead como uno de estos códigos, nunca texto
 * libre — así el CRM puede comparar canales.
 */
export const ORIGENES_LEAD = [
  'instagram',
  'linkedin',
  'google',
  'qr-local',
  'qr-evento',
  'web',
  'telefono',
  'walk-in',
  'referido',
  'derivacion',
  'otro',
] as const;

export type OrigenLead = (typeof ORIGENES_LEAD)[number];

export function esOrigenLead(v: string | undefined | null): v is OrigenLead {
  return Boolean(v) && (ORIGENES_LEAD as readonly string[]).includes(v as string);
}

/** Etiquetas para la UI (el valor persistido es SIEMPRE el código canónico). */
export const ORIGENES_LEAD_LABELS: Record<OrigenLead, string> = {
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  google: 'Google (Maps / búsqueda)',
  'qr-local': 'QR en el local',
  'qr-evento': 'QR en evento',
  web: 'Sitio web / portal',
  telefono: 'Teléfono',
  'walk-in': 'Mostrador (walk-in)',
  referido: 'Referido',
  derivacion: 'Derivación médica',
  otro: 'Otro',
};

/** Clave del recurso de configuración de Tipo de Cambio (Basic). */
export const CONFIG_TC_ID = 'config-tipo-cambio';

/** Moneda de lista del catálogo. */
export const MONEDA_LISTA = 'USD' as const;

// ============================================================================
// CONTRATO DE PAGOS con Administración (repo `administracion`) — INAMOVIBLE.
// El bot kpis-finanzas y los tableros de Andrés leen EXACTAMENTE estos códigos
// y URLs. Cambiarlos rompe los reportes. Ver docs/bots.md § Contrato de pagos.
// ============================================================================

/** Los 5 medios de pago canónicos. La UI de cobro es un select de ESTOS valores. */
export const MEDIOS_PAGO = [
  'efectivo',
  'tarjeta-debito',
  'tarjeta-credito',
  'transferencia',
  'mercadopago',
] as const;

export type MedioPago = (typeof MEDIOS_PAGO)[number];

export function esMedioPago(v: string | undefined | null): v is MedioPago {
  return Boolean(v) && (MEDIOS_PAGO as readonly string[]).includes(v as string);
}

/** Etiquetas para la UI (el valor persistido es SIEMPRE el código canónico). */
export const MEDIOS_PAGO_LABELS: Record<MedioPago, string> = {
  efectivo: 'Efectivo',
  'tarjeta-debito': 'Tarjeta débito',
  'tarjeta-credito': 'Tarjeta crédito',
  transferencia: 'Transferencia',
  mercadopago: 'MercadoPago',
};

/** Líneas comerciales del ChargeItem (las lee kpis-finanzas de administracion). */
export const LINEAS_COMERCIALES = [
  'membresias',
  'sueltas-combos',
  'paquetes',
  'iv-tb',
  'consultas',
  'otros',
] as const;

export type LineaComercial = (typeof LINEAS_COMERCIALES)[number];

/**
 * Extensión linea-comercial del ChargeItem (valueCode). ⚠️ El system es del
 * dominio del repo administracion (bio.medplum.com.ar), NO del nuestro: no
 * "corregirlo" — es el string exacto que lee el tablero.
 */
export const EXT_LINEA_COMERCIAL = 'https://bio.medplum.com.ar/fhir/StructureDefinition/linea-comercial';
