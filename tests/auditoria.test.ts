/**
 * Retención de la auditoría.
 *
 * Lo que se defiende acá es la asimetría: entre guardar de más y borrar
 * evidencia, se guarda de más. Un `AuditEvent` sin fecha se conserva; la
 * escritura que prueba una firma vive diez años; una LECTURA de ese mismo
 * consentimiento, noventa días, porque se generan en cada apertura de ficha.
 */
import { describe, expect, it } from 'vitest';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { AuditEvent } from '@medplum/fhirtypes';
import {
  RETENCION_DIAS,
  RETENCION_FIRMA_DIAS,
  corteDeRetencion,
  decidirPurga,
  direccionDe,
  esEvidenciaDeFirma,
  requestorDe,
  traeNombres,
  veredictoIp,
  type EventoAuditoria,
} from '../src/lib/auditoria.js';
import { handler as purgar } from '../src/bots/purgar-auditoria.js';

const AHORA = new Date('2026-09-21T12:00:00.000Z');
const haceDias = (d: number): string => new Date(AHORA.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

const evento = (over: Partial<EventoAuditoria> = {}): EventoAuditoria => ({
  fechaISO: haceDias(1),
  subtipos: ['search'],
  entidades: ['Appointment/a1'],
  ...over,
});

describe('decidirPurga — los dos plazos', () => {
  it('lo común se borra a los 90 días, no antes', () => {
    expect(decidirPurga(evento({ fechaISO: haceDias(RETENCION_DIAS - 1) }), AHORA)).toBe('conservar');
    expect(decidirPurga(evento({ fechaISO: haceDias(RETENCION_DIAS + 1) }), AHORA)).toBe('purgar');
  });

  it('la ESCRITURA de un consentimiento vive el plazo largo', () => {
    // Es lo que se muestra el día que alguien impugna una firma: quién la
    // creó, cuándo y desde qué IP. Ese día puede caer años después.
    const firma = evento({ subtipos: ['create'], entidades: ['Consent/c1'] });
    expect(decidirPurga({ ...firma, fechaISO: haceDias(RETENCION_DIAS + 1) }, AHORA)).toBe('conservar');
    expect(decidirPurga({ ...firma, fechaISO: haceDias(RETENCION_FIRMA_DIAS + 1) }, AHORA)).toBe('purgar');
    // Y el DocumentReference de la evidencia, igual.
    expect(
      decidirPurga(
        { ...firma, entidades: ['DocumentReference/d1'], fechaISO: haceDias(1000) },
        AHORA,
      ),
    ).toBe('conservar');
  });

  it('LEER un consentimiento no es evidencia de la firma: plazo corto', () => {
    // `bw-estado-consentimiento` lee el consentimiento en cada apertura de
    // ficha y en cada reserva. Guardar diez años de eso cuesta como guardar la
    // evidencia mil veces y no prueba nada sobre quién firmó.
    for (const subtipo of ['read', 'search', 'vread', 'history']) {
      const lectura = evento({ subtipos: [subtipo], entidades: ['Consent/c1'], fechaISO: haceDias(RETENCION_DIAS + 1) });
      expect(esEvidenciaDeFirma(lectura), subtipo).toBe(false);
      expect(decidirPurga(lectura, AHORA), subtipo).toBe('purgar');
    }
  });

  it('una escritura sobre OTRO recurso no hereda el plazo largo', () => {
    const turno = evento({ subtipos: ['update'], entidades: ['Appointment/a1'], fechaISO: haceDias(RETENCION_DIAS + 1) });
    expect(decidirPurga(turno, AHORA)).toBe('purgar');
  });

  it('sin fecha, o con una fecha ilegible, se CONSERVA', () => {
    // Falla cerrado: un evento que no se sabe cuándo pasó no se puede declarar
    // viejo, y entre guardar de más y borrar evidencia, se guarda de más.
    expect(decidirPurga(evento({ fechaISO: undefined }), AHORA)).toBe('conservar');
    expect(decidirPurga(evento({ fechaISO: 'ayer a la tarde' }), AHORA)).toBe('conservar');
  });

  it('los plazos son los decididos, y el corte se calcula hacia atrás', () => {
    expect(RETENCION_DIAS).toBe(90);
    expect(RETENCION_FIRMA_DIAS).toBe(3653); // 10 años
    expect(corteDeRetencion(AHORA, 90)).toBe(haceDias(90));
  });
});

// ---------------------------------------------------------------------------

/** Un servidor de mentira con N eventos, que respeta el filtro y el cursor. */
function servidorCon(eventos: AuditEvent[]): { medplum: MedplumClient; borrados: string[] } {
  const vivos = new Map(eventos.map((a) => [a.id as string, a]));
  const borrados: string[] = [];
  const medplum = {
    searchResources: async (_tipo: string, query: string) => {
      const params = new URLSearchParams(query.replace(/&/g, '&'));
      const lts = query.match(/_lastUpdated=lt([^&]+)/)?.[1];
      const ges = query.match(/_lastUpdated=ge([^&]+)/)?.[1];
      const count = Number(params.get('_count') ?? 20);
      return [...vivos.values()]
        .filter((a) => {
          const f = a.meta?.lastUpdated as string;
          return (!lts || f < decodeURIComponent(lts)) && (!ges || f >= decodeURIComponent(ges));
        })
        .sort((a, b) => (a.meta!.lastUpdated! < b.meta!.lastUpdated! ? -1 : 1))
        .slice(0, count);
    },
    deleteResource: async (_tipo: string, id: string) => {
      vivos.delete(id);
      borrados.push(id);
    },
  } as unknown as MedplumClient;
  return { medplum, borrados };
}

function ae(id: string, dias: number, over: Partial<AuditEvent> = {}): AuditEvent {
  const f = haceDias(dias);
  return {
    resourceType: 'AuditEvent',
    id,
    recorded: f,
    meta: { lastUpdated: f },
    type: { code: 'rest' },
    agent: [],
    source: {},
    subtype: [{ code: 'search' }],
    entity: [{ what: { reference: 'Appointment/a1' } }],
    ...over,
  } as AuditEvent;
}

const correr = (medplum: MedplumClient, input: Record<string, unknown> = {}): ReturnType<typeof purgar> =>
  purgar(medplum, { input: { ahora: AHORA.toISOString(), ...input }, secrets: {} } as unknown as BotEvent<never>);

describe('bw-purgar-auditoria', () => {
  it('borra lo viejo, deja lo nuevo y deja la evidencia de la firma', async () => {
    const firma = ae('firma', 200, { subtype: [{ code: 'create' }], entity: [{ what: { reference: 'Consent/c1' } }] });
    const { medplum, borrados } = servidorCon([ae('viejo1', 100), ae('viejo2', 120), ae('nuevo', 10), firma]);

    const r = await correr(medplum);

    expect(r.ok).toBe(true);
    expect(borrados.sort()).toEqual(['viejo1', 'viejo2']);
    expect(r.borrados).toBe(2);
    expect(r.conservados).toBe(1); // la firma; el nuevo ni se trae
  });

  it('el cursor AVANZA aunque la primera página sea toda de conservados', async () => {
    // Sin cursor, los conservados quedan siempre al frente de la página 1 y la
    // purga no llega nunca a los de atrás: un bucle que reporta éxito sin
    // borrar nada. Acá hay 3 conservados más viejos que los purgables.
    const firmas = [200, 199, 198].map((d, i) =>
      ae(`firma${i}`, d, { subtype: [{ code: 'create' }], entity: [{ what: { reference: 'Consent/c1' } }] }),
    );
    const { medplum, borrados } = servidorCon([...firmas, ae('viejo', 100), ae('viejo2', 95)]);

    const r = await correr(medplum, { porPagina: 3 });

    expect(borrados.sort()).toEqual(['viejo', 'viejo2']);
    expect(r.conservados).toBe(3);
  });

  it('respeta el tope por corrida y avisa que queda trabajo', async () => {
    const { medplum, borrados } = servidorCon([100, 101, 102, 103, 104].map((d, i) => ae(`v${i}`, d)));

    const r = await correr(medplum, { maxBorrados: 2 });

    expect(borrados).toHaveLength(2);
    expect(r.quedaTrabajo).toBe(true);
  });

  it('con dryRun cuenta y no borra nada', async () => {
    // La primera corrida en producción se hace así: ver el volumen antes de
    // borrar por primera vez.
    const { medplum, borrados } = servidorCon([ae('v1', 100), ae('v2', 110)]);

    const r = await correr(medplum, { dryRun: true });

    expect(r.borrados).toBe(2);
    expect(r.dryRun).toBe(true);
    expect(borrados).toHaveLength(0);
  });

  it('si no puede leer los AuditEvent, lo dice en vez de reportar cero', async () => {
    // Sin permiso, devolver `borrados: 0` se lee como "estaba limpio".
    const roto = {
      searchResources: async () => {
        throw new Error('403 Forbidden');
      },
    } as unknown as MedplumClient;

    const r = await correr(roto);

    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain('403');
    expect(r.quedaTrabajo).toBe(true);
  });

  it('un borrado que falla no frena a los demás', async () => {
    const { medplum } = servidorCon([ae('v1', 100), ae('v2', 110)]);
    const original = medplum.deleteResource.bind(medplum) as (t: string, id: string) => Promise<void>;
    let primera = true;
    (medplum as unknown as { deleteResource: unknown }).deleteResource = async (t: string, id: string) => {
      if (primera) {
        primera = false;
        throw new Error('409');
      }
      return original(t, id);
    };

    const r = await correr(medplum);

    expect(r.borrados).toBe(1);
    expect(r.fallidos).toBe(1);
    expect(r.mensaje).toContain('no se pudieron borrar');
  });
});

describe('veredictoIp — la prueba de humo, en una función', () => {
  it('sin eventos: el flag no está activo', () => {
    expect(veredictoIp([])).toBe('sin-eventos');
  });

  it('todas locales: la cadena del proxy está cortada', () => {
    // El caso que justifica el comando. Detrás de nginx, sin confianza en el
    // proxy, TODOS los eventos guardan 127.0.0.1 y la auditoría no sirve.
    expect(veredictoIp(['127.0.0.1', '::1', ' 127.0.0.1 '])).toBe('solo-local');
    expect(veredictoIp(['::ffff:127.0.0.1'])).toBe('solo-local');
  });

  it('basta UNA real: los bots entran por loopback y eso es normal', () => {
    expect(veredictoIp(['127.0.0.1', '181.45.20.7', '127.0.0.1'])).toBe('ok');
  });

  it('eventos sin dirección se distinguen de no tener eventos', () => {
    // Son dos problemas distintos y se arreglan distinto: uno es el flag, el
    // otro es que solo hubo movimiento interno.
    expect(veredictoIp([undefined, undefined])).toBe('sin-direccion');
    expect(veredictoIp(['   '])).toBe('sin-direccion');
  });
});

describe('direccionDe / requestorDe — FHIR permite varios agentes', () => {
  // La forma real de un evento de ejecución de bot, tal como lo devolvió
  // producción el 2026-09-21: primero la PERSONA que lo disparó (sin IP),
  // después el bot.
  const ejecucionDeBot = [
    { nombre: 'Valentina Pereyra', esRequestor: true },
    { nombre: 'bw-estado-seguridad', esRequestor: false },
  ];

  it('la dirección se busca en TODOS los agentes, no solo en el primero', () => {
    // Mirar `agent[0]` es el error fácil: reportaría "(sin dirección)" sobre un
    // evento que sí la tiene, solo porque el orden vino al revés.
    expect(direccionDe([{ nombre: 'app' }, { direccion: '181.104.26.111' }])).toBe('181.104.26.111');
    expect(direccionDe([{ direccion: '  ' }, { direccion: '181.104.26.111' }])).toBe('181.104.26.111');
  });

  it('una ejecución de bot no trae IP en NINGÚN agente', () => {
    // No es una falla del proxy: ese tipo de evento no la lleva. Lo que sí la
    // lleva son las interacciones (read, update, create).
    expect(direccionDe(ejecucionDeBot)).toBeUndefined();
  });

  it('quién lo hizo es el requestor: la persona, no el bot', () => {
    expect(requestorDe(ejecucionDeBot)).toBe('Valentina Pereyra');
    // Aunque venga en segundo lugar.
    expect(requestorDe([...ejecucionDeBot].reverse())).toBe('Valentina Pereyra');
    // Sin requestor marcado, el primero.
    expect(requestorDe([{ nombre: 'bw-recordatorios' }])).toBe('bw-recordatorios');
    expect(requestorDe([])).toBeUndefined();
  });
});

describe('traeNombres — verificar redactAuditEvents', () => {
  it('detecta cualquier nombre propio que haya quedado', () => {
    expect(traeNombres(['Valentina Pereyra'])).toBe(true);
    expect(traeNombres([undefined, 'bw-estado-seguridad', undefined])).toBe(true);
  });

  it('un evento redactado no trae ninguno', () => {
    // Queda la referencia (Practitioner/074875f0…), que es lo que prueba, sin
    // el nombre. El servidor vacía el `display` en los tres lugares.
    expect(traeNombres([undefined, undefined, undefined])).toBe(false);
    expect(traeNombres([])).toBe(false);
    expect(traeNombres(['   '])).toBe(false);
  });
});

describe('redacción: la pregunta la contesta el evento MÁS NUEVO', () => {
  // Del más nuevo al más viejo, como los devuelve `_sort=-_lastUpdated`.
  const conNombre = ['Valentina Pereyra'];
  const redactado = [undefined, undefined];

  it('el conteo solo NO alcanza: los viejos conservan los nombres', () => {
    // Caso real del 2026-09-21: 8 de los últimos 10 traían nombres y aun así
    // el flag había tomado hacía minutos. Mirar el número engaña; mirar el
    // primero, no.
    const pagina = [redactado, redactado, conNombre, conNombre, conNombre];
    expect(pagina.filter(traeNombres)).toHaveLength(3);
    expect(traeNombres(pagina[0] as string[])).toBe(false); // tomó
  });

  it('si el más nuevo TODAVÍA trae nombres, no tomó', () => {
    expect(traeNombres([conNombre, redactado][0] as string[])).toBe(true);
  });

  it('el último con nombres marca cuándo empezó a aplicarse', () => {
    const pagina = [redactado, conNombre, conNombre];
    expect(pagina.findIndex(traeNombres)).toBe(1);
  });
});
