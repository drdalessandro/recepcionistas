import { describe, it, expect, vi, afterEach } from 'vitest';
import type { BotEvent } from '@medplum/core';
import { handler, type EntradaFederador, type ResultadoFederador } from '../src/bots/federador.js';
import { BUS_URLS } from '../src/lib/bus-msal.js';
import { SYSTEM_RENAPER_DNI } from '../src/fhir/identifiers.js';

/**
 * El bot contra el bus del Ministerio.
 *
 * Lo que se prueba acá es **qué contesta cuando el otro lado se porta mal**, que
 * es donde estaba el defecto que encontró la revisión: un 200 con un cuerpo que
 * no es FHIR se reportaba como "esa persona no está federada" — una afirmación
 * falsa sobre el registro nacional, y sin rastro en el log.
 */

const SECRETS = {
  BUS_MSAL_URL: { name: 'BUS_MSAL_URL', valueString: BUS_URLS.qa },
  BUS_MSAL_ISSUER: { name: 'BUS_MSAL_ISSUER', valueString: 'https://api.medplum.com.ar' },
  BUS_MSAL_SECRET: { name: 'BUS_MSAL_SECRET', valueString: 'secreto-de-prueba' },
};

const PACIENTE = {
  resourceType: 'Patient',
  id: '5025175',
  identifier: [{ use: 'usual', system: SYSTEM_RENAPER_DNI, value: '12497884' }],
  active: true,
  name: [{ use: 'official', text: 'DANIEL SILVIO VACCARO', family: 'VACCARO', given: ['DANIEL', 'SILVIO'] }],
  gender: 'male',
  birthDate: '1956-04-26',
};

function evento(input: EntradaFederador, secrets: Record<string, unknown> = SECRETS): BotEvent<EntradaFederador> {
  return { bot: { reference: 'Bot/test' }, contentType: 'application/json', input, secrets } as never;
}

/** Mockea el fetch: primero el auth, después la búsqueda. */
function mockFetch(busqueda: { status?: number; body?: string; json?: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/bus-auth/')) {
        return new Response(JSON.stringify({ accessToken: 'TOK' }), { status: 200 });
      }
      const cuerpo = busqueda.body ?? JSON.stringify(busqueda.json ?? {});
      return new Response(cuerpo, { status: busqueda.status ?? 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cuando el bus se porta mal, no dice que la persona no existe', () => {
  it('200 con HTML de un proxy → bus-no-responde, NO sin-resultados', async () => {
    mockFetch({ body: '<html>502 Bad Gateway</html>' });
    const r = (await handler({} as never, evento({ dni: '12497884' }))) as ResultadoFederador;
    expect(r.motivo).toBe('bus-no-responde');
    expect(r.detalle).toContain('no-JSON');
  });

  it('200 con OperationOutcome → bus-no-responde', async () => {
    mockFetch({ json: { resourceType: 'OperationOutcome', issue: [{ severity: 'error' }] } });
    const r = (await handler({} as never, evento({ dni: '12497884' }))) as ResultadoFederador;
    expect(r.motivo).toBe('bus-no-responde');
    expect(r.detalle).toContain('OperationOutcome');
  });

  it('200 con un JSON sin resourceType → bus-no-responde', async () => {
    mockFetch({ json: { cualquier: 'cosa' } });
    const r = (await handler({} as never, evento({ dni: '12497884' }))) as ResultadoFederador;
    expect(r.motivo).toBe('bus-no-responde');
  });

  it('un Bundle vacío SÍ es sin-resultados: el bus contestó bien', async () => {
    mockFetch({ json: { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] } });
    const r = (await handler({} as never, evento({ dni: '12497884' }))) as ResultadoFederador;
    expect(r.motivo).toBe('sin-resultados');
  });

  it('un 500 sigue siendo bus-no-responde, con el código', async () => {
    mockFetch({ status: 500, body: 'boom' });
    const r = (await handler({} as never, evento({ dni: '12497884' }))) as ResultadoFederador;
    expect(r.motivo).toBe('bus-no-responde');
    expect(r.detalle).toContain('500');
  });
});

describe('el camino feliz', () => {
  it('devuelve la sugerencia y el ambiente', async () => {
    mockFetch({ json: { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: PACIENTE }] } });
    const r = (await handler({} as never, evento({ dni: '12.497.884' }))) as ResultadoFederador;
    expect(r.ok).toBe(true);
    expect(r.ambiente).toBe('qa');
    expect(r.sugerencia).toMatchObject({ nombre: 'DANIEL SILVIO', apellido: 'VACCARO', genero: 'male' });
    expect(r.idFederador).toBe('5025175');
  });

  it('no pisa lo que la recepcionista ya escribió', async () => {
    mockFetch({ json: { resourceType: 'Bundle', entry: [{ resource: PACIENTE }] } });
    const r = (await handler(
      {} as never,
      evento({ dni: '12497884', yaCargado: { nombre: 'Daniel', genero: 'male' } }),
    )) as ResultadoFederador;
    expect(r.sugerencia?.nombre).toBeUndefined();
    expect(r.sugerencia?.genero).toBeUndefined();
    expect(r.sugerencia?.apellido).toBe('VACCARO');
  });
});

describe('no sale a la red si algo no está en orden', () => {
  it('sin secrets: sin-credenciales y NI UN fetch', async () => {
    const espia = vi.fn();
    vi.stubGlobal('fetch', espia);
    const r = (await handler({} as never, evento({ dni: '12497884' }, {}))) as ResultadoFederador;
    expect(r.motivo).toBe('sin-credenciales');
    expect(espia).not.toHaveBeenCalled();
  });

  it('una URL que no es ninguno de los dos buses: NO se firma nada', async () => {
    // Un `http://` por tipeo mandaría el JWT —y después el DNI— en claro.
    const espia = vi.fn();
    vi.stubGlobal('fetch', espia);
    const r = (await handler(
      {} as never,
      evento({ dni: '12497884' }, { ...SECRETS, BUS_MSAL_URL: { valueString: 'http://bus.msal.gob.ar' } }),
    )) as ResultadoFederador;
    expect(r.motivo).toBe('bus-desconocido');
    expect(espia).not.toHaveBeenCalled();
  });

  it('un DNI que no es un DNI no se consulta', async () => {
    const espia = vi.fn();
    vi.stubGlobal('fetch', espia);
    const r = (await handler({} as never, evento({ dni: '123' }))) as ResultadoFederador;
    expect(r.motivo).toBe('dni-invalido');
    expect(espia).not.toHaveBeenCalled();
  });
});

describe('la consulta va con el system canónico y el path del servicio', () => {
  it('la URL de búsqueda lleva el identifier de RENAPER y masterfile-federacion-service', async () => {
    const llamadas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        llamadas.push(String(url));
        return new Response(
          JSON.stringify(String(url).includes('/bus-auth/') ? { accessToken: 'TOK' } : { resourceType: 'Bundle', entry: [] }),
          { status: 200 },
        );
      }),
    );
    await handler({} as never, evento({ dni: '12497884' }));
    const busqueda = llamadas.find((u) => !u.includes('/bus-auth/')) ?? '';
    expect(busqueda).toContain('/masterfile-federacion-service/fhir/Patient');
    expect(busqueda).toContain(`${SYSTEM_RENAPER_DNI}|12497884`);
    expect(busqueda.startsWith(BUS_URLS.qa)).toBe(true);
  });
});
