import { describe, expect, it } from 'vitest';
import {
  SIN_BORRADOR,
  limpiarBorrador,
  promptBorrador,
  systemBorrador,
  textoContexto,
  textoHilo,
  type MensajeHilo,
} from '../src/lib/borrador.js';

describe('system prompt del borrador', () => {
  const sys = systemBorrador();

  it('trae los datos reales del centro, para que el modelo no los invente', () => {
    expect(sys).toContain('Roque Sáenz Peña 530');
    expect(sys).toContain('lunes a viernes de 08:00 a 22:00');
    expect(sys).toContain('info.biowellness.ar');
  });

  it('prohíbe explícitamente lo clínico y los precios inventados', () => {
    expect(sys).toMatch(/NO des indicaciones médicas/);
    expect(sys).toMatch(/NO inventes precios/);
  });

  it('trae las reglas del negocio que la recepcionista sí puede afirmar', () => {
    expect(sys).toContain('seña del 50%');
    expect(sys).toContain('2 h'); // SENA.vencimientoHoras
    expect(sys).toContain('24 h'); // R-14
  });

  it('define la salida de escape para lo que tiene que contestar una persona', () => {
    expect(sys).toContain(SIN_BORRADOR);
  });
});

describe('contexto del paciente', () => {
  it('dice explícitamente lo que NO tiene, para que el modelo no lo asuma', () => {
    const t = textoContexto({ nombre: 'Ana' });
    expect(t).toContain('Paciente: Ana');
    expect(t).toContain('no tiene ninguno agendado');
    expect(t).toContain('Plan activo: ninguno');
  });

  it('resume turno, plan, saldo y bloqueo', () => {
    const t = textoContexto({
      nombre: 'Ana',
      proximoTurno: 'el jueves, 03/09 15:00 · HBOT',
      plan: { nombre: 'membresia-plus', sesionesRestantes: 3 },
      saldoARS: 45000,
      bloqueadoPorPago: true,
    });
    expect(t).toContain('el jueves, 03/09 15:00 · HBOT');
    expect(t).toContain('le quedan 3 sesiones');
    expect(t).toContain('$45.000');
    expect(t).toContain('bloqueado para reservar');
  });

  it('marca el consentimiento solo cuando falta (es lo accionable)', () => {
    expect(textoContexto({ consentimientoFirmado: false })).toContain('NO firmado');
    expect(textoContexto({ consentimientoFirmado: true })).not.toContain('Consentimiento');
  });

  it('un número sin ficha se declara como tal', () => {
    expect(textoContexto({})).toContain('no registrado');
  });
});

describe('transcripción del hilo', () => {
  it('distingue quién habló, incluido el sistema', () => {
    const mensajes: MensajeHilo[] = [
      { de: 'paciente', texto: 'hola' },
      { de: 'recepcion', texto: 'Recibimos tu mensaje 👋', automatico: true },
      { de: 'recepcion', texto: '¿En qué te ayudamos?' },
      { de: 'paciente', texto: 'quiero cambiar mi turno' },
    ];
    const t = textoHilo(mensajes);
    expect(t).toContain('PACIENTE: hola');
    expect(t).toContain('SISTEMA (automático): Recibimos tu mensaje 👋');
    expect(t).toContain('RECEPCIÓN: ¿En qué te ayudamos?');
  });

  it('el prompt junta contexto y conversación', () => {
    const p = promptBorrador({ nombre: 'Ana' }, [{ de: 'paciente', texto: 'hola' }]);
    expect(p).toContain('Contexto del paciente');
    expect(p).toContain('Conversación');
    expect(p).toContain('PACIENTE: hola');
  });
});

describe('limpieza de lo que devuelve el modelo', () => {
  it('devuelve el texto tal cual cuando es un borrador normal', () => {
    expect(limpiarBorrador('¡Hola Ana! Te esperamos el jueves.').borrador).toBe('¡Hola Ana! Te esperamos el jueves.');
  });

  it('reconoce cuando el modelo deriva a una persona', () => {
    const r = limpiarBorrador(`${SIN_BORRADOR}: consulta clínica`);
    expect(r.borrador).toBeUndefined();
    expect(r.motivo).toBe('consulta clínica');
  });

  it('sin motivo, igual explica por qué no hay borrador', () => {
    expect(limpiarBorrador(SIN_BORRADOR).motivo).toBeTruthy();
  });

  it('saca las comillas con las que algunos modelos envuelven la respuesta', () => {
    expect(limpiarBorrador('"¡Hola Ana!"').borrador).toBe('¡Hola Ana!');
    expect(limpiarBorrador('«¡Hola Ana!»').borrador).toBe('¡Hola Ana!');
  });

  it('corta un borrador desmedido: en WhatsApp, un texto larguísimo se manda sin leer', () => {
    const largo = 'a'.repeat(1200);
    const r = limpiarBorrador(largo, 900);
    expect(r.borrador?.length).toBeLessThanOrEqual(901);
    expect(r.borrador?.endsWith('…')).toBe(true);
  });

  it('una respuesta vacía no es un borrador vacío: es un motivo', () => {
    expect(limpiarBorrador('').motivo).toBeTruthy();
    expect(limpiarBorrador(undefined).borrador).toBeUndefined();
  });
});
