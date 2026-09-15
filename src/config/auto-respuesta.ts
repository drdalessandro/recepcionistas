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

/**
 * Link al mapa: el CORTO de Google Maps (creado desde la ficha del centro).
 *
 * Hasta 2026-09-15 se armaba `maps.google.com/?q=<dirección codificada>`: en
 * el teléfono ocupaba tres renglones de `%20` y `%C3%B1` y se leía como un
 * error. La bienvenida ya usaba el corto; ahora hay una sola fuente. Si el
 * centro se muda, se cambia acá y en `CENTRO_DIRECCION`.
 */
export const CENTRO_MAPA = 'https://maps.app.goo.gl/8dN7McDRnREjdDsV7';

/**
 * Cómo llegar (tren, colectivo, estacionamiento), un renglón por ítem. Sale
 * como bloque "🚗 Cómo llegar:" al final de la respuesta de dirección y
 * horario. **Vacío = el bloque no sale**: hoy no está cargado porque el texto
 * lo tiene que dar Andrés (no se inventa una línea de colectivo).
 */
export const CENTRO_COMO_LLEGAR: string[] = [];

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
  // ORDEN = la escalera comercial, de lista a más conveniente. No es una
  // intuición: sesión suelta 0 % · paquete 5-15 % · combo 20-22 % · membresía
  // 20-30 % ADEMÁS del combo (`descuentoContinuidad` se acumula). Verificado
  // contra config/paquetes, combos y membresias (2026-09-14).
  //
  // Que "Sesiones" quede PRIMERO tiene un efecto extra: WhatsApp arma la
  // tarjeta de vista previa con el primer link del mensaje, así que la tarjeta
  // pasa a ser la puerta de entrada del catálogo en vez de Combos, que era el
  // tercer escalón.
  { titulo: 'Sesiones', url: 'https://info.biowellness.ar/sesiones-m3a5.html' },
  { titulo: 'Paquetes de sesiones', url: 'https://info.biowellness.ar/paquetes-k4m7.html' },
  { titulo: 'Combos', url: 'https://info.biowellness.ar/combos-r9t4.html' },
  { titulo: 'Membresías', url: 'https://info.biowellness.ar/membresias-w8p2.html' },
  // Cierre, no un escalón más: el índice por si ninguna de las cuatro era lo
  // que buscaba. La Web salió de esta lista — no es una lista de precios y en
  // un mensaje de "Precios" era ruido; sigue estando en la bienvenida.
  { titulo: 'Todo el catálogo', url: 'https://info.biowellness.ar' },
];

/**
 * Links de información (no de precios). Los manda la intención `informacion`.
 *
 * REGLA DE ORO: esto enlaza material YA PUBLICADO por nosotros, no contesta.
 * La diferencia importa: mandar la Guía HBOT es seguro; responder una pregunta
 * clínica sobre HBOT no lo es, y por eso `detectarIntencion` manda a una
 * persona cualquier mensaje con señales clínicas (ver RE_CLINICO).
 */
export const LINKS_INFO: Array<{ titulo: string; url: string }> = [
  { titulo: 'Toda la información', url: 'https://info.biowellness.ar/' },
  { titulo: 'Cómo funciona', url: 'https://info.biowellness.ar/como-funciona.html' },
];

/** Links de Cámara Hiperbárica (intención `hbot`). */
export const LINKS_HBOT: Array<{ titulo: string; url: string }> = [
  { titulo: 'Cámara Hiperbárica', url: 'https://info.biowellness.ar/hbot.html' },
  { titulo: 'Cómo funciona', url: 'https://info.biowellness.ar/como-funciona.html' },
  { titulo: 'Guía HBOT', url: 'https://info.biowellness.ar/guia/hbot/' },
];

/**
 * Links de IHHT — Hipoxia-Hiperoxia Intermitente (intención `ihht`). Mismo
 * esquema que HBOT: la página, cómo funciona y la guía del paciente
 * (Andrés, 2026-09-15). La página de IHHT va PRIMERA: es la que arma la tarjeta.
 */
