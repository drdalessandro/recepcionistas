import { describe, expect, it } from 'vitest';
import {
  MAX_MOTIVO,
  SCHEMA_SALIDA,
  SIN_PROPUESTA,
  parsearSalida,
  promptPropuesta,
  systemPropuesta,
  textoOferta,
  textoSolicitud,
  validarSalida,
  type OfertaPropuesta,
  type ServicioOfrecido,
} from '../src/lib/propuesta.js';

/** Oferta de juguete: HBOT mono (1 persona) y biplaza (2), jueves y viernes. */
function oferta(extra: Partial<OfertaPropuesta> = {}): OfertaPropuesta {
  const chips = (fecha: string, horas: string[]) => ({
    fecha,
    horarios: horas.map((h) => ({ inicio: `${fecha}T${h}:00-03:00`, fin: `${fecha}T${h}:00-03:00` })),
  });
  const mono: ServicioOfrecido = {
    codigo: 'HBOT_MONO',
    nombre: 'Cámara hiperbárica monoplaza',
    duracionMin: 60,
    capacidadMax: 1,
    grupal: false,
    dias: [chips('2026-09-03', ['09:00', '16:00', '17:00']), chips('2026-09-04', ['10:00'])],
  };
  const bi: ServicioOfrecido = {
    codigo: 'HBOT_BIPLAZA',
    nombre: 'Cámara hiperbárica biplaza',
    duracionMin: 60,
    capacidadMax: 2,
    grupal: false,
    dias: [chips('2026-09-03', ['16:00'])],
  };
  return {
    ahoraISO: '2026-09-02T10:00:00-03:00',
    paciente: { nombre: 'Mariana López', consentimientoFirmado: true },
    solicitud: { terapia: 'Cámara hiperbárica (HBOT)', terapiaCodigo: 'HBOT', preferenciaTexto: 'jueves a la tarde, vengo con mi marido' },
    servicios: [mono, bi],
    ...extra,
  };
}

describe('system prompt de la propuesta (Nivel 4)', () => {
  const sys = systemPropuesta();

  it('el modelo elige ENTRE horarios: nunca los inventa', () => {
    expect(sys).toMatch(/Elegí SOLO un horario de la lista/);
    expect(sys).toMatch(/NO inventes horarios/);
  });

  it('prohíbe explícitamente lo clínico, los precios y prometerle cosas al paciente', () => {
    expect(sys).toMatch(/NO des indicaciones médicas/);
    expect(sys).toMatch(/NO inventes precios/);
    expect(sys).toMatch(/NO prometas nada al paciente/);
  });

  it('define la salida de escape para lo que decide una persona', () => {
    expect(sys).toContain(SIN_PROPUESTA);
    expect(sys).toContain('sin_propuesta');
  });

  it('traduce las franjas del lenguaje del paciente a horas concretas', () => {
    expect(sys).toContain('tarde = 13:00 a 19:00');
    expect(sys).toContain('"con mi pareja/marido/mujer/amigo" = 2 personas');
  });
});

describe('lo que ve el modelo', () => {
  it('la solicitud va en palabras, con el horario elegido si lo hubo', () => {
    const t = textoSolicitud({ terapia: 'HBOT', terapiaCodigo: 'HBOT_MONO', preferenciaInicioISO: '2026-09-03T16:00:00-03:00' });
    expect(t).toContain('Terapia pedida: HBOT (HBOT_MONO)');
    expect(t).toContain('jueves 03/09 16:00');
    expect(t).toContain('2026-09-03T16:00:00-03:00');
  });

  it('sin horario ni texto, dice que vale el más próximo', () => {
    expect(textoSolicitud({ terapia: 'HBOT' })).toContain('No indicó horario');
  });

  it('la oferta lista cada chip con su ISO exacto, por servicio y por día', () => {
    const t = textoOferta(oferta().servicios);
    expect(t).toContain('HBOT_MONO — Cámara hiperbárica monoplaza (60 min, hasta 1 persona)');
    expect(t).toContain('HBOT_BIPLAZA — Cámara hiperbárica biplaza (60 min, hasta 2 personas)');
    expect(t).toContain('jueves 03/09: 09:00 → 2026-09-03T09:00:00-03:00');
    expect(t).toContain('viernes 04/09: 10:00 → 2026-09-04T10:00:00-03:00');
  });

  it('los inicios excluidos por Recepción no aparecen en la oferta', () => {
    const t = textoOferta(oferta().servicios, ['2026-09-03T16:00:00-03:00']);
    expect(t).not.toContain('2026-09-03T16:00:00-03:00');
    expect(t).toContain('2026-09-03T17:00:00-03:00');
  });

  it('un servicio sin horarios lo dice, en vez de desaparecer', () => {
    const [mono] = oferta().servicios;
    const t = textoOferta([{ ...mono!, dias: [] }]);
    expect(t).toContain('sin horarios disponibles');
  });

  it('el prompt junta fecha de hoy, ficha, solicitud y oferta', () => {
    const p = promptPropuesta(oferta({ excluir: ['2026-09-03T16:00:00-03:00'] }));
    expect(p).toContain('Hoy es miércoles, 2 de septiembre de 2026');
    expect(p).toContain('Paciente: Mariana López');
    expect(p).toContain('vengo con mi marido');
    expect(p).toContain('HORARIOS DISPONIBLES');
    expect(p).toContain('Recepción ya descartó estos inicios');
  });

  it('el esquema obliga a decidir y a explicar; no admite campos extra', () => {
    expect(SCHEMA_SALIDA.required).toEqual(['decision', 'motivo']);
    expect(SCHEMA_SALIDA.additionalProperties).toBe(false);
    expect(SCHEMA_SALIDA.properties.decision.enum).toEqual(['propuesta', 'sin_propuesta']);
  });
});

