/**
 * Quién manda los emails de Biowellness.
 *
 * Está en un solo lugar porque estaba en dos y no decían lo mismo: el reset de
 * contraseña salía de `info@biowellness.ar` (escrito a mano en el bot) y la
 * invitación al portal caía, si el Project Secret no estaba cargado, en
 * `hola@medplum.com.ar` — **el dominio del proveedor, no el nuestro**. Un
 * paciente que recibe el acceso a su historia clínica desde un dominio que no
 * reconoce tiene todos los motivos para tratarlo como phishing, y ese reporte
 * de spam le pega a la reputación de TODOS los emails de la cuenta.
 *
 * ## Por qué una sola dirección y no una por tipo de mensaje
 *
 * La tentación es separar (`turnos@`, `notificaciones@`, `no-reply@`) para
 * "proteger la reputación". **No funciona así**: SES mide rebotes y quejas por
 * CUENTA, no por identidad — separar direcciones no aísla nada. Lo que da
 * métricas separadas son los Configuration Sets, y lo que aísla reputación de
 * verdad son las IPs dedicadas, que a este volumen no se justifican.
 *
 * Lo que sí cambia con la dirección es **dónde caen las respuestas**, y ahí una
 * sola gana: el email del recordatorio de una videollamada es el que más se
 * responde ("no me anda la cámara", "no puedo entrar"), y llega dos horas antes
 * de la consulta. Un `no-reply@` tira esa respuesta al vacío en el peor momento
 * posible. `info@` es la casilla que Recepción ya mira.
 */

/** Remitente por defecto. Se puede pisar con el Project Secret `EMAIL_FROM`. */
export const EMAIL_FROM = 'Biowellness San Isidro <info@biowellness.ar>';

/**
 * A dónde contesta el paciente si aprieta "Responder".
 *
 * Va aparte del remitente a propósito: si algún día el `From` cambia —por una
 * campaña, por un subdominio de envío— las respuestas tienen que seguir
 * llegando a una persona. Un email operativo sin respuesta posible es una
 * puerta cerrada con el paciente del otro lado.
 */
export const EMAIL_RESPUESTAS = 'info@biowellness.ar';

/**
 * El remitente a usar: lo que diga el secret, o el nuestro.
 *
 * Un valor vacío o en blanco cuenta como ausente: un secret cargado sin querer
 * con un espacio dejaría los emails sin `From` válido, y SES los rechaza.
 */
export function remitenteEmail(configurado?: string): string {
  return configurado?.trim() || EMAIL_FROM;
}
