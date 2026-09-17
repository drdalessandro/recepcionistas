/**
 * Agendas publicadas de los médicos (portal → Consulta médica).
 * Franjas definidas por Andrés: Conrado 2026-07-26, D'Alessandro y Dos Santos
 * 2026-08-13.
 */
import { describe, it, expect } from 'vitest';
import { reconciliarSlots, solapamientosDeAgendas } from '../src/lib/agenda-medicos.js';
import { MEDICOS, MEDICOS_POR_CODIGO, codigoAgenda, codigoConsulta } from '../src/config/medicos.js';
import { getServicio } from '../src/config/catalogo.js';
import { buildScheduleMedico, buildSlotMedico, esScheduleDeMedico, horarioDeAgendaMedico } from '../src/seed/builders.js';
import { generarSlots } from '../src/lib/slots.js';
import { EXT } from '../src/fhir/identifiers.js';
import { HORARIO_SEMANAL } from '../src/config/horario.js';

/** Slots de una semana completa para un médico, como los genera el seed. */
function slotsDeUnaSemana(codigo: string): string[] {
  const m = MEDICOS_POR_CODIGO.get(codigo)!;
  const dur = getServicio(codigoConsulta(codigo)).duracionMin;
  return generarSlots([{ codigo, nombre: m.nombre, tipo: 'CONSULTORIO', capacidad: 1 }], horarioDeAgendaMedico(m), {
    // Lunes 2026-08-17, 7 días: cubre la semana entera.
    desde: new Date('2026-08-17T00:00:00Z'),
    dias: 7,
    granularidadMin: dur,
  }).map((s) => s.inicio);
}

describe('Agenda publicada — franjas declaradas', () => {
  it("D'Alessandro: martes y jueves 16-20, miércoles 8-12 (4 turnos de 60 min cada día)", () => {
    const inicios = slotsDeUnaSemana('MED_DALESSANDRO');
    // Martes 18/08 y jueves 20/08 a la tarde; miércoles 19/08 a la mañana.
    expect(inicios).toContain('2026-08-18T16:00:00-03:00');
    expect(inicios).toContain('2026-08-18T19:00:00-03:00');
    expect(inicios).toContain('2026-08-19T08:00:00-03:00');
    expect(inicios).toContain('2026-08-19T11:00:00-03:00');
    expect(inicios).toContain('2026-08-20T16:00:00-03:00');
    // El último turno TERMINA a las 20:00: no se ofrece uno que se pase.
    expect(inicios).not.toContain('2026-08-18T20:00:00-03:00');
    expect(inicios).not.toContain('2026-08-19T12:00:00-03:00');
    // Nada fuera de sus días.
    expect(inicios.some((i) => i.startsWith('2026-08-17'))).toBe(false); // lunes
    expect(inicios.some((i) => i.startsWith('2026-08-21'))).toBe(false); // viernes
    expect(inicios).toHaveLength(12); // 3 días × 4 turnos
  });

  it('Conrado: viernes 17-20 (3 turnos), ya no el miércoles', () => {
    const inicios = slotsDeUnaSemana('MED_CONRADO');
    expect(inicios).toEqual([
      '2026-08-21T17:00:00-03:00',
      '2026-08-21T18:00:00-03:00',
      '2026-08-21T19:00:00-03:00',
    ]);
    expect(inicios.some((i) => i.startsWith('2026-08-19'))).toBe(false); // miércoles: liberado
  });

  it('Dos Santos: miércoles 17-20 (3 turnos)', () => {
    const inicios = slotsDeUnaSemana('MED_DOS_SANTOS');
    expect(inicios).toEqual([
      '2026-08-19T17:00:00-03:00',
      '2026-08-19T18:00:00-03:00',
      '2026-08-19T19:00:00-03:00',
    ]);
  });

  it('Toda franja publicada cae dentro del horario del centro', () => {
    for (const m of MEDICOS.filter((x) => (x.agenda?.length ?? 0) > 0)) {
      for (const f of m.agenda!) {
        const centro = HORARIO_SEMANAL.find((h) => h.dia === f.dia)!;
        expect(centro.abierto, `${m.nombre}: el centro cierra ese día`).toBe(true);
        const cabe = centro.franjas.some((c) => c.desde <= f.desde && f.hasta <= c.hasta);
        expect(cabe, `${m.nombre} ${f.desde}-${f.hasta} fuera del horario del centro`).toBe(true);
      }
    }
  });
});

