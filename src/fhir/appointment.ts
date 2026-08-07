/**
 * Campos FHIR nativos del turno que dicen QUÉ se hace.
 *
 * `Appointment.extension` item-tipo/item-codigo dice qué se **cobró** (contrato
 * de facturación: en un combo es el código del combo, `BIO_OXYGEN`). Eso no
 * alcanza para el registro clínico: el Panel Bio necesita saber qué terapia se
 * administra en esa sala para contar la exposición acumulada (el tope de HBOT
 * es de por vida, no de la serie en curso), y ahí un turno de combo tiene que
 * decir `HBOT_MONO`, no `BIO_OXYGEN`.
 *
 * Por eso el servicio efectivo viaja además en los campos nativos de FHIR:
 *   - `serviceType`     → el servicio (`HBOT_MONO`), sistema `CodeSystem/servicio`.
 *   - `serviceCategory` → la terapia (`HBOT`), sistema `CodeSystem/categoria-servicio`.
 *
 * La categoría existe porque una terapia tiene VARIOS códigos: monoplaza,
 * biplaza y multiplaza son tres servicios distintos y la misma exposición. Con
 * la categoría en el turno, quien cuenta no necesita mantener una tabla de
 * equivalencias ni se rompe cuando el catálogo suma un servicio nuevo.
 */
import type { CodeableConcept } from '@medplum/fhirtypes';
import { CATEGORIA_COMERCIAL, getServicio } from '../config/catalogo.js';
import { SYSTEM } from './identifiers.js';

export interface ClasificacionServicio {
  serviceType: CodeableConcept[];
  serviceCategory: CodeableConcept[];
}

/**
 * `serviceType` + `serviceCategory` del turno a partir del código de servicio.
 * Lanza si el código no está en el catálogo (mismo criterio que `getServicio`).
 */
export function clasificacionDeServicio(servicioCodigo: string): ClasificacionServicio {
  const s = getServicio(servicioCodigo);
  return {
    serviceType: [
      { coding: [{ system: SYSTEM.servicioCodigo, code: s.codigo, display: s.nombre }], text: s.nombre },
    ],
    serviceCategory: [
      {
        coding: [
          { system: SYSTEM.categoriaServicio, code: s.categoria, display: CATEGORIA_COMERCIAL[s.categoria] },
        ],
        text: CATEGORIA_COMERCIAL[s.categoria],
      },
    ],
  };
}
