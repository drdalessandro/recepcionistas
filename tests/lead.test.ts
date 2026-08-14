import { describe, it, expect } from 'vitest';
import { descripcionLead, esLeadAnonimo, nombreDeLead, validarLead } from '../src/lib/lead.js';

// Caso 1 del walk-in: alguien pasa, entra, pregunta y se va. Hoy no deja rastro,
// así que el local —el canal más caro— es el único que no se puede medir. El
// registro tiene que funcionar aunque no deje nada: importa el evento.

const AHORA = new Date('2026-08-14T15:30:00-03:00');

describe('nombreDeLead — el curioso puede no dejar su nombre', () => {
  it('si lo dejó, se usa el suyo', () => {
    expect(nombreDeLead({ nombre: '  Ana Pérez  ' }, AHORA)).toBe('Ana Pérez');
  });

  it('sin nombre, una etiqueta descriptiva con la fecha (NUNCA un nombre inventado)', () => {
    const n = nombreDeLead({}, AHORA);
    // En el kanban del CRM, dos tarjetas sin nombre son indistinguibles.
    expect(n).toContain('Consulta en el mostrador');
    expect(n).toMatch(/14\/08/);
    expect(n).toMatch(/15:30/);
  });

  it('dos consultas anónimas en distinto momento se distinguen', () => {
    const otra = new Date('2026-08-14T17:45:00-03:00');
    expect(nombreDeLead({}, AHORA)).not.toBe(nombreDeLead({}, otra));
  });
});

describe('esLeadAnonimo', () => {
  it('reconoce el lead sin identidad y no confunde a uno con nombre', () => {
    expect(esLeadAnonimo(nombreDeLead({}, AHORA))).toBe(true);
    expect(esLeadAnonimo(nombreDeLead({ nombre: 'Ana Pérez' }, AHORA))).toBe(false);
    expect(esLeadAnonimo(undefined)).toBe(false);
  });
});

describe('descripcionLead — lo que ve el CRM en la tarjeta', () => {
  it('dice de dónde salió y qué preguntó', () => {
    const d = descripcionLead({ interes: 'Cámara hiperbárica', telefono: '1169315830' });
    expect(d).toContain('presencial en el local');
    expect(d).toContain('Cámara hiperbárica');
  });

  it('avisa cuando NO se lo puede contactar (para no trabajarlo como accionable)', () => {
    expect(descripcionLead({ interes: 'Precios' })).toContain('no se le puede escribir');
    expect(descripcionLead({ interes: 'Precios', telefono: '1169315830' })).not.toContain('no se le puede escribir');
  });
});

describe('validarLead — de un clic, sin fricción', () => {
  it('alcanza con cualquiera de los tres datos', () => {
    expect(validarLead({ interes: 'HBOT' }).ok).toBe(true);
    expect(validarLead({ telefono: '1169315830' }).ok).toBe(true);
    expect(validarLead({ nombre: 'Ana' }).ok).toBe(true);
  });

  it('solo se rechaza el vacío absoluto, que no sirve ni para medir', () => {
    expect(validarLead({}).ok).toBe(false);
    expect(validarLead({ nombre: '  ', interes: '' }).ok).toBe(false);
  });
});
