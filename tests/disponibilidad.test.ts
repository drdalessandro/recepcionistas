import { describe, it, expect } from 'vitest';
import { calcularDisponibilidad, horarioOfrecido, perfilDeReserva, type DiaDisponible } from '../src/lib/disponibilidad.js';
import { getServicio } from '../src/config/catalogo.js';
import type { ReservaRecurso } from '../src/lib/reglas-turno.js';

// Miércoles 10:00 de Argentina (el centro abre según HORARIO_SEMANAL).
const AHORA = new Date('2026-07-22T10:00:00-03:00');

function horarios(dias: DiaDisponible[]): string[] {
  return dias.flatMap((d) => d.horarios.map((h) => h.inicio));
}

function reserva(recurso: string, inicio: string, fin: string, ocupantes = 1): ReservaRecurso {
  return { recursoCodigo: recurso, inicio: new Date(inicio), fin: new Date(fin), ocupantes };
}

describe('perfilDeReserva — derivación R-13 (la del server)', () => {
  it('tag-fm manda: FM aunque no tenga membresía', () => {
    expect(perfilDeReserva(true, [])).toBe('FM');
  });
  it('Membresía Intensivo => INTENSIVO', () => {
    expect(perfilDeReserva(false, ['INTENSIVO'])).toBe('INTENSIVO');
    expect(perfilDeReserva(false, ['STANDARD', 'INTENSIVO'])).toBe('INTENSIVO');
  });
  it('Membresía Standard => STANDARD; sin membresía => PUBLICO', () => {
    expect(perfilDeReserva(false, ['STANDARD'])).toBe('STANDARD');
    expect(perfilDeReserva(false, [])).toBe('PUBLICO');
  });
});

describe('calcularDisponibilidad — ventana por perfil (R-13, prueba e2e del handoff)', () => {
  const servicio = getServicio('HBOT_MONO');

  function ultimaFecha(perfil: 'PUBLICO' | 'STANDARD' | 'INTENSIVO' | 'FM'): string {
    const r = calcularDisponibilidad({ servicio, perfil, ahora: AHORA, reservas: [] });
    expect(r.dias.length).toBeGreaterThan(0);
    return r.dias[r.dias.length - 1]!.fecha;
  }

  it('Público (48 h) llega menos lejos que Standard (72 h) que Intensivo (96 h) que FM (7 días)', () => {
    const publico = ultimaFecha('PUBLICO');
    const standard = ultimaFecha('STANDARD');
    const intensivo = ultimaFecha('INTENSIVO');
    const fm = ultimaFecha('FM');
    expect(publico < standard || (publico === standard && true)).toBe(true);
    expect(publico <= standard && standard <= intensivo && intensivo <= fm).toBe(true);
    expect(publico < fm).toBe(true);
    // Público: 48 h desde el miércoles 10:00 => nada después del viernes 24.
    expect(publico <= '2026-07-24').toBe(true);
    // FM: hasta 7 días.
    expect(fm >= '2026-07-27').toBe(true);
  });

  it('ventanaHoras acompaña al perfil y solo ofrece horarios a futuro', () => {
    const r = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas: [] });
    expect(r.ventanaHoras).toBe(48);
    expect(r.grupal).toBe(false);
    for (const ini of horarios(r.dias)) {
      expect(new Date(ini).getTime()).toBeGreaterThan(AHORA.getTime());
    }
  });
});

describe('calcularDisponibilidad — capacidad y agenda real (R-07)', () => {
  const servicio = getServicio('HBOT_MONO');

  it('Una franja tomada en TODAS las salas aptas desaparece; sigue si queda alguna libre', () => {
    const franjaMono = reserva('R_HBOT_MONO', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00');
    const franjaBi = reserva('R_HBOT_BIPLAZA', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00');

    const conUna = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas: [franjaMono] });
    // La mono está tomada pero la biplaza (misma categoría) queda: el horario se ofrece.
    expect(horarios(conUna.dias)).toContain('2026-07-22T15:00:00-03:00');

    const conDos = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas: [franjaMono, franjaBi] });
    expect(horarios(conDos.dias)).not.toContain('2026-07-22T15:00:00-03:00');
    // Los vecinos que no solapan siguen.
    expect(horarios(conDos.dias)).toContain('2026-07-22T16:00:00-03:00');
  });

  it('El turno completo tiene que caber: sin arranques que se pasen del cierre de la franja', () => {
    const r = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas: [] });
    for (const d of r.dias) {
      for (const h of d.horarios) {
        // Ningún fin puede quedar después de la última media hora generada del día.
        expect(h.fin.slice(0, 10)).toBe(h.inicio.slice(0, 10));
      }
    }
  });
});

