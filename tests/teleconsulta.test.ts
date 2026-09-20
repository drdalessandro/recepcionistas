/**
 * Teleconsulta — casos de la lógica pura.
 *
 * El foco está en los bordes de la ventana de acceso y en la forma del token,
 * porque el token es la única barrera entre una consulta médica y cualquiera de
 * internet. Un test que pasa "en el medio" de la ventana no prueba nada.
 */
import { describe, expect, it } from 'vitest';
import type { Appointment } from '@medplum/fhirtypes';
import { modalidadAppointmentType, modalidadDeTurno } from '../src/fhir/appointment.js';
import { FRACCION_SENA, avisoTurnoReservado, calcularSenaARS, fraccionAnticipada } from '../src/lib/pricing.js';
import { SERVICIOS } from '../src/config/catalogo.js';
import { RECURSOS } from '../src/config/recursos.js';
import {
  TELECONSULTA,
  accesoPermitido,
  avisoDue,
  claimsToken,
  dominioJitsi,
  emailRecordatorioTeleconsulta,
  esNombreSala,
  habilitaNoShow,
  minutosDeEspera,
  motivoSinAcceso,
  nombreSala,
  rutaTeleconsulta,
  ventanaAcceso,
} from '../src/lib/teleconsulta.js';

const UUID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const INICIO = new Date('2026-09-20T17:00:00.000Z');
const FIN = new Date('2026-09-20T18:00:00.000Z');
const min = (n: number): number => n * 60_000;

describe('nombre de sala', () => {
  it('lleva el prefijo y el uuid, y nada del paciente', () => {
    const sala = nombreSala(UUID);
    expect(sala).toBe(`tc-${UUID}`);
    expect(esNombreSala(sala)).toBe(true);
  });

  it('rechaza cualquier cosa que no sea un uuid prefijado', () => {
    expect(esNombreSala('tc-ana-perez')).toBe(false);
    expect(esNombreSala(UUID)).toBe(false); // sin prefijo
    expect(esNombreSala(undefined)).toBe(false);
    expect(esNombreSala('')).toBe(false);
  });
});

describe('ventana de acceso', () => {
  it('abre 15 minutos antes y cierra 60 después del fin', () => {
    const v = ventanaAcceso(INICIO, FIN);
    expect(v.desde.toISOString()).toBe('2026-09-20T16:45:00.000Z');
    expect(v.hasta.toISOString()).toBe('2026-09-20T19:00:00.000Z');
  });

  it('los bordes exactos entran', () => {
    const v = ventanaAcceso(INICIO, FIN);
    expect(accesoPermitido(INICIO, FIN, v.desde)).toBe(true);
    expect(accesoPermitido(INICIO, FIN, v.hasta)).toBe(true);
  });

  it('un minuto antes de abrir y uno después de cerrar, no', () => {
    const v = ventanaAcceso(INICIO, FIN);
    expect(accesoPermitido(INICIO, FIN, new Date(v.desde.getTime() - min(1)))).toBe(false);
    expect(accesoPermitido(INICIO, FIN, new Date(v.hasta.getTime() + min(1)))).toBe(false);
  });

  it('distingue "todavía no" de "ya terminó"', () => {
    const antes = motivoSinAcceso(INICIO, FIN, new Date(INICIO.getTime() - min(60)));
    const despues = motivoSinAcceso(INICIO, FIN, new Date(FIN.getTime() + min(120)));
    expect(antes).toMatch(/todavía no es la hora/i);
    expect(despues).toMatch(/ya terminó/i);
    expect(antes).not.toBe(despues);
  });

  it('dentro de la ventana no hay motivo', () => {
    expect(motivoSinAcceso(INICIO, FIN, INICIO)).toBeUndefined();
  });
});

