/**
 * Bot · Ingreso presencial (kiosco del mostrador).
 *
 * Resuelve el callejón sin salida del walk-in: hasta ahora el consentimiento y el
 * cuestionario de ingreso solo existían en el portal, y al portal se entra por
 * invitación **con email** (`bw-invitar-paciente`). Quien cruzaba la puerta sin
 * email —o sin smartphone— no tenía forma de firmar, y desde R-20 eso significa
 * que no se le puede reservar nada.
 *
 * Cómo funciona: Recepción le presta la tablet al paciente, en una pantalla de
 * kiosco. **Contesta y firma el paciente**, no la recepcionista. Al enviar, este
 * bot escribe con identidad de proyecto:
 *
 *   - `DocumentReference` — la EVIDENCIA: el texto exacto que leyó y firmó.
 *   - `Consent` — el HECHO jurídico, enlazado a la evidencia por `sourceReference`.
 *   - `QuestionnaireResponse` — el screening de contraindicaciones.
 *
 * Por qué un bot y no que escriba la app: la AccessPolicy de Recepción no incluye
 * `Consent`, `DocumentReference` ni `QuestionnaireResponse` — ni debe, sería
 * abrirle la historia clínica entera (CLAUDE.md, principio 3). El bot escribe lo
 * justo y Recepción sigue viendo solo la señal binaria del banner.
 *
 * La firma es el **nombre tipeado** por el paciente, la misma evidencia que el
 * portal (decisión 2026-08-14): una sola clase de documento por los dos caminos.
 * El documento lo arma la lógica pura compartida, así que sale idéntico.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { createReference } from '@medplum/core';
import { createHash } from 'node:crypto';
import type { Consent, DocumentReference, Patient, QuestionnaireResponse, QuestionnaireResponseItem } from '@medplum/fhirtypes';
import {
  COD_CONSENTIMIENTO,
  COD_LOINC_CONSENTIMIENTO,
  INTAKE_QUESTIONNAIRE_URL,
  LOINC_CONSENTIMIENTO,
  SYSTEM,
} from '../fhir/identifiers.js';
import { VERSION_CONSENTIMIENTO } from '../config/consentimiento-texto.js';
import { armarDocumentoConsentimiento } from '../lib/consentimiento-documento.js';
import { consentimientosARevocar, validarFirmaPresencial } from '../lib/ingreso.js';

export interface EntradaIngresoPresencial {
  /** "Patient/<id>". */
  pacienteRef: string;
  /** Nombre completo tipeado por el paciente (su firma electrónica). */
  nombreFirma: string;
  /** DNI tipeado por el paciente. */
  dni: string;
  /** Opcional: si lo deja, se guarda en la ficha (habilita el portal más adelante). */
  email?: string;
  /** Opt-in de uso secundario de datos (Ley 25.326). Separado y revocable. */
  usoDatosAceptado?: boolean;
  /** Respuestas del cuestionario de ingreso, tal como las arma QuestionnaireForm. */
  respuestasScreening?: QuestionnaireResponseItem[];
}