describe('validarSalida — la respuesta del modelo contra la oferta (falla cerrado)', () => {
  it('acepta un chip real del servicio ofrecido, con personas dentro de la capacidad', () => {
    const r = validarSalida(
      {
        decision: 'propuesta',
        servicioCodigo: 'HBOT_BIPLAZA',
        inicio: '2026-09-03T16:00:00-03:00',
        ocupantes: 2,
        motivo: 'Pidió jueves a la tarde con su marido: el jueves 03/09 a las 16:00 está libre la Biplaza.',
        alternativas: ['2026-09-03T17:00:00-03:00'],
      },
      oferta(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.propuesta.servicioCodigo).toBe('HBOT_BIPLAZA');
      expect(r.propuesta.ocupantes).toBe(2);
      // 17:00 no es un chip de la BIPLAZA (solo de la mono): se filtra, no se rechaza todo.
      expect(r.propuesta.alternativas).toEqual([]);
    }
  });

  it('un horario que NO está en la lista no se propone, aunque venga bien formado', () => {
    const r = validarSalida(
      { decision: 'propuesta', servicioCodigo: 'HBOT_MONO', inicio: '2026-09-03T16:30:00-03:00', motivo: 'x' },
      oferta(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.motivo).toMatch(/no está disponible/);
    }
  });

  it('un inicio que Recepción excluyó con "Otra opción" tampoco vuelve', () => {
    const r = validarSalida(
      { decision: 'propuesta', servicioCodigo: 'HBOT_MONO', inicio: '2026-09-03T16:00:00-03:00', motivo: 'x' },
      oferta({ excluir: ['2026-09-03T16:00:00-03:00'] }),
    );
    expect(r.ok).toBe(false);
  });

  it('rechaza un servicio no ofrecido y más personas de las que entran', () => {
    expect(
      validarSalida({ decision: 'propuesta', servicioCodigo: 'RECOVERY_PRO', inicio: '2026-09-03T16:00:00-03:00', motivo: 'x' }, oferta()).ok,
    ).toBe(false);
    expect(
      validarSalida(
        { decision: 'propuesta', servicioCodigo: 'HBOT_MONO', inicio: '2026-09-03T16:00:00-03:00', ocupantes: 2, motivo: 'x' },
        oferta(),
      ).ok,
    ).toBe(false);
  });

  it('sesión grupal: no propone más personas que lugares libres en ese chip', () => {
    const multi: ServicioOfrecido = {
      codigo: 'HBOT_MULTIPLAZA',
      nombre: 'Multiplaza',
      duracionMin: 60,
      capacidadMax: 6,
      grupal: true,
      dias: [{ fecha: '2026-09-03', horarios: [{ inicio: '2026-09-03T15:00:00-03:00', fin: '2026-09-03T16:00:00-03:00', lugares: 1, ocupantes: 5 }] }],
    };
    const o = oferta({ servicios: [multi] });
    const base = { decision: 'propuesta', servicioCodigo: 'HBOT_MULTIPLAZA', inicio: '2026-09-03T15:00:00-03:00', motivo: 'x' };
    expect(validarSalida({ ...base, ocupantes: 1 }, o).ok).toBe(true);
    expect(validarSalida({ ...base, ocupantes: 2 }, o).ok).toBe(false);
  });

  it('sin_propuesta pasa como "resolvela vos", con el motivo del modelo', () => {
    const r = validarSalida({ decision: 'sin_propuesta', motivo: 'Menciona un marcapasos: que lo vea una persona.' }, oferta());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.motivo).toContain('marcapasos');
    }
  });

  it('el motivo se recorta y se limpia; si falta, se arma uno neutro', () => {
    const largo = 'a'.repeat(MAX_MOTIVO + 50);
    const r1 = validarSalida({ decision: 'propuesta', servicioCodigo: 'HBOT_MONO', inicio: '2026-09-03T09:00:00-03:00', motivo: largo }, oferta());
    expect(r1.ok && r1.propuesta.motivo.length).toBe(MAX_MOTIVO);
    const r2 = validarSalida({ decision: 'propuesta', servicioCodigo: 'HBOT_MONO', inicio: '2026-09-03T09:00:00-03:00', motivo: '   ' }, oferta());
    expect(r2.ok && r2.propuesta.motivo).toContain('jueves 03/09 09:00');
  });

  it('basura (no JSON, JSON sin decisión) no propone nada', () => {
    expect(parsearSalida('esto no es json')).toBeUndefined();
    expect(validarSalida(undefined, oferta()).ok).toBe(false);
    expect(validarSalida({ hola: 1 }, oferta()).ok).toBe(false);
    expect(validarSalida(parsearSalida('{"decision":"propuesta"}'), oferta()).ok).toBe(false);
  });
});
