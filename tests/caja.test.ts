/**
 * Caja chica (opción 2, aprobada 2026-08-09): saldo DERIVADO (nunca doble
 * registro de ingresos), gastos con lista cerrada + tope, arqueo con
 * diferencia explícita. Parámetros confirmados (2026-08-10) en src/config/caja.ts.
 */
import { describe, expect, it } from 'vitest';
import { armarArqueo, efectoEnSaldo, saldoEsperado, validarGasto, type MovimientoCaja } from '../src/lib/caja.js';
import { arqueoAPaymentReconciliation, basicAMovimiento, movimientoABasic, reconciliationAArqueo } from '../src/fhir/caja.js';
import { CAJA_TOPE_GASTO_ARS } from '../src/config/caja.js';
import { EXT, SYSTEM } from '../src/fhir/identifiers.js';

const egreso = (montoARS: number, extra?: Partial<MovimientoCaja>): MovimientoCaja => ({
  tipo: 'egreso',
  montoARS,
  categoria: 'insumos',
  ...extra,
});

describe('saldoEsperado — derivado, nunca doble registro', () => {
  it('arranque + efectivo cobrado − egresos + reposiciones', () => {
    const movs: MovimientoCaja[] = [egreso(12_000), egreso(8_000), { tipo: 'reposicion', montoARS: 20_000 }];
    expect(saldoEsperado(200_000, 150_000, movs)).toBe(350_000);
  });

  it('un egreso cargado con monto negativo por error igual RESTA (signo lo da el tipo)', () => {
    expect(efectoEnSaldo(egreso(-5_000))).toBe(-5_000);
    expect(efectoEnSaldo({ tipo: 'reposicion', montoARS: -5_000 })).toBe(5_000);
  });

  it('el ajuste corrige para cualquier lado (conserva el signo)', () => {
    expect(efectoEnSaldo({ tipo: 'ajuste', montoARS: -3_000 })).toBe(-3_000);
    expect(efectoEnSaldo({ tipo: 'ajuste', montoARS: 3_000 })).toBe(3_000);
  });
});

describe('validarGasto — lista cerrada + tope con autorización', () => {
  it('gasto normal con categoría válida => ok', () => {
    expect(validarGasto({ montoARS: 10_000, categoria: 'limpieza' }).ok).toBe(true);
  });

  it('sin categoría o con categoría inventada => error (Administración compara por rubro)', () => {
    expect(validarGasto({ montoARS: 10_000 }).ok).toBe(false);
    expect(validarGasto({ montoARS: 10_000, categoria: 'kiosco' }).ok).toBe(false);
  });

  it('monto cero o negativo => error', () => {
    expect(validarGasto({ montoARS: 0, categoria: 'insumos' }).ok).toBe(false);
    expect(validarGasto({ montoARS: -100, categoria: 'insumos' }).ok).toBe(false);
  });

  it('sobre el tope sin marca de autorización => bloquea; con la marca => pasa', () => {
    const sobre = CAJA_TOPE_GASTO_ARS + 1;
    const sin = validarGasto({ montoARS: sobre, categoria: 'mantenimiento' });
    expect(sin.ok).toBe(false);
    expect(sin.requiereAutorizacion).toBe(true);
    expect(validarGasto({ montoARS: sobre, categoria: 'mantenimiento', autorizado: true }).ok).toBe(true);
  });
});

describe('arqueo — la diferencia es explícita y con signo', () => {
  it('cuadra cuando contado = esperado', () => {
    const r = armarArqueo(350_000, 350_000);
    expect(r.cuadra).toBe(true);
    expect(r.diferenciaARS).toBe(0);
  });

  it('faltante => diferencia negativa; sobrante => positiva', () => {
    expect(armarArqueo(350_000, 340_000).diferenciaARS).toBe(-10_000);
    expect(armarArqueo(350_000, 351_500).diferenciaARS).toBe(1_500);
  });
});

describe('FHIR — Basic y PaymentReconciliation ida y vuelta', () => {
  it('movimiento → Basic → movimiento conserva todo', () => {
    const m = egreso(15_000, { detalle: 'Alcohol y algodón', autorizado: false });
    const b = movimientoABasic(m, '2026-08-09T18:00:00.000Z');
    expect(b.code?.coding?.[0]).toMatchObject({ system: SYSTEM.caja, code: 'egreso' });
    const vuelta = basicAMovimiento(b)!;
    expect(vuelta.tipo).toBe('egreso');
    expect(vuelta.montoARS).toBe(15_000);
    expect(vuelta.categoria).toBe('insumos');
    expect(vuelta.detalle).toBe('Alcohol y algodón');
  });

  it('un Basic ajeno (config del TC) NO se interpreta como movimiento', () => {
    expect(basicAMovimiento({ resourceType: 'Basic', code: { text: 'config-tipo-cambio' } })).toBeUndefined();
  });

  it('arqueo → PaymentReconciliation con esperado/diferencia en extensiones e identifier antiduplicados', () => {
    const p = arqueoAPaymentReconciliation(armarArqueo(350_000, 340_000), {
      desdeISO: '2026-08-08T21:00:00.000Z',
      hastaISO: '2026-08-09T21:00:00.000Z',
    });
    expect(p.identifier?.[0]).toMatchObject({ system: SYSTEM.caja, value: 'arqueo-2026-08-09T21:00:00.000Z' });
    expect(p.extension?.find((e) => e.url === EXT.cajaDiferencia)?.valueDecimal).toBe(-10_000);
    expect(p.paymentAmount).toMatchObject({ value: 340_000, currency: 'ARS' });
    expect(p.disposition).toContain('DIFERENCIA');
    const vuelta = reconciliationAArqueo(p)!;
    expect(vuelta.contadoARS).toBe(340_000);
    expect(vuelta.fechaISO).toBe('2026-08-09T21:00:00.000Z');
  });
});
