/**
 * Teleconsulta — casos de la lógica pura.
 *
 * El foco está en los bordes de la ventana de acceso y en la forma del token,
 * porque el token es la única barrera entre una consulta médica y cualquiera de
 * internet. Un test que pasa "en el medio" de la ventana no prueba nada.
 */
import { describe, expect, it } from 'vitest';
import {
  TELECONSULTA,
  accesoPermitido,
  avisoDue,
  claimsToken,
  esNombreSala,
  habilitaNoShow,
  minutosDeEspera,
  motivoSinAcceso,
  nombreSala,
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