describe('solapamientosDeAgendas — un solo consultorio', () => {
  it('Las agendas reales NO se pisan: Conrado pasó a viernes y liberó el miércoles', () => {
    // Andrés, 2026-08-13: Conrado miércoles 17-20 → viernes 17-20, justamente
    // porque chocaba con Dos Santos. Este test es el que lo mantiene resuelto.
    expect(solapamientosDeAgendas(MEDICOS)).toEqual([]);
    expect(MEDICOS_POR_CODIGO.get('MED_CONRADO')!.agenda).toEqual([{ dia: 5, desde: '17:00', hasta: '20:00' }]);
  });

  it('Detecta un cruce cuando lo hay (el caso que había el 13/08)', () => {
    const cruces = solapamientosDeAgendas([
      { codigo: 'A', nombre: 'Dra. X', esDirector: false, precioConsultaARS: 1, agenda: [{ dia: 3, desde: '17:00', hasta: '20:00' }] },
      { codigo: 'B', nombre: 'Dr. Y', esDirector: true, precioConsultaARS: 1, agenda: [{ dia: 3, desde: '17:00', hasta: '20:00' }] },
    ]);
    expect(cruces).toHaveLength(1);
    expect(cruces[0]).toMatchObject({ dia: 3, desde: '17:00', hasta: '20:00' });
    expect(cruces[0]!.detalle).toContain('un solo consultorio');
  });

  it('Cruce parcial: solo se reporta la franja compartida', () => {
    const cruces = solapamientosDeAgendas([
      { codigo: 'A', nombre: 'A', esDirector: false, precioConsultaARS: 1, agenda: [{ dia: 2, desde: '16:00', hasta: '20:00' }] },
      { codigo: 'B', nombre: 'B', esDirector: false, precioConsultaARS: 1, agenda: [{ dia: 2, desde: '19:00', hasta: '22:00' }] },
    ]);
    expect(cruces).toHaveLength(1);
    expect(cruces[0]).toMatchObject({ desde: '19:00', hasta: '20:00' });
  });

  it('Tocarse no es superponerse (una termina cuando la otra empieza)', () => {
    const pegadas = solapamientosDeAgendas([
      { codigo: 'A', nombre: 'A', esDirector: false, precioConsultaARS: 1, agenda: [{ dia: 1, desde: '08:00', hasta: '12:00' }] },
      { codigo: 'B', nombre: 'B', esDirector: false, precioConsultaARS: 1, agenda: [{ dia: 1, desde: '12:00', hasta: '16:00' }] },
    ]);
    expect(pegadas).toEqual([]);
  });

  it('Un médico sin agenda no genera cruces', () => {
    const sinAgenda = solapamientosDeAgendas([
      { codigo: 'A', nombre: 'A', esDirector: false, precioConsultaARS: 1, agenda: [{ dia: 1, desde: '08:00', hasta: '12:00' }] },
      { codigo: 'B', nombre: 'B', esDirector: false, precioConsultaARS: 1 },
    ]);
    expect(sinAgenda).toEqual([]);
  });
});