export const LINKS_IHHT: Array<{ titulo: string; url: string }> = [
  // "Qué es" y no el nombre completo: la apertura del mensaje ya dice
  // "IHHT (Hipoxia-Hiperoxia Intermitente)" y repetirlo se leía doble.
  { titulo: 'Qué es el IHHT', url: 'https://info.biowellness.ar/ihht.html' },
  { titulo: 'Cómo funciona', url: 'https://info.biowellness.ar/como-funciona.html' },
  { titulo: 'Guía IHHT', url: 'https://info.biowellness.ar/guia/ihht/' },
];

/**
 * Links de Red Light — Fotobiomodulación (intención `red-light`). Mismo
 * esquema que HBOT e IHHT (Andrés, 2026-09-15).
 */
export const LINKS_RED_LIGHT: Array<{ titulo: string; url: string }> = [
  { titulo: 'Qué es Red Light', url: 'https://info.biowellness.ar/red-light.html' },
  { titulo: 'Cómo funciona', url: 'https://info.biowellness.ar/como-funciona.html' },
  { titulo: 'Guía Red Light', url: 'https://info.biowellness.ar/guia/red-light/' },
];

/**
 * Links de Recovery Pro — el circuito de sauna infrarrojo, frío y red light
 * (intención `recovery`). Mismo esquema que HBOT, IHHT y Red Light
 * (Andrés, 2026-09-15).
 */
export const LINKS_RECOVERY: Array<{ titulo: string; url: string }> = [
  { titulo: 'Qué es Recovery Pro', url: 'https://info.biowellness.ar/recovery-pro.html' },
  { titulo: 'Cómo funciona', url: 'https://info.biowellness.ar/como-funciona.html' },
  { titulo: 'Guía Recovery Pro', url: 'https://info.biowellness.ar/guia/recovery-pro/' },
];

/**
 * Formato de una lista de links para WhatsApp: **título y link en renglones
 * distintos**.
 *
 * Antes iba `· Título: https://…` en una sola línea. En el teléfono la URL
 * larga se parte sola y el renglón queda cortado al medio: se lee compactado y
 * desordenado (Andrés, 2026-09-14, con la captura). Con el título arriba, el
 * link queda entero en su propio renglón y la lista se escanea de un vistazo.
 */
export function listaDeLinks(links: Array<{ titulo: string; url: string }>): string {
  return links.map((l) => `${l.titulo}:\n${l.url}`).join('\n\n');
}

/** La App de la paciente (el portal). Misma URL que `PORTAL_URL` en `lib/onboarding.ts`; hay test. */
export const APP_URL = 'https://app.biowellness.ar';

/**
 * Cierre de (casi) toda respuesta automática: la invitación a autogestionarse
 * desde la App.
 *
 * Por qué al FINAL y no al principio: WhatsApp arma la tarjeta de vista previa
 * con el primer link del mensaje, y ese lugar es de Sesiones (precios) o de la
 * página de HBOT. En las respuestas que no traen ningún link (acuse, turno,
 * comprobante) la App pasa a ser el único y se lleva la tarjeta, que es
 * exactamente lo que queremos vender.
 *
 * Lo que promete es lo que la App hace hoy (mismo alcance que la invitación
 * de `lib/onboarding.ts`: turnos, plan, pagos): pedir turno, seguir el plan y
 * los pagos, y escribirnos. No promete "pagás desde la App": la seña sale por
 * link de MercadoPago, y una promesa que la App no cumple es un reclamo en
 * Mensajes.
 *
 * Formato: título en **negrita de WhatsApp** (`*…*`, se renderiza en texto
 * libre, que es lo único que manda el bot), una línea de imperativos y el link
 * solo en el último renglón (misma regla que `listaDeLinks`). Va separado del
 * resto por un renglón en blanco. El título en negrita es lo que lo pone a la
 * par de Web e Info en la bienvenida (Andrés, 2026-09-14).
 *
 * NO va en dos casos, decididos en `llevaCtaApp()` (`lib/auto-respuesta.ts`):
 * cuando la persona pidió `HUMANO` (pidió que la dejemos de contestar, no que
 * le vendamos la App) y en la bienvenida al número desconocido, donde ESTE
 * MISMO bloque es el segundo globo (ver `BIENVENIDA_SALUDO`).
 */
