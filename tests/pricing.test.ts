import { describe, it, expect } from 'vitest';
import { getServicio, nombreServicioRecepcion, SERVICIOS } from '../src/config/catalogo.js';
import { COMBOS, getCombo } from '../src/config/combos.js';
import { getMembresia } from '../src/config/membresias.js';
import { PAQUETES, getPaquete } from '../src/config/paquetes.js';
import {
  precioSueltoUSD,
  cascadaTB,
  calcularSplit,
  calcularCobro,
  calcularSenaARS,
} from '../src/lib/pricing.js';
import { usdAArs, redondearUSD } from '../src/lib/money.js';

describe('Pricing — HBOT', () => {
  it('Monoplaza = USD 165', () => {
    expect(precioSueltoUSD(getServicio('HBOT_MONO'))).toBe(165);
  });

  it('AC-06: FM 20% OFF en suelta => HBOT mono 165 -> 132', () => {
    expect(precioSueltoUSD(getServicio('HBOT_MONO'), { fm: true })).toBe(132);
  });

  it('Biplaza: 2 personas = 200 (100 c/u); 1 sola = 165', () => {
    const bip = getServicio('HBOT_BIPLAZA');
    expect(precioSueltoUSD(bip, { ocupantes: 2 })).toBe(200);
    expect(precioSueltoUSD(bip, { ocupantes: 1 })).toBe(165);
  });

  it('Multiplaza: 80/persona, mínimo 3', () => {
    const multi = getServicio('HBOT_MULTIPLAZA');
    expect(precioSueltoUSD(multi, { ocupantes: 3 })).toBe(240);
    expect(precioSueltoUSD(multi, { ocupantes: 6 })).toBe(480);
    // Aunque pidan 1, se cobra el mínimo de 3.
    expect(precioSueltoUSD(multi, { ocupantes: 1 })).toBe(240);
  });
});

describe('Pricing — Recovery Pro indivisible', () => {
  it('USD 200 por gabinete, 1 o 2 personas', () => {
    const rp = getServicio('RECOVERY_PRO');
    expect(precioSueltoUSD(rp, { ocupantes: 1 })).toBe(200);
    expect(precioSueltoUSD(rp, { ocupantes: 2 })).toBe(200);
  });
});

describe('Pricing — IHHT v9', () => {
  it('Sesión única 45 min = USD 90', () => {
    const ihht = getServicio('IHHT');
    expect(precioSueltoUSD(ihht)).toBe(90);
    expect(ihht.duracionMin).toBe(45);
  });
});

describe('Catálogo — Combos v9', () => {
  it('Precios v9 conocidos (tabla Sección 3 del Manual)', () => {
    expect(getCombo('BIO_ENERGY').precioUSD).toBe(112);
    expect(getCombo('BIO_ENERGY').precioListaUSD).toBe(140);
    expect(getCombo('BIO_COMPRESS').precioUSD).toBe(88);
    expect(getCombo('BIO_OXYGEN').precioUSD).toBe(200); // OFF 21% según el Manual
    expect(getCombo('BIO_OXYGEN_PAREJA').precioUSD).toBe(300);
    expect(getCombo('BIO_RECOVERY').precioUSD).toBe(292);
    expect(getCombo('BIO_LONGEVITY').precioUSD).toBe(364);
    expect(getCombo('BIO_LONGEVITY_PAREJA').precioUSD).toBe(464);
  });

  it('Coherencia: precio == round(lista * (1 - descuento))', () => {
    for (const c of COMBOS) {
      expect(c.precioUSD).toBe(Math.round(c.precioListaUSD * (1 - c.descuento)));
    }
  });

  it('Los combos no reciben descuento FM (no aplica a combos)', () => {
    // Un combo se cobra a su precio fijo (sin la rama FM de sueltas).
    const r = calcularCobro([{ tipo: 'combo', codigo: 'BIO_LONGEVITY' }], { tc: 1450 });
    expect(r.totalUSD).toBe(364);
  });

  it('Un combo se cobra a su precio de combo convertido a ARS', () => {
    const r = calcularCobro([{ tipo: 'combo', codigo: 'BIO_LONGEVITY' }], { tc: 1450 });
    expect(r.totalUSD).toBe(364);
    expect(r.totalARS).toBe(364 * 1450); // 527.800
  });
});

