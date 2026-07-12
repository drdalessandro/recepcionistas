/**
 * Migración: extensión medio-pago de Invoices existentes al contrato de
 * Administración (valueString + códigos canónicos).
 *
 *   npm run migrar:medios            → DRY-RUN: lista qué cambiaría.
 *   npm run migrar:medios -- --apply → aplica los cambios.
 *
 * - valueCode → valueString (mismo valor si ya es canónico).
 * - 'tarjeta' (legado, ambiguo) → 'tarjeta-credito' y se reporta para revisión.
 * - Valores no canónicos → se reportan y NO se tocan (revisar a mano).
 * - Agrega totalNet = totalGross donde falte (el tablero lee cualquiera de los dos).
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Invoice } from '@medplum/fhirtypes';
import { EXT, esMedioPago } from '../fhir/identifiers.js';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));

  const invoices = await medplum.searchResources('Invoice', { _count: 1000 });
  console.log(`Invoices: ${invoices.length}`);

  let migrados = 0;
  let tarjetas = 0;
  const raros: string[] = [];

  for (const inv of invoices) {
    const ext = [...(inv.extension ?? [])];
    const i = ext.findIndex((x) => x.url === EXT.medioPago);
    let cambio = false;

    if (i >= 0) {
      const actual = ext[i]!;
      let valor = actual.valueString ?? actual.valueCode;
      if (valor === 'tarjeta') {
        valor = 'tarjeta-credito';
        tarjetas++;
      }
      if (!valor || !esMedioPago(valor)) {
        raros.push(`Invoice/${inv.id}: medio "${valor ?? '(vacío)'}" no canónico — revisar a mano`);
      } else if (actual.valueCode !== undefined || actual.valueString !== valor) {
        ext[i] = { url: EXT.medioPago, valueString: valor };
        cambio = true;
      }
    }

    const conTotalNet: Partial<Invoice> = {};
    if (!inv.totalNet && inv.totalGross) {
      conTotalNet.totalNet = inv.totalGross;
      cambio = true;
    }

    if (cambio) {
      console.log(`  ~ Invoice/${inv.id}${i >= 0 ? ` medio=${ext[i]?.valueString}` : ''}${conTotalNet.totalNet ? ' +totalNet' : ''}`);
      if (apply) {
        await medplum.updateResource<Invoice>({ ...inv, ...conTotalNet, extension: ext });
      }
      migrados++;
    }
  }

  for (const r of raros) {
    console.warn(`  ! ${r}`);
  }
  console.log(`\n${apply ? 'Migrados' : '[dry-run] Se migrarían'}: ${migrados} · 'tarjeta'→'tarjeta-credito': ${tarjetas} · no canónicos: ${raros.length}`);
  if (!apply) {
    console.log('Corré con --apply para aplicar.');
  }
}

main().catch((err) => {
  console.error('Migración falló:', err);
  process.exitCode = 1;
});
