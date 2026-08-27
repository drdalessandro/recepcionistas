import { describe, expect, it, vi } from 'vitest';
import { conEsperaDeCuota } from '../src/bots/_shared.js';

/**
 * Cuota FHIR de Medplum: 50.000 puntos/min, escritura = 100 puntos. La demo de
 * ocupación (~1.400 escrituras) y su limpieza la agotan sí o sí. El contrato:
 * un 429 se ESPERA lo que el propio error pide (`_msBeforeNext`) y se
 * reintenta; cualquier otro error se relanza intacto, sin reintentos.
 */

/** El error tal como lo tira Medplum (OperationOutcomeError con el estado del limitador). */
function error429(msBeforeNext: number): Error {
  return new Error(
    `Too Many Requests ({"_remainingPoints":0,"_msBeforeNext":${msBeforeNext},"_consumedPoints":50090,"_isFirstInDuration":false,"limit":50000})`,
  );
}

describe('conEsperaDeCuota', () => {
  it('espera lo que pide el 429 y reintenta hasta que sale', async () => {
    let intentos = 0;
    const fn = vi.fn(async () => {
      intentos++;
      if (intentos < 3) {
        throw error429(5); // 5 ms: el test espera de verdad, pero nada
      }
      return 'listo';
    });
    await expect(conEsperaDeCuota(fn)).resolves.toBe('listo');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('un error que NO es 429 se relanza intacto, sin reintentos', async () => {
    const fn = vi.fn(async () => {
      throw new Error('Not found');
    });
    await expect(conEsperaDeCuota(fn)).rejects.toThrow('Not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('con maxEsperas agotado, el 429 sale a la superficie (no espera para siempre)', async () => {
    const fn = vi.fn(async () => {
      throw error429(1);
    });
    await expect(conEsperaDeCuota(fn, 2)).rejects.toThrow('Too Many Requests');
    expect(fn).toHaveBeenCalledTimes(3); // 1 intento + 2 esperas
  });
});