export const CTA_APP =
  '📱 *Autogestión en la App*\n' +
  'Pedí turnos, seguí tu plan y tus pagos, y escribinos. Todo en un solo lugar:\n' +
  APP_URL;

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
 *
 * NO subirla para "darle tiempo a contestar" (se evaluó, 2026-09-14): Twilio
 * corta a los 15 s y el bot corre en Lambda con el timeout por defecto de
 * Medplum (10 s), así que con 10-12 s por pausa el tercer globo no saldría y
 * tampoco correría lo de después —el aviso a Recepción del número desconocido—.
 * Y aunque se pudiera, no resuelve nada: escribir nombre, apellido y email
 * lleva 20-40 s. Lo que evita el cruce es el ORDEN de la bienvenida (la
 * pregunta va en el ÚLTIMO globo), no la pausa.
 */
export const SEGUNDOS_ENTRE_MENSAJES = 3;

/**
 * La bienvenida al número que NO está en la base son TRES globos, en este
 * orden y con `SEGUNDOS_ENTRE_MENSAJES` entre medio:
 *
 *   1. `BIENVENIDA_SALUDO` — saludo, bajada de marca, Web e Info destacadas,
 *      mapa e Instagram en segundo plano.
 *   2. `CTA_APP` — la App, a la par de Web e Info.
 *   3. El pedido de datos (`pedidoDeDatos()` en `lib/auto-respuesta.ts`), que
 *      es dinámico: fuera de horario dice cuándo se responde.
 *
 * **La pregunta va ÚLTIMA a propósito** (Andrés, 2026-09-14). Hasta entonces
 * iba en el primer globo y quien contestaba rápido veía sus datos seguidos de
 * dos mensajes nuestros que parecían ignorarlos. Con la pregunta al final, la
 * respuesta no puede llegar antes que ella, a cualquier velocidad — es la
 * única solución que no depende de la pausa (ver `SEGUNDOS_ENTRE_MENSAJES`).
 *
 * Jerarquía visual (pedida por Andrés): Web, Info y App con emoji + título en
 * negrita y el link solo en su renglón; mapa e Instagram en una línea plana
 * cada uno, sin negrita. El email salió: quien escribe por WhatsApp ya nos
 * tiene, y era el texto que sobraba.
 *
 * WhatsApp arma la tarjeta de vista previa con el PRIMER link de cada globo:
 * la Web en el 1, la App en el 2. La bajada de marca va SOLO acá, no repetida
 * en los otros globos (Andrés, 2026-08-23).
 */
export const BIENVENIDA_SALUDO =
  'Hola! 👋🏼\n' +
  'Gracias por tu interés en Biowellness San Isidro.\n' +
  'BIOWELLNESS: Longevidad Saludable - Recuperación Deportiva - Optimización Biológica. 🧬\n' +
  '\n' +
  '🌐 *Conocé Biowellness*\n' +
  'https://www.biowellness.ar\n' +
  '\n' +
  'ℹ️ *Servicios e información*\n' +
  'https://info.biowellness.ar\n' +
  '\n' +
  `📍 Mapa: ${CENTRO_MAPA}\n` +
  '📸 Instagram: @biowellness.ar';

/**
 * Los campos que se le piden al desconocido para darlo de alta. Un campo por
 * renglón, con los dos puntos: la persona los completa debajo o al lado. El
 * DNI es opcional (Andrés, 2026-09-14): sirve para el dedup de la ficha, pero
 * pedirlo como obligatorio en el primer contacto espanta.
 */
export const PEDIDO_DATOS = 'Nombre y Apellido:\nEmail:\nDNI (opcional):';