describe('claims del token', () => {
  const base = {
    appId: 'biowellness-teleconsulta',
    dominio: 'meet.biowellness.ar',
    sala: nombreSala(UUID),
    inicio: INICIO,
    fin: FIN,
  };

  it('el profesional entra como owner y el paciente como member', () => {
    const prof = claimsToken({ ...base, nombre: 'Dra. Dos Santos', rol: 'profesional' });
    const pac = claimsToken({ ...base, nombre: 'Ana', rol: 'paciente' });
    expect(prof.context.user.affiliation).toBe('owner');
    expect(pac.context.user.affiliation).toBe('member');
  });

  it('acota el token a UNA sala, nunca al comodín', () => {
    const t = claimsToken({ ...base, nombre: 'Ana', rol: 'paciente' });
    expect(t.room).toBe(`tc-${UUID}`);
    expect(t.room).not.toBe('*');
  });

  it('la vigencia sale de la ventana del turno, no de un plazo fijo', () => {
    const t = claimsToken({ ...base, nombre: 'Ana', rol: 'paciente' });
    const v = ventanaAcceso(INICIO, FIN);
    expect(t.nbf).toBe(Math.floor(v.desde.getTime() / 1000));
    expect(t.exp).toBe(Math.floor(v.hasta.getTime() / 1000));
    expect(t.exp).toBeGreaterThan(t.nbf);
  });

  it('no filtra nada más que el nombre visible', () => {
    const t = claimsToken({ ...base, nombre: 'Ana', rol: 'paciente' });
    const plano = JSON.stringify(t);
    expect(Object.keys(t.context.user)).toEqual(['name', 'affiliation']);
    expect(plano).not.toMatch(/dni|documento|email|@|Patient\//i);
  });

  it('el emisor y el dominio son los que espera Prosody', () => {
    const t = claimsToken({ ...base, nombre: 'Ana', rol: 'paciente' });
    expect(t.iss).toBe('biowellness-teleconsulta');
    expect(t.aud).toBe('jitsi');
    expect(t.sub).toBe('meet.biowellness.ar');
  });
});

describe('avisos a Recepción', () => {
  const solo = { pacienteEnLinea: true, profesionalEnLinea: false };
  const vacia = { pacienteEnLinea: false, profesionalEnLinea: false };
  const ambos = { pacienteEnLinea: true, profesionalEnLinea: true };

  it('antes de la hora no avisa nada', () => {
    expect(avisoDue(INICIO, solo, new Date(INICIO.getTime() - min(1)))).toBeUndefined();
  });

  it('paciente esperando solo pasados 5 minutos → profesional ausente', () => {
    expect(avisoDue(INICIO, solo, new Date(INICIO.getTime() + min(4)))).toBeUndefined();
    expect(avisoDue(INICIO, solo, new Date(INICIO.getTime() + min(5)))).toBe('profesional-ausente');
  });

  it('nadie del lado del paciente pasados 10 minutos → paciente ausente', () => {
    expect(avisoDue(INICIO, vacia, new Date(INICIO.getTime() + min(9)))).toBeUndefined();
    expect(avisoDue(INICIO, vacia, new Date(INICIO.getTime() + min(10)))).toBe('paciente-ausente');
  });

  it('con los dos adentro no hay nada que avisar', () => {
    expect(avisoDue(INICIO, ambos, new Date(INICIO.getTime() + min(30)))).toBeUndefined();
  });
});

describe('no-show', () => {
  it('habilita recién a los 15 minutos y solo si el paciente no está', () => {
    const sinPaciente = { pacienteEnLinea: false, profesionalEnLinea: true };
    expect(habilitaNoShow(INICIO, sinPaciente, new Date(INICIO.getTime() + min(14)))).toBe(false);
    expect(habilitaNoShow(INICIO, sinPaciente, new Date(INICIO.getTime() + min(15)))).toBe(true);
  });

  it('si el paciente entró, nunca habilita, por más tarde que sea', () => {
    const conPaciente = { pacienteEnLinea: true, profesionalEnLinea: false };
    expect(habilitaNoShow(INICIO, conPaciente, new Date(INICIO.getTime() + min(120)))).toBe(false);
  });
});

describe('minutos de espera', () => {
  it('cuenta desde que entró mientras el profesional no está', () => {
    const entro = new Date(INICIO.getTime() - min(3));
    expect(minutosDeEspera(entro, false, new Date(INICIO.getTime() + min(4)))).toBe(7);
  });

  it('con el profesional adentro, o sin haber entrado, es cero', () => {
    expect(minutosDeEspera(new Date(INICIO), true, new Date(INICIO.getTime() + min(9)))).toBe(0);
    expect(minutosDeEspera(undefined, false, new Date(INICIO.getTime() + min(9)))).toBe(0);
  });
});

describe('parámetros', () => {
  it('la grilla virtual es de 60 minutos (Andrés, 2026-09-16)', () => {
    expect(TELECONSULTA.slotMin).toBe(60);
  });
});

describe('El turno virtual: modalidad, cobro y ruta del portal', () => {
  it('modalidadDeTurno: la ausencia de appointmentType es PRESENCIAL', () => {
    // Los miles de turnos anteriores a la teleconsulta no tienen el campo, y
    // leerlos como virtuales les cambiaría retroactivamente el cobro.
    expect(modalidadDeTurno({ resourceType: 'Appointment', status: 'booked', participant: [] })).toBe('presencial');
    expect(
      modalidadDeTurno({
        resourceType: 'Appointment',
        status: 'booked',
        participant: [],
        appointmentType: { coding: [{ system: 'https://otro.ar/sistema', code: 'virtual' }] },
      }),
    ).toBe('presencial');
  });

  it('modalidadDeTurno lee lo que escribe modalidadAppointmentType (ida y vuelta)', () => {
    for (const modalidad of ['presencial', 'virtual'] as const) {
      const appt: Appointment = {
        resourceType: 'Appointment',
        status: 'booked',
        participant: [],
        appointmentType: modalidadAppointmentType(modalidad),
      };
      expect(modalidadDeTurno(appt)).toBe(modalidad);
    }
  });

  it('La teleconsulta se cobra ENTERA por adelantado; la presencial, la seña', () => {
    expect(fraccionAnticipada('virtual')).toBe(1);
    expect(fraccionAnticipada('presencial')).toBe(FRACCION_SENA);
    // Sin modalidad (todo el catálogo v9) se comporta como siempre.
    expect(fraccionAnticipada(undefined)).toBe(FRACCION_SENA);
  });

  it('Cobrada entera, una teleconsulta no deja saldo', () => {
    const items = [{ tipo: 'servicio' as const, codigo: 'TELECONSULTA_MED_DALESSANDRO' }];
    const { totalARS, senaARS } = calcularSenaARS(items, { fraccion: fraccionAnticipada('virtual') });
    expect(senaARS).toBe(totalARS);
    expect(totalARS - senaARS).toBe(0);
    // Y es el precio de lista, no la mitad: 150.000 (Andrés, 2026-09-16).
    expect(totalARS).toBe(150_000);
  });

  it('El cartel del mostrador NO le dice "seña" a un turno virtual', () => {
    // Visto en producción el 2026-09-20: la plata salía bien (el 100 %) y el
    // cartel de "Turno reservado ✓" decía "Tentativo hasta cobrar la seña del
    // 50 %". La recepcionista le repite al paciente lo que dice la pantalla,
    // así que prometía un saldo que nadie iba a cobrar.
    const virtual = avisoTurnoReservado('virtual');
    expect(virtual).not.toMatch(/seña/i);
    expect(virtual).toMatch(/100 %/);
    expect(virtual).toMatch(/no queda saldo/);
    // Y no le dice "sala" a una videollamada: no hay consultorio que ocupar.
    expect(virtual).not.toMatch(/sala/i);
  });

  it('El presencial sigue diciendo lo de siempre: seña del 50 % y sala ocupada', () => {
    for (const modalidad of ['presencial', undefined] as const) {
      const texto = avisoTurnoReservado(modalidad);
      expect(texto).toMatch(/seña del 50 %/);
      expect(texto).toMatch(/La sala queda ocupada/);
    }
  });

  it('Con plan no se cobra nada, y el lugar se nombra según la modalidad', () => {
    // Confirmado por el plan: la sesión ya está paga, así que no se menciona
    // ni seña ni pago por adelantado en ninguna de las dos modalidades.
    const conPlan = avisoTurnoReservado('virtual', 3);
    expect(conPlan).toContain('Quedan 3 sesiones');
    expect(conPlan).not.toMatch(/seña|adelantado/i);
    expect(conPlan).toMatch(/El horario queda tomado/);
    expect(avisoTurnoReservado('presencial', 3)).toMatch(/La sala queda ocupada/);
    // 0 sesiones restantes es un número, no "sin plan": si esto se rompe, el
    // turno que gastó la última sesión vuelve a pedir seña.
    expect(avisoTurnoReservado('presencial', 0)).toContain('Quedan 0 sesiones');
    expect(avisoTurnoReservado('presencial', 0)).not.toMatch(/seña/i);
  });

  it('rutaTeleconsulta es la ruta que confirmó el portal', () => {
    expect(rutaTeleconsulta('abc-123')).toBe('/teleconsulta/abc-123');
  });
});

describe('dominioJitsi — el secret con nombre engañoso', () => {
  it('El host pelado pasa igual', () => {
    expect(dominioJitsi('meet.biowellness.ar')).toBe('meet.biowellness.ar');
  });

  it('Acepta la URL completa, que es lo que invita a escribir el nombre del secret', () => {
    // Con el esquema adelante, el claim `sub` no matchea el VirtualHost de
    // Prosody y el token se rechaza: el error aparece lejos de la causa.
    for (const v of [
      'https://meet.biowellness.ar',
      'http://meet.biowellness.ar',
      'https://meet.biowellness.ar/',
      '  https://meet.biowellness.ar//  ',
    ]) {
      expect(dominioJitsi(v)).toBe('meet.biowellness.ar');
    }
  });

  it('El dominio normalizado es el que viaja en el token', () => {
    const claims = claimsToken({
      appId: 'biowellness-teleconsulta',
      dominio: dominioJitsi('https://meet.biowellness.ar/'),
      sala: nombreSala(UUID),
      nombre: 'Ana',
      rol: 'paciente',
      inicio: INICIO,
      fin: FIN,
    });
    expect(claims.sub).toBe('meet.biowellness.ar');
  });
});

describe('El email del recordatorio de la videollamada', () => {
  const mail = emailRecordatorioTeleconsulta({
    hora: '15:00',
    servicio: 'Teleconsulta de Cardiología — Dr. Alejandro Sergio D\'Alessandro',
    link: 'https://app.biowellness.ar/teleconsulta/abc-123',
  });

  it('EL ASUNTO NO DICE LA ESPECIALIDAD', () => {
    // Un asunto se lee en la pantalla bloqueada y por encima del hombro; el
    // cuerpo hay que abrirlo. "Cardiología" ahí le cuenta algo de la salud del
    // paciente a cualquiera que mire su teléfono.
    expect(mail.asunto).not.toMatch(/cardiolog|endocrinolog|nutrici/i);
    expect(mail.asunto).toContain('15:00');
  });

  it('El cuerpo sí, y sobre todo lleva el link', () => {
    expect(mail.cuerpo).toContain('https://app.biowellness.ar/teleconsulta/abc-123');
    expect(mail.cuerpo).toContain('Cardiología');
  });

  it('Dice desde cuándo se puede entrar, con el número de la regla', () => {
    expect(mail.cuerpo).toContain(`${TELECONSULTA.accesoAntesMin} minutos antes`);
  });

  it('Invita a responder: es el mail que más se responde y llega 2 h antes', () => {
    expect(mail.cuerpo).toMatch(/respond[eé]/i);
  });
});

describe('El servicio virtual se tiene que poder ENCONTRAR en el mostrador', () => {
  const virtual = SERVICIOS.filter((s) => s.modalidad === 'virtual');

  it('Hay servicios virtuales publicados', () => {
    expect(virtual.length).toBeGreaterThan(0);
  });

  it('EL NOMBRE EMPIEZA CON "Teleconsulta"', () => {
    // El buscador del modal de reserva filtra por este texto. Con "Cardiología
    // por videollamada", la recepcionista que tipeaba "teleconsulta" —la palabra
    // que usa todo el mundo, y la del código del servicio— no encontraba nada y
    // el botón de reservar quedaba gris sin explicar por qué.
    for (const s of virtual) {
      expect(s.nombre.toLowerCase()).toMatch(/^teleconsulta/);
    }
  });

  it('…y trae la especialidad y el profesional, que es lo otro que se busca', () => {
    const cardio = virtual.find((s) => s.codigo === 'TELECONSULTA_MED_DALESSANDRO');
    expect(cardio?.nombre).toContain('Cardiología');
    expect(cardio?.nombre).toContain("D'Alessandro");
  });

  it('La sala virtual no es una sesión grupal: su capacidad no son ocupantes', () => {
    // El modal leía la capacidad 50 como "personas por reserva" y ofrecía armar
    // una teleconsulta de 50. Acá queda fijado que el recurso es de tipo VIRTUAL,
    // que es por lo que el modal lo saltea.
    const sala = RECURSOS.find((r) => r.codigo === 'R_TELECONSULTA');
    expect(sala?.tipo).toBe('VIRTUAL');
    expect(sala?.capacidad).toBeGreaterThan(1);
  });
});
