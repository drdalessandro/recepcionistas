import { describe, it, expect } from 'vitest';
import {
  ASSERTION_TTL_S,
  PATH_AUTH,
  PATH_FEDERADOR,
  SCOPES,
  claimsClientAssertion,
  cuerpoPedidoToken,
  tokenSirve,
  urlBusquedaPorDni,
  urlToken,
  type TokenCacheado,
} from '../src/lib/bus-msal.js';
import { firmarClientAssertion } from '../src/bots/federador.js';

/**
 * Bus Auth v2 del Ministerio de Salud.
 *
 * Todo lo que se fija acá sale de la **colección de Postman oficial** del
 * Federador (PacientesPROD, OCT 2025). No son preferencias nuestras: son el
 * contrato del otro lado, y si algo cambia allá, estos tests lo cantan.
 */

const ISSUER = 'https://api.medplum.com.ar';
const AHORA = new Date('2026-08-25T01:00:00Z');

describe('el pedido de token, tal como lo hace la colección oficial', () => {
  it('el endpoint es /bus-auth/v2/auth', () => {
    expect(urlToken('https://bus.msal.gob.ar')).toBe('https://bus.msal.gob.ar/bus-auth/v2/auth');
    expect(PATH_AUTH).toBe('/bus-auth/v2/auth');
  });

  it('una barra de más en la base no duplica la barra', () => {
    expect(urlToken('https://bus.msal.gob.ar/')).toBe('https://bus.msal.gob.ar/bus-auth/v2/auth');
  });

  it('el body lleva los cuatro campos, con el clientAssertionType de OAuth2', () => {
    expect(cuerpoPedidoToken(SCOPES.pacienteLeer, 'JWT.FIRMADO.ACA')).toEqual({
      grantType: 'client_credentials',
      scope: 'Patient/*.read',
      clientAssertionType: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      clientAssertion: 'JWT.FIRMADO.ACA',
    });
  });

  it('UN scope por token: nunca se mandan todos juntos', () => {
    // La pantalla de credenciales es explícita: "debe incluirse únicamente
    // Patient/*.read en el campo scope".
    const body = cuerpoPedidoToken(SCOPES.pacienteLeer, 'x');
    expect(body.scope).toBe('Patient/*.read');
    expect(body.scope).not.toContain(',');
  });
});

describe('los claims del JWT', () => {
  it('`iss` es el dominio; `iat`/`exp` en segundos', () => {
    const c = claimsClientAssertion(ISSUER, AHORA);
    expect(c.iss).toBe(ISSUER);
    expect(c.iat).toBe(Math.floor(AHORA.getTime() / 1000));
    expect(c.exp).toBe((c.iat as number) + ASSERTION_TTL_S);
  });

  it('los claims de relleno van con el valor literal de la colección', () => {
    // Son relleno que el bus no valida. Se replican tal cual: "mejorarlos" con
    // valores que parezcan sensatos sería inventar un contrato.
    const c = claimsClientAssertion(ISSUER, AHORA);
    expect(c).toMatchObject({ aud: 'aud', sub: 'sub', name: 'name', ident: 'ident', role: 'role' });
  });

  it('la aserción vive minutos, no meses', () => {
    // La colección oficial usa iat + 6000000 (≈69 días) para un credential de un
    // solo uso. Un exp más corto nunca es más permisivo.
    expect(ASSERTION_TTL_S).toBeLessThanOrEqual(15 * 60);
  });
});

describe('la firma HS256', () => {
  it('arma un JWT de tres partes en base64url', () => {
    const jwt = firmarClientAssertion(ISSUER, 'secreto-de-prueba', AHORA);
    const partes = jwt.split('.');
    expect(partes).toHaveLength(3);
    // base64url: sin +, sin / y sin padding.
    for (const p of partes) {
      expect(p).not.toMatch(/[+/=]/);
    }
  });

  it('el header declara HS256, que es lo que fija la colección', () => {
    const [header] = firmarClientAssertion(ISSUER, 's', AHORA).split('.');
    const decodificado = JSON.parse(Buffer.from(header as string, 'base64url').toString());
    expect(decodificado).toEqual({ typ: 'JWT', alg: 'HS256' });
  });

  it('el payload lleva nuestro issuer', () => {
    const payload = firmarClientAssertion(ISSUER, 's', AHORA).split('.')[1] as string;
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss).toBe(ISSUER);
  });

  it('otro secreto ⇒ otra firma (si no, no estaría firmando nada)', () => {
    const a = firmarClientAssertion(ISSUER, 'secreto-a', AHORA);
    const b = firmarClientAssertion(ISSUER, 'secreto-b', AHORA);
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
    // Mismo header y payload: lo único que cambia es la firma.
    expect(a.split('.').slice(0, 2)).toEqual(b.split('.').slice(0, 2));
  });

  it('es determinística con el mismo secreto y el mismo instante', () => {
    expect(firmarClientAssertion(ISSUER, 's', AHORA)).toBe(firmarClientAssertion(ISSUER, 's', AHORA));
  });
});

describe('la búsqueda por DNI', () => {
  it('usa el path del servicio de federación, no /fhir a secas', () => {
    // La doc muestra ejemplos con /fhir/Patient, pero TODAS las búsquedas de la
    // colección usan masterfile-federacion-service.
    expect(PATH_FEDERADOR).toBe('/masterfile-federacion-service/fhir');
    expect(urlBusquedaPorDni('https://bus.msal.gob.ar', '23327755')).toBe(
      'https://bus.msal.gob.ar/masterfile-federacion-service/fhir/Patient?identifier=http://www.renaper.gob.ar/dni|23327755',
    );
  });
});

describe('el cache del token', () => {
  const vivo: TokenCacheado = { scope: SCOPES.pacienteLeer, accessToken: 'abc', venceEn: new Date(AHORA.getTime() + 600_000) };

  it('sirve mientras le quede margen', () => {
    expect(tokenSirve(vivo, SCOPES.pacienteLeer, AHORA)).toBe(true);
  });

  it('no sirve el de OTRO scope: el bus valida permisos por token', () => {
    expect(tokenSirve(vivo, SCOPES.profesionalLeer, AHORA)).toBe(false);
  });

  it('un token que vence en segundos no alcanza para la llamada que sigue', () => {
    const casiVencido: TokenCacheado = { ...vivo, venceEn: new Date(AHORA.getTime() + 10_000) };
    expect(tokenSirve(casiVencido, SCOPES.pacienteLeer, AHORA)).toBe(false);
  });

  it('sin cache, hay que pedirlo', () => {
    expect(tokenSirve(undefined, SCOPES.pacienteLeer, AHORA)).toBe(false);
  });
});
