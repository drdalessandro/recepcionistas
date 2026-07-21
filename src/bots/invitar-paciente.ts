/**
 * Bot · Invitar paciente al portal.
 *
 * Le da acceso de login al paciente (para ver SUS turnos/plan/pagos) reutilizando
 * el invite de Medplum con `sendEmail:false`, y entrega el link mágico
 * (`/setpassword/{id}/{secret}`) por el canal elegido:
 *   - whatsapp → Twilio;     - email → mail BioWellness (SES);     - qr → devuelve
 *     el link para que el front lo muestre como QR en el mostrador.
 *
 * Reusa el `Patient` existente (`upsert:true` → no duplica). Requiere que el bot
 * tenga **admin del proyecto** (el invite es un endpoint de administración).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Bundle, Patient, ProjectMembership, UserSecurityRequest } from '@medplum/fhirtypes';
import { EXT } from '../fhir/identifiers.js';
import { NOMBRE_POLICY_PACIENTE } from '../fhir/access-policies.js';
import {
  esCanalValido,
  linkSetPassword,
  mensajeInvitacion,
  partirNombre,
  validarEmail,
  type CanalInvitacion,
} from '../lib/onboarding.js';
import { enviarEmail, enviarWhatsApp, resolverProjectId } from './_shared.js';

export interface EntradaInvitarPaciente {
  pacienteRef: string; // "Patient/123"
  canal: CanalInvitacion;
  /** Email para el login (si no se pasa, se toma del Patient.telecom). */
  email?: string;
}

