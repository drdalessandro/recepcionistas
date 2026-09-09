import { describe, expect, it } from 'vitest';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { QuestionnaireResponseItem } from '@medplum/fhirtypes';
import { evaluarScreening } from '../src/lib/screening.js';
import { CUESTIONARIO_INGRESO, SCREENING_RIESGOS, SIN_PREGUNTA_POR_DISENIO } from '../src/config/cuestionario-ingreso.js';
import { CONTRAINDICACIONES, CONTRAINDICACIONES_POR_CODIGO } from '../src/config/contraindicaciones.js';
import { handler as estadoSeguridad } from '../src/bots/estado-seguridad.js';

/**
 * El bug real (2026-08-28): un paciente completó el cuestionario desde el
 * PORTAL con "¿Tenés neumotórax no tratado?" = True y "¿Tenés una infección
 * respiratoria alta aguda?" = True — y el banner de Recepción decía
 * "Sin contraindicaciones — Paciente apto para atención". Nadie, en ningún
 * camino (portal ni kiosco), leía las respuestas: el screening se daba por
 * bueno con solo EXISTIR. Estos tests fijan el eslabón que faltaba.
 */

/** Respuestas del cuestionario con la MISMA anidación que produce QuestionnaireForm. */
function respuestas(porLinkId: Record<string, boolean | string>): QuestionnaireResponseItem[] {
  const grupos = new Map<string, QuestionnaireResponseItem[]>();
  for (const [linkId, valor] of Object.entries(porLinkId)) {
    const grupo = (CUESTIONARIO_INGRESO.item ?? []).find((g) => g.item?.some((i) => i.linkId === linkId))?.linkId ?? '_suelto';
    const arr = grupos.get(grupo) ?? [];
    arr.push({
      linkId,
      answer: [typeof valor === 'boolean' ? { valueBoolean: valor } : { valueString: valor }],
    });
    grupos.set(grupo, arr);
  }
  return [...grupos.entries()].map(([linkId, item]) => (linkId === '_suelto' ? item[0]! : { linkId, item }));
}

describe('evaluarScreening — el contenido importa, no la existencia', () => {
  it('CASO REAL: neumotórax + infección respiratoria en True → dos riesgos, con sus códigos de la tabla', () => {
    const r = evaluarScreening(
      respuestas({ 'hbot-neumotorax': true, 'hbot-infeccion-resp': true, 'hbot-claustrofobia': false }),
    );
    expect(r.declarados).toEqual(['hbot-neumotorax', 'hbot-infeccion-resp']);
    // Las dos bloquean HBOT desde el doc de admisión (2026-09-01).
    expect(r.codigos).toContain('HBOT_NEUMOTORAX_NO_TRATADO');
    expect(r.codigos).toContain('HBOT_INFECCION_VIA_AEREA');
  });

  it('todo en "no": ningún riesgo', () => {
    const todoNo = Object.fromEntries(SCREENING_RIESGOS.map((s) => [s.linkId, false]));
    const r = evaluarScreening(respuestas({ ...todoNo, embarazo: 'No' }));
    expect(r.declarados).toEqual([]);
    expect(r.codigos).toEqual([]);
  });

  it('marcapasos: desde el doc de admisión (2026-09-01) declara riesgo Y bloquea HBOT', () => {
    // Antes quedaba sin código en la tabla y solo pintaba el banner. El
    // documento de admisión le asignó bloqueo y Andrés eligió el criterio más
    // estricto, así que ahora también muerde en la reserva.
    const r = evaluarScreening(respuestas({ 'hbot-marcapasos': true }));
    expect(r.declarados).toEqual(['hbot-marcapasos']);
    expect(r.codigos).toEqual(['HBOT_IMPLANTE_NO_CERTIFICADO']);
  });

  it('ninguna pregunta de riesgo quedó sin código tras el doc de admisión', () => {
    for (const s of SCREENING_RIESGOS) {
      expect(s.codigos.length, `${s.linkId} sin mapear`).toBeGreaterThan(0);
    }
  });

  it('embarazo es un choice: "Sí" cuenta, "No aplica" no', () => {
    expect(evaluarScreening(respuestas({ embarazo: 'Sí' })).codigos).toContain('HBOT_EMBARAZO');
    expect(evaluarScreening(respuestas({ embarazo: 'No aplica' })).declarados).toEqual([]);
  });

  it('acepta variantes de tipo: valueString "True" también es afirmativa', () => {
    const r = evaluarScreening([
      { linkId: 'contraind-hbot', item: [{ linkId: 'hbot-neumotorax', answer: [{ valueString: 'True' }] }] },
    ]);
    expect(r.declarados).toEqual(['hbot-neumotorax']);
  });

  it('sin respuestas / sin items: ningún riesgo (eso lo maneja "sin-screening", no esto)', () => {
    expect(evaluarScreening(undefined).declarados).toEqual([]);
    expect(evaluarScreening([]).declarados).toEqual([]);
  });
});

