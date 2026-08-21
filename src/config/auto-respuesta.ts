/**
 * Respuestas automáticas de WhatsApp — datos y perillas.
 *
 * Todo lo que un humano puede querer cambiar sin tocar lógica vive acá: los
 * textos salen de `src/lib/auto-respuesta.ts` armados con estos datos y con el
 * `HORARIO_SEMANAL` real, así que si Andrés cambia el horario, el mensaje
 * cambia solo.
 *
 * REGLA DE ORO (docs/whatsapp-auto-respuestas.md): acá NO se contesta nada
 * clínico ni se cotiza un precio. Lo clínico es del Director Médico y lo
 * comercial se responde con el link a la lista publicada, que es la que se
 * mantiene. Una automatización que improvisa un precio o un consejo médico es
 * un problema, no una mejora.
 */

/** Dirección del centro (la misma del consentimiento). */
export const CENTRO_DIRECCION = 'Roque Sáenz Peña 530, San Isidro, Buenos Aires';

/** Link al mapa: se arma con la dirección, no se hardcodea un id de Google. */
export const CENTRO_MAPA = `https://maps.google.com/?q=${encodeURIComponent(CENTRO_DIRECCION)}`;

/**
 * Links a la lista de precios publicada.
 *
 * ⚠️ COMPLETAR con las URLs reales de info.biowellness.ar (terapias, paquetes,
 * membresías). Solo la de combos está confirmada; las demás las tiene Andrés en
 * la barra de favoritos. Mientras tanto se manda la home, que nunca miente.
 */
export const LINKS_PRECIOS: Array<{ titulo: string; url: string }> = [
  { titulo: 'Combos', url: 'https://info.biowellness.ar/combos-r9t4.html' },
  { titulo: 'Todo el catálogo', url: 'https://info.biowellness.ar' },
];

/**
 * Cuánto espera el sistema antes de repetir la MISMA auto-respuesta en un hilo.
 *
 * No es un capricho: si alguien manda cinco mensajes seguidos tiene que recibir
 * un acuse, no cinco. Una intención distinta sí responde enseguida (contestar
 * "recibimos tu comprobante" no debería quedar mudo porque hace diez minutos se
 * mandó un "hola").
 */
export const MINUTOS_ENTRE_AUTO_RESPUESTAS = 180;

/**
 * Cuánto silencio pide la palabra clave de escape (`HUMANO`).
 *
 * Que el paciente pueda apagar el bot es innegociable: el peor WhatsApp es el
 * que te contesta solo y no te suelta. Durante esta ventana el sistema no manda
 * NADA automático a ese hilo.
 */
export const MINUTOS_SILENCIO_HUMANO = 12 * 60;

/** Palabra que el paciente escribe para que lo atienda una persona. */
export const PALABRA_HUMANO = 'HUMANO';

/**
 * Ventana de Meta para texto libre: 24 h desde el último mensaje del cliente.
 * Fuera de ella solo salen plantillas aprobadas. La usan el bot (para no
 * intentar lo imposible) y la bandeja de Mensajes (para avisarle a Recepción).
 */
export const VENTANA_LIBRE_HORAS = 24;

/** Con menos de esto, la bandeja muestra la ventana en amarillo (se está por cerrar). */
export const VENTANA_AVISO_MINUTOS = 60;
