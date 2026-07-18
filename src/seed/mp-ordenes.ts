/**
 * Últimos pagos de la cuenta de MercadoPago, con su Payment ID y Order ID
 * (merchant order). Sirve para el formulario de "Calidad de integración" del
 * panel de MP, que pide el ID de un pago/orden procesado por la aplicación.
 *
 *   npm run mp:ordenes
 *
 * Solo lectura (no crea ni toca nada). Lee MERCADOPAGO_ACCESS_TOKEN del .env:
 * con credenciales TEST lista los pagos de prueba; con productivas, los reales.
 * Si no hay pagos todavía: correr `npm run mp:test`, pagar la preferencia con
 * la tarjeta de prueba y volver a correr esto.
 */
import 'dotenv/config';

interface PagoMP {
  id?: number;
  status?: string;
  status_detail?: string;
  transaction_amount?: number;
  currency_id?: string;
  description?: string;
  external_reference?: string;
  date_created?: string;
  order?: { id?: number; type?: string };
}

async function main(): Promise<void> {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) {
    console.error('Falta MERCADOPAGO_ACCESS_TOKEN en .env (el mismo que usa mp:test).');
    process.exitCode = 1;
    return;
  }
  const esTest = token.startsWith('TEST-');
  console.log(`=== Últimos pagos de la cuenta (${esTest ? 'credenciales de PRUEBA' : 'credenciales PRODUCTIVAS'}) ===\n`);

  const resp = await fetch(
    'https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&limit=15',
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) {
    console.error(`MP respondió ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }
  const data = (await resp.json()) as { results?: PagoMP[] };
  const pagos = data.results ?? [];
  if (pagos.length === 0) {
    console.log('No hay pagos todavía. Corré `npm run mp:test`, pagá la preferencia con la');
    console.log('tarjeta de prueba (titular APRO) y volvé a correr `npm run mp:ordenes`.');
    return;
  }

  for (const p of pagos) {
    const fecha = p.date_created ? p.date_created.slice(0, 16).replace('T', ' ') : '¿?';
    const monto = `${p.currency_id ?? ''} ${p.transaction_amount ?? '¿?'}`;
    console.log(`• Payment ID: ${p.id}   Order ID: ${p.order?.id ?? '—'} (${p.order?.type ?? 'sin orden'})`);
    console.log(`    ${fecha} · ${p.status}${p.status_detail ? ` (${p.status_detail})` : ''} · ${monto}`);
    console.log(`    ${p.description ?? ''}${p.external_reference ? ` · ref: ${p.external_reference}` : ''}\n`);
  }
  console.log('Para "Calidad de integración" en el panel de MP: usá el Order ID (merchant');
  console.log('order) de un pago APROBADO hecho por esta aplicación; si el formulario pide');
  console.log('un ID de pago, es el Payment ID de la misma fila.');
}

main().catch((err) => {
  console.error('mp:ordenes falló:', err);
  process.exitCode = 1;
});
