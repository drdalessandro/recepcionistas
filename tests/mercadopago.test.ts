import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validarFirmaMercadoPago } from '../src/lib/mercadopago.js';

const SECRET = 'clave-secreta-del-panel';

function firmar(manifiesto: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(manifiesto, 'utf8').digest('hex');
}

describe('validarFirmaMercadoPago — firma x-signature del webhook', () => {
  it('acepta una firma bien calculada (manifiesto completo)', () => {
    const v1 = firmar('id:12345678901;request-id:req-abc;ts:1704908010;');
    expect(
      validarFirmaMercadoPago({
        xSignature: `ts=1704908010,v1=${v1}`,
        xRequestId: 'req-abc',
        dataId: '12345678901',
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it('el data.id alfanumérico va en minúsculas en el manifiesto (contrato de MP)', () => {
    const v1 = firmar('id:abc123;request-id:req-abc;ts:1;');
    expect(
      validarFirmaMercadoPago({ xSignature: `ts=1,v1=${v1}`, xRequestId: 'req-abc', dataId: 'ABC123', secret: SECRET }),
    ).toBe(true);
  });

  it('sin x-request-id, esa parte se omite del manifiesto', () => {
    const v1 = firmar('id:99;ts:2;');
    expect(
      validarFirmaMercadoPago({ xSignature: `ts=2,v1=${v1}`, xRequestId: undefined, dataId: '99', secret: SECRET }),
    ).toBe(true);
  });

  it('rechaza una firma alterada, otra clave, o un header ausente/malformado', () => {
    const v1 = firmar('id:99;request-id:r;ts:2;');
    const base = { xRequestId: 'r', dataId: '99', secret: SECRET };
    expect(validarFirmaMercadoPago({ ...base, xSignature: `ts=2,v1=${v1}0` })).toBe(false);
    expect(validarFirmaMercadoPago({ ...base, xSignature: `ts=3,v1=${v1}` })).toBe(false);
    expect(validarFirmaMercadoPago({ ...base, xSignature: undefined })).toBe(false);
    expect(validarFirmaMercadoPago({ ...base, xSignature: 'sin-partes' })).toBe(false);
    expect(
      validarFirmaMercadoPago({ ...base, xSignature: `ts=2,v1=${firmar('id:99;request-id:r;ts:2;', 'otra-clave')}` }),
    ).toBe(false);
  });
});
