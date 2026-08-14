import { describe, it, expect } from 'vitest';
import {
  CANDIDATOS_EN_AVISO,
  ESPERA_NOTA_MAX,
  candidatosParaHueco,
  cuandoLargo,
  detalleAvisoHueco,
  fechaCorta,
  finDelDia,
  franjaDe,
  momentoArgentino,
  resumenEspera,
  sirveElHueco,
  textoOfertaHueco,
  tituloAvisoHueco,
  validarEspera,
  vencimientoPorDefecto,
  vigente,
  type EntradaEspera,
  type HuecoLiberado,
} from '../src/lib/lista-espera.js';
import { BUSQUEDA_ESPERAS, appointmentAEspera, esperaAAppointment } from '../src/fhir/lista-espera.js';
import { EXT, SYSTEM } from '../src/fhir/identifiers.js';

/**
 * Lista de espera: el walk-in que quiere venir y no hay lugar.
 *
 * Lo que se prueba acá es lo que decide a quién se le avisa de qué. El aviso
 * equivocado es peor que ninguno: enseña a ignorar los avisos.
 */

// Martes 18/08/2026, 17:00 en Argentina (UTC-3).
const MARTES_17 = new Date('2026-08-18T17:00:00-03:00');
const AHORA = new Date('2026-08-14T10:00:00-03:00');

function espera(over: Partial<EntradaEspera> = {}): EntradaEspera {
  return {
    pacienteRef: 'Patient/p1',
    pacienteNombre: 'Julio D’Alessandro',
    servicioCodigo: 'HBOT_MONO',
    categoria: 'HBOT',
    desde: AHORA,
    hasta: new Date('2026-08-31T23:59:59-03:00'),
    dias: [],
    franjas: [],
    creadaEn: AHORA,
    ...over,
  };
}

function hueco(over: Partial<HuecoLiberado> = {}): HuecoLiberado {
  return {
    inicio: MARTES_17,
    fin: new Date('2026-08-18T18:00:00-03:00'),
    categoria: 'HBOT',
    servicioCodigo: 'HBOT_MONO',
    ...over,
  };
}

describe('franjas y días — en hora de Argentina, no la del servidor', () => {
  it('las 17:00 de Argentina son "tarde" (aunque en UTC ya sean las 20)', () => {
    expect(franjaDe(MARTES_17)).toBe('tarde');
  });

  it('el martes es martes: el día se lee en hora local', () => {
    expect(momentoArgentino(MARTES_17).dia).toBe(2);
  });

  it('las 9 son mañana, las 19 son noche', () => {
    expect(franjaDe(new Date('2026-08-18T09:00:00-03:00'))).toBe('manana');
    expect(franjaDe(new Date('2026-08-18T19:00:00-03:00'))).toBe('noche');
  });

  it('fuera del horario del centro no hay franja (no es "cualquiera")', () => {
    expect(franjaDe(new Date('2026-08-18T06:00:00-03:00'))).toBeUndefined();
    expect(franjaDe(new Date('2026-08-18T23:30:00-03:00'))).toBeUndefined();
  });

  it('las franjas cubren el horario sin superponerse: 12:00 es tarde, no mañana', () => {
    expect(franjaDe(new Date('2026-08-18T12:00:00-03:00'))).toBe('tarde');
    expect(franjaDe(new Date('2026-08-18T11:59:00-03:00'))).toBe('manana');
  });
});

