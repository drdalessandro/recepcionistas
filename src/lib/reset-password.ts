/**
 * Reset de contraseña del portal — lógica pura.
 *
 * El circuito es NUESTRO a propósito (decisión de Andrés, 2026-08-20): el
 * `auth/resetpassword` nativo de Medplum manda un email genérico en inglés con
 * el link armado sobre el `appBaseUrl` del server — que apunta a la consola de
 * Admin (`app.medplum.com.ar`) y tiene que seguir apuntando ahí, porque la
 * consola la usan sus propios flujos. En vez de pelear por una config global
 * compartida, el bot `bw-reset-password` arma el link sobre el PORTAL y manda
 * el email él mismo, en castellano y con marca propia — el mismo patrón que
 * `bw-invitar-paciente` usa desde siempre.
 *
 * Acá vive lo decidible sin red: la validación de la entrada, el texto del
 * email y la interpretación de la respuesta de reCAPTCHA.
 */
import { validarEmail } from './onboarding.js';

/**
 * La respuesta del bot es SIEMPRE la misma, exista o no la cuenta. Si "existe"
 * y "no existe" se distinguieran —por el texto, por el código, por lo que sea—
 * el formulario serviría para averiguar qué emails tienen cuenta acá, uno por
 * uno. El único rechazo distinguible es el formato inválido, que no revela nada.
 */
export const RESPUESTA_GENERICA = {
  ok: true as const,
  mensaje:
    'Si existe una cuenta con ese email, te enviamos un link para crear una contraseña nueva. Revisá también la carpeta de spam.',
};

/** Valida la entrada. Solo el FORMATO: la existencia de la cuenta no se revela. */
export function validarEntradaReset(email: string | undefined): { ok: true; email: string } | { ok: false; mensaje: string } {
  const e = email?.trim().toLowerCase();
  if (!e || !validarEmail(e)) {
    return { ok: false, mensaje: 'Ingresá un email válido.' };
  }
  return { ok: true, email: e };
}

/**
 * Interpreta la respuesta de `siteverify` de Google.
 *
 * La validación corre EN EL BOT y no en el navegador, porque en el navegador no
 * es una validación: cualquiera puede saltear la página y pegarle al endpoint.
 * Es también lo que hace innecesario configurar `recaptchaSecretKey` en el
 * server de Medplum para este flujo — la secret vive en Project Secrets.
 *
 * `score` es de reCAPTCHA v3 (0 = bot, 1 = humano). El umbral 0.3 es
 * deliberadamente laxo: un falso positivo acá deja a un paciente real sin
 * poder resetear, y el daño de un falso negativo es un email de reset de más.
 */
export function evaluarSiteverify(respuesta: unknown): { valido: boolean; motivo?: string } {
  const r = respuesta as { success?: boolean; score?: number; 'error-codes'?: string[] } | undefined;
  if (!r || typeof r !== 'object') {
    return { valido: false, motivo: 'sin respuesta de siteverify' };
  }
  if (r.success !== true) {
    return { valido: false, motivo: (r['error-codes'] ?? []).join(',') || 'success=false' };
  }
  if (typeof r.score === 'number' && r.score < 0.3) {
    return { valido: false, motivo: `score ${r.score}` };
  }
  return { valido: true };
}

/** El email de reset, en castellano y con la voz de los demás mensajes del centro. */
export function mensajeReset(link: string): { asunto: string; texto: string } {
  return {
    asunto: 'Recuperá tu acceso | Biowellness San Isidro',
    texto:
      `¡Hola! Recibimos tu pedido para crear una contraseña nueva en el portal de Biowellness.\n\n` +
      `Entrá a este link y elegí tu contraseña:\n\n${link}\n\n` +
      `El link es de un solo uso. Si no fuiste vos, ignorá este mensaje: tu cuenta sigue igual que siempre.`,
  };
}
