import { describe, expect, it } from 'vitest';
import { CANTIDAD_PACIENTES, pacientesDemo, planDia } from '../src/seed/demo-ocupacion.js';
import { validarRecursos } from '../src/lib/reglas-turno.js';

/**
 * La demo de ocupación tiene una obligación que los datos reales no: NO puede
 * mostrar una agenda ilegal. Si la grilla de la demo viola R-07 (capacidad o
 * desfasaje de los gabinetes), las chicas aprenden mirando un ejemplo inválido.
 * Por eso el plan se valida acá con LOS MISMOS validadores del motor real.
 */

// 2026-08-28 = viernes (08–22) · 29 = sábado (08–20) · 30 = domingo (cerrado).
const VIERNES = '2026-08-28';
const SABADO = '2026-08-29';
const DOMINGO = '2026-08-30';
const MEDIODIA = new Date(`${VIERNES}T12:00:00-03:00`);

describe('demo-ocupacion · planDia', () => {
  it('el día lleno pasa los validadores REALES de R-07 (capacidad + desfasaje)', () => {
    for (const fecha of [VIERNES, SABADO]) {
      const plan = planDia(fecha, MEDIODIA);
      const r = validarRecursos(
        plan.map((t) => ({ recursoCodigo: t.recursoCodigo, inicio: t.inicio, fin: t.fin, ocupantes: t.ocupantes })),
      );
      expect(r.ok, r.bloqueos.map((i) => i.mensaje).join(' | ')).toBe(true);
    }
  });

  it('ocupación completa: la monoplaza encadena 60\' de punta a punta', () => {
    const plan = planDia(VIERNES, MEDIODIA);
    // Viernes 08:00–22:00 = 14 h → 14 sesiones de HBOT de 60'.
    expect(plan.filter((t) => t.recursoCodigo === 'R_HBOT_MONO')).toHaveLength(14);
    // Sábado corta 20:00 → 12.
    expect(planDia(SABADO, MEDIODIA).filter((t) => t.recursoCodigo === 'R_HBOT_MONO')).toHaveLength(12);
    // Cada puesto IHHT: 28 medias horas.
    expect(plan.filter((t) => t.recursoCodigo === 'R_IHHT_1')).toHaveLength(28);
  });

  it('domingo cerrado: plan vacío', () => {
    expect(planDia(DOMINGO, MEDIODIA)).toHaveLength(0);
  });

  it('R-07: el Gabinete 2 arranca 30\' corrido del Gabinete 1', () => {
    const plan = planDia(VIERNES, MEDIODIA);
    const primeroG1 = plan.filter((t) => t.recursoCodigo === 'R_RECOVERY_G1')[0]!;
    const primeroG2 = plan.filter((t) => t.recursoCodigo === 'R_RECOVERY_G2')[0]!;
    expect(primeroG2.inicio.getTime() - primeroG1.inicio.getTime()).toBe(30 * 60_000);
  });

  it('multiplaza: sesiones grupales de a lo sumo 6 personas, apiladas en la misma franja', () => {
    const plan = planDia(VIERNES, MEDIODIA);
    const porFranja = new Map<number, number>();
    for (const t of plan.filter((x) => x.recursoCodigo === 'R_HBOT_MULTIPLAZA')) {
      porFranja.set(t.inicio.getTime(), (porFranja.get(t.inicio.getTime()) ?? 0) + 1);
    }
    expect(porFranja.size).toBeGreaterThan(0);
    for (const personas of porFranja.values()) {
      expect(personas).toBeGreaterThanOrEqual(3);
      expect(personas).toBeLessThanOrEqual(6);
    }
  });

  it('estados según el reloj: pasado completado, presente llegó, futuro confirmado (con tentativos)', () => {
    const plan = planDia(VIERNES, MEDIODIA);
    for (const t of plan) {
      if (t.fin.getTime() <= MEDIODIA.getTime()) {
        expect(t.status).toBe('fulfilled');
      } else if (t.inicio.getTime() <= MEDIODIA.getTime()) {
        expect(t.status).toBe('arrived');
      } else {
        expect(['booked', 'pending']).toContain(t.status);
      }
    }
    // La leyenda amarilla también se tiene que ver: hay tentativos sueltos.
    expect(plan.some((t) => t.status === 'pending')).toBe(true);
  });

  it('el consultorio se llena SOLO en las franjas reales de los médicos', () => {
    // Viernes: Dr. Conrado 17:00–20:00. Nada fuera de esa franja.
    const consultas = planDia(VIERNES, MEDIODIA).filter((t) => t.recursoCodigo === 'R_CONSULTORIO');
    expect(consultas.length).toBeGreaterThan(0);
    for (const c of consultas) {
      expect(c.practitionerCodigo).toBeDefined();
      expect(c.inicio.getUTCHours()).toBeGreaterThanOrEqual(20); // 17:00 AR = 20:00 UTC
    }
    // Sábado no atiende nadie: consultorio vacío (100 % de lo OFERTABLE).
    expect(planDia(SABADO, MEDIODIA).filter((t) => t.recursoCodigo === 'R_CONSULTORIO')).toHaveLength(0);
  });
});

describe('demo-ocupacion · pacientes', () => {
  it('28 pacientes con DNI, teléfono y email únicos (bw-dedup-paciente es una Subscription real)', () => {
    const ps = pacientesDemo();
    expect(ps).toHaveLength(CANTIDAD_PACIENTES);
    expect(new Set(ps.map((p) => p.dni)).size).toBe(ps.length);
    expect(new Set(ps.map((p) => p.tel)).size).toBe(ps.length);
    expect(new Set(ps.map((p) => p.email)).size).toBe(ps.length);
  });
});
