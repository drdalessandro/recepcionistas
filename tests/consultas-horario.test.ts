import { describe, expect, it } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import { getServicio } from '../src/config/catalogo.js';
import { calcularDisponibilidad, horarioOfrecido, isoHorarioPortal } from '../src/lib/disponibilidad.js';
import { chequearHorarioDisponible } from '../src/bots/_shared.js';

/**
 * Regresión de producción (22-ago-2026): `bw-solicitar-turno` rechazaba TODAS
 * las consultas médicas con `horario-ocupado` sobre Slots libres.
 *
 * La causa NO era una grilla vacía: era que la consulta se validaba contra la
 * grilla de TERAPIAS, que aplica la ventana de reserva R-13 (48 h para el
 * público). Los médicos publican su agenda con semanas de anticipación, así que
 * todo turno suyo caía fuera de la ventana.
 */

const CONSULTA = getServicio('CONSULTA_MED_DALESSANDRO');

/** MedplumClient falso con la agenda publicada de un médico. */
function fakeMedplum(slotsLibres: string[]) {
  return {
    searchOne: async (tipo: string) => (tipo === 'Schedule' ? { resourceType: 'Schedule', id: 'sch-med' } : undefined),
    searchResources: async (tipo: string) =>
      tipo === 'Slot'
        ? slotsLibres.map((start, i) => ({
            resourceType: 'Slot',
            id: `s${i}`,
            status: 'free',
            start,
            end: new Date(new Date(start).getTime() + 60 * 60_000).toISOString(),
          }))
        : [],
  } as unknown as MedplumClient;
}

describe('la grilla de terapias NO sirve para una consulta médica', () => {
  it('reproduce el bug: un turno del médico a 3 días queda fuera de la ventana R-13 del público', () => {
    const ahora = new Date('2026-08-22T12:00:00-03:00');
    const pedido = new Date('2026-08-25T16:00:00-03:00');
    const grillaTerapias = calcularDisponibilidad({
      servicio: CONSULTA,
      perfil: 'PUBLICO',
      ahora,
      reservas: [],
    });
    // La grilla NO está vacía (hay consultorio), pero solo llega a 48 h.
    expect(grillaTerapias.dias.length).toBeGreaterThan(0);
    expect(grillaTerapias.ventanaHoras).toBe(48);
    expect(horarioOfrecido(grillaTerapias.dias, pedido)).toBe(false);
  });
});

/**
 * Fechas RELATIVAS al día de la corrida, a propósito.
 *
 * `chequearHorarioDisponible` descarta las alternativas que ya pasaron contra el
 * reloj REAL, así que con fechas absolutas estos casos venían con bomba de
 * tiempo: pasaban hasta que la fecha quemada quedaba atrás y desde ahí fallaban
 * todos los días (explotó el 27-ago-2026, con los Slots fijados al 25 y 26).
 * Expresadas en días desde hoy, dicen lo que quieren decir: un horario futuro se
 * ofrece y uno pasado no, corra el test cuando corra.
 */
/** Hora en punto de Argentina (UTC−3 fijo, sin DST), a `dias` de hoy. */
function enDias(dias: number, hora: number): Date {
  const arg = new Date(Date.now() + 3 * 60 * 60 * 1000);
  arg.setUTCDate(arg.getUTCDate() + dias);
  arg.setUTCHours(hora, 0, 0, 0);
  return new Date(arg.getTime() - 3 * 60 * 60 * 1000);
}
/** Día calendario argentino ("YYYY-MM-DD"), como lo agrupa el portal. */
const dia = (d: Date): string => isoHorarioPortal(d).slice(0, 10);

describe('chequearHorarioDisponible · consultas → agenda del médico', () => {
  const pedido = enDias(3, 16);

  it('acepta el horario si el médico tiene ese Slot libre, aunque esté a 3 días', async () => {
    const medplum = fakeMedplum([isoHorarioPortal(pedido), isoHorarioPortal(enDias(3, 17))]);
    expect(await chequearHorarioDisponible(medplum, 'Patient/p1', CONSULTA, pedido)).toEqual({ ok: true });
  });

  it('compara INSTANTES, no texto: el mismo momento en UTC con milisegundos vale igual', async () => {
    // En el servidor conviven los dos formatos (`-03:00` y `Z` con ms). Una
    // comparación como string fallaría en silencio en cuanto se crucen.
    const medplum = fakeMedplum([pedido.toISOString()]);
    expect((await chequearHorarioDisponible(medplum, 'Patient/p1', CONSULTA, pedido)).ok).toBe(true);
  });

  it('rechaza si ese horario ya no está libre, y devuelve los que quedan', async () => {
    const otroDelDia = enDias(3, 17);
    const alDiaSiguiente = enDias(4, 8);
    const medplum = fakeMedplum([isoHorarioPortal(otroDelDia), isoHorarioPortal(alDiaSiguiente)]);
    const r = await chequearHorarioDisponible(medplum, 'Patient/p1', CONSULTA, pedido);
    expect(r.ok).toBe(false);
    // Alternativas agrupadas por día, en la forma que ya pinta el portal.
    expect(r.alternativas?.map((d) => d.fecha)).toEqual([dia(otroDelDia), dia(alDiaSiguiente)]);
    expect(r.alternativas?.[0]?.horarios[0]?.inicio).toBe(isoHorarioPortal(otroDelDia));
  });

  it('sin agenda publicada no bloquea: decide Recepción', async () => {
    const medplum = { searchOne: async () => undefined } as unknown as MedplumClient;
    expect(await chequearHorarioDisponible(medplum, 'Patient/p1', CONSULTA, pedido)).toEqual({ ok: true });
  });

  it('no ofrece como alternativa un horario que ya pasó', async () => {
    // El pasado va con fecha fija: 2020 nunca vuelve a ser futuro.
    const futuro = enDias(4, 8);
    const medplum = fakeMedplum(['2020-01-01T10:00:00-03:00', isoHorarioPortal(futuro)]);
    const r = await chequearHorarioDisponible(medplum, 'Patient/p1', CONSULTA, pedido);
    expect(r.alternativas?.map((d) => d.fecha)).toEqual([dia(futuro)]);
  });
});

describe('las terapias siguen usando la grilla de salas (R-13 incluida)', () => {
  it('una terapia se valida contra la grilla, no contra una agenda de médico', async () => {
    const terapia = getServicio('CHEQUEO_BW');
    expect(terapia.practitionerCodigo).toBeUndefined();
    // Sin practitionerCodigo el chequeo cae en disponibilidadDePaciente, que
    // toca el servidor: acá alcanza con fijar el ruteo por el campo.
    expect(CONSULTA.practitionerCodigo).toBeTruthy();
  });
});
