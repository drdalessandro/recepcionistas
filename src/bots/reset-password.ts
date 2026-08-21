/**
 * Bot · Reset de contraseña del portal (endpoint PÚBLICO vía nginx).
 *
 * El "¿Olvidaste tu contraseña?" del portal le pega a
 * `https://api.medplum.com.ar/webhooks/reset-password` — una URL limpia donde
 * nginx inyecta el Authorization Basic de la ClientApplication de webhooks y
 * reenvía al $execute de este bot (la MISMA receta de MercadoPago y Twilio, ver
 * `deploy/nginx-api-proxy.conf`).
 *
 * Por qué no se usa el email nativo de `auth/resetpassword`: arma el link sobre
 * el `appBaseUrl` del server, que apunta a la consola de Admin y DEBE seguir
 * apuntando ahí (decisión de Andrés, 2026-08-20). Este bot arma el link sobre
 * el portal (`PORTAL_BASE_URL`) y manda el email él mismo — en castellano, con
 * marca propia, desde la identidad SES de siempre.
 *
 * Seguridad (es un endpoint público; cada decisión está a la altura de eso):
 *  - reCAPTCHA se valida ACÁ contra Google, con la secret en Project Secrets
 *    (RECAPTCHA_SECRET_KEY). En el navegador no sería una validación.
 *  - La respuesta es IDÉNTICA exista o no la cuenta (RESPUESTA_GENERICA):
 *    el formulario no sirve para enumerar usuarios.
 *  - El link con el secret va SOLO al inbox del dueño del email. Nunca en la
 *    respuesta.
 *  - Anti-ráfaga: si el usuario ya tiene un UserSecurityRequest sin usar de
 *    hace menos de 2 minutos, no se genera ni manda otro (doble click, spam).
 *    El rate limit de verdad va en nginx (`limit_req` del location).
 *
 * Requiere admin del proyecto (lee UserSecurityRequest), igual que
 * `bw-invitar-paciente`.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Bundle, UserSecurityRequest } from '@medplum/fhirtypes';
import { linkSetPassword } from '../lib/onboarding.js';
import {
  RESPUESTA_GENERICA,
  evaluarSiteverify,
  mensajeReset,
  validarEntradaReset,
} from '../lib/reset-password.js';
import { enviarEmail, resolverProjectId } from './_shared.js';

export interface EntradaResetPassword {
  email?: string;
  recaptchaToken?: string;
}

export interface ResultadoResetPassword {
  ok: boolean;
  mensaje?: string;
}

const DOS_MINUTOS_MS = 2 * 60 * 1000;

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaResetPassword>,
): Promise<ResultadoResetPassword> {
  const entrada = validarEntradaReset(event.input?.email);
  if (!entrada.ok) {
    return { ok: false, mensaje: entrada.mensaje };
  }
  const email = entrada.email;

  // reCAPTCHA, si está configurado. Sin secret no se exige (mismo contrato que
  // el server de Medplum): así el circuito no se cae por una config que falte.
  const recaptchaSecret = event.secrets['RECAPTCHA_SECRET_KEY']?.valueString;
  if (recaptchaSecret) {
    if (!event.input?.recaptchaToken) {
      return { ok: false, mensaje: 'No pudimos verificar que seas una persona. Recargá la página y probá de nuevo.' };
    }
    try {
      const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: recaptchaSecret, response: event.input.recaptchaToken }),
      });
      const veredicto = evaluarSiteverify(await res.json());
      if (!veredicto.valido) {
        console.warn(`reset-password: reCAPTCHA rechazado (${veredicto.motivo}).`);
        return { ok: false, mensaje: 'No pudimos verificar que seas una persona. Recargá la página y probá de nuevo.' };
      }
    } catch (err) {
      // Google caído no puede dejar al paciente sin reset: se sigue. El costo
      // de un abuso puntual es un email; el de bloquear, un cliente trabado.
      console.warn('reset-password: siteverify inaccesible, se sigue sin reCAPTCHA:', (err as Error).message);
    }
  }

  try {
    const projectId = await resolverProjectId(medplum);
    const baseUrl = event.secrets['PORTAL_BASE_URL']?.valueString ?? 'https://app.biowellness.ar';

    // ¿Existe el usuario? Se busca el User por email DENTRO del proyecto.
    // Si no existe, RESPUESTA_GENERICA y nada más: no revelar es el contrato.
    // (User no está en el union de recursos tipados: vía REST directo, igual
    // que UserSecurityRequest en bw-invitar-paciente.)
    const usuarios = (await medplum.get(`fhir/R4/User?email=${encodeURIComponent(email)}&_count=1`)) as {
      entry?: Array<{ resource?: { id?: string } }>;
    };
    const userId = usuarios.entry?.[0]?.resource?.id;
    if (!userId) {
      return RESPUESTA_GENERICA;
    }

    const buscarVigente = async (): Promise<UserSecurityRequest | undefined> => {
      const bundle = (await medplum.get(
        `fhir/R4/UserSecurityRequest?user=User/${userId}&_sort=-_lastUpdated&_count=1`,
      )) as Bundle<UserSecurityRequest>;
      const usr = bundle.entry?.[0]?.resource;
      return usr?.id && usr.secret && !usr.used ? usr : undefined;
    };

    // Anti-ráfaga: un pedido sin usar de hace < 2 min se REUSA (mismo link),
    // así el doble click no llena el inbox ni invalida el email anterior.
    let usr = await buscarVigente();
    const esReciente =
      usr?.meta?.lastUpdated && Date.now() - new Date(usr.meta.lastUpdated).getTime() < DOS_MINUTOS_MS;
    if (!usr || !esReciente) {
      await medplum
        .post('auth/resetpassword', { email, sendEmail: false, projectId })
        .catch((err) => console.warn('reset-password: auth/resetpassword falló:', (err as Error).message));
      usr = await buscarVigente();
    }
    if (!usr?.id || !usr.secret) {
      // Cuenta rara (p. ej. User server-scoped viejo). Para afuera, lo mismo:
      // la respuesta no puede depender del estado interno de la cuenta.
      console.error(`reset-password: sin UserSecurityRequest legible para User/${userId}.`);
      return RESPUESTA_GENERICA;
    }

    const m = mensajeReset(linkSetPassword(baseUrl, usr.id, usr.secret));
    await enviarEmail(medplum, {
      asunto: m.asunto,
      cuerpo: m.texto,
      template: 'reset-password',
      to: email,
      from: 'Biowellness <info@biowellness.ar>',
    });
    return RESPUESTA_GENERICA;
  } catch (err) {
    // Falla interna: se loguea de verdad y para afuera va un error honesto pero
    // genérico (sin filtrar si la cuenta existe).
    console.error('reset-password: error interno:', (err as Error).message);
    return { ok: false, mensaje: 'No pudimos procesar el pedido. Probá de nuevo en unos minutos.' };
  }
}
