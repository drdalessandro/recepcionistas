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
 * `titulo` es SOLO la etiqueta que ve el paciente en el mensaje ("· Combos:
 * https://…"): NO se usa para reconocer lo que escribió. Duplicar una entrada
 * con y sin acento no agrega tolerancia — manda el mismo link dos veces y se
 * lee como un error. Las variantes de escritura del paciente las resuelve
 * `normalizar()` en `src/lib/auto-respuesta.ts`, que saca acentos y mayúsculas
 * antes de comparar.
 */
export const LINKS_PRECIOS: Array<{ titulo: string; url: string }> = [
  { titulo: 'Combos', url: 'https://info.biowellness.ar/combos-r9t4.html' },
  { titulo: 'Paquetes', url: 'https://info.biowellness.ar/paquetes-k4m7.html' },
  { titulo: 'Membresías', url: 'https://info.biowellness.ar/membresias-w8p2.html' },
  { titulo: 'Web', url: 'https://www.biowellness.ar' },
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

/**
 * Pausa entre los mensajes de una misma respuesta automática.
 *
 * El bot contesta dentro del webhook de Twilio, que espera la respuesta en una
 * ventana acotada: cada segundo de pausa se descuenta de ese presupuesto. Tres
 * segundos dan el ritmo de alguien escribiendo sin arriesgar un timeout (y con
 * dos pausas encadenadas seguimos MUY por debajo del límite).
 */
export const SEGUNDOS_ENTRE_MENSAJES = 3;

/**
 * Los mensajes que siguen al saludo cuando el número NO está en la base.
 *
 * Van en mensajes aparte a propósito: los cuatro links en un solo globo lo
 * estiran y WhatsApp arma la tarjeta de vista previa con el primero. La bajada
 * ("Longevidad Saludable - …") queda SOLO en el saludo: repetirla acá, tres
 * segundos después, se leía como un mensaje duplicado (Andrés, 2026-08-23).
 */
export const BIENVENIDA_DESCONOCIDO: string[] = [
  'Queremos que conozcas más acerca de BIOWELLNESS\n' +
    '\n' +
    'Te compartimos información útil\n' +
    'Web: https://www.biowellness.ar\n' +
    'Mapa: https://maps.app.goo.gl/8dN7McDRnREjdDsV7',
  'También podés entrar desde acá:\n' +
    '\n' +
    'Autogestión y App del usuario\n' +
    'App: https://app.biowellness.ar\n' +
    '\n' +
    'Información sobre nuestros servicios\n' +
    'Info: https://info.biowellness.ar\n' +
    '\n' +
    'Contactanos:\n' +
    'Email: info@biowellness.ar\n' +
    'Instagram: @biowellness.ar',
];
