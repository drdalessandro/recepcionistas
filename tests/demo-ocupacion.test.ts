import { describe, expect, it } from 'vitest';
import { CANTIDAD_PACIENTES, diasHasta, pacientesDemo, planDia } from '../src/seed/demo-ocupacion.js';
import { validarGrillaTurno, validarRecursos } from '../src/lib/reglas-turno.js';
import { getServicio } from '../src/config/catalogo.js';

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
    // Cada puesto IHHT: 14 sesiones de 30' arrancando en punto (R-22); la
    // media hora siguiente queda libre, como en la agenda real.
    const ihht = plan.filter((t) => t.recursoCodigo === 'R_IHHT_1');
    expect(ihht).toHaveLength(14);
    for (const t of ihht) {
      expect(t.inicio.getUTCMinutes()).toBe(0);
    }
  });

  it('R-22: cada turno de la demo arranca en la grilla comercial de su servicio (Recovery Pro a la media también)', () => {
    for (const fecha of [VIERNES, SABADO]) {
      for (const t of planDia(fecha, MEDIODIA)) {
        const r = validarGrillaTurno(getServicio(t.servicioCodigo), t.inicio);
        expect(r.ok, `${t.recursoCodigo} ${t.inicio.toISOString()}: ${r.bloqueos.map((b) => b.mensaje).join(' | ')}`).toBe(true);
      }
    }
    // El Gabinete 2 sigue arrancando a la media (única excepción de R-22).
    expect(planDia(VIERNES, MEDIODIA).some((t) => t.recursoCodigo === 'R_RECOVERY_G2' && t.inicio.getUTCMinutes() === 30)).toBe(true);
  });

  it('ocupación parcial: deja huecos repartidos, sigue legal (R-07 + R-22) y es determinista', () => {
    const lleno = planDia(VIERNES, MEDIODIA);
    const parcial = planDia(VIERNES, MEDIODIA, { ocupacion: 0.6 });
    expect(parcial.length).toBeLessThan(lleno.length);
    expect(parcial.length).toBeGreaterThan(lleno.length * 0.4);
    expect(planDia(VIERNES, MEDIODIA, { ocupacion: 0.6 })).toEqual(parcial);
    // Los huecos no se concentran en una sala: todas siguen teniendo turnos, y todas perdieron alguno.
    const porSala = (plan: typeof lleno): Map<string, number> => {
      const m = new Map<string, number>();
      for (const t of plan) {
        m.set(t.recursoCodigo, (m.get(t.recursoCodigo) ?? 0) + 1);
      }
      return m;
    };
    const l = porSala(lleno);
    const q = porSala(parcial);
    for (const [sala, n] of l) {
      expect(q.get(sala) ?? 0, sala).toBeGreaterThan(0);
      expect(q.get(sala) ?? 0, sala).toBeLessThan(n);
    }
    const r = validarRecursos(parcial.map((t) => ({ recursoCodigo: t.recursoCodigo, inicio: t.inicio, fin: t.fin, ocupantes: t.ocupantes })));
    expect(r.ok).toBe(true);
    // ocupacion: 1 es exactamente el plan de siempre.
    expect(planDia(VIERNES, MEDIODIA, { ocupacion: 1 })).toEqual(lleno);
  });

  it('--hasta: cuenta los días desde hoy (AR) hasta la fecha, ambos incluidos', () => {
    const hoy = new Date('2026-09-02T15:00:00-03:00');
    expect(diasHasta('2026-09-15', hoy)).toBe(14);
    expect(diasHasta('2026-09-02', hoy)).toBe(1);
    expect(diasHasta('2026-08-30', hoy)).toBe(1); // en el pasado: nunca menos de hoy
    expect(() => diasHasta('15/09/2026', hoy)).toThrow(/YYYY-MM-DD/);
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
