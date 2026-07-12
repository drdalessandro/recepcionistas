import { MEDIOS_PAGO, MEDIOS_PAGO_LABELS, type MedioPago } from '@bw/fhir/identifiers';

export type { MedioPago };

/**
 * Data para TODOS los selects de medio de pago de la app. Contrato con
 * Administración: el valor persistido es SIEMPRE uno de los 5 códigos canónicos
 * (nunca texto libre); acá solo se decide la etiqueta visible.
 */
export const MEDIOS_SELECT = MEDIOS_PAGO.map((m) => ({ value: m, label: MEDIOS_PAGO_LABELS[m] }));
