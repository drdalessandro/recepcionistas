/**
 * Validación de la firma `x-signature` de los webhooks de MercadoPago — lógica
 * pura (sin red), testeable.
 *
 * MP firma cada notificación con la **clave secreta** del webhook (panel: Tus
 * integraciones → tu app → Webhooks → "Clave secreta"). El header llega como
 * `x-signature: ts=<epoch>,v1=<hmac>` y el HMAC-SHA256 (hex) se calcula sobre
 * el manifiesto `id:{data.id};request-id:{x-request-id};ts:{ts};` — cada parte
 * se OMITE (con su etiqueta) si el dato no vino, y un `data.id` alfanumérico va
 * en minúsculas. Contrato: developers de MercadoPago → Webhooks → "Validar
 * origen de la notificación".
 *
 * Vive en `src/lib` pero usa `node:crypto`, igual que `whatsapp.ts` (la firma
 * de Twilio): es para los bots, NO para el bundle del navegador.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function validarFirmaMercadoPago(opts: {
  /** Header `x-signature` tal como llegó (`ts=...,v1=...`). */
  xSignature: string | undefined;
  /** Header `x-request-id` de la misma notificación. */
  xRequestId: string | undefined;
  /** `data.id` del cuerpo de la notificación (id del pago). */
  dataId: string | undefined;
  /** Clave secreta del webhook (panel de MP). */
  secret: string;
}): boolean {
  if (!opts.xSignature) {
    return false;
  }
  const partes = new Map<string, string>();
  for (const parte of opts.xSignature.split(',')) {
    const i = parte.indexOf('=');
    if (i > 0) {
      partes.set(parte.slice(0, i).trim(), parte.slice(i + 1).trim());
    }
  }
  const ts = partes.get('ts');
  const v1 = partes.get('v1');
  if (!ts || !v1) {
    return false;
  }
  const id = opts.dataId?.toLowerCase();
  const manifiesto = `${id ? `id:${id};` : ''}${opts.xRequestId ? `request-id:${opts.xRequestId};` : ''}ts:${ts};`;
  const esperada = Buffer.from(createHmac('sha256', opts.secret).update(manifiesto, 'utf8').digest('hex'), 'utf8');
  const recibida = Buffer.from(v1, 'utf8');
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}