export interface ResultadoIngresoPresencial {
  ok: boolean;
  consentId?: string;
  documentReferenceId?: string;
  questionnaireResponseId?: string;
  mensaje?: string;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaIngresoPresencial>,
): Promise<ResultadoIngresoPresencial> {
  const e = event.input;
  const v = validarFirmaPresencial(e);
  if (!v.ok) {
    return { ok: false, mensaje: v.error };
  }

  let paciente: Patient;
  try {
    paciente = await medplum.readResource('Patient', e.pacienteRef.split('/')[1] as string);
  } catch {
    return { ok: false, mensaje: 'No se encontró la ficha del paciente.' };
  }

  const timestamp = new Date().toISOString();
  const email = e.email?.trim() || paciente.telecom?.find((t) => t.system === 'email')?.value || '—';
  const texto = armarDocumentoConsentimiento({
    nombre: e.nombreFirma.trim(),
    dni: e.dni.trim(),
    email,
    fechaNacimiento: paciente.birthDate ?? '—',
    timestamp,
    usoDatosAceptado: e.usoDatosAceptado === true,
    canal: 'mostrador',
  });
  // Los bytes exactos que se firman, una sola vez: de acá salen `data`, `size`
  // y `hash`, y los tres tienen que describir lo MISMO o la comprobación de
  // integridad no prueba nada.
  const bytes = Buffer.from(texto, 'utf-8');

  // 1) La evidencia. Mismo tipo LOINC que el portal: el bot de la señal y el
  //    banner de Atender lo reconocen sin cambios.
  const doc = await medplum.createResource<DocumentReference>({
    resourceType: 'DocumentReference',
    status: 'current',
    docStatus: 'final',
    type: {
      coding: [{ system: LOINC_CONSENTIMIENTO, code: COD_LOINC_CONSENTIMIENTO, display: 'Patient Consent' }],
      text: 'Consentimiento Informado BIOWELLNESS',
    },
    category: [{ text: 'Consentimiento Informado' }],
    subject: createReference(paciente),
    author: [createReference(paciente)],
    date: timestamp,
    description: `Consentimiento Informado firmado por ${e.nombreFirma.trim()} (DNI ${e.dni.trim()}) — presencial en el centro`,
    content: [
      {
        attachment: {
          contentType: 'text/plain; charset=utf-8',
          title: 'Consentimiento Informado BIOWELLNESS.txt',
          data: bytes.toString('base64'),
          // Integridad del adjunto, igual que el portal (handoff 2026-09-21).
          // SHA-1 en base64 porque es lo que FHIR R4 define para este campo —
          // no es una elección criptográfica nuestra.
          //
          // Prueba integridad, no autoría: quien pueda escribir el documento
          // puede reescribir `data`, `size` y `hash` a juego. Lo que no puede
          // tocar es el historial, así que la comprobación que vale es contra
          // la VERSIÓN 1 (`/_history`), que tiene el hash del momento de firmar.
          size: bytes.byteLength,
          hash: createHash('sha1').update(bytes).digest('base64'),
          creation: timestamp,
        },
      },
    ],
  });

  // 2) El hecho jurídico, enlazado a su evidencia.
  const consent = await medplum.createResource<Consent>({
    resourceType: 'Consent',
    status: 'active',
    scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'treatment' }] },
    category: [{ coding: [{ system: LOINC_CONSENTIMIENTO, code: COD_LOINC_CONSENTIMIENTO, display: 'Patient Consent' }] }],
    patient: createReference(paciente),
    // El instante JURÍDICO sale del servidor —el `meta.lastUpdated` que Medplum
    // le puso a la versión 1 de la evidencia—, no del reloj del runtime del
    // bot. Acá el riesgo era chico (el bot corre en un servidor, no en el
    // teléfono de nadie), pero sin esto las dos firmas no eran comparables
    // campo a campo, que es la premisa del encabezado de este bot. Mismo
    // criterio que el portal (handoff 2026-09-21).
    //
    // `date` y `attachment.creation` del documento SIGUEN con `timestamp` a
    // propósito: es la hora que quedó impresa dentro del texto que el paciente
    // leyó y firmó, y tienen que coincidir con él.
    dateTime: doc.meta?.lastUpdated ?? timestamp,
    performer: [createReference(paciente)],
    sourceReference: createReference(doc),
    policyRule: {
      coding: [
        {
          system: SYSTEM.consentimiento,
          code: COD_CONSENTIMIENTO.atencion,
          display: 'Consentimiento general de atención',
        },
      ],
      text: `Consentimiento Informado BIOWELLNESS (texto ${VERSION_CONSENTIMIENTO}) — firmado en el mostrador`,
    },
    provision: { type: 'permit' },
  });

  // Refirma: los de atención anteriores quedan inactive, DESPUÉS de crear el
  // nuevo (nunca una ventana sin consentimiento activo) y sin tocar los de
  // laboratorio. Best-effort: la firma ya vale con el documento.
  try {
    const previos = await medplum.searchResources('Consent', `patient=${e.pacienteRef}&status=active&_count=50`);
    for (const previo of consentimientosARevocar(previos, consent.id)) {
      await medplum.updateResource<Consent>({ ...previo, status: 'inactive' });
    }
  } catch {
    // queda más de uno activo; el más reciente es el que manda igual
  }

  // 3) El screening. Solo si vino: el consentimiento y el cuestionario son dos
  //    pasos y el paciente puede completar el segundo más tarde.
  let questionnaireResponseId: string | undefined;
  if (e.respuestasScreening?.length) {
    const qr = await medplum.createResource<QuestionnaireResponse>({
      resourceType: 'QuestionnaireResponse',
      status: 'completed',
      questionnaire: INTAKE_QUESTIONNAIRE_URL,
      subject: createReference(paciente),
      // `source` = quién declara. Es el PACIENTE: contestó él en la tablet, no
      // la recepcionista. Si algún día alguien transcribe, esto tiene que cambiar.
      source: createReference(paciente),
      authored: timestamp,
      item: e.respuestasScreening,
    });
    questionnaireResponseId = qr.id;
  }

  // El email es opcional, pero si lo dejó conviene guardarlo: habilita invitarlo
  // al portal después sin volver a pedírselo. Best-effort.
  if (e.email?.trim() && !paciente.telecom?.some((t) => t.system === 'email' && t.value === e.email?.trim())) {
    try {
      await medplum.updateResource<Patient>({
        ...paciente,
        telecom: [...(paciente.telecom ?? []), { system: 'email', value: e.email.trim() }],
      });
    } catch {
      // la firma ya quedó registrada; el email se puede cargar a mano
    }
  }

  return {
    ok: true,
    consentId: consent.id,
    documentReferenceId: doc.id,
    questionnaireResponseId,
  };
}
