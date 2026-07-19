import { describe, it, expect } from 'vitest';
import {
  altasPorMes,
  CANALES_QR,
  linkPortal,
  linkWhatsApp,
  resumenPorCanal,
  SIN_FECHA,
  SIN_ORIGEN,
  WHATSAPP_NUMERO,
} from '../src/lib/canales.js';
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

  it('resumenPorCanal agrupa, calcula conversión (turno/pago/socio) y deja "(sin datos)" al final', () => {
    const pacientes = [
      { id: 'a', origen: 'instagram' },
      { id: 'b', origen: 'instagram' },
      { id: 'c', origen: 'google' },
      { id: 'd' }, // sin origen
      { id: 'e', origen: '' }, // vacío = sin datos
    ];
    const filas = resumenPorCanal(pacientes, new Set(['a', 'c']), new Set(['a']), new Set(['b']));
    expect(filas).toEqual([
      { origen: 'instagram', clientes: 2, conTurno: 1, conPago: 1, socios: 1 },
      { origen: 'google', clientes: 1, conTurno: 1, conPago: 0, socios: 0 },
      { origen: SIN_ORIGEN, clientes: 2, conTurno: 0, conPago: 0, socios: 0 },
    ]);
  });

  it('altasPorMes arma las cohortes mensuales por fecha-alta y agrupa las fichas sin fecha al final', () => {
    const cohortes = altasPorMes([
      { id: '1', origen: 'instagram', fechaAlta: '2026-08-12' },
      { id: '2', origen: 'google', fechaAlta: '2026-08-20' },
      { id: '3', origen: 'instagram', fechaAlta: '2026-09-02' },
      { id: '4', origen: 'referido' }, // ficha vieja sin fecha
    ]);
    expect(cohortes.map((c) => c.mes)).toEqual(['2026-08', '2026-09', SIN_FECHA]);
    expect(cohortes[0]).toEqual({
      mes: '2026-08',
      total: 2,
      porCanal: [
        { origen: 'google', clientes: 1 },
        { origen: 'instagram', clientes: 1 },
      ],
    });
    expect(cohortes[2]?.porCanal).toEqual([{ origen: 'referido', clientes: 1 }]);
  });

  it('resumenPorCanal ordena por volumen y desempata alfabéticamente', () => {
    const filas = resumenPorCanal(
      [
        { id: '1', origen: 'web' },
        { id: '2', origen: 'referido' },
        { id: '3', origen: 'referido' },
        { id: '4', origen: 'linkedin' },
      ],
      new Set(),
      new Set(),
    );
    expect(filas.map((f) => f.origen)).toEqual(['referido', 'linkedin', 'web']);
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
