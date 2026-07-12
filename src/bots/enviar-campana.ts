import { BotEvent, MedplumClient, getReferenceString } from '@medplum/core';
import type { Group, Patient, Communication } from '@medplum/fhirtypes';

/**
 * Bot: enviar-campana — envía una campaña a un segmento (Group) del CRM.
 *
 * Recorre los miembros del Group, personaliza el mensaje, lo envía por el canal
 * elegido y deja un Communication por destinatario etiquetado con el id de la
 * campaña (para trackear enviados / aperturas / respuestas después).
 *
 * Input (no es un recurso FHIR):
 *   { groupId, canal: 'email'|'whatsapp', asunto?, cuerpo, campaniaId, from? }
 * El cuerpo admite el placeholder {nombre}.
 *
 * Email: se envía por SES (medplum.sendEmail). WhatsApp: se deja el Communication
 * en 'preparation' para que lo despache el bot enviar-whatsapp / proveedor.
 */
const BIO = 'https://bio.medplum.com.ar/fhir';
const SID_CAMPANIA = `${BIO}/sid/campania`;
const CAT_SYS = `${BIO}/CodeSystem/categoria-comunicacion`;

interface CampanaInput {
  groupId: string;
  canal: 'email' | 'whatsapp';
  asunto?: string;
  cuerpo: string;
  campaniaId: string;
  from?: string;
}

interface CampanaResult {
  ok: boolean;
  campania: string;
  total: number;
  enviados: number;
  sinContacto: number;
  fallidos: number;
  mensaje: string;
}

function contacto(p: Patient, canal: 'email' | 'whatsapp'): string | undefined {
  const sys = canal === 'email' ? 'email' : 'phone';
  return p.telecom?.find((t) => t.system === sys)?.value;
}

export async function handler(medplum: MedplumClient, event: BotEvent<CampanaInput>): Promise<CampanaResult> {
  const input = event.input;
  if (!input?.groupId || !input.cuerpo || !input.campaniaId) {
    return { ok: false, campania: input?.campaniaId ?? '', total: 0, enviados: 0, sinContacto: 0, fallidos: 0,
      mensaje: 'Faltan groupId, cuerpo o campaniaId.' };
  }
  const canal = input.canal ?? 'email';
  const group = await medplum.readResource('Group', input.groupId);
  const miembros = group.member ?? [];

  let enviados = 0, sinContacto = 0, fallidos = 0;

  for (const m of miembros) {
    const ref = m.entity?.reference;
    if (!ref?.startsWith('Patient/')) continue;
    const id = ref.split('/')[1];
    if (!id) { fallidos++; continue; }
    const p = await medplum.readResource('Patient', id).catch(() => undefined);
    if (!p) { fallidos++; continue; }

    const dest = contacto(p, canal);
    const nombre = p.name?.[0]?.given?.[0] ?? p.name?.[0]?.family ?? '';
    const cuerpo = input.cuerpo.replace(/\{nombre\}/g, nombre);

    let status: Communication['status'] = 'preparation';
    if (!dest) {
      sinContacto++;
    } else if (canal === 'email') {
      try {
        await medplum.sendEmail({
          to: dest, subject: input.asunto ?? 'BioWellness', text: cuerpo,
          ...(input.from ? { from: input.from } : {}),
        });
        status = 'completed';
        enviados++;
      } catch (err) {
        console.error('enviar-campana: SES falló:', err instanceof Error ? err.message : err);
        status = 'entered-in-error';
        fallidos++;
      }
    } else {
      // WhatsApp: queda encolado para el proveedor / bot enviar-whatsapp
      status = 'preparation';
      enviados++;
    }

    await medplum.createResource<Communication>({
      resourceType: 'Communication',
      status,
      identifier: [{ system: SID_CAMPANIA, value: input.campaniaId }],
      category: [{ coding: [{ system: CAT_SYS, code: 'campania', display: 'Campaña' }] }],
      medium: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationMode',
                            code: canal === 'email' ? 'EMAILWRIT' : 'WRITTEN', display: canal }] }],
      subject: { reference: getReferenceString(p) },
      recipient: [{ reference: getReferenceString(p) }],
      sent: new Date().toISOString(),
      payload: [{ contentString: cuerpo }],
    });
  }

  return {
    ok: true,
    campania: input.campaniaId,
    total: miembros.length,
    enviados, sinContacto, fallidos,
    mensaje: `Campaña "${input.campaniaId}" a "${group.name}": ${enviados} enviados, ${sinContacto} sin contacto, ${fallidos} fallidos.`,
  };
}