describe('reconciliarSlots — cambiar una agenda no deja horarios fantasma', () => {
  const desde = new Date('2026-08-17T00:00:00-03:00');
  const hasta = new Date('2026-09-16T00:00:00-03:00');
  // Conrado se movió de miércoles a viernes: lo esperado ahora es el viernes.
  const esperados = ['2026-08-21T17:00:00-03:00', '2026-08-21T18:00:00-03:00'];

  it('Borra los libres que ya no corresponden y conserva los vigentes', () => {
    const r = reconciliarSlots(
      [
        { id: 'viejo1', start: '2026-08-19T17:00:00-03:00', status: 'free' }, // miércoles: sobra
        { id: 'viejo2', start: '2026-08-19T18:00:00-03:00', status: 'free' },
        { id: 'vigente', start: '2026-08-21T17:00:00-03:00', status: 'free' }, // viernes: queda
      ],
      esperados,
      { desde, hasta },
    );
    expect(r.aBorrar).toEqual(['viejo1', 'viejo2']);
    expect(r.ocupadosFuera).toEqual([]);
  });

  it('Un turno RESERVADO fuera de la agenda nueva no se borra: se reporta', () => {
    const r = reconciliarSlots(
      [{ id: 'conPaciente', start: '2026-08-19T17:00:00-03:00', status: 'busy' }],
      esperados,
      { desde, hasta },
    );
    expect(r.aBorrar).toEqual([]);
    expect(r.ocupadosFuera.map((s) => s.id)).toEqual(['conPaciente']);
  });

  it('Compara instantes, no strings: el server devuelve UTC y el generador -03:00', () => {
    const r = reconciliarSlots(
      // Mismo momento que '2026-08-21T17:00:00-03:00', escrito en UTC.
      [{ id: 'mismoMomento', start: '2026-08-21T20:00:00.000Z', status: 'free' }],
      esperados,
      { desde, hasta },
    );
    expect(r.aBorrar).toEqual([]);
  });

  it('Fuera de la ventana regenerada no se toca nada (ni antes ni después)', () => {
    const r = reconciliarSlots(
      [
        { id: 'pasado', start: '2026-08-12T17:00:00-03:00', status: 'free' },
        { id: 'lejano', start: '2026-10-14T17:00:00-03:00', status: 'free' },
      ],
      esperados,
      { desde, hasta },
    );
    expect(r.aBorrar).toEqual([]);
  });
});

/**
 * Agenda de VIDEO separada de la presencial (Andrés, 2026-09-17: el Dr.
 * D'Alessandro atiende teleconsulta cardiológica lunes y viernes de 18 a 20).
 *
 * El campo `agendaTeleconsulta` existía desde el 16-sep con un docstring que
 * prometía justo esto, y **no lo usaba nadie**: las dos modalidades caían en el
 * mismo `Schedule`. Lo que fija esta batería es que ahora sí son dos agendas y,
 * sobre todo, que activarlas no rompe nada de lo que ya estaba publicado.
 */
