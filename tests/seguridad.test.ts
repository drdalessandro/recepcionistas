import { describe, it, expect } from 'vitest';
import { accionSeguridad, estadoSeguridad, tituloSeguridad } from '../src/lib/seguridad.js';

// El bug que originó este módulo (2026-08-14): el banner derivaba su color SOLO
// de los Flag activos, así que "no hay Flags" se mostraba como "Paciente apto
// para atención". Para un walk-in recién creado en el mostrador eso es afirmar
// algo que nadie verificó. Estos casos fijan que no vuelva a pasar.

describe('estadoSeguridad — ausencia de datos NO es "apto"', () => {
  it('paciente recién creado (sin screening, sin Flags): NO es apto', () => {
    const r = estadoSeguridad({ contraindicacionesActivas: [], screeningCompleto: false });
    expect(r.estado).toBe('sin-screening');
    expect(r.color).toBe('gris'); // ni verde ni rojo: no sabemos
    expect(r.puedeAvanzar).toBe(false);
  });

  it('con screening completo, EVALUADO sin riesgos y sin contraindicaciones: apto', () => {
    const r = estadoSeguridad({ contraindicacionesActivas: [], screeningCompleto: true, riesgosScreening: 0 });
    expect(r.estado).toBe('apto');
    expect(r.color).toBe('verde');
    expect(r.puedeAvanzar).toBe(true);
  });

  it('el bug del 2026-08-28: screening completo PERO con riesgos declarados → ROJO, no apto', () => {
    // El paciente del portal contestó "sí" a neumotórax e infección respiratoria
    // y el banner decía "Paciente apto para atención": el screening se daba por
    // bueno con solo existir. Declarar un riesgo es conocimiento, no ausencia.
    const r = estadoSeguridad({ contraindicacionesActivas: [], screeningCompleto: true, riesgosScreening: 2 });
    expect(r.estado).toBe('riesgo-declarado');
    expect(r.color).toBe('rojo');
    expect(r.puedeAvanzar).toBe(false);
  });

  it('screening completo pero SIN evaluar (riesgos undefined) ya no alcanza para apto', () => {
    // Si un caller viejo no evalúa las respuestas, el resultado es
    // no-verificable — nunca un apto por omisión.
    const r = estadoSeguridad({ contraindicacionesActivas: [], screeningCompleto: true });
    expect(r.estado).toBe('no-verificable');
    expect(r.puedeAvanzar).toBe(false);
  });

  it('con contraindicación activa: rojo, sin importar el screening', () => {
    for (const screeningCompleto of [true, false, undefined]) {
      const r = estadoSeguridad({ contraindicacionesActivas: ['HBOT_NEUMOTORAX_NO_TRATADO'], screeningCompleto });
      expect(r.estado).toBe('contraindicado');
      expect(r.color).toBe('rojo');
      expect(r.puedeAvanzar).toBe(false);
    }
  });
});

describe('estadoSeguridad — falla CERRADO', () => {
  it('si no se pudieron leer las contraindicaciones: no-verificable, nunca apto', () => {
    const r = estadoSeguridad({ contraindicacionesActivas: undefined, screeningCompleto: true, riesgosScreening: 0 });
    expect(r.estado).toBe('no-verificable');
    expect(r.puedeAvanzar).toBe(false);
  });

  it('si no se pudo averiguar el screening: no-verificable, nunca apto', () => {
    const r = estadoSeguridad({ contraindicacionesActivas: [], screeningCompleto: undefined });
    expect(r.estado).toBe('no-verificable');
    expect(r.puedeAvanzar).toBe(false);
  });

  it('sin datos de ningún tipo (el caso del bot que no responde): no-verificable', () => {
    const r = estadoSeguridad({});
    expect(r.estado).toBe('no-verificable');
    expect(r.color).toBe('gris');
    expect(r.puedeAvanzar).toBe(false);
  });

  it('NINGÚN camino habilita avanzar salvo "apto"', () => {
    const combinaciones = [
      { contraindicacionesActivas: undefined, screeningCompleto: undefined },
      { contraindicacionesActivas: undefined, screeningCompleto: false },
      { contraindicacionesActivas: undefined, screeningCompleto: true },
      { contraindicacionesActivas: [], screeningCompleto: undefined },
      { contraindicacionesActivas: [], screeningCompleto: false },
      { contraindicacionesActivas: [], screeningCompleto: true },
      { contraindicacionesActivas: [], screeningCompleto: true, riesgosScreening: 1 },
      { contraindicacionesActivas: ['X'], screeningCompleto: undefined },
      { contraindicacionesActivas: ['X'], screeningCompleto: false },
      { contraindicacionesActivas: ['X'], screeningCompleto: true },
    ];
    for (const c of combinaciones) {
      expect(estadoSeguridad(c).puedeAvanzar).toBe(false);
    }
    expect(
      estadoSeguridad({ contraindicacionesActivas: [], screeningCompleto: true, riesgosScreening: 0 }).puedeAvanzar,
    ).toBe(true);
  });
});

describe('textos del banner — sin contenido clínico', () => {
  it('cada estado tiene título y acción, y ninguno filtra el detalle clínico', () => {
    for (const estado of ['contraindicado', 'riesgo-declarado', 'apto', 'sin-screening', 'no-verificable'] as const) {
      const texto = `${tituloSeguridad(estado)} ${accionSeguridad(estado)}`;
      expect(texto.length).toBeGreaterThan(0);
      // El banner nunca nombra una contraindicación concreta.
      expect(texto).not.toMatch(/NEUMOTORAX|EPOC|bleomicina/i);
    }
  });

  it('"sin screening" manda a completar el cuestionario; "no verificable" escala al equipo', () => {
    // La diferencia importa en el mostrador: una acción es del paciente y la
    // otra es nuestra. Un texto genérico para los dos deja a la recepcionista
    // sin saber a quién perseguir.
    expect(accionSeguridad('sin-screening')).toMatch(/cuestionario de ingreso/i);
    expect(accionSeguridad('no-verificable')).toMatch(/equipo médico/i);
    expect(accionSeguridad('sin-screening')).not.toBe(accionSeguridad('no-verificable'));
  });
});