describe('Catálogo — Membresías v9', () => {
  it('Precios v9 conocidos (tabla Sección 4 del Manual)', () => {
    expect(getMembresia('FOCUS_STD_IND').precioMesUSD).toBe(718);
    expect(getMembresia('FOCUS_INT_IND').precioMesUSD).toBe(1008);
    expect(getMembresia('PRIME_INT_IND').precioMesUSD).toBe(2453); // PRIME sin cambios
    expect(getMembresia('HEALTHSPAN_STD_IND').precioMesUSD).toBe(2184);
    expect(getMembresia('HEALTHSPAN_INT_PAR').precioMesUSD).toBe(3898);
  });

  it('AC-06: la membresía no recibe el 20% FM', () => {
    const r = calcularCobro([{ tipo: 'membresia', codigo: 'FOCUS_STD_IND', fm: true }], { tc: 1450 });
    expect(r.totalUSD).toBe(718);
  });
});

describe('Catálogo — Paquetes', () => {
  // AC-06 del Anexo A decía 784, que es el número REDONDEADO del Manual v9. El
  // PO decidió (2026-08-15) no redondear: el exacto es 783,75. El precio FM no
  // se mueve —783,75 × 0,80 = 627, lo mismo que daba redondeando— y ese es
  // justamente el punto: sin redondeo la derivación es exacta y alcanza con
  // guardar un solo número por producto.
  it('HBOT mono x5 = 783,75 (AC-06 sin redondeo); FM = 627, que no cambió', () => {
    const p = getPaquete('PAQ_HBOT_MONO_X5');
    expect(p.nombre).toBe('HBOT MONO — Starter');
    expect(p.totalListaUSD).toBe(825);
    expect(p.totalUSD).toBe(783.75);
    expect(p.totalFMUSD).toBe(627);
  });

  it('el precio FM se DERIVA exacto del total en los 24 paquetes (por eso no se guarda dos veces)', () => {
    for (const p of PAQUETES) {
      expect(p.totalFMUSD).toBe(Number((p.totalUSD * 0.8).toFixed(4)));
      expect(p.precioSesionUSD * p.tamano).toBeCloseTo(p.totalUSD, 4);
      expect(p.totalUSD).toBeLessThan(p.totalListaUSD);
    }
  });

  it('los dos paquetes que faltaban: Multiplaza (por persona) y Recovery Pro (por gabinete)', () => {
    expect(PAQUETES.length).toBe(24);
    expect(getPaquete('PAQ_HBOT_MULTIPLAZA_X5').totalUSD).toBe(380); // 80 × 5 × 0,95
    expect(getPaquete('PAQ_RECOVERY_PRO_X5').totalUSD).toBe(950); // 200 × 5 × 0,95
  });

  it('IHHT (base v9 USD 90): Core = 810; Pro FM = 1224', () => {
    const core = getPaquete('PAQ_IHHT_X10');
    expect(core.nombre).toBe('IHHT — Core');
    expect(core.totalUSD).toBe(810);
    const pro = getPaquete('PAQ_IHHT_X20');
    expect(pro.totalUSD).toBe(1530);
    expect(pro.totalFMUSD).toBe(1224);
  });
});

describe('Pricing — Cascada TB / IV (R-08)', () => {
  it('AC-08: IV NAD+ 250, neto BW = (250×0.75 − insumo − 15) × 0.85', () => {
    const insumo = 30;
    const dist = cascadaTB(250, insumo);
    const base = 250 * 0.75 - insumo - 15; // 142.5
    expect(dist.bwUSD).toBe(redondearUSD(base * 0.85)); // 121.13
    expect(dist.prescriptoresUSD).toBe(redondearUSD(base * 0.15)); // 21.38
  });

  it('Marca cuando el neto BW cae bajo el piso de 25% de margen', () => {
    // Insumo alto fuerza el neto por debajo del piso.
    const dist = cascadaTB(250, 200);
    expect(dist.bajoMargenMinimo).toBe(true);
  });
});

describe('Pricing — Splits (R-08)', () => {
  it('HBOT => 100% BW', () => {
    const dist = calcularSplit(getServicio('HBOT_MONO'), 165);
    expect(dist.bwUSD).toBe(165);
    expect(dist.terapeutaUSD).toBeUndefined();
  });

  it('Masaje => 50/50 con el terapeuta', () => {
    const dist = calcularSplit(getServicio('MASAJE_DEPORTIVO'), 90);
    expect(dist.bwUSD).toBe(45);
    expect(dist.terapeutaUSD).toBe(45);
  });
});

