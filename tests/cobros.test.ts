import { describe, it, expect } from 'vitest';
import { lineaComercialDeItem, repartirEnPartes, validarMedios } from '../src/lib/cobros.js';
import { MEDIOS_PAGO, esMedioPago } from '../src/fhir/identifiers.js';
import { calcularCobro, descuentoALaCarteDe } from '../src/lib/pricing.js';
import { validarBloqueoAdministrativo } from '../src/lib/reglas-turno.js';

const TC = 1450;

describe('Contrato · medios de pago canónicos', () => {
  it('son exactamente los 5 del contrato', () => {
    expect(MEDIOS_PAGO).toEqual(['efectivo', 'tarjeta-debito', 'tarjeta-credito', 'transferencia', 'mercadopago']);
  });

  it('esMedioPago rechaza variantes no canónicas', () => {
    expect(esMedioPago('tarjeta')).toBe(false);
    expect(esMedioPago('MP')).toBe(false);
    expect(esMedioPago('Efectivo ')).toBe(false);
    expect(esMedioPago('mercadopago')).toBe(true);
  });
});

describe('Contrato · línea comercial del ChargeItem', () => {
  it('mapea cada tipo/categoría a su línea', () => {
    expect(lineaComercialDeItem('membresia')).toBe('membresias');
    expect(lineaComercialDeItem('paquete')).toBe('paquetes');
    expect(lineaComercialDeItem('combo')).toBe('sueltas-combos');
    expect(lineaComercialDeItem('servicio', 'HBOT')).toBe('sueltas-combos');
    expect(lineaComercialDeItem('servicio', 'IV_THERAPY')).toBe('iv-tb');
    expect(lineaComercialDeItem('servicio', 'TERAPIA_BIOLOGICA')).toBe('iv-tb');
    expect(lineaComercialDeItem('servicio', 'CONSULTA')).toBe('consultas');
    expect(lineaComercialDeItem('servicio')).toBe('otros');
  });
});

describe('Pago mixto · N Invoices, suma exacta por medio', () => {
  it('50/50 exacto pasa', () => {
    const r = validarMedios(
      [
        { medio: 'efectivo', montoARS: 119625 },
        { medio: 'tarjeta-credito', montoARS: 119625 },
      ],
      239250,
    );
    expect(r.ok).toBe(true);
  });

  it('rechaza suma que no cierra con el total', () => {
    const r = validarMedios(
      [
        { medio: 'efectivo', montoARS: 100000 },
        { medio: 'tarjeta-debito', montoARS: 100000 },
      ],
      239250,
    );
    expect(r.ok).toBe(false);
  });

  it('rechaza medios no canónicos y repetidos', () => {
    expect(validarMedios([{ medio: 'tarjeta', montoARS: 100 }], 100).ok).toBe(false);
    expect(
      validarMedios(
        [
          { medio: 'efectivo', montoARS: 50 },
          { medio: 'efectivo', montoARS: 50 },
        ],
        100,
      ).ok,
    ).toBe(false);
  });

  it('repartirEnPartes suma exacto aunque el total sea impar', () => {
    const partes = repartirEnPartes(239251, 2);
    expect(partes).toHaveLength(2);
    expect(partes[0]! + partes[1]!).toBe(239251);
  });
});

describe('Descuentos por tipo de cliente (PROVISORIO: el mayor, no acumulan)', () => {
  it('miembro Standard: 10% a la carte en sueltas', () => {
    // HBOT_MONO USD 165 → 148.5 → ARS 215.325
    const r = calcularCobro([{ tipo: 'servicio', codigo: 'HBOT_MONO' }], { tc: TC, descuentos: { aLaCartePct: 0.1 } });
    expect(r.lineas[0]?.subtotalUSD).toBe(148.5);
    expect(r.lineas[0]?.descuentoOrigen).toBe('a-la-carte');
    expect(r.totalARS).toBe(215325);
  });

  it('miembro Intensivo: 15%', () => {
    const r = calcularCobro([{ tipo: 'servicio', codigo: 'HBOT_MONO' }], { tc: TC, descuentos: { aLaCartePct: 0.15 } });
    expect(r.lineas[0]?.subtotalUSD).toBe(140.25);
  });

  it('FM + miembro Standard: gana el 20% de FM (no acumula)', () => {
    const r = calcularCobro([{ tipo: 'servicio', codigo: 'HBOT_MONO' }], {
      tc: TC,
      descuentos: { fm: true, aLaCartePct: 0.1 },
    });
    expect(r.lineas[0]?.subtotalUSD).toBe(132); // 165 × 0.8, NO 165×0.8×0.9
    expect(r.lineas[0]?.descuentoOrigen).toBe('fm');
  });

  it('las consultas (ARS) no reciben descuento', () => {
    const consulta = 'CONSULTA_MED_DALESSANDRO';
    const r = calcularCobro([{ tipo: 'servicio', codigo: consulta }], { tc: TC, descuentos: { fm: true, aLaCartePct: 0.15 } });
    expect(r.lineas[0]?.subtotalARS).toBe(120000);
    expect(r.lineas[0]?.descuentoPct).toBeUndefined();
  });

  it('combos y membresías no reciben descuento adicional', () => {
    const combo = calcularCobro([{ tipo: 'combo', codigo: 'BIO_ENERGY' }], { tc: TC, descuentos: { fm: true, aLaCartePct: 0.15 } });
    const soloCombo = calcularCobro([{ tipo: 'combo', codigo: 'BIO_ENERGY' }], { tc: TC });
    expect(combo.totalARS).toBe(soloCombo.totalARS);
  });

  it('descuentoALaCarteDe mapea intensidad → pct', () => {
    expect(descuentoALaCarteDe('STANDARD')).toBe(0.1);
    expect(descuentoALaCarteDe('INTENSIVO')).toBe(0.15);
    expect(descuentoALaCarteDe(undefined)).toBe(0);
  });
});

describe('R-11 · bloqueo administrativo por pago rechazado', () => {
  it('bloqueado => no se puede reservar', () => {
    const r = validarBloqueoAdministrativo(true);
    expect(r.ok).toBe(false);
    expect(r.bloqueos[0]?.regla).toBe('R-11');
  });

  it('sin bloqueo => pasa', () => {
    expect(validarBloqueoAdministrativo(false).ok).toBe(true);
  });
});
