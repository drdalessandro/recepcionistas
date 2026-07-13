import { describe, it, expect } from 'vitest';
import {
  validarSolicitud,
  resumenSolicitud,
  preferenciaLegible,
  mensajeWhatsAppRecepcion,
  indiceSolicitudAResolver,
  type SolicitudTurno,
} from '../src/lib/solicitudes.js';

const base: SolicitudTurno = { pacienteRef: 'Patient/123', terapia: 'Cámara hiperbárica (HBOT)' };

describe('Solicitudes de turno — validación', () => {
  it('OK con paciente y terapia', () => {
    expect(validarSolicitud(base)).toEqual({ ok: true });
  });

  it('Rechaza sin paciente o ref inválida', () => {
    expect(validarSolicitud({ ...base, pacienteRef: '' }).ok).toBe(false);
    expect(validarSolicitud({ ...base, pacienteRef: '123' }).ok).toBe(false);
  });

  it('Rechaza sin terapia', () => {
    expect(validarSolicitud({ ...base, terapia: '   ' }).ok).toBe(false);
  });

  it('Rechaza fecha preferida inválida', () => {
    expect(validarSolicitud({ ...base, preferenciaInicio: 'no-es-fecha' }).ok).toBe(false);
  });

  it('Rechaza texto demasiado largo', () => {
    expect(validarSolicitud({ ...base, nota: 'x'.repeat(501) }).ok).toBe(false);
  });
});

describe('Solicitudes de turno — textos', () => {
  it('preferenciaLegible prioriza la fecha elegida sobre el texto', () => {
    const conFecha = preferenciaLegible({ ...base, preferenciaInicio: '2026-07-02T18:00:00-03:00', preferenciaTexto: 'cuando sea' });
    expect(conFecha).toMatch(/18:00/);
    expect(preferenciaLegible({ ...base, preferenciaTexto: 'jueves a la tarde' })).toBe('jueves a la tarde');
    expect(preferenciaLegible(base)).toBeUndefined();
  });

  it('resumenSolicitud arma el detalle para Recepción', () => {
    const r = resumenSolicitud({ ...base, preferenciaTexto: 'jueves a la tarde', nota: 'vengo con un amigo' });
    expect(r).toContain('Cámara hiperbárica (HBOT)');
    expect(r).toContain('jueves a la tarde');
    expect(r).toContain('vengo con un amigo');
  });

  it('mensajeWhatsAppRecepcion incluye el nombre y la terapia', () => {
    const m = mensajeWhatsAppRecepcion({ ...base, preferenciaTexto: 'mañana' }, 'Juan Pérez');
    expect(m).toContain('Juan Pérez');
    expect(m).toContain('Cámara hiperbárica (HBOT)');
    expect(m).toContain('mañana');
  });
});

describe('indiceSolicitudAResolver (auto-resolver al reservar)', () => {
  it('Una sola pendiente => esa, coincida o no la terapia', () => {
    expect(indiceSolicitudAResolver([{ terapiaCodigo: 'IHHT' }], ['HBOT_MONO', 'HBOT'])).toBe(0);
    expect(indiceSolicitudAResolver([{}], ['HBOT_MONO', 'HBOT'])).toBe(0);
  });

  it('Varias => la primera que coincide por código de servicio o categoría', () => {
    const pendientes = [{ terapiaCodigo: 'IHHT' }, { terapiaCodigo: 'HBOT' }, { terapiaCodigo: 'HBOT' }];
    expect(indiceSolicitudAResolver(pendientes, ['HBOT_MONO', 'HBOT'])).toBe(1);
  });

  it('Varias sin coincidencia => ninguna (se resuelve a mano, no cerramos de más)', () => {
    const pendientes = [{ terapiaCodigo: 'IHHT' }, { terapiaCodigo: 'CRIO' }];
    expect(indiceSolicitudAResolver(pendientes, ['HBOT_MONO', 'HBOT'])).toBe(-1);
    expect(indiceSolicitudAResolver([], ['HBOT'])).toBe(-1);
  });
});