describe('sirveElHueco — a quién le sirve este lugar', () => {
  it('sin preferencias, cualquier horario de su terapia le sirve', () => {
    expect(sirveElHueco(espera(), hueco(), AHORA)).toBe(true);
  });

  it('pidió martes: un jueves no le sirve', () => {
    expect(sirveElHueco(espera({ dias: [2] }), hueco(), AHORA)).toBe(true);
    expect(sirveElHueco(espera({ dias: [4] }), hueco(), AHORA)).toBe(false);
  });

  it('pidió a la mañana: las 17 no le sirven', () => {
    expect(sirveElHueco(espera({ franjas: ['manana'] }), hueco(), AHORA)).toBe(false);
    expect(sirveElHueco(espera({ franjas: ['tarde', 'noche'] }), hueco(), AHORA)).toBe(true);
  });

  it('el match es por TERAPIA, no por el código exacto: espera HBOT_MONO y se libera un biplaza', () => {
    expect(sirveElHueco(espera(), hueco({ servicioCodigo: 'HBOT_BIPLAZA' }), AHORA)).toBe(true);
  });

  it('otra terapia no le sirve aunque el horario sea perfecto', () => {
    expect(sirveElHueco(espera(), hueco({ categoria: 'IHHT' }), AHORA)).toBe(false);
  });

  it('la espera vencida deja de recibir avisos sola', () => {
    const vencida = espera({ hasta: new Date('2026-08-17T23:59:59-03:00') });
    const dentro = hueco({ inicio: new Date('2026-08-17T17:00:00-03:00') });
    expect(vigente(vencida, AHORA)).toBe(true);
    expect(sirveElHueco(vencida, dentro, AHORA)).toBe(true);
    // Pasado el 17, el hueco del martes 18 existe igual y ella ya no está.
    const despues = new Date('2026-08-18T10:00:00-03:00');
    expect(vigente(vencida, despues)).toBe(false);
    expect(sirveElHueco(vencida, hueco(), despues)).toBe(false);
  });

  it('un hueco que ya pasó no se ofrece: para cuando se llame, no existe', () => {
    const tarde = new Date('2026-08-18T17:30:00-03:00');
    expect(sirveElHueco(espera(), hueco(), tarde)).toBe(false);
  });

  it('al que acaba de cancelar NO se le ofrece el turno que canceló', () => {
    expect(sirveElHueco(espera(), hueco({ pacienteRef: 'Patient/p1' }), AHORA)).toBe(false);
    expect(sirveElHueco(espera(), hueco({ pacienteRef: 'Patient/otro' }), AHORA)).toBe(true);
  });

  it('un hueco fuera de la ventana que pidió no le sirve', () => {
    const corta = espera({ hasta: new Date('2026-08-17T23:59:59-03:00') });
    expect(sirveElHueco(corta, hueco(), AHORA)).toBe(false);
  });
});

describe('candidatosParaHueco — a quién se llama primero', () => {
  it('por orden de llegada: el que pidió primero, primero', () => {
    const entradas = [
      espera({ pacienteRef: 'Patient/tarde', creadaEn: new Date('2026-08-14T12:00:00-03:00') }),
      espera({ pacienteRef: 'Patient/temprano', creadaEn: new Date('2026-08-10T09:00:00-03:00') }),
    ];
    expect(candidatosParaHueco(entradas, hueco(), AHORA).map((c) => c.pacienteRef)).toEqual([
      'Patient/temprano',
      'Patient/tarde',
    ]);
  });

  it('descarta a los que no les sirve, no solo los ordena', () => {
    const entradas = [
      espera({ pacienteRef: 'Patient/manana', franjas: ['manana'] }),
      espera({ pacienteRef: 'Patient/tarde', franjas: ['tarde'] }),
      espera({ pacienteRef: 'Patient/ihht', categoria: 'IHHT' }),
    ];
    expect(candidatosParaHueco(entradas, hueco(), AHORA).map((c) => c.pacienteRef)).toEqual(['Patient/tarde']);
  });

  it('el aviso no es un listado: corta en los primeros', () => {
    const entradas = Array.from({ length: 10 }, (_, i) =>
      espera({ pacienteRef: `Patient/p${i}`, creadaEn: new Date(AHORA.getTime() + i * 1000) }),
    );
    expect(candidatosParaHueco(entradas, hueco(), AHORA)).toHaveLength(CANDIDATOS_EN_AVISO);
  });

  it('sin nadie esperando devuelve vacío (y entonces no hay aviso)', () => {
    expect(candidatosParaHueco([], hueco(), AHORA)).toEqual([]);
  });
});

