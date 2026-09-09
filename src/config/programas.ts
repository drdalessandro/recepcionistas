/**
 * Programas — productos por TIEMPO, no por sesiones (handoff PB100D §2).
 *
 * Un programa no vende sesiones: su Coverage no lleva contador y el portal lo
 * muestra en "Mi cuenta" sin saldo. Se publican como PlanDefinition igual que
 * las membresías, pero con `type.text = 'programa'`: el portal deriva las
 * variantes de membresía de los sufijos del código (`_INT_`, `_PAR`) y exige
 * `tier` — nada de eso aplica acá, y mezclar familias rompería esa derivación.
 *
 * El portal NO hardcodea códigos: título, bajada y precio salen del
 * PlanDefinition. Cambiar un precio o sumar una modalidad es tocar este archivo
 * y correr `npm run seed`.
 *
 * ⚠️ El COPY (`descripcion`) es la referencia del brief PB100D §6.10 y está
 * pendiente de validación del Director Médico — igual que el resto del copy
 * clínico del programa. Ajustarlo acá cuando lo valide.
 */
import type { ModalidadPrograma } from '../domain/types.js';

export interface Programa {
  codigo: string;
  nombre: string;
  /** 'mensual' = suscripción renovable cada 30 días · '100-dias' = pago único. */
  modalidad: ModalidadPrograma;
  precioUSD: number;
  /** Orden en la góndola del portal (extensión `orden`). */
  orden: number;
  /**
   * Vigencia en días del Coverage. Solo la modalidad de pago único la tiene:
   * el programa entero se vende una vez y termina solo. La mensual no vence —
   * se renueva mientras la paciente no la cancele.
   */
  vigenciaDias?: number;
  /** La bajada que lee la paciente debajo del título (PlanDefinition.description). */
  descripcion: string;
}

export const PROGRAMAS: Programa[] = [
  {
    codigo: 'PB100D_PREMIUM_MENSUAL',
    nombre: 'Plan Bienestar 100 Días — Premium',
    modalidad: 'mensual',
    precioUSD: 100,
    orden: 1,
    descripcion:
      'Seguimiento médico y nutricional personalizado durante tu programa de 100 días: ' +
      'ajustes del protocolo por el médico, y atención prioritaria en mensajes y turnos. ' +
      'Se cobra por mes y podés cancelarlo cuando quieras.',
  },
  {
    codigo: 'PB100D_PREMIUM_100D',
    nombre: 'Plan Bienestar 100 Días — Premium completo',
    modalidad: '100-dias',
    precioUSD: 300,
    orden: 2,
    vigenciaDias: 100,
    descripcion:
      'El mismo acompañamiento premium —seguimiento médico y nutricional personalizado, ' +
      'ajustes del protocolo por el médico y atención prioritaria— pagando una sola vez ' +
      'los 100 días completos.',
  },
];

export const PROGRAMAS_POR_CODIGO: ReadonlyMap<string, Programa> = new Map(
  PROGRAMAS.map((p) => [p.codigo, p]),
);

export function getPrograma(codigo: string): Programa {
  const p = PROGRAMAS_POR_CODIGO.get(codigo);
  if (!p) {
    throw new Error(`Programa desconocido: ${codigo}`);
  }
  return p;
}
