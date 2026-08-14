import { describe, it, expect } from 'vitest';
import type { Consent } from '@medplum/fhirtypes';
import { consentimientosARevocar, validarFirmaPresencial } from '../src/lib/ingreso.js';
import { armarDocumentoConsentimiento } from '../src/lib/consentimiento-documento.js';
import { COD_CONSENTIMIENTO, SYSTEM } from '../src/fhir/identifiers.js';
import { consentSections } from '../src/config/consentimiento-texto.js';

const FIRMA = {
  nombre: 'Ana María Pérez',
  dni: '30111222',
  email: 'ana@example.com',
  fechaNacimiento: '1985-03-12',
  timestamp: '2026-08-14T15:00:00.000Z',
  usoDatosAceptado: true,
  canal: 'mostrador' as const,
};

describe('validarFirmaPresencial — qué firma vale', () => {
  it('nombre y DNI válidos => ok', () => {
    expect(validarFirmaPresencial({ pacienteRef: 'Patient/1', nombreFirma: 'Ana Pérez', dni: '30111222' }).ok).toBe(true);
  });

  it('acepta el DNI con puntos, como lo tipea la gente', () => {
    expect(validarFirmaPresencial({ pacienteRef: 'Patient/1', nombreFirma: 'Ana Pérez', dni: '30.111.222' }).ok).toBe(true);
  });

  it('sin paciente, sin nombre o con DNI inválido => no se registra', () => {
    expect(validarFirmaPresencial(undefined).ok).toBe(false);
    expect(validarFirmaPresencial({ nombreFirma: 'Ana', dni: '30111222' }).ok).toBe(false);
    expect(validarFirmaPresencial({ pacienteRef: 'Patient/1', nombreFirma: 'A', dni: '30111222' }).ok).toBe(false);
    expect(validarFirmaPresencial({ pacienteRef: 'Patient/1', nombreFirma: 'Ana Pérez', dni: '123' }).ok).toBe(false);
    expect(validarFirmaPresencial({ pacienteRef: 'Patient/1', nombreFirma: 'Ana Pérez', dni: 'abcdefg' }).ok).toBe(false);
  });
});

describe('armarDocumentoConsentimiento — la evidencia', () => {
  it('incluye identidad, fecha y las ocho secciones del texto legal', () => {
    const doc = armarDocumentoConsentimiento(FIRMA);
    expect(doc).toContain('Ana María Pérez');
    expect(doc).toContain('30111222');
    expect(doc).toContain('2026-08-14T15:00:00.000Z');
    for (const seccion of consentSections) {
      expect(doc).toContain(seccion.heading.toUpperCase());
    }
  });

  it('deja registrado el canal: firmado presencialmente en el centro', () => {
    expect(armarDocumentoConsentimiento(FIRMA)).toContain('presencial en el centro');
    expect(armarDocumentoConsentimiento({ ...FIRMA, canal: 'portal' })).not.toContain('presencial en el centro');
  });

  it('registra la decisión de uso secundario en las dos direcciones', () => {
    expect(armarDocumentoConsentimiento(FIRMA)).toContain('ACEPTA el uso secundario');
    expect(armarDocumentoConsentimiento({ ...FIRMA, usoDatosAceptado: false })).toContain('NO ACEPTA el uso secundario');
  });

  it('deja la versión del texto, para saber QUÉ se firmó sin abrir nada más', () => {
    expect(armarDocumentoConsentimiento(FIRMA)).toMatch(/Texto: v\d+/);
  });

  it('el mismo canal y los mismos datos producen el MISMO documento (es la prueba legal)', () => {
    expect(armarDocumentoConsentimiento(FIRMA)).toBe(armarDocumentoConsentimiento({ ...FIRMA }));
  });
});

describe('consentimientosARevocar — refirma en el mostrador', () => {
  const consent = (id: string, code: string, status: Consent['status'] = 'active'): Consent => ({
    resourceType: 'Consent',
    id,
    status,
    scope: { coding: [{ code: 'treatment' }] },
    category: [],
    patient: { reference: 'Patient/1' },
    policyRule: { coding: [{ system: SYSTEM.consentimiento, code }] },
  });

  it('da de baja el anterior de atención y conserva el nuevo', () => {
    const previos = [consent('viejo', COD_CONSENTIMIENTO.atencion), consent('nuevo', COD_CONSENTIMIENTO.atencion)];
    expect(consentimientosARevocar(previos, 'nuevo').map((c) => c.id)).toEqual(['viejo']);
  });

  it('NO toca el de laboratorio: es otra autorización', () => {
    const previos = [
      consent('lab', COD_CONSENTIMIENTO.procesamientoDatosSalud),
      consent('viejo', COD_CONSENTIMIENTO.atencion),
    ];
    expect(consentimientosARevocar(previos, 'nuevo').map((c) => c.id)).toEqual(['viejo']);
  });

  it('los ya inactivos y los de otro system no se tocan', () => {
    expect(consentimientosARevocar([consent('x', COD_CONSENTIMIENTO.atencion, 'inactive')], 'nuevo')).toEqual([]);
    const ajeno: Consent = {
      ...consent('ajeno', COD_CONSENTIMIENTO.atencion),
      policyRule: { coding: [{ system: 'http://otro.org', code: COD_CONSENTIMIENTO.atencion }] },
    };
    expect(consentimientosARevocar([ajeno], 'nuevo')).toEqual([]);
  });
});