describe('validarEspera — se valida poco, la persona está enfrente', () => {
  it('sin servicio no se puede anotar: no habría de qué avisarle', () => {
    expect(validarEspera({ hasta: new Date() })).toEqual({ ok: false, error: 'Elegí qué está esperando.' });
  });

  it('sin fecha límite tampoco: una espera eterna es una lista que nadie limpia', () => {
    expect(validarEspera({ servicioCodigo: 'HBOT_MONO' }).ok).toBe(false);
  });

  it('con servicio y fecha alcanza (días y franjas son opcionales)', () => {
    expect(validarEspera({ servicioCodigo: 'HBOT_MONO', hasta: new Date('2026-08-31') })).toEqual({ ok: true });
  });

  it('la nota es una nota, no la crónica de la charla', () => {
    const larga = 'x'.repeat(ESPERA_NOTA_MAX + 1);
    expect(validarEspera({ servicioCodigo: 'HBOT_MONO', hasta: new Date('2026-08-31'), nota: larga }).ok).toBe(false);
  });
});

describe('vencimiento — el último día cuenta entero', () => {
  it('"hasta el 30" incluye el 30: vence a las 23:59, no a las 00:00', () => {
    const fin = finDelDia(new Date('2026-08-30T09:00:00-03:00'));
    expect(fin.toISOString()).toBe(new Date('2026-08-30T23:59:59-03:00').toISOString());
    // Un turno del 30 a la tarde todavía entra.
    const e = espera({ hasta: fin });
    expect(sirveElHueco(e, hueco({ inicio: new Date('2026-08-30T18:00:00-03:00') }), AHORA)).toBe(true);
  });

  it('el default son dos semanas', () => {
    expect(fechaCorta(vencimientoPorDefecto(AHORA))).toBe('28/08');
  });
});

describe('textos — lo que se lee y lo que se manda', () => {
  it('el ofrecimiento NO promete que el lugar esté guardado', () => {
    const t = textoOfertaHueco(hueco(), 'Cámara hiperbárica');
    expect(t).toContain('se liberó un lugar');
    expect(t).toContain('martes 18/08 a las 17:00');
    expect(t).toContain('respondé');
    // El lugar no queda tomado hasta que Recepción lo reserva.
    expect(t).not.toMatch(/te lo reservamos ya|quedó reservado|te lo guardamos/i);
  });

  it('el detalle del aviso dice a quién llamar y en qué orden', () => {
    const candidatos = [
      espera({ pacienteNombre: 'Ana', telefono: '+5491169315830' }),
      espera({ pacienteNombre: 'Beto' }),
    ];
    const d = detalleAvisoHueco(hueco(), candidatos, 'Cámara hiperbárica');
    expect(d).toContain('1. Ana · +5491169315830');
    // Que no haya teléfono se dice: si no, alguien busca el número que no está.
    expect(d).toContain('2. Beto · sin teléfono');
  });

  it('el título distingue uno de varios (es lo que se lee en la campanita)', () => {
    expect(tituloAvisoHueco([espera()])).toBe('Se liberó un turno y hay alguien esperándolo');
    expect(tituloAvisoHueco([espera(), espera()])).toContain('hay 2 esperándolo');
  });

  it('el resumen dice qué, cuándo le sirve y hasta cuándo', () => {
    const r = resumenEspera(espera({ dias: [2, 4], franjas: ['tarde'] }), 'Cámara hiperbárica');
    expect(r).toBe('Cámara hiperbárica · Martes · Jueves · tarde · hasta el 31/08');
  });

  it('sin preferencias lo dice: "cualquier día" es información, no un campo vacío', () => {
    expect(resumenEspera(espera(), 'Cámara hiperbárica')).toContain('cualquier día');
  });

  it('cuandoLargo nombra el turno como se lo ofrece por teléfono', () => {
    expect(cuandoLargo(MARTES_17)).toBe('martes 18/08 a las 17:00');
  });
});

