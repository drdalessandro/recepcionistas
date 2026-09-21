/**
 * Traza de la firma del consentimiento (handoff del portal, 2026-09-21).
 *
 * Dos cosas distintas, con la misma pregunta detrás: si mañana alguien impugna
 * una firma, ¿qué podemos mostrar?
 *
 *  1. De DÓNDE sale la fecha que se muestra y con la que se valida R-03. Desde
 *     que el portal saca `Consent.dateTime` del servidor y deja
 *     `DocumentReference.date` con el reloj del dispositivo, tener las dos
 *     filas hacía ganar al reloj del celular.
 *  2. Que la firma del MOSTRADOR deje la misma evidencia que la del portal:
 *     hash e instante del servidor. Es la premisa del encabezado del bot.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Consent, DocumentReference, Resource } from '@medplum/fhirtypes';
import { COD_CONSENTIMIENTO, COD_LOINC_CONSENTIMIENTO, LOINC_CONSENTIMIENTO, SYSTEM } from '../src/fhir/identifiers.js';
import { estadoConsentimiento } from '../src/lib/consentimiento.js';
import { leerRegistrosConsentimiento } from '../src/bots/_shared.js';
import { handler as ingreso } from '../src/bots/ingreso-presencial.js';

const PACIENTE = 'Patient/p1';
/** El servidor guardó la firma a las 15:00. */
const DEL_SERVIDOR = '2026-09-21T15:00:00.000Z';
/** El celular del paciente está 3 horas adelantado. */
const DEL_CELULAR = '2026-09-21T18:00:00.000Z';

function consent(over: Partial<Consent> = {}): Consent {
  return {
    resourceType: 'Consent',
    id: 'c1',
    status: 'active',
    scope: {},
    category: [],
    dateTime: DEL_SERVIDOR,
    policyRule: { coding: [{ system: SYSTEM.consentimiento, code: COD_CONSENTIMIENTO.atencion }] },
    ...over,
  };
}

function documento(over: Partial<DocumentReference> = {}): DocumentReference {
  return {
    resourceType: 'DocumentReference',
    id: 'd1',
    status: 'current',
    content: [],
    date: DEL_CELULAR,
    ...over,
  };
}

/** Un Medplum que solo sabe devolver los Consent y DocumentReference dados. */
function medplumCon(opts: { consents?: Consent[]; docs?: DocumentReference[] }): MedplumClient {
  return {
    searchResources: async (tipo: string) => (tipo === 'Consent' ? (opts.consents ?? []) : (opts.docs ?? [])),
  } as unknown as MedplumClient;
}

describe('leerRegistrosConsentimiento · el Consent manda sobre el documento', () => {
  it('con Consent de atención, la fecha es la del SERVIDOR aunque el documento diga una mayor', async () => {
    // El caso que motivó el handoff: `estadoConsentimiento` se queda con la
    // fecha mayor, así que un celular adelantado le ponía su hora al badge de
    // Atender y el arreglo del portal se perdía en la pantalla.
    const registros = await leerRegistrosConsentimiento(
      medplumCon({ consents: [consent()], docs: [documento()] }),
      PACIENTE,
    );

    expect(registros).toHaveLength(1);
    expect(estadoConsentimiento(registros, { codigo: COD_CONSENTIMIENTO.atencion })).toEqual({
      estado: 'firmado',
      fechaISO: DEL_SERVIDOR,
    });
  });

  it('sin ningún Consent, el documento sigue contando: las firmas viejas no se pierden', async () => {
    // Es para lo que se agregó la fila del DocumentReference: las firmas
    // anteriores a que el portal creara el Consent.
    const registros = await leerRegistrosConsentimiento(medplumCon({ docs: [documento()] }), PACIENTE);

    expect(estadoConsentimiento(registros, { codigo: COD_CONSENTIMIENTO.atencion })).toEqual({
      estado: 'firmado',
      fechaISO: DEL_CELULAR,
    });
  });

  it('un Consent de OTRO código no tapa la firma de atención vieja', async () => {
    // El handoff proponía descartar los documentos cuando hubiera cualquier
    // Consent (`registros.length === 0`). Con eso, un paciente con consent de
    // terapia biológica y su firma de atención solo como documento pasaba a
    // "no registrado" y R-20 le bloqueaba las reservas.
    const registros = await leerRegistrosConsentimiento(
      medplumCon({
        consents: [
          consent({
            id: 'c-tb',
            policyRule: { coding: [{ system: SYSTEM.consentimiento, code: COD_CONSENTIMIENTO.terapiaBiologica }] },
          }),
        ],
        docs: [documento()],
      }),
      PACIENTE,
    );

    expect(estadoConsentimiento(registros, { codigo: COD_CONSENTIMIENTO.atencion }).estado).toBe('firmado');
    expect(estadoConsentimiento(registros, { codigo: COD_CONSENTIMIENTO.terapiaBiologica }).estado).toBe('firmado');
  });

  it('un Consent REVOCADO no revive por el documento que quedó `current`', async () => {
    // La revocación toca el Consent y no el DocumentReference (`ingreso-presencial`
    // solo actualiza Consent). Antes, la fila del documento seguía diciendo
    // "firmado" sobre un consentimiento dado de baja.
    const registros = await leerRegistrosConsentimiento(
      medplumCon({ consents: [consent({ status: 'inactive' })], docs: [documento()] }),
      PACIENTE,
    );

    expect(estadoConsentimiento(registros, { codigo: COD_CONSENTIMIENTO.atencion }).estado).toBe('no-registrado');
  });

  it('si la lectura falla, sigue siendo no-verificable: nunca "no firmó"', async () => {
    const roto = {
      searchResources: async () => {
        throw new Error('403');
      },
    } as unknown as MedplumClient;

    expect(await leerRegistrosConsentimiento(roto, PACIENTE)).toBeUndefined();
    expect(estadoConsentimiento(undefined).estado).toBe('no-verificable');
  });
});

