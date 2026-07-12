/**
 * Onboarding de pacientes al portal — lógica pura (sin FHIR ni red).
 *
 * El alta del paciente crea el recurso `Patient`. La invitación al portal le da
 * login: usa el invite de Medplum con `sendEmail:false` y entrega el link mágico
 * (`/setpassword/{id}/{secret}`) por el canal elegido (WhatsApp / mail / QR).
 */
export type CanalInvitacion = 'whatsapp' | 'email' | 'qr';

export const CANALES_INVITACION: readonly CanalInvitacion[] = ['whatsapp', 'email', 'qr'];

export function esCanalValido(c: string | undefined): c is CanalInvitacion {
  return c === 'whatsapp' || c === 'email' || c === 'qr';
}

/**
 * Email mínimamente válido (algo@algo.dominio). No pretende ser RFC-completo:
 * sólo evita altas de portal con un email obviamente roto.
 */
export function validarEmail(email: string | undefined): email is string {
  if (!email) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Link mágico de Medplum para que el paciente fije su contraseña. */
export function linkSetPassword(baseUrl: string, id: string, secret: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/setpassword/${id}/${secret}`;
}

/** Parte el nombre completo en nombre + apellido (apellido = última palabra). */
export function partirNombre(completo: string): { firstName: string; lastName: string } {
  const partes = completo.trim().split(/\s+/).filter(Boolean);
  if (partes.length <= 1) {
    return { firstName: partes[0] ?? '', lastName: '' };
  }
  return { firstName: partes.slice(0, -1).join(' '), lastName: partes[partes.length - 1]! };
}

export interface MensajeInvitacion {
  asunto: string;
  texto: string;
}

/** URL del portal del paciente (se muestra para que lo guarde / lo agregue a inicio). */
export const PORTAL_URL = 'https://bio.medplum.com.ar';

/**
 * Cuerpo de la invitación al portal (mismo link mágico en todos los canales).
 * Personalizado para BioWellness San Isidro: asunto de bienvenida + sugerencia de
 * añadir el portal a la pantalla de inicio (PWA).
 */
export function mensajeInvitacion(nombre: string, link: string): MensajeInvitacion {
  const saludo = nombre ? `¡Hola ${nombre}!` : '¡Hola!';
  return {
    asunto: 'Bienvenido a BioWellness | San Isidro',
    texto:
      `${saludo} Te damos la bienvenida a BioWellness San Isidro 💚\n\n` +
      `Activá tu acceso al portal para ver tus turnos, tu plan, tus pagos y tus estudios. ` +
      `Entrá a este link y elegí tu contraseña:\n\n${link}\n\n` +
      `Después vas a poder ingresar siempre desde:\n${PORTAL_URL}\n\n` +
      `📲 Te recomendamos "Añadir a pantalla de inicio" para abrirlo como una app:\n` +
      `• iPhone (Safari): tocá Compartir → "Añadir a pantalla de inicio".\n` +
      `• Android (Chrome): tocá el menú ⋮ → "Añadir a pantalla de inicio".\n\n` +
      `Si no solicitaste esto, podés ignorar este mensaje.`,
  };
}
