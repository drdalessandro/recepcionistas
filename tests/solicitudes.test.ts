import { describe, it, expect } from 'vitest';
import {
  validarSolicitud,
  resumenSolicitud,
  preferenciaLegible,
  mensajeWhatsAppRecepcion,
  indiceSolicitudAResolver,
  solicitudBorrable,
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

/**
 * `limpiar:solicitudes` borra de verdad, así que el criterio de QUÉ se puede
 * borrar es lo único que separa una limpieza de un accidente.
 */
describe('solicitudBorrable — qué se puede borrar y qué no', () => {
  const ahora = new Date('2026-09-18T12:00:00-03:00');
  const haceDias = (d: number): string => new Date(ahora.getTime() - d * 24 * 3600_000).toISOString();

  it('Una resuelta hace 60 días, con el umbral en 30: se borra', () => {
    expect(solicitudBorrable({ status: 'completed', ultimaActividad: haceDias(60) }, { ahora, dias: 30 })).toBe(true);
  });

  it('Una resuelta ayer, con el umbral en 30: NO se borra', () => {
    expect(solicitudBorrable({ status: 'completed', ultimaActividad: haceDias(1) }, { ahora, dias: 30 })).toBe(false);
  });

  it('UNA SOLICITUD EN CURSO NO SE BORRA, por vieja que sea', () => {
    // Es el accidente que hay que evitar: está en la bandeja de Recepción y
    // `disponibilidadDePaciente` le está reservando el horario al paciente.
    // Borrarla es hacerle desaparecer el pedido de abajo de las manos.
    for (const status of ['requested', 'received', 'accepted', 'in-progress']) {
      expect(
        solicitudBorrable({ status, ultimaActividad: haceDias(400) }, { ahora, dias: 30 }),
        `${status} no se puede borrar`,
      ).toBe(false);
    }
  });

  it('Las canceladas sí (las deja bw-fusionar-paciente al absorber una ficha)', () => {
    expect(solicitudBorrable({ status: 'cancelled', ultimaActividad: haceDias(60) }, { ahora, dias: 30 })).toBe(true);
  });

  it('SIN FECHA NO SE BORRA: ante la duda, un script destructivo se abstiene', () => {
    expect(solicitudBorrable({ status: 'completed' }, { ahora, dias: 30 })).toBe(false);
    expect(solicitudBorrable({ status: 'completed', ultimaActividad: 'cualquier cosa' }, { ahora, dias: 30 })).toBe(
      false,
    );
  });

  it('Sin estado tampoco', () => {
    expect(solicitudBorrable({ ultimaActividad: haceDias(400) }, { ahora, dias: 30 })).toBe(false);
  });

  it('Con --dias=0 se borra todo lo cerrado, incluso lo de hoy', () => {
    // Sirve para limpiar datos de prueba. El script avisa fuerte cuando el
    // umbral es corto, pero no lo prohíbe: es una decisión del operador.
    expect(solicitudBorrable({ status: 'completed', ultimaActividad: haceDias(0) }, { ahora, dias: 0 })).toBe(true);
  });
});
