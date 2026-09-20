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
import type { Appointment, CodeableConcept } from '@medplum/fhirtypes';
import { CATEGORIA_COMERCIAL, SERVICIOS_POR_CODIGO, getServicio } from '../config/catalogo.js';
import type { ModalidadAtencion } from '../domain/types.js';
import { EXT, SYSTEM } from './identifiers.js';

/**
 * Código del profesional que atiende el turno (`MED_DALESSANDRO`), si es una
 * consulta. Sale del ítem COBRADO (`item-codigo` → catálogo → `practitionerCodigo`)
 * y no del `participant Practitioner/…`: el participant trae el id del
 * recurso, y lo que se necesita para avisarle es su código, que es como se
 * nombran sus Project Secrets (`PROFESIONAL_WHATSAPP_<código>`). Un combo o
 * una terapia no tienen profesional: `undefined`.
 */
export function practitionerCodigoDeTurno(appt: Appointment): string | undefined {
  const codigo = appt.extension?.find((e) => e.url === EXT.itemCodigo)?.valueString;
  return codigo ? SERVICIOS_POR_CODIGO.get(codigo)?.practitionerCodigo : undefined;
}

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

/**
 * `appointmentType` del turno: **cómo** se presta, presencial o por videollamada.
 *
 * Va en el campo nativo y no en una extensión nuestra por el mismo motivo que
 * `serviceType`: FHIR tiene el campo, y quien lee el turno de afuera (el Panel
 * Bio, el portal, Administración) no debería tener que aprenderse una extensión
 * para saber si la consulta fue por video. También es el campo por el que se
 * busca: `Appointment?appointment-type=<system>|virtual`.
 */
export function modalidadAppointmentType(modalidad: ModalidadAtencion): CodeableConcept {
  return {
    coding: [{ system: SYSTEM.modalidadAtencion, code: modalidad }],
    text: modalidad === 'virtual' ? 'Por videollamada' : 'Presencial',
  };
}

/**
 * Modalidad de un turno ya creado. **Ausente = `presencial`**: todos los turnos
 * anteriores a la teleconsulta lo son, y tratarlos de otra manera cambiaría
 * retroactivamente cómo se cobran.
 *
 * Es la función por la que el cobro decide si pide seña o el total (ver
 * `fraccionAnticipada` en `src/lib/pricing.ts`): que salga del TURNO y no de un
 * parámetro es lo que evita que un llamador se olvide de pasarla y le cobre a
 * una teleconsulta la mitad, sin saldo que reclamar después.
 */
export function modalidadDeTurno(appt: Appointment): ModalidadAtencion {
  const code = appt.appointmentType?.coding?.find((c) => c.system === SYSTEM.modalidadAtencion)?.code;
  return code === 'virtual' ? 'virtual' : 'presencial';
}