describe('FHIR — la espera es un Appointment waitlist (estándar R4)', () => {
  it('ida y vuelta: lo que se guarda es lo que se lee', () => {
    const original = espera({ dias: [2, 4], franjas: ['tarde'], nota: 'Después de las 19 no puede' });
    const leida = appointmentAEspera({ ...esperaAAppointment(original), id: 'a1' });
    expect(leida).toBeDefined();
    expect(leida?.pacienteRef).toBe('Patient/p1');
    expect(leida?.servicioCodigo).toBe('HBOT_MONO');
    expect(leida?.categoria).toBe('HBOT');
    expect(leida?.dias).toEqual([2, 4]);
    expect(leida?.franjas).toEqual(['tarde']);
    expect(leida?.nota).toBe('Después de las 19 no puede');
    expect(leida?.hasta.toISOString()).toBe(original.hasta.toISOString());
  });

  it('NO tiene start: por eso no aparece en la agenda (todo busca por date=ge)', () => {
    const a = esperaAAppointment(espera());
    expect(a.status).toBe('waitlist');
    expect(a.start).toBeUndefined();
    expect(a.requestedPeriod?.[0]?.end).toBeDefined();
  });

  it('la terapia queda en serviceCategory, que es la dimensión del match', () => {
    const a = esperaAAppointment(espera());
    expect(a.serviceCategory?.[0]?.coding?.[0]).toMatchObject({ system: SYSTEM.categoriaServicio, code: 'HBOT' });
    expect(a.serviceType?.[0]?.coding?.[0]).toMatchObject({ system: SYSTEM.servicioCodigo, code: 'HBOT_MONO' });
  });

  it('sin preferencias no escribe extensiones vacías', () => {
    expect(esperaAAppointment(espera()).extension).toEqual([]);
    const conDias = esperaAAppointment(espera({ dias: [1], franjas: ['noche'] }));
    expect(conDias.extension).toContainEqual({ url: EXT.esperaDias, valueString: '1' });
    expect(conDias.extension).toContainEqual({ url: EXT.esperaFranjas, valueString: 'noche' });
  });

  it('un turno normal NO se lee como espera', () => {
    expect(appointmentAEspera({ resourceType: 'Appointment', status: 'booked', participant: [] })).toBeUndefined();
  });

  it('una espera sin ventana o sin paciente se descarta (no se puede ofrecer nada)', () => {
    const sinPeriodo = { ...esperaAAppointment(espera()), requestedPeriod: undefined };
    expect(appointmentAEspera(sinPeriodo)).toBeUndefined();
    const sinPaciente = { ...esperaAAppointment(espera()), participant: [] };
    expect(appointmentAEspera(sinPaciente)).toBeUndefined();
  });

  it('basura en las extensiones no rompe la lectura (se ignora lo que no es un día)', () => {
    const a = esperaAAppointment(espera());
    a.extension = [
      { url: EXT.esperaDias, valueString: '2, 9, x, 4' },
      { url: EXT.esperaFranjas, valueString: 'tarde,siesta' },
    ];
    const leida = appointmentAEspera(a);
    expect(leida?.dias).toEqual([2, 4]);
    expect(leida?.franjas).toEqual(['tarde']);
  });

  it('sin `created` va al final de la cola: la duda no gana lugares', () => {
    const a = { ...esperaAAppointment(espera()), created: undefined };
    const leida = appointmentAEspera(a) as EntradaEspera;
    const conFecha = espera({ pacienteRef: 'Patient/otro', creadaEn: new Date('2026-08-14T23:00:00-03:00') });
    expect(candidatosParaHueco([leida, conFecha], hueco(), AHORA)[0]?.pacienteRef).toBe('Patient/otro');
  });

  it('la búsqueda de esperas es por status, no por un code inventado', () => {
    expect(BUSQUEDA_ESPERAS).toContain('status=waitlist');
  });
});