export interface ResultadoInvitarPaciente {
  ok: boolean;
  mensaje?: string;
  canal?: CanalInvitacion;
  membershipId?: string;
  /** Link de activación (para QR / copiar). Es sensible: sólo para uso de recepción. */
  link?: string;
  /** true si el link se entregó por WhatsApp/email. */
  enviado?: boolean;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaInvitarPaciente>,
): Promise<ResultadoInvitarPaciente> {
  const e = event.input;
  try {
    if (!esCanalValido(e.canal)) {
      return { ok: false, mensaje: 'Canal de invitación inválido (whatsapp / email / qr).' };
    }

    const patient = await medplum.readResource('Patient', e.pacienteRef.split('/')[1]!);
    const email = (e.email ?? patient.telecom?.find((t) => t.system === 'email')?.value)?.trim();
    if (!validarEmail(email)) {
      return { ok: false, mensaje: 'El paciente necesita un email válido para acceder al portal.' };
    }

    const display = patient.name?.[0]?.text ?? '';
    const given = patient.name?.[0]?.given?.join(' ');
    const family = patient.name?.[0]?.family;
    const { firstName, lastName } =
      given || family ? { firstName: given ?? '', lastName: family ?? '' } : partirNombre(display);

    // Registrar el canal elegido en el Patient (auditoría) + asegurar el email.
    const extension = [...(patient.extension ?? [])].filter((x) => x.url !== EXT.canalInvitacion);
    extension.push({ url: EXT.canalInvitacion, valueCode: e.canal });
    const telecom = [...(patient.telecom ?? [])];
    if (!telecom.some((t) => t.system === 'email' && t.value === email)) {
      telecom.push({ system: 'email', value: email });
    }
    await medplum.updateResource<Patient>({ ...patient, telecom, extension });

    // AccessPolicy del portal (mínimo privilegio: sólo lo suyo).
    const policy = await medplum.searchOne('AccessPolicy', `name=${encodeURIComponent(NOMBRE_POLICY_PACIENTE)}`);
    if (!policy?.id) {
      return { ok: false, mensaje: `Falta la AccessPolicy "${NOMBRE_POLICY_PACIENTE}". Corré: npm run seed.` };
    }

    // Invite (sin email nativo): crea User + ProjectMembership, reusa el Patient.
    const projectId = await resolverProjectId(medplum);
    const membership = (await medplum.post(`admin/projects/${projectId}/invite`, {
      resourceType: 'Patient',
      firstName,
      lastName,
      email,
      sendEmail: false,
      upsert: true,
      membership: { accessPolicy: { reference: `AccessPolicy/${policy.id}` } },
    })) as ProjectMembership;

    // Recuperar el link mágico (UserSecurityRequest del usuario). El server lo crea
    // SOLO para usuarios nuevos: si el usuario ya existía (upsert / reinvitación),
    // pedimos uno nuevo con auth/resetpassword (sendEmail:false, flujo custom de
    // Medplum) y reintentamos. El link va al PORTAL del paciente (PORTAL_BASE_URL).
    const userId = membership.user?.reference?.split('/')[1];
    const baseUrl = event.secrets['PORTAL_BASE_URL']?.valueString ?? 'https://app.biowellness.ar';

    // UserSecurityRequest no está en el union tipado de búsqueda: vía REST directo.
    const buscarLink = async (): Promise<string | undefined> => {
      if (!userId) {
        return undefined;
      }
      const bundle = (await medplum.get(
        `fhir/R4/UserSecurityRequest?user=User/${userId}&_sort=-_lastUpdated&_count=1`,
      )) as Bundle<UserSecurityRequest>;
      const usr = bundle.entry?.[0]?.resource;
      return usr?.id && usr.secret && !usr.used ? linkSetPassword(baseUrl, usr.id, usr.secret) : undefined;
    };

    let link = await buscarLink();
    if (!link) {
      // Usuario existente (reinvitación): generar una solicitud nueva sin email nativo.
      await medplum
        .post('auth/resetpassword', { email, sendEmail: false, projectId })
        .catch((err) => console.warn('invitar-paciente: auth/resetpassword falló:', (err as Error).message));
      link = await buscarLink();
    }

    if (!link) {
      console.error(`invitar-paciente: sin UserSecurityRequest legible para User/${userId} (¿usuario server-scoped de una invitación vieja?).`);
      return {
        ok: true,
        canal: e.canal,
        membershipId: membership.id,
        mensaje:
          'Se creó el acceso, pero no pude generar el link de activación. ' +
          'El paciente puede usar "¿Olvidaste tu contraseña?" en el portal, o borrá el User viejo en Medplum y reinvitá.',
      };
    }

    // Entrega por el canal elegido (qr: lo muestra el front con el link devuelto).
    // `enviado` refleja el envío REAL (status de la Communication), no el intento.
    let enviado = false;
    let avisoCanal: string | undefined;
    if (e.canal === 'whatsapp') {
      const comm = await enviarWhatsApp(medplum, event.secrets, {
        template: 'invitacion-portal',
        pacienteRef: e.pacienteRef,
        body: mensajeInvitacion(display, link).texto,
      });
      enviado = comm.status === 'completed';
      if (!enviado) {
        avisoCanal = 'El acceso se creó y el link está listo, pero el WhatsApp no salió (revisá Twilio / teléfono). Podés compartir el link por otro canal.';
      }
    } else if (e.canal === 'email') {
      const m = mensajeInvitacion(display, link);
      // Remitente con marca (la dirección sigue siendo la identidad SES verificada).
      // Configurable con el secret EMAIL_FROM.
      const from = event.secrets['EMAIL_FROM']?.valueString ?? 'BioWellness San Isidro <hola@medplum.com.ar>';
      const comm = await enviarEmail(medplum, {
        to: email,
        asunto: m.asunto,
        cuerpo: m.texto,
        template: 'invitacion-portal',
        pacienteRef: e.pacienteRef,
        from,
      });
      enviado = comm.status === 'completed';
      if (!enviado) {
        avisoCanal = 'El acceso se creó y el link está listo, pero el email no salió (revisá SES). Podés compartir el link por otro canal.';
      }
    }

    return { ok: true, canal: e.canal, membershipId: membership.id, link, enviado, mensaje: avisoCanal };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'No se pudo invitar al paciente.';
    const forbidden = /forbidden/i.test(msg);
    return {
      ok: false,
      mensaje: forbidden
        ? 'El bot no tiene permiso de admin del proyecto para invitar. Asigná admin a su ProjectMembership en Medplum.'
        : msg,
    };
  }
}