describe('calcularDisponibilidad — Multiplaza (sesión grupal "sumate")', () => {
  const servicio = getServicio('HBOT_MULTIPLAZA');

  it('Con 2 ocupantes anotados: lugares 4, ocupantes 2 (paso 4 del handoff)', () => {
    const existente = reserva('R_HBOT_MULTIPLAZA', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00', 2);
    const r = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas: [existente] });
    expect(r.grupal).toBe(true);
    const franja = r.dias.flatMap((d) => d.horarios).find((h) => h.inicio === '2026-07-22T15:00:00-03:00')!;
    expect(franja).toBeDefined();
    expect(franja.ocupantes).toBe(2);
    expect(franja.lugares).toBe(4);
  });

  it('Debajo del mínimo de 3 igual se ofrece (advertencia, no bloqueo); llena (6/6) desaparece', () => {
    const llena = reserva('R_HBOT_MULTIPLAZA', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00', 6);
    const r = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas: [llena] });
    const inicios = horarios(r.dias);
    expect(inicios).not.toContain('2026-07-22T15:00:00-03:00');
    // Una franja vacía (0 anotados, bajo el mínimo de 3) se ofrece igual.
    const vacia = r.dias.flatMap((d) => d.horarios).find((h) => h.inicio === '2026-07-22T16:00:00-03:00')!;
    expect(vacia).toBeDefined();
    expect(vacia.ocupantes).toBe(0);
    expect(vacia.lugares).toBe(6);
  });

  it('Una sesión individual HBOT no pisa la Multiplaza (y viceversa no la ve)', () => {
    const mono = getServicio('HBOT_MONO');
    const enMulti = reserva('R_HBOT_MULTIPLAZA', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00', 6);
    // La multiplaza llena no afecta la disponibilidad del servicio individual.
    const r = calcularDisponibilidad({ servicio: mono, perfil: 'PUBLICO', ahora: AHORA, reservas: [enMulti] });
    expect(horarios(r.dias)).toContain('2026-07-22T15:00:00-03:00');
  });
});

describe('calcularDisponibilidad — desfasaje Recovery (R-07 / AC-05)', () => {
  const servicio = getServicio('RECOVERY_PRO');

  it('El gabinete hermano arrancando a la misma hora bloquea; a 30 min está OK', () => {
    const g1 = reserva('R_RECOVERY_G1', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00');
    const r = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas: [g1] });
    const inicios = horarios(r.dias);
    // 15:00 en el G2 arrancaría junto con el G1 => fuera. 15:30 => permitido.
    expect(inicios).not.toContain('2026-07-22T15:00:00-03:00');
    expect(inicios).toContain('2026-07-22T15:30:00-03:00');
  });
});