describe('Agenda de teleconsulta: dos agendas por profesional', () => {
  const dalessandro = MEDICOS_POR_CODIGO.get('MED_DALESSANDRO')!;

  it('Las franjas son lunes y viernes de 18 a 20', () => {
    expect(dalessandro.agendaTeleconsulta).toEqual([
      { dia: 1, desde: '18:00', hasta: '20:00' },
      { dia: 5, desde: '18:00', hasta: '20:00' },
    ]);
  });

  it('`codigoAgenda` manda a Schedules distintos según la modalidad', () => {
    expect(codigoAgenda('MED_DALESSANDRO')).toBe('SCH_MED_DALESSANDRO');
    expect(codigoAgenda('MED_DALESSANDRO', 'presencial')).toBe('SCH_MED_DALESSANDRO');
    expect(codigoAgenda('MED_DALESSANDRO', 'virtual')).toBe('SCH_TELE_MED_DALESSANDRO');
  });

  it('SIN franjas de video, la modalidad NO cambia nada (las dos comparten agenda)', () => {
    // Es lo que hace que activar esto sea seguro: para todos los demás
    // profesionales el comportamiento es byte por byte el de antes.
    expect(MEDICOS_POR_CODIGO.get('MED_CONRADO')?.agendaTeleconsulta).toBeUndefined();
    expect(codigoAgenda('MED_CONRADO', 'virtual')).toBe('SCH_MED_CONRADO');
    expect(codigoAgenda('MED_CONRADO', 'presencial')).toBe('SCH_MED_CONRADO');
  });

  it('El horario de video trae lunes y viernes, y el presencial NO los trae', () => {
    const video = horarioDeAgendaMedico(dalessandro, 'virtual');
    expect(video.filter((d) => d.abierto).map((d) => d.dia)).toEqual([1, 5]);
    const presencial = horarioDeAgendaMedico(dalessandro);
    expect(presencial.filter((d) => d.abierto).map((d) => d.dia)).toEqual([2, 3, 4]);
  });

  it('EL IDENTIFIER DE LOS SLOTS PRESENCIALES NO CAMBIA', () => {
    // El alta de slots es un create condicional POR IDENTIFIER. Si el de la
    // agenda presencial cambiara, la próxima corrida del seed duplicaría cada
    // slot ya publicado en vez de reconocerlo.
    const desc = {
      recursoCodigo: 'MED_DALESSANDRO',
      inicio: '2026-09-22T16:00:00-03:00',
      fin: '2026-09-22T17:00:00-03:00',
      estado: 'free' as const,
    };
    const presencial = buildSlotMedico(dalessandro, desc, 'Schedule/x');
    expect(presencial.identifier?.[0]?.value).toBe('MED_DALESSANDRO|2026-09-22T16:00:00-03:00');

    const video = buildSlotMedico(dalessandro, desc, 'Schedule/y', 'virtual');
    expect(video.identifier?.[0]?.value).toBe('TELE_MED_DALESSANDRO|2026-09-22T16:00:00-03:00');
    // Distintos: si no, un médico que atienda las dos modalidades a la misma
    // hora tendría dos slots peleando por el mismo identifier.
    expect(video.identifier?.[0]?.value).not.toBe(presencial.identifier?.[0]?.value);
  });

  it('`limpiar` NO puede borrar la agenda de video', () => {
    // `esScheduleDeMedico` es lo único que salva a las agendas de médicos de
    // `npm run limpiar -- --apply`: no llevan la extensión `recurso-fisico`, así
    // que sin reconocerlas por identifier las daría por ajenas y las BORRARÍA
    // con todos sus slots. Ya pasó de faltar una vez; con la de video sería otra.
    expect(esScheduleDeMedico(buildScheduleMedico(dalessandro, 'virtual'))).toBe(true);
    expect(esScheduleDeMedico(buildScheduleMedico(dalessandro))).toBe(true);
  });

  it('El viernes de video NO es una superposición de consultorio con el Dr. Conrado', () => {
    // Conrado atiende presencial los viernes 17-20 y ahora D'Alessandro da
    // video los viernes 18-20. No se pisan: una videollamada no ocupa el
    // consultorio. Si `agenda:check` lo reportara, avisaría de un conflicto
    // que no existe y el ruido haría ignorar los que sí.
    expect(MEDICOS_POR_CODIGO.get('MED_CONRADO')?.agenda).toEqual([{ dia: 5, desde: '17:00', hasta: '20:00' }]);
    const viernes = solapamientosDeAgendas(MEDICOS).filter((c) => c.dia === 5);
    expect(viernes).toEqual([]);
  });

  it('LA AGENDA DE VIDEO DECLARA SU MODALIDAD (el portal no puede deducirla del nombre)', () => {
    // Los dos Schedule del mismo profesional tienen el mismo `actor.display`
    // —es la misma persona— así que un selector de médicos lo muestra DOS
    // VECES con el mismo texto. La modalidad va en un campo, con el mismo
    // contrato que la del servicio: `valueCode`, lista cerrada, y solo en la
    // virtual (la ausencia es presencial).
    const video = buildScheduleMedico(dalessandro, 'virtual');
    const ext = video.extension?.find((e) => e.url === EXT.modalidadAtencion);
    expect(ext?.valueCode).toBe('virtual');
    expect(buildScheduleMedico(dalessandro).extension).toBeUndefined();
  });

  it('El seed publica un Schedule por agenda, y se distinguen en el admin', () => {
    const video = buildScheduleMedico(dalessandro, 'virtual');
    expect(video.identifier?.[0]?.value).toBe('SCH_TELE_MED_DALESSANDRO');
    expect(video.identifier?.[1]?.value).toBe('bw-sched-tele-dalessandro');
    expect(video.comment).toContain('Teleconsulta');
    // El presencial queda igual que siempre (mismo identifier, sin comment).
    const presencial = buildScheduleMedico(dalessandro);
    expect(presencial.identifier?.[0]?.value).toBe('SCH_MED_DALESSANDRO');
    expect(presencial.identifier?.[1]?.value).toBe('bw-sched-dalessandro');
    expect(presencial.comment).toBeUndefined();
  });
});