describe('integridad del mapeo pregunta → tabla validada', () => {
  it('todo código mapeado existe en la tabla de contraindicaciones', () => {
    for (const s of SCREENING_RIESGOS) {
      for (const codigo of s.codigos) {
        expect(CONTRAINDICACIONES_POR_CODIGO.has(codigo), `${s.linkId} → ${codigo}`).toBe(true);
      }
    }
  });

  it('TODA pregunta booleana de los screenings HBOT/IHHT está en el mapeo (si se agrega una, este test avisa)', () => {
    const mapeadas = new Set(SCREENING_RIESGOS.map((s) => s.linkId));
    for (const grupo of ['contraind-hbot', 'contraind-ihht']) {
      const seccion = (CUESTIONARIO_INGRESO.item ?? []).find((g) => g.linkId === grupo);
      for (const pregunta of seccion?.item ?? []) {
        expect(mapeadas.has(pregunta.linkId!), `falta mapear ${pregunta.linkId}`).toBe(true);
      }
    }
  });

  it('todo linkId del mapeo existe en el cuestionario (no hay mapeos fantasma)', () => {
    const enCuestionario = new Set<string>();
    const juntar = (items: typeof CUESTIONARIO_INGRESO.item): void => {
      for (const i of items ?? []) {
        if (i.linkId) {
          enCuestionario.add(i.linkId);
        }
        juntar(i.item);
      }
    };
    juntar(CUESTIONARIO_INGRESO.item);
    for (const s of SCREENING_RIESGOS) {
      expect(enCuestionario.has(s.linkId), `mapeo fantasma: ${s.linkId}`).toBe(true);
    }
  });
});

