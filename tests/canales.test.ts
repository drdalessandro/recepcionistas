import { describe, it, expect } from 'vitest';
import { CANALES_QR, linkPortal, linkWhatsApp, WHATSAPP_NUMERO } from '../src/lib/canales.js';
import { esOrigenLead, ORIGENES_LEAD, ORIGENES_LEAD_LABELS } from '../src/fhir/identifiers.js';

describe('Canales de acceso — origen-lead (lista cerrada) y links medibles', () => {
  it('esOrigenLead acepta solo los códigos canónicos', () => {
    expect(esOrigenLead('instagram')).toBe(true);
    expect(esOrigenLead('walk-in')).toBe(true);
    expect(esOrigenLead('facebook')).toBe(false);
    expect(esOrigenLead('')).toBe(false);
    expect(esOrigenLead(undefined)).toBe(false);
  });

  it('Todos los códigos tienen etiqueta para la UI', () => {
    for (const o of ORIGENES_LEAD) {
      expect(ORIGENES_LEAD_LABELS[o]).toBeTruthy();
    }
  });

  it('linkWhatsApp arma el wa.me del número productivo con el texto prefijado', () => {
    const link = linkWhatsApp('Hola (vengo de Instagram)');
    expect(link).toBe(`https://wa.me/${WHATSAPP_NUMERO}?text=Hola%20(vengo%20de%20Instagram)`);
  });

  it('linkPortal lleva UTM del canal', () => {
    expect(linkPortal('qr-local')).toContain('utm_source=qr-local');
    expect(linkPortal('qr-local')).toContain('utm_medium=qr');
  });

  it('Cada canal QR usa un código canónico y un texto con marca distinguible', () => {
    const textos = new Set<string>();
    for (const c of CANALES_QR) {
      expect(esOrigenLead(c.origen)).toBe(true);
      expect(c.texto.length).toBeGreaterThan(10);
      textos.add(c.texto);
    }
    // Sin textos repetidos: la marca es lo que identifica el canal.
    expect(textos.size).toBe(CANALES_QR.length);
  });
});
