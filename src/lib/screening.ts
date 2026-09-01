/**
 * Evaluación del screening de ingreso — lógica pura (sin FHIR ni red).
 *
 * El agujero que cierra: `leerScreeningCompleto` solo verificaba que EXISTIERA
 * un QuestionnaireResponse `completed` — jamás abría las respuestas. Contestar
 * "sí" a una descalificante producía el mismo "apto" que contestar todo "no",
 * por el portal y por el kiosco por igual, y la reserva de HBOT pasaba (R-20
 * exigía "completo", no "sin riesgos"; R-02 solo miraba Flags que ningún
 * proceso creaba desde el screening).
 *
 * Qué hace: recorre las respuestas (recursivo, los grupos del cuestionario
 * anidan), detecta las afirmativas entre las preguntas de riesgo
 * (`SCREENING_RIESGOS`) y devuelve dos listas:
 *  - `declarados`: los linkIds afirmativos — alimentan el banner (rojo).
 *  - `codigos`: sus equivalentes en la tabla de contraindicaciones validada —
 *    alimentan R-02 con la severidad que definió el Director Médico.
 *
 * Robustez de formatos: el portal y el kiosco usan QuestionnaireForm de
 * Medplum, que para `type: boolean` guarda `valueBoolean`. Igual se aceptan
 * variantes (`valueString` "true"/"sí", `valueCoding`) porque una respuesta
 * afirmativa mal tipada que pase inadvertida es exactamente el bug original.
 */
import type { QuestionnaireResponseItem } from '@medplum/fhirtypes';
import { SCREENING_RIESGOS } from '../config/cuestionario-ingreso.js';

export interface ResultadoScreening {
  /** linkIds de riesgo contestados afirmativamente (mapeados a la tabla o no). */
  declarados: string[];
  /** Códigos de la tabla de contraindicaciones equivalentes (para R-02). */
  codigos: string[];
}

const AFIRMATIVOS = new Set(['si', 'sí', 'true', 'yes', 'y']);

/** ¿Alguna de las respuestas del ítem es afirmativa? */
function esAfirmativa(item: QuestionnaireResponseItem): boolean {
  return (item.answer ?? []).some((a) => {
    if (a.valueBoolean === true) {
      return true;
    }
    const textos = [a.valueString, a.valueCoding?.code, a.valueCoding?.display];
    return textos.some((t) => typeof t === 'string' && AFIRMATIVOS.has(t.trim().toLowerCase()));
  });
}

/** Aplana el árbol de respuestas (los grupos anidan) en un mapa por linkId. */
function porLinkId(
  items: QuestionnaireResponseItem[] | undefined,
  destino: Map<string, QuestionnaireResponseItem>,
): void {
  for (const item of items ?? []) {
    if (item.linkId) {
      destino.set(item.linkId, item);
    }
    porLinkId(item.item, destino);
    // Medplum también puede anidar ítems DENTRO de una respuesta (answer.item).
    for (const a of item.answer ?? []) {
      porLinkId(a.item, destino);
    }
  }
}

/** Evalúa las respuestas del cuestionario de ingreso contra las preguntas de riesgo. */
export function evaluarScreening(items: QuestionnaireResponseItem[] | undefined): ResultadoScreening {
  const respuestas = new Map<string, QuestionnaireResponseItem>();
  porLinkId(items, respuestas);

  const declarados: string[] = [];
  const codigos: string[] = [];
  for (const riesgo of SCREENING_RIESGOS) {
    const item = respuestas.get(riesgo.linkId);
    if (item && esAfirmativa(item)) {
      declarados.push(riesgo.linkId);
      codigos.push(...riesgo.codigos);
    }
  }
  return { declarados, codigos: [...new Set(codigos)] };
}
