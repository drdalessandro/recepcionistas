import { describe, it, expect } from 'vitest';
import { descripcionLead, esLeadAnonimo, fuenteDeLead, nombreDeLead, proximaAccionLead, validarLead } from '../src/lib/lead.js';
import { ORIGENES_LEAD_LABELS } from '../src/fhir/identifiers.js';

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

// Contrato del Provenance del CRM (su respuesta al handoff, 2026-08-14):
// `fuente` es TEXTO PARA MOSTRAR — va como chip en la tarjeta del kanban—, no
// un código. El canal canónico para métricas sigue siendo `origen-lead`.
describe('fuenteDeLead — el chip de la tarjeta del CRM', () => {
  it('walk-in sale exactamente como el ejemplo que nos pasaron', () => {
    expect(fuenteDeLead('walk-in', ORIGENES_LEAD_LABELS)).toBe('Mostrador (walk-in)');
  });

  it('sale del mapa de etiquetas, no de un string suelto que se desincronice', () => {
    for (const [codigo, etiqueta] of Object.entries(ORIGENES_LEAD_LABELS)) {
      expect(fuenteDeLead(codigo, ORIGENES_LEAD_LABELS)).toBe(etiqueta);
    }
  });

  it('un canal sin etiqueta cae al código (nunca undefined con origen presente)', () => {
    expect(fuenteDeLead('canal-nuevo', ORIGENES_LEAD_LABELS)).toBe('canal-nuevo');
  });

  it('sin origen no hay chip: no se escribe un Provenance vacío', () => {
    expect(fuenteDeLead(undefined, ORIGENES_LEAD_LABELS)).toBeUndefined();
  });
});

// La tarjeta del kanban del CRM muestra nombre + chip de fuente + `próxima-acción`
// + responsable, y NO muestra `Task.description`. O sea que este texto es lo
// unico que le dice a quien trabaja el lead a que vino la persona.
describe('proximaAccionLead — lo unico que se ve en la tarjeta', () => {
  it('con telefono, dice que hay que contactarlo y por que', () => {
    const t = proximaAccionLead({ interes: 'Cámara hiperbárica', telefono: '1169315830' });
    expect(t).toContain('Contactar');
    expect(t).toContain('Cámara hiperbárica');
  });

  it('sin telefono NO dice "contactar": no se puede, y prometerlo es peor', () => {
    const t = proximaAccionLead({ interes: 'Cámara hiperbárica' });
    expect(t).not.toContain('Contactar');
    expect(t).toContain('no dejó datos de contacto');
    expect(t).toContain('Cámara hiperbárica');
  });

  it('siempre devuelve algo: una tarjeta sin texto no dice nada', () => {
    expect(proximaAccionLead({}).length).toBeGreaterThan(0);
    expect(proximaAccionLead({ telefono: '1169315830' })).toContain('Contactar');
  });
});

// El acompanante: vino con alguien que se atiende, tiene 40 minutos de espera y
// ya vio el lugar por dentro. El vinculo es su dato de mas valor comercial.
describe('acompañante — el vínculo es lo que abre la conversación', () => {
  it('el vínculo va PRIMERO: "vino con Julio" abre mejor que el servicio', () => {
    const t = proximaAccionLead({ acompanaA: "Julio D'Alessandro", interes: 'IHHT', telefono: '1169315830' });
    expect(t).toContain('Contactar');
    expect(t.indexOf("Julio D'Alessandro")).toBeLessThan(t.indexOf('IHHT'));
  });

  it('sin teléfono tampoco promete contactar, pero conserva el vínculo', () => {
    const t = proximaAccionLead({ acompanaA: "Julio D'Alessandro", interes: 'IHHT' });
    expect(t).not.toContain('Contactar');
    expect(t).toContain("Julio D'Alessandro");
    expect(t).toContain('no dejó datos de contacto');
  });

  it('acompañante sin interés declarado igual dice con quién vino', () => {
    expect(proximaAccionLead({ acompanaA: 'Ana', telefono: '1169315830' })).toContain('Ana');
  });

  it('el vínculo alcanza para registrar: ya es un lead trabajable', () => {
    expect(validarLead({ acompanaA: 'Ana' }).ok).toBe(true);
    // Sin nada sigue sin registrarse.
    expect(validarLead({}).ok).toBe(false);
  });

  it('la descripción deja el vínculo para quien abra el detalle', () => {
    expect(descripcionLead({ acompanaA: 'Ana', interes: 'IHHT' })).toContain('Acompañó a Ana');
  });

  it('sin vínculo, los textos siguen exactamente como antes', () => {
    expect(proximaAccionLead({ interes: 'IHHT', telefono: '1' })).toBe('Contactar — preguntó por IHHT');
    expect(descripcionLead({ interes: 'IHHT' })).toContain('Consulta presencial en el local');
  });
});
