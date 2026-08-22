/**
 * Membresías y listas de precios versionadas.
 *
 * ⚠️ [PROPUESTA NO RATIFICADA] — La estructura de membresías está en revisión.
 * Todos los precios de este archivo son la propuesta que hay sobre la mesa, no
 * una lista acordada. El motor los usa y los arrastra como advertencia hasta el
 * plan de reserva. No hardcodear nada de esto en el código.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VERSIONADO Y EL FOUNDING MEMBER
 *
 * El FM **no** congela el precio de su membresía: congela la lista de precios
 * completa vigente el día de su inscripción. Por eso las listas son versiones
 * enteras e inmutables, y el cliente guarda una `fmVersionListaPrecios`.
 *
 * Un FM que entró en agosto 2026 con FOCUS y en 2028 pasa a HEALTHSPAN paga el
 * HEALTHSPAN de agosto 2026. Eso sólo funciona si la lista de agosto 2026 sigue
 * existiendo entera y sin editar.
 *
 * REGLA DE ORO: una versión publicada nunca se edita. Se publica otra.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Membresia, PrecioServicio, VersionListaPrecios } from '../dominio/tipos.js';

export const MEMBRESIAS: readonly Membresia[] = [
  {
    codigo: 'FOCUS',
    nombre: 'Focus',
    comboBase: 'BIO_OXYGEN',
    sesionesPorModalidad: { standard: 8, intensivo: 12 },
  },
  {
    codigo: 'PRIME',
    nombre: 'Prime',
    comboBase: 'BIO_RECOVERY',
    sesionesPorModalidad: { standard: 8, intensivo: 12 },
  },
  {
    codigo: 'HEALTHSPAN',
    nombre: 'Healthspan',
    comboBase: 'BIO_LONGEVITY',
    sesionesPorModalidad: { standard: 8, intensivo: 12 },
  },
];

/**
 * Precios de sesión suelta.
 *
 * Sólo están cargados los que el Manual da por decididos:
 *  - R-04 Biplaza: con 2 ocupantes, USD 100 por persona; con 1, USD 165 (precio
 *    monoplaza). La reserva registra la cantidad de ocupantes.
 *  - R-06 Multiplaza: USD 80 por persona desde 1 ocupante, sin piso de sesión.
 *    La ocupación se calcula sobre 6 plazas.
 *
 * El resto del catálogo **no tiene precio cargado a propósito**: nadie los
 * ratificó y no se inventan. El validador los reporta al arrancar como faltantes
 * y cotizarlos devuelve `PRECIO_NO_DEFINIDO`.
 */
const SERVICIOS_CON_PRECIO: readonly PrecioServicio[] = [
  {
    servicio: 'HBOT_BIPLAZA',
    precioPorOcupantesUsd: { 1: 165, 2: 100 },
  },
  {
    servicio: 'HBOT_MULTIPLAZA',
    precioPorOcupantesUsd: {},
    precioPorPersonaUsd: 80,
  },
];

/**
 * Lista de agosto de 2026. Es la versión contra la que cotizan los Founding
 * Members inscriptos ese mes, para siempre.
 */
export const LISTA_2026_08: VersionListaPrecios = {
  version: '2026-08',
  vigenteDesde: new Date('2026-08-01T00:00:00.000Z'),
  recargoPlazoMensual: 0.2,
  servicios: SERVICIOS_CON_PRECIO,
  membresias: [
    { membresia: 'FOCUS', modalidad: 'standard', formato: 'individual', precioBaseUsd: 1200 },
    { membresia: 'FOCUS', modalidad: 'intensivo', formato: 'individual', precioBaseUsd: 1680 },
    { membresia: 'FOCUS', modalidad: 'standard', formato: 'pareja', precioBaseUsd: 1800 },
    { membresia: 'FOCUS', modalidad: 'intensivo', formato: 'pareja', precioBaseUsd: 2520 },
    { membresia: 'PRIME', modalidad: 'standard', formato: 'individual', precioBaseUsd: 1752 },
    { membresia: 'PRIME', modalidad: 'intensivo', formato: 'individual', precioBaseUsd: 2453 },
    { membresia: 'PRIME', modalidad: 'standard', formato: 'pareja', precioBaseUsd: 1920 },
    { membresia: 'PRIME', modalidad: 'intensivo', formato: 'pareja', precioBaseUsd: 2688 },
    { membresia: 'HEALTHSPAN', modalidad: 'standard', formato: 'individual', precioBaseUsd: 2184 },
    { membresia: 'HEALTHSPAN', modalidad: 'intensivo', formato: 'individual', precioBaseUsd: 3058 },
    { membresia: 'HEALTHSPAN', modalidad: 'standard', formato: 'pareja', precioBaseUsd: 2784 },
    { membresia: 'HEALTHSPAN', modalidad: 'intensivo', formato: 'pareja', precioBaseUsd: 3898 },
  ],
};

export const LISTAS_PRECIOS: readonly VersionListaPrecios[] = [LISTA_2026_08];