describe('Consultas médicas (precio en ARS)', () => {
  it('Se cobran en pesos fijos, sin convertir por TC', () => {
    const r = calcularCobro([{ tipo: 'servicio', codigo: 'CONSULTA_MED_DALESSANDRO' }], { tc: 1450 });
    expect(r.totalARS).toBe(120000);
    expect(r.totalUSD).toBe(0);
    expect(r.lineas[0]?.moneda).toBe('ARS');
  });

  it('Cobro mixto USD + consulta ARS suma en ARS', () => {
    const r = calcularCobro(
      [
        { tipo: 'servicio', codigo: 'HBOT_MONO' },
        { tipo: 'servicio', codigo: 'CONSULTA_MED_DOS_SANTOS' },
      ],
      { tc: 1450 },
    );
    expect(r.totalARS).toBe(239250 + 120000);
  });

  it('Chequeo Biowellness: precio de consulta en ARS, sin FM ni prescripción', () => {
    const s = getServicio('CHEQUEO_BW');
    expect(s.categoria).toBe('CONSULTA');
    expect(s.practitionerCodigo).toBeUndefined(); // devolución con cualquier médico
    expect(s.requierePrescripcion).toBe(false);
    const r = calcularCobro([{ tipo: 'servicio', codigo: 'CHEQUEO_BW', fm: true }], { tc: 1450 });
    expect(r.totalARS).toBe(120000); // fm no aplica
    expect(r.totalUSD).toBe(0);
    expect(r.lineas[0]?.moneda).toBe('ARS');
  });
});

describe('Conversión a ARS (R-17)', () => {
  it('AC-13: USD 165 a TC 1450 = ARS 239.250', () => {
    expect(usdAArs(165, 1450)).toBe(239250);
  });

  it('calcularCobro devuelve total en USD y ARS con el TC aplicado', () => {
    const r = calcularCobro([{ tipo: 'servicio', codigo: 'HBOT_MONO' }], { tc: 1450 });
    expect(r.totalUSD).toBe(165);
    expect(r.totalARS).toBe(239250);
    expect(r.tcAplicado).toBe(1450);
  });
});

describe('Seña (50%)', () => {
  it('Servicio en USD: seña = 50% del total en ARS', () => {
    const { totalARS, senaARS } = calcularSenaARS([{ tipo: 'servicio', codigo: 'HBOT_MONO' }], { tc: 1450 });
    expect(totalARS).toBe(239250);
    expect(senaARS).toBe(119625);
  });

  it('Combo: seña = 50% del precio de combo en ARS', () => {
    const { totalARS, senaARS } = calcularSenaARS([{ tipo: 'combo', codigo: 'BIO_LONGEVITY' }], { tc: 1450 });
    expect(totalARS).toBe(364 * 1450);
    expect(senaARS).toBe((364 * 1450) / 2);
  });

  it('Total impar: la seña redondea y el saldo es el complemento exacto (seña + saldo = total)', () => {
    // HBOT 165 USD a TC 1451 = ARS 239.415 (impar) => seña 119.708, saldo 119.707.
    const { totalARS, senaARS } = calcularSenaARS([{ tipo: 'servicio', codigo: 'HBOT_MONO' }], { tc: 1451 });
    expect(totalARS).toBe(239415);
    expect(senaARS).toBe(119708);
    expect(totalARS - senaARS).toBe(119707); // así lo emite confirmarReserva como Invoice de saldo
  });

  it('Consulta en ARS: seña = 50% del precio fijo', () => {
    const { totalARS, senaARS } = calcularSenaARS([{ tipo: 'servicio', codigo: 'CONSULTA_MED_DALESSANDRO' }]);
    expect(totalARS).toBe(120000);
    expect(senaARS).toBe(60000);
  });
});

describe('Integridad del catálogo', () => {
  it('No hay códigos de servicio duplicados', () => {
    const codigos = SERVICIOS.map((s) => s.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
  });

  it('Todo servicio IV/TB requiere prescripción', () => {
    for (const s of SERVICIOS) {
      if (s.categoria === 'IV_THERAPY' || s.categoria === 'TERAPIA_BIOLOGICA') {
        expect(s.requierePrescripcion).toBe(true);
      }
    }
  });
});

describe('nombreServicioRecepcion — el mostrador siempre sabe con quién', () => {
  it('Re-agrega el médico cuando el título comercial no lo menciona', () => {
    expect(nombreServicioRecepcion(getServicio('CONSULTA_MED_DOS_SANTOS'))).toBe(
      'Evaluación Biowellness — Dra. Stephanie Dos Santos',
    );
    expect(nombreServicioRecepcion(getServicio('CONSULTA_MED_DALESSANDRO'))).toBe(
      "Evaluación Biowellness — Dr. Alejandro D'Alessandro",
    );
  });
  it('No duplica si el título ya lo trae, ni toca servicios sin médico', () => {
    expect(nombreServicioRecepcion(getServicio('CONSULTA_MED_CONRADO'))).toBe(
      'Consulta médica — Dr. Conrado López Alonso',
    );
    expect(nombreServicioRecepcion(getServicio('HBOT_MONO'))).toBe('Cámara Hiperbárica (HBOT) — Monoplaza');
  });
});