describe('lo declarado alimenta R-02: la reserva de HBOT del caso real se BLOQUEA', () => {
  it('neumotórax declarado (absoluta) → bloqueo sin autorización médica; con autorización pasa', async () => {
    const { validarContraindicaciones } = await import('../src/lib/reglas-turno.js');
    const codigos = evaluarScreening(respuestas({ 'hbot-neumotorax': true })).codigos;

    const sinAutorizacion = validarContraindicaciones(['HBOT'], codigos, {});
    expect(sinAutorizacion.ok).toBe(false);
    expect(sinAutorizacion.bloqueos.some((b) => b.regla === 'R-02')).toBe(true);

    // La vía de escape existente (autorización médica explícita) sigue valiendo.
    expect(validarContraindicaciones(['HBOT'], codigos, { autorizacionMedica: true }).ok).toBe(true);
  });

  it('infección respiratoria declarada → ADVIERTE en R-02, pero el banner sigue en ROJO', async () => {
    // Historia de esta entrada: relativa en la tabla del Dr. Conrado; el documento
    // de admisión la subió a bloqueo (Andrés, criterio más estricto, 2026-09-01);
    // y el 9-sep-2026 el Dr. D'Alessandro la devolvió a relativa sobre los
    // consensos UHMS —"no suspender sesiones por esto"—.
    //
    // Lo que este test fija es POR QUÉ esa vuelta atrás no desprotege a la
    // paciente: son dos compuertas distintas y la severidad sólo controla una.
    const { validarContraindicaciones } = await import('../src/lib/reglas-turno.js');
    const { estadoSeguridad } = await import('../src/lib/seguridad.js');
    const r = evaluarScreening(respuestas({ 'hbot-infeccion-resp': true }));

    // 1) R-02 (bots de reserva): ya no bloquea, advierte.
    const v = validarContraindicaciones(['HBOT'], r.codigos, {});
    expect(v.ok).toBe(true);
    expect(v.advertencias.some((a) => a.regla === 'R-02')).toBe(true);
    expect(v.bloqueos).toEqual([]);

    // 2) El banner de Atender: NO mira la severidad. Un riesgo declarado lo pinta
    //    de rojo y deja `puedeAvanzar: false` igual. Si esto se rompiera, bajar
    //    una entrada a relativa sí dejaría pasar la sesión sin que nadie la mire.
    expect(
      estadoSeguridad({
        contraindicacionesActivas: [],
        screeningCompleto: true,
        riesgosScreening: r.declarados.length,
      }),
    ).toMatchObject({ color: 'rojo', puedeAvanzar: false });
  });

  it('embarazo declarado → BLOQUEA IHHT y sólo ADVIERTE en HBOT', async () => {
    // Resolución del Director Médico (9-sep-2026): en HBOT el embarazo es relativa
    // —teratógeno cuestionable, y en emergencia por CO se usa—; en IHHT es
    // absoluta porque no hay evidencia de seguridad. Severidades opuestas, así que
    // la entrada se partió en dos y la pregunta mapea a las DOS.
    //
    // Lo que este test protege: si alguien vuelve a juntarlas, o el mapeo pierde
    // uno de los dos códigos, una de las terapias se queda sin su severidad y
    // nadie se entera.
    const { validarContraindicaciones } = await import('../src/lib/reglas-turno.js');
    const codigos = evaluarScreening(respuestas({ embarazo: 'Sí' })).codigos;
    expect(codigos).toContain('HBOT_EMBARAZO');
    expect(codigos).toContain('IHHT_EMBARAZO');

    // IHHT: bloqueo, con la vía de escape de la autorización médica.
    const ihht = validarContraindicaciones(['IHHT'], codigos, {});
    expect(ihht.ok).toBe(false);
    expect(validarContraindicaciones(['IHHT'], codigos, { autorizacionMedica: true }).ok).toBe(true);

    // HBOT: advertencia, no bloqueo.
    const hbot = validarContraindicaciones(['HBOT'], codigos, {});
    expect(hbot.ok).toBe(true);
    expect(hbot.advertencias.some((a) => a.regla === 'R-02')).toBe(true);
  });

  it('el riesgo declarado NO afecta terapias de otra categoría (un masaje sigue pasando)', async () => {
    const { validarContraindicaciones } = await import('../src/lib/reglas-turno.js');
    const codigos = evaluarScreening(respuestas({ 'hbot-neumotorax': true })).codigos;
    const r = validarContraindicaciones(['MASAJE_OSTEOPATIA'], codigos, {});
    expect(r.ok).toBe(true);
    expect(r.advertencias).toEqual([]);
  });
});

