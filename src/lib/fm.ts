/**
 * Founding Members (R-09) — lógica pura (sin FHIR ni red).
 *
 * Programa FM-100: dos cohortes consecutivas definidas por el NÚMERO del
 * fundador — 1–50 el 1 a 1 personal de Andrés, 51–100 la Web (founding.html).
 * La cohorte no se elige: la asigna el número, y el número lo asigna el orden
 * en que se marcan. El cupo avisa, nunca bloquea (decisión 2026-08-09).
 */
import { FM } from '../config/reglas.js';

export type CohorteFm = '1a1' | 'web';

export const COHORTE_FM_LABELS: Record<CohorteFm, string> = {
  '1a1': '1 a 1',
  web: 'Web',
};

/** Cohorte de un número de fundador: 1–50 → 1 a 1; 51 en adelante → Web. */
export function cohorteFm(numero: number): CohorteFm {
  return numero <= FM.cupos1a1 ? '1a1' : 'web';
}

/**
 * Próximo número a asignar: máximo existente + 1. Con el padrón vacío arranca
 * en 1. Si se desmarcó al último, su número se reusa (max de los que quedan
 * + 1); los huecos del medio NO se rellenan — el número cuenta la historia
 * del programa, no la ocupación actual.
 */
export function proximoNumeroFm(numerosExistentes: readonly number[]): number {
  let max = 0;
  for (const n of numerosExistentes) {
    if (Number.isFinite(n) && n > max) {
      max = n;
    }
  }
  return max + 1;
}

export interface AvisoCupoFm {
  nivel: 'ok' | 'alerta' | 'cupo-web' | 'programa-completo';
  mensaje?: string;
}

/**
 * Aviso al marcar el fundador número `numero` (R-09: avisar, nunca bloquear).
 *  - 1–39: sin aviso.
 *  - 40–50: alerta — el cupo 1 a 1 se agota.
 *  - 51–100: entra en la cohorte Web, no en el 1 a 1.
 *  - 101+: el programa FM-100 está completo; marcar igual es decisión de Andrés.
 */
export function avisoCupoFm(numero: number): AvisoCupoFm {
  if (numero > FM.cuposTotales) {
    return {
      nivel: 'programa-completo',
      mensaje: `El programa Founding (${FM.cuposTotales}) está completo: este sería el Nº ${numero}. Se puede marcar igual — confirmalo con Andrés.`,
    };
  }
  if (numero > FM.cupos1a1) {
    return {
      nivel: 'cupo-web',
      mensaje: `Nº ${numero}: entra en el cupo Web (${FM.cupos1a1 + 1}–${FM.cuposTotales}), no en el 1 a 1.`,
    };
  }
  if (numero >= FM.alertaEnCupo) {
    return {
      nivel: 'alerta',
      mensaje: `Quedan ${FM.cupos1a1 - numero} lugares del cupo 1 a 1 después de este.`,
    };
  }
  return { nivel: 'ok' };
}
