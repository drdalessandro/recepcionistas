/**
 * Bot · Invitar paciente al portal.
 *
 * Le da acceso de login al paciente (para ver SUS turnos/plan/pagos) reutilizando
 * el invite de Medplum con `sendEmail:false`, y entrega el link mágico
 * (`/setpassword/{id}/{secret}`) por el canal elegido:
 *   - whatsapp → Twilio;     - email → mail Biowellness (SES);     - qr → devuelve
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
import { remitenteEmail } from '../config/email.js';

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
    // En minúsculas SIEMPRE: Medplum guarda el email del User normalizado y
    // `auth/resetpassword` lo busca por igualdad exacta. Un "Juan@Gmail.com"
    // tipeado en el mostrador no encontraría al usuario y —como ese endpoint
    // responde OK igual (ver abajo)— el fallo sería invisible.
    const email = (e.email ?? patient.telecom?.find((t) => t.system === 'email')?.value)?.trim().toLowerCase();
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
    const buscarSolicitud = async (): Promise<UserSecurityRequest | undefined> => {
      if (!userId) {
        return undefined;
      }
      const bundle = (await medplum.get(
        `fhir/R4/UserSecurityRequest?user=User/${userId}&_sort=-_lastUpdated&_count=1`,
      )) as Bundle<UserSecurityRequest>;
      return bundle.entry?.[0]?.resource;
    };
    const linkDe = (usr: UserSecurityRequest | undefined): string | undefined =>
      usr?.id && usr.secret && !usr.used ? linkSetPassword(baseUrl, usr.id, usr.secret) : undefined;

    let solicitud = await buscarSolicitud();
    let link = linkDe(solicitud);
    let fallo: string | undefined;

    if (!link) {
      // Reinvitación: el `invite` de Medplum crea el link SOLO para usuarios
      // nuevos (`if (!existingUser)`), así que acá hay que pedirlo aparte.
      //
      // OJO con cómo se mide el éxito: `auth/resetpassword` responde **200 aunque
      // NO encuentre al usuario** (anti-enumeración de cuentas, OWASP). Por eso
      // no alcanza con que no tire error — hay que verificar que aparezca una
      // solicitud NUEVA. Antes esto se daba por hecho y el fallo era mudo.
      //
      // Dos intentos: con `projectId` (usuarios del proyecto, el caso normal) y
      // sin él — Medplum filtra por "proyecto vacío" cuando no se lo pasás, que
      // es la única forma de encontrar a un User *server-scoped* (invitaciones
      // viejas, altas hechas por fuera de este flujo).
      const idPrevio = solicitud?.id;
      for (const cuerpo of [{ email, sendEmail: false, projectId }, { email, sendEmail: false }]) {
        try {
          await medplum.post('auth/resetpassword', cuerpo);
        } catch (err) {
          fallo = `auth/resetpassword respondió: ${(err as Error).message}`;
        }
        solicitud = await buscarSolicitud();
        if (solicitud?.id && solicitud.id !== idPrevio) {
          break;
        }
        // reCAPTCHA: el servidor exige un token que solo puede resolver un
        // navegador. Reintentar es inútil — y no es un error nuestro: ese
        // camino le corresponde al paciente desde el portal (ver abajo).
        if (/recaptcha/i.test(fallo ?? '')) {
          break;
        }
      }
      link = linkDe(solicitud);
    }

    if (!link) {
      // Sin link no hay activación: decir QUÉ pasó, no un texto genérico.
      const causa =
        fallo ??
        (solicitud?.id
          ? 'el servidor no generó una solicitud nueva (la última ya fue usada)'
          : 'el servidor no generó ninguna solicitud para este usuario');
      console.error(`invitar-paciente: sin link para User/${userId} (email ${email}): ${causa}.`);

      // Caso NORMAL, no una falla: el paciente ya tiene cuenta y solo necesita
      // recuperar la contraseña. Ese camino es del portal —que pide reCAPTCHA
      // desde el navegador, algo que un bot no puede resolver— y funciona
      // (arreglado 2026-08-21). Decirle a Recepción qué hacer, no qué se rompió.
      if (/recaptcha/i.test(fallo ?? '')) {
        return {
          ok: true,
          canal: e.canal,
          membershipId: membership.id,
          mensaje:
            'Este paciente YA tiene cuenta en el portal, así que no necesita link de activación sino ' +
            `recuperar la contraseña: que entre a "¿Olvidaste tu contraseña?" en el portal con ${email} ` +
            'y le llega el link por mail.',
        };
      }

      return {
        ok: true,
        canal: e.canal,
        membershipId: membership.id,
        mensaje:
          `Se creó el acceso, pero no pude generar el link de activación: ${causa}. ` +
          `Suele pasar cuando el paciente ya tiene una cuenta vieja (a veces con OTRO email). ` +
          `Verificá con: npm run portal:check -- ${email}`,
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
      // Remitente con marca (la dirección tiene que ser una identidad SES
      // verificada). El default era `hola@medplum.com.ar` —el dominio del
      // PROVEEDOR—: un paciente que recibe el acceso a su historia desde un
      // dominio que no reconoce tiene todos los motivos para marcarlo como spam.
      const from = remitenteEmail(event.secrets['EMAIL_FROM']?.valueString);
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