describe('bw-estado-seguridad — el caso del bug, punta a punta', () => {
  function fakeMedplum(opts: { itemsQR?: QuestionnaireResponseItem[]; sinQR?: boolean }) {
    return {
      searchResources: async (tipo: string) => {
        if (tipo === 'Flag') {
          return []; // el caso real: cero Flags (nadie los crea desde el screening)
        }
        if (tipo === 'QuestionnaireResponse') {
          return opts.sinQR ? [] : [{ resourceType: 'QuestionnaireResponse', status: 'completed', item: opts.itemsQR }];
        }
        return [];
      },
    } as unknown as MedplumClient;
  }
  const evento = { input: { pacienteRef: 'Patient/p1' }, secrets: {} } as unknown as BotEvent<{ pacienteRef: string }>;

  it('QR del portal con neumotórax=True y CERO Flags → ROJO riesgo-declarado, nunca más "apto"', async () => {
    const r = await estadoSeguridad(fakeMedplum({ itemsQR: respuestas({ 'hbot-neumotorax': true }) }), evento);
    expect(r.estado).toBe('riesgo-declarado');
    expect(r.color).toBe('rojo');
    expect(r.puedeAvanzar).toBe(false);
  });

  it('QR todo en "no" → apto, como siempre', async () => {
    const todoNo = Object.fromEntries(SCREENING_RIESGOS.map((s) => [s.linkId, false]));
    const r = await estadoSeguridad(fakeMedplum({ itemsQR: respuestas(todoNo) }), evento);
    expect(r.estado).toBe('apto');
  });

  it('sin QR → sin-screening (gris), igual que antes', async () => {
    const r = await estadoSeguridad(fakeMedplum({ sinQR: true }), evento);
    expect(r.estado).toBe('sin-screening');
  });
});

describe('ningún código queda sin encender — el invariante que faltaba', () => {
  /**
   * El agujero que motivó esto: una contraindicación sólo muerde si algo la
   * activa. `HBOT_MEDICACION_INCOMPATIBLE` era ABSOLUTA, estaba validada desde el
   * 9-ago-2026 y no tenía pregunta: una paciente en tratamiento con bleomicina
   * reservaba HBOT con el banner en verde. No porque se hubiera evaluado — porque
   * nadie preguntaba. Había cinco así, y nada lo avisaba.
   *
   * Este test cierra esa clase entera de bug: todo código tiene que tener
   * pregunta, o estar en `SIN_PREGUNTA_POR_DISENIO` con el motivo escrito.
   */
  it('cada contraindicación tiene pregunta, o una exención con motivo', () => {
    const conPregunta = new Set(SCREENING_RIESGOS.flatMap((r) => r.codigos));
    const huerfanas = CONTRAINDICACIONES.map((c) => c.codigo)
      .filter((c) => !conPregunta.has(c) && !(c in SIN_PREGUNTA_POR_DISENIO))
      .sort();
    expect(huerfanas).toEqual([]);
  });

  it('la exención no tapa una absoluta: lo que bloquea, se pregunta', () => {
    // Una relativa sin pregunta advierte de menos. Una ABSOLUTA sin pregunta deja
    // pasar una reserva que tenía que frenar: eso no se exime nunca.
    const exentasAbsolutas = Object.keys(SIN_PREGUNTA_POR_DISENIO).filter(
      (c) => CONTRAINDICACIONES_POR_CODIGO.get(c)?.severidad === 'absoluta',
    );
    expect(exentasAbsolutas).toEqual([]);
  });

  it('la exención no acumula códigos muertos', () => {
    // Si una entrada desaparece de la tabla, su exención tiene que irse con ella.
    const inexistentes = Object.keys(SIN_PREGUNTA_POR_DISENIO).filter((c) => !CONTRAINDICACIONES_POR_CODIGO.has(c));
    expect(inexistentes).toEqual([]);
  });

  it('toda pregunta del mapeo existe en el cuestionario y apunta a códigos reales', () => {
    const linkIds = new Set<string>();
    const recorrer = (items: NonNullable<typeof CUESTIONARIO_INGRESO.item>): void => {
      for (const it of items) {
        if (it.linkId) {
          linkIds.add(it.linkId);
        }
        if (it.item) {
          recorrer(it.item);
        }
      }
    };
    recorrer(CUESTIONARIO_INGRESO.item ?? []);

    for (const r of SCREENING_RIESGOS) {
      expect(linkIds, `la pregunta ${r.linkId} no está en el cuestionario`).toContain(r.linkId);
      for (const c of r.codigos) {
        expect(CONTRAINDICACIONES_POR_CODIGO.has(c), `${r.linkId} apunta a ${c}, que no existe`).toBe(true);
      }
    }
  });
});