describe('calcularDisponibilidad — solicitudes pendientes (decisión 2026-07-26)', () => {
  const hbot = getServicio('HBOT_MONO');
  const multi = getServicio('HBOT_MULTIPLAZA');

  function sol(inicio: string, servicioCodigo?: string, pedidaEn: Date = AHORA): {
    inicio: Date;
    servicioCodigo?: string;
    pedidaEn: Date;
  } {
    return { inicio: new Date(inicio), servicioCodigo, pedidaEn };
  }

  it('Individual: un horario ya pedido NO se ofrece (aunque otra sala siga libre)', () => {
    const r = calcularDisponibilidad({
      servicio: hbot,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [],
      solicitudes: [sol('2026-07-22T15:00:00-03:00', 'HBOT_MONO')],
    });
    const inicios = horarios(r.dias);
    expect(inicios).not.toContain('2026-07-22T15:00:00-03:00');
    // El solape parcial también bloquea (el pedido de 15:00 dura hasta las 16:00).
    expect(inicios).not.toContain('2026-07-22T15:30:00-03:00');
    expect(inicios).toContain('2026-07-22T16:00:00-03:00');
    expect(r.excluidosPorSolicitudes).toBeGreaterThan(0);
  });

  it('Resuelta (no llega a la lista) => vuelve a ofrecerse; confirmada => lo tapa la agenda, sin doble descuento', () => {
    // Rechazada: la lista de pendientes queda vacía.
    const rechazada = calcularDisponibilidad({ servicio: hbot, perfil: 'PUBLICO', ahora: AHORA, reservas: [], solicitudes: [] });
    expect(horarios(rechazada.dias)).toContain('2026-07-22T15:00:00-03:00');
    // Confirmada: hay Appointment (reserva) y el Task ya no está pendiente.
    const confirmada = calcularDisponibilidad({
      servicio: hbot,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [
        reserva('R_HBOT_MONO', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00'),
        reserva('R_HBOT_BIPLAZA', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00'),
      ],
      solicitudes: [],
    });
    expect(horarios(confirmada.dias)).not.toContain('2026-07-22T15:00:00-03:00');
    expect(confirmada.excluidosPorSolicitudes).toBe(0);
  });

  it('Grupal: cada pendiente resta un lugar y ocupantes sigue contando solo confirmados', () => {
    const r = calcularDisponibilidad({
      servicio: multi,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [reserva('R_HBOT_MULTIPLAZA', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00', 2)],
      solicitudes: [sol('2026-07-22T15:00:00-03:00', 'HBOT_MULTIPLAZA')],
    });
    const franja = r.dias.flatMap((d) => d.horarios).find((h) => h.inicio === '2026-07-22T15:00:00-03:00')!;
    expect(franja.lugares).toBe(3); // 6 − 2 confirmados − 1 pendiente
    expect(franja.ocupantes).toBe(2); // "ya somos N" = solo confirmados
  });

  it('Grupal lleno entre confirmados y pendientes => el horario se omite', () => {
    const r = calcularDisponibilidad({
      servicio: multi,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [reserva('R_HBOT_MULTIPLAZA', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00', 2)],
      solicitudes: Array.from({ length: 4 }, () => sol('2026-07-22T15:00:00-03:00', 'HBOT_MULTIPLAZA')),
    });
    expect(horarios(r.dias)).not.toContain('2026-07-22T15:00:00-03:00');
  });

  it('Vencimiento: horario pasado o pedido hace más de 24 h => no bloquea', () => {
    const r = calcularDisponibilidad({
      servicio: hbot,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [],
      solicitudes: [
        sol('2026-07-22T09:00:00-03:00', 'HBOT_MONO'), // ya pasó (AHORA = 10:00)
        sol('2026-07-22T15:00:00-03:00', 'HBOT_MONO', new Date(AHORA.getTime() - 25 * 3_600_000)), // vencida
      ],
    });
    expect(horarios(r.dias)).toContain('2026-07-22T15:00:00-03:00');
    expect(r.excluidosPorSolicitudes).toBe(0);
  });

  it('No compiten: otra sala (IHHT vs HBOT) o sin código de servicio => no bloquean; mismo consultorio sí', () => {
    const r = calcularDisponibilidad({
      servicio: hbot,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [],
      solicitudes: [sol('2026-07-22T15:00:00-03:00', 'IHHT'), sol('2026-07-22T15:00:00-03:00', undefined)],
    });
    expect(horarios(r.dias)).toContain('2026-07-22T15:00:00-03:00');
    // El Chequeo y las consultas comparten el consultorio: sí compiten.
    const chequeo = calcularDisponibilidad({
      servicio: getServicio('CHEQUEO_BW'),
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [],
      solicitudes: [sol('2026-07-22T15:00:00-03:00', 'CONSULTA_MED_DALESSANDRO')],
    });
    expect(horarios(chequeo.dias)).not.toContain('2026-07-22T15:00:00-03:00');
  });
});

describe('calcularDisponibilidad — ocupados por día (handoff portal: tachados en Reservas)', () => {
  const servicio = getServicio('HBOT_MONO');

  function ocupados(dias: DiaDisponible[]): string[] {
    return dias.flatMap((d) => (d.ocupados ?? []).map((o) => o.inicio));
  }

  it('franja tomada en TODAS las salas: sale de horarios y entra en ocupados, con su fin', () => {
    const r = calcularDisponibilidad({
      servicio,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [
        reserva('R_HBOT_MONO', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00'),
        reserva('R_HBOT_BIPLAZA', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00', 2),
      ],
    });
    expect(horarios(r.dias)).not.toContain('2026-07-22T15:00:00-03:00');
    const dia = r.dias.find((d) => d.fecha === '2026-07-22')!;
    // La sesión de 60' choca con la reserva arrancando 14:30, 15:00 y 15:30.
    expect((dia.ocupados ?? []).map((o) => o.inicio)).toEqual([
      '2026-07-22T14:30:00-03:00',
      '2026-07-22T15:00:00-03:00',
      '2026-07-22T15:30:00-03:00',
    ]);
    expect(dia.ocupados?.find((o) => o.inicio === '2026-07-22T15:00:00-03:00')?.fin).toBe('2026-07-22T16:00:00-03:00');
    // Los vecinos libres no se tachan.
    expect(ocupados(r.dias)).not.toContain('2026-07-22T16:00:00-03:00');
  });

  it('tomada en UNA sola sala (queda otra libre): sigue ofrecido y NO se tacha', () => {
    const r = calcularDisponibilidad({
      servicio,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [reserva('R_HBOT_MONO', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00')],
    });
    expect(horarios(r.dias)).toContain('2026-07-22T15:00:00-03:00');
    expect(ocupados(r.dias)).not.toContain('2026-07-22T15:00:00-03:00');
  });

  it('solicitud pendiente individual: el horario pedido aparece tachado', () => {
    const r = calcularDisponibilidad({
      servicio,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [],
      solicitudes: [{ inicio: new Date('2026-07-22T15:00:00-03:00'), servicioCodigo: 'HBOT_MONO', pedidaEn: AHORA }],
    });
    // El pedido de 15:00 (60') tacha 14:30, 15:00 y 15:30; 16:00 sigue libre.
    expect(ocupados(r.dias)).toContain('2026-07-22T15:00:00-03:00');
    expect(ocupados(r.dias)).toContain('2026-07-22T15:30:00-03:00');
    expect(horarios(r.dias)).toContain('2026-07-22T16:00:00-03:00');
    expect(r.excluidosPorSolicitudes).toBeGreaterThan(0);
  });

  it('grupal: cupo agotado (confirmados 6/6, o confirmados + pendientes) => tachado', () => {
    const multi = getServicio('HBOT_MULTIPLAZA');
    const llena = calcularDisponibilidad({
      servicio: multi,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [reserva('R_HBOT_MULTIPLAZA', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00', 6)],
    });
    expect(ocupados(llena.dias)).toContain('2026-07-22T15:00:00-03:00');
    const mixta = calcularDisponibilidad({
      servicio: multi,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [reserva('R_HBOT_MULTIPLAZA', '2026-07-22T15:00:00-03:00', '2026-07-22T16:00:00-03:00', 2)],
      solicitudes: Array.from({ length: 4 }, () => ({
        inicio: new Date('2026-07-22T15:00:00-03:00'),
        servicioCodigo: 'HBOT_MULTIPLAZA',
        pedidaEn: AHORA,
      })),
    });
    expect(horarios(mixta.dias)).not.toContain('2026-07-22T15:00:00-03:00');
    expect(ocupados(mixta.dias)).toContain('2026-07-22T15:00:00-03:00');
  });

  it('lo que no es parte de la grilla visible NO se tacha: pasado y fuera de ventana R-13', () => {
    const r = calcularDisponibilidad({
      servicio,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [
        // Ya pasó (AHORA = miércoles 10:00): no es un chip, no se tacha.
        reserva('R_HBOT_MONO', '2026-07-22T08:00:00-03:00', '2026-07-22T09:00:00-03:00'),
        reserva('R_HBOT_BIPLAZA', '2026-07-22T08:00:00-03:00', '2026-07-22T09:00:00-03:00', 2),
        // Viernes 15:00 queda fuera de la ventana pública (48 h => viernes 10:00).
        reserva('R_HBOT_MONO', '2026-07-24T15:00:00-03:00', '2026-07-24T16:00:00-03:00'),
        reserva('R_HBOT_BIPLAZA', '2026-07-24T15:00:00-03:00', '2026-07-24T16:00:00-03:00', 2),
      ],
    });
    expect(ocupados(r.dias)).not.toContain('2026-07-22T08:00:00-03:00');
    expect(ocupados(r.dias)).not.toContain('2026-07-24T15:00:00-03:00');
  });

  it('día completamente tomado: aparece igual, con horarios [] y todo en ocupados', () => {
    const r = calcularDisponibilidad({
      servicio,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [
        reserva('R_HBOT_MONO', '2026-07-23T08:00:00-03:00', '2026-07-23T22:00:00-03:00'),
        reserva('R_HBOT_BIPLAZA', '2026-07-23T08:00:00-03:00', '2026-07-23T22:00:00-03:00', 2),
      ],
    });
    const jueves = r.dias.find((d) => d.fecha === '2026-07-23')!;
    expect(jueves).toBeDefined();
    expect(jueves.horarios).toEqual([]);
    // Todos los arranques del día (08:00 a 21:00, el último donde caben los 60').
    expect(jueves.ocupados?.[0]?.inicio).toBe('2026-07-23T08:00:00-03:00');
    expect(jueves.ocupados?.[jueves.ocupados.length - 1]?.inicio).toBe('2026-07-23T21:00:00-03:00');
    expect(jueves.ocupados).toHaveLength(27);
  });

  it('sin nada tomado, los días viajan sin la clave ocupados (payload limpio)', () => {
    const r = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas: [] });
    expect(r.dias.length).toBeGreaterThan(0);
    for (const d of r.dias) {
      expect(d.ocupados).toBeUndefined();
    }
  });

  it('un ocupado NO cuenta como ofrecido (horarioOfrecido sigue mirando solo horarios)', () => {
    const disp = calcularDisponibilidad({
      servicio,
      perfil: 'PUBLICO',
      ahora: AHORA,
      reservas: [
        reserva('R_HBOT_MONO', '2026-07-23T09:00:00-03:00', '2026-07-23T10:00:00-03:00'),
        reserva('R_HBOT_BIPLAZA', '2026-07-23T09:00:00-03:00', '2026-07-23T10:00:00-03:00', 2),
      ],
    });
    expect(ocupados(disp.dias)).toContain('2026-07-23T09:00:00-03:00');
    expect(horarioOfrecido(disp.dias, new Date('2026-07-23T09:00:00-03:00'))).toBe(false);
  });
});

describe('horarioOfrecido — defensa en profundidad de bw-solicitar-turno (feedback recepción 2026-08-12)', () => {
  const servicio = getServicio('HBOT_MONO');

  it('solo la monoplaza ocupada: el horario SIGUE ofrecido — la sesión HBOT puede ir a la biplaza (la sala la elige Recepción)', () => {
    // Miércoles 22/07 10:00 "ahora" → jueves 23/07 en ventana pública (48 h).
    const monoOcupada = reserva('R_HBOT_MONO', '2026-07-23T09:00:00-03:00', '2026-07-23T10:00:00-03:00');
    const disp = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas: [monoOcupada] });
    // Esto NO es un bug: es el mismo criterio que usa Recepción a mano. El
    // horario recién desaparece cuando TODAS las salas de la categoría están
    // tomadas (caso siguiente).
    expect(horarioOfrecido(disp.dias, new Date('2026-07-23T08:30:00-03:00'))).toBe(true);
  });

  it('el caso reportado, con TODAS las salas HBOT tomadas 9:00–10:00: 8:30 (solapa), 9:00 y 9:30 NO se ofrecen; 10:00 sí', () => {
    const reservas = [
      reserva('R_HBOT_MONO', '2026-07-23T09:00:00-03:00', '2026-07-23T10:00:00-03:00'),
      reserva('R_HBOT_BIPLAZA', '2026-07-23T09:00:00-03:00', '2026-07-23T10:00:00-03:00', 2),
    ];
    const disp = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas });
    expect(horarioOfrecido(disp.dias, new Date('2026-07-23T08:30:00-03:00'))).toBe(false);
    expect(horarioOfrecido(disp.dias, new Date('2026-07-23T09:00:00-03:00'))).toBe(false);
    expect(horarioOfrecido(disp.dias, new Date('2026-07-23T09:30:00-03:00'))).toBe(false);
    expect(horarioOfrecido(disp.dias, new Date('2026-07-23T10:00:00-03:00'))).toBe(true);
  });

  it('sin reservas, el mismo horario SÍ está ofrecido (el chequeo no inventa rechazos)', () => {
    const disp = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas: [] });
    expect(horarioOfrecido(disp.dias, new Date('2026-07-23T08:30:00-03:00'))).toBe(true);
  });

  it('fuera de la ventana R-13 o desalineado de la grilla => no ofrecido', () => {
    const disp = calcularDisponibilidad({ servicio, perfil: 'PUBLICO', ahora: AHORA, reservas: [] });
    // Público = 48 h: la semana siguiente queda afuera.
    expect(horarioOfrecido(disp.dias, new Date('2026-07-29T09:00:00-03:00'))).toBe(false);
    // 9:10 no es un arranque de la grilla de 30'.
    expect(horarioOfrecido(disp.dias, new Date('2026-07-23T09:10:00-03:00'))).toBe(false);
  });
});
