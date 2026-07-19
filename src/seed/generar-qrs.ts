/**
 * Genera los QRs de canales (docs/canales-acceso.md, decisión "WhatsApp para
 * todo, portal para autogestión"):
 *
 *   npm run qr:canales
 *
 * Escribe en `qrs/` un PNG por canal (wa.me con texto prefijado que identifica
 * el canal) + el QR del portal, y lista los links para pegar en la bio de
 * Instagram, posts, ficha de Google, etc. Sin red: todo se genera local.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { toBuffer } from 'qrcode';
import { CANALES_QR, linkPortal, linkWhatsApp } from '../lib/canales.js';

const DIR = 'qrs';

async function qrPng(contenido: string): Promise<Buffer> {
  return toBuffer(contenido, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 640,
    color: { dark: '#2a1b10', light: '#ffffff' }, // marrón habano oscuro (marca) sobre blanco
  });
}

async function main(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  console.log('QRs de canales — WhatsApp para todo, portal para autogestión\n');

  for (const c of CANALES_QR) {
    const link = linkWhatsApp(c.texto);
    const archivo = `${DIR}/qr-whatsapp-${c.origen}.png`;
    writeFileSync(archivo, await qrPng(link));
    console.log(`• ${c.nombre}`);
    console.log(`    QR:   ${archivo}`);
    console.log(`    Link: ${link}\n`);
  }

  const portal = linkPortal('qr-local');
  writeFileSync(`${DIR}/qr-portal.png`, await qrPng(portal));
  console.log('• Portal (autogestión)');
  console.log(`    QR:   ${DIR}/qr-portal.png`);
  console.log(`    Link: ${portal}\n`);

  console.log('Uso: el QR/link de cada canal va en su pieza (bio de IG, post, flyer,');
  console.log('mostrador). El mensaje llega a la bandeja con la marca del canal, y al');
  console.log('crear la ficha se carga ese origen en "¿Cómo nos conoció?".');
}

main().catch((err) => {
  console.error('qr:canales falló:', err);
  process.exitCode = 1;
});