describe('bw-ingreso-presencial · la firma del mostrador deja la misma evidencia', () => {
  const META_DOC = '2026-09-21T15:00:00.123Z';

  /** Guarda lo que se crea y le pone `meta.lastUpdated`, como hace el servidor. */
  function medplumKiosco(): { medplum: MedplumClient; creados: Resource[] } {
    const creados: Resource[] = [];
    const medplum = {
      readResource: async (tipo: string, id: string) => ({
        resourceType: tipo,
        id,
        birthDate: '1985-03-12',
        name: [{ given: ['Ana'], family: 'Pérez' }],
      }),
      searchResources: async () => [],
      createResource: async (r: Resource) => {
        const creado = { ...r, id: `id-${creados.length + 1}`, meta: { lastUpdated: META_DOC } } as Resource;
        creados.push(creado);
        return creado;
      },
      updateResource: async (r: Resource) => r,
    } as unknown as MedplumClient;
    return { medplum, creados };
  }

  async function firmar(): Promise<Resource[]> {
    const { medplum, creados } = medplumKiosco();
    const r = await ingreso(medplum, {
      input: { pacienteRef: PACIENTE, nombreFirma: 'Ana María Pérez', dni: '30111222', usoDatosAceptado: true },
      secrets: {},
    } as unknown as BotEvent<never>);
    expect(r.ok).toBe(true);
    return creados;
  }

  it('el adjunto lleva size y hash, y describen el MISMO texto', async () => {
    // Sin esto, una firma del mostrador no se podía comprobar: la integridad
    // siempre daba "sin-hash" y las dos firmas no eran comparables.
    const doc = (await firmar()).find((r): r is DocumentReference => r.resourceType === 'DocumentReference');
    const adjunto = doc?.content?.[0]?.attachment;
    expect(adjunto?.data).toBeTruthy();

    const bytes = Buffer.from(adjunto!.data as string, 'base64');
    expect(adjunto?.size).toBe(bytes.byteLength);
    expect(adjunto?.hash).toBe(createHash('sha1').update(bytes).digest('base64'));
    // Y el texto es el que el paciente leyó: su nombre y su DNI están adentro.
    const texto = bytes.toString('utf-8');
    expect(texto).toContain('Ana María Pérez');
    expect(texto).toContain('30111222');
  });

  it('el instante jurídico del Consent sale del servidor, no del reloj del bot', async () => {
    const creados = await firmar();
    const doc = creados.find((r): r is DocumentReference => r.resourceType === 'DocumentReference');
    const consentCreado = creados.find((r): r is Consent => r.resourceType === 'Consent');

    expect(consentCreado?.dateTime).toBe(META_DOC);
    expect(consentCreado?.dateTime).toBe(doc?.meta?.lastUpdated);
    // El documento, en cambio, conserva la hora que quedó IMPRESA en el texto
    // que se firmó: tiene que coincidir con lo que el paciente vio.
    expect(doc?.date).not.toBe(META_DOC);
    expect(doc?.content?.[0]?.attachment?.creation).toBe(doc?.date);
    const texto = Buffer.from(doc!.content![0]!.attachment!.data as string, 'base64').toString('utf-8');
    expect(texto).toContain(doc!.date as string);
  });

  it('el documento entra por el mismo LOINC que el del portal', async () => {
    // Es lo que hace que el bot de la señal y el banner de Atender lo
    // reconozcan sin ramas por canal.
    const doc = (await firmar()).find((r): r is DocumentReference => r.resourceType === 'DocumentReference');
    const coding = doc?.type?.coding?.[0];
    expect(coding?.system).toBe(LOINC_CONSENTIMIENTO);
    expect(coding?.code).toBe(COD_LOINC_CONSENTIMIENTO);
  });
});
