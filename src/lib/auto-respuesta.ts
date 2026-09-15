/**
 * Respuestas automáticas de WhatsApp — lógica pura (sin FHIR, sin red).
 *
 * Decide QUÉ contestarle a un mensaje entrante y si además hay que dejarle
 * trabajo a Recepción. El bot (`bw-whatsapp-entrante`) solo orquesta: pregunta
 * acá y ejecuta.
 *
 * Dos límites que ordenan todo el diseño:
 *
 *  1. **La ventana de 24 h de Meta.** Fuera de ella solo salen plantillas
 *     aprobadas. Como toda auto-respuesta contesta un mensaje que el paciente
 *     acaba de mandar, siempre cae DENTRO de la ventana: texto libre, sin
 *     plantilla que aprobar. Por eso este nivel es barato.
 *  2. **Nada clínico ni cotizado a mano.** Ver `src/config/auto-respuesta.ts`.
 *     Lo que este módulo no sabe contestar, lo deriva a una persona — que es la
 *     respuesta correcta, no una falla.
 */
import { HORARIO_SEMANAL } from '../config/horario.js';
import {
  BIENVENIDA_SALUDO,
  CENTRO_COMO_LLEGAR,
  CENTRO_DIRECCION,
  CENTRO_MAPA,
  CTA_APP,
  LINKS_HBOT,
  LINKS_IHHT,
  LINKS_INFO,
  LINKS_RECOVERY,
  LINKS_RED_LIGHT,
  LINKS_PRECIOS,
  listaDeLinks,
  MINUTOS_ENTRE_AUTO_RESPUESTAS,
  MINUTOS_SILENCIO_HUMANO,
  PALABRA_HUMANO,
  PEDIDO_DATOS,
  VENTANA_LIBRE_HORAS,
} from '../config/auto-respuesta.js';

const MINUTO_MS = 60_000;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Intenciones que el sistema sabe reconocer. `generico` es el acuse de recibo. */
export type Intencion =
  | 'humano'
  | 'comprobante-pago'
  | 'turno-pedido'
  | 'turno-consulta'
  | 'precios'
  | 'hbot'
  | 'ihht'
  | 'red-light'
  | 'recovery'
  | 'informacion'
  | 'horario-ubicacion'
  | 'generico';

// ---------------------------------------------------------------------------
// Horario del centro
// ---------------------------------------------------------------------------

/**
 * Día de la semana y minutos desde medianoche, en hora de Argentina.
 *
 * Argentina no tiene horario de verano desde 2009: el offset es fijo -03:00, y
 * el repo ya resuelve esto corriendo la fecha 3 h y leyendo las partes UTC
 * (mismo criterio que `disponibilidad.ts`). Sin esto, un bot corriendo en UTC
 * le diría a las 22:30 de un viernes que el centro está abierto.
 */
export function partesArgentina(fecha: Date): { dia: number; minutos: number } {
  const local = new Date(fecha.getTime() - 3 * 60 * MINUTO_MS);
  return { dia: local.getUTCDay(), minutos: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

function aMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function hhmm(minutos: number): string {
  return `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
}

/** ¿El centro está atendiendo en este momento? */
export function estaAbierto(ahora: Date): boolean {
  const { dia, minutos } = partesArgentina(ahora);
  const horario = HORARIO_SEMANAL.find((h) => h.dia === dia);
  if (!horario?.abierto) {
    return false;
  }
  return horario.franjas.some((f) => minutos >= aMinutos(f.desde) && minutos < aMinutos(f.hasta));
}

/**
 * Cuándo vuelve a abrir, en palabras: "hoy a las 08:00", "mañana a las 08:00",
 * "el lunes a las 08:00". Devuelve undefined si el horario no tiene ningún día
 * abierto (configuración rota: mejor no prometer nada).
 */
export function textoProximaApertura(ahora: Date): string | undefined {
  const { dia, minutos } = partesArgentina(ahora);
  for (let salto = 0; salto < 8; salto++) {
    const d = (dia + salto) % 7;
    const horario = HORARIO_SEMANAL.find((h) => h.dia === d);
    if (!horario?.abierto || horario.franjas.length === 0) {
      continue;
    }
    // Hoy solo sirve una franja que todavía no arrancó.
    const apertura = horario.franjas
      .map((f) => aMinutos(f.desde))
      .sort((a, b) => a - b)
      .find((m) => salto > 0 || m > minutos);
    if (apertura === undefined) {
      continue;
    }
    const cuando = salto === 0 ? 'hoy' : salto === 1 ? 'mañana' : `el ${DIAS[d]}`;
    return `${cuando} a las ${hhmm(apertura)}`;
  }
  return undefined;
}

/** El horario semanal en una línea, agrupando los días iguales. */
export function textoHorarioSemanal(): string {
  const partes: string[] = [];
  let grupo: { desde: number; hasta: number; franjas: string } | undefined;
  // Se recorre de lunes a domingo (así se lee), agrupando días consecutivos
  // con la misma franja para no escupir siete líneas iguales.
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const horario = HORARIO_SEMANAL.find((h) => h.dia === d);
    const franjas =
      horario?.abierto && horario.franjas.length
        ? horario.franjas.map((f) => `${f.desde} a ${f.hasta}`).join(' y ')
        : '';
    if (grupo && grupo.franjas === franjas) {
      grupo.hasta = d;
      continue;
    }
    if (grupo) {
      partes.push(frase(grupo));
    }
    grupo = { desde: d, hasta: d, franjas };
  }
  if (grupo) {
    partes.push(frase(grupo));
  }
  return partes.join('; ');
}

function frase(g: { desde: number; hasta: number; franjas: string }): string {
  const dias = g.desde === g.hasta ? DIAS[g.desde] : `${DIAS[g.desde]} a ${DIAS[g.hasta]}`;
  return g.franjas ? `${dias} de ${g.franjas}` : `${dias} cerrado`;
}

// ---------------------------------------------------------------------------
// Ventana de 24 h (Meta)
// ---------------------------------------------------------------------------

export interface Ventana24h {
  /** true = se puede mandar texto libre; false = solo plantillas aprobadas. */
  abierta: boolean;
  /** Minutos que quedan de texto libre (0 si ya cerró). */
  restanteMin: number;
}

/**
 * Estado de la ventana de texto libre, contada desde el ÚLTIMO mensaje del
 * paciente. Sin mensajes entrantes la ventana está cerrada: nunca se abrió.
 */
export function ventana24h(ultimoEntranteISO: string | undefined, ahora: Date): Ventana24h {
  if (!ultimoEntranteISO) {
    return { abierta: false, restanteMin: 0 };
  }
  const cierra = new Date(ultimoEntranteISO).getTime() + VENTANA_LIBRE_HORAS * 60 * MINUTO_MS;
  const restanteMin = Math.floor((cierra - ahora.getTime()) / MINUTO_MS);
  return restanteMin > 0 ? { abierta: true, restanteMin } : { abierta: false, restanteMin: 0 };
}

/** "3 h 20 m" / "45 m" — para el indicador de la bandeja. */
export function textoRestante(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h > 0 ? `${h} h ${m} m` : `${m} m`;
}

// ---------------------------------------------------------------------------
// Detección de intención
// ---------------------------------------------------------------------------

/** Sin acentos y en minúsculas: "Horários" y "horarios" tienen que matchear igual. */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const RE_PAGO = /\b(pagu|pague|pago|pagado|transferenc|transferi|comprobante|deposit|abone|abonado)/;
// Sin "sesion" a propósito: "gracias por la sesión" no es un pedido de turno.
const RE_TURNO = /\b(turno|cita|reserva|reservar|agendar|sobreturno)/;
const RE_PEDIDO = /\b(quiero|querria|quisiera|necesito|puedo|podria|me gustaria|sacar|pedir|reservar|agendar|tienen|hay|disponib)/;
const RE_PRECIO = /\b(precio|precios|cuanto sale|cuanto cuesta|cuanto esta|valor|valores|tarifa|arancel|cotiz)/;
const RE_HORARIO = /\b(horario|horarios|abren|abierto|cierran|cierra|hasta que hora|a que hora abren)/;
// "donde es\b" y no "donde es": sin el borde, "¿dónde estacionar?" entraba por
// accidente. Ahora estacionar/estacionamiento/estación entran a propósito, igual
// que "en San Isidro" y "en tren/colectivo/auto": todas se contestan con la
// dirección, el mapa y (si está cargado) el bloque de cómo llegar.
const RE_UBICACION =
  /\b(donde (estan|esta|queda|quedan|es)\b|direccion|como llego|como se llega|como llegar|ubicacion|ubicados|mapa|estacion(ar|amiento)?\b|en san isidro|en tren\b|en colectivo\b|en auto\b)/;
const RE_HBOT = /\b(hbot|camara hiperbarica|hiperbarica|hiperbarico|oxigeno hiperbarico)/;
// IHHT = Hipoxia-Hiperoxia Intermitente. Sin acentos porque `normalizar()` los
// saca antes: "hipóxico" llega como "hipoxico". "Intermitente" sola NO está: es
// demasiado genérica para mandar un folleto por ella.
const RE_IHHT = /\b(ihht|hipoxia|hiperoxia|hipoxic|hiperoxic|entrenamiento (en|de) altura|altura simulada)/;
// Red Light = Fotobiomodulación. "Infrarrojo" a secas NO está: también es el
// sauna del circuito Recovery, y mandar el folleto de luz roja por él sería
// contestar otra cosa. "Fotobiomodul" cubre -ación y -ador.
const RE_RED_LIGHT = /\b(red ?light|red-light|fotobiomodul|luz roja|terapia (de|con) luz)|\bpbm\b/;
// Recovery Pro = el circuito de sauna infrarrojo, frío y red light. "Frío" y
// "crio" a secas NO están: la Crioterapia Localizada es OTRO servicio del
// catálogo, y "tengo frío" no es una consulta. "Sauna" sí: acá solo hay uno.
const RE_RECOVERY =
  /\b(recovery|sauna|ba[nñ]o de hielo|inmersion en frio|cold plunge|contraste|circuito (de )?recuperacion|circuito recovery)/;
// "Información" sola, o pidiendo material. Acotada a propósito: la palabra es
// tan genérica que un patrón amplio se tragaría mensajes que tienen que llegar
// a una persona.
const RE_INFO = /\b(informacion|info|folleto|catalogo|mas datos|quiero saber mas|como funciona)\b/;
/**
 * Señales de pregunta CLÍNICA. No son para contestar: son para NO contestar.
 *
 * "Cámara hiperbárica" aparece igual en "contame de la cámara" que en "¿puedo
 * hacer cámara con un stent?". La primera se responde con el link a nuestra
 * página publicada; la segunda la contesta el Director Médico (límite 1 de
 * docs/whatsapp-auto-respuestas.md). Ante la duda, a una persona.
 */
const RE_CLINICO =
  /\b(puedo|podria|es seguro|contraindic|riesgo|peligro|embaraz|marcapaso|stent|cancer|tumor|epoc|diabet|presion|medicac|tratamiento|operad|cirugia|lesion|dolor|sintoma|enfermedad|tengo)\b/;

/**
 * Qué quiere el mensaje. El orden importa y es deliberado:
 *
 *  - `humano` primero: es la salida de emergencia, gana siempre.
 *  - `comprobante-pago` antes que el resto: un comprobante con la palabra
 *    "turno" adentro sigue siendo un comprobante.
 *  - `turno-pedido` antes que `precios`: si alguien pide turno Y pregunta el
 *    precio, es mejor anotarle el pedido (Recepción le responde las dos cosas)
 *    que mandarle un link y perder la intención de reservar.
 *
 * Lo que no cae en ninguna es `generico`: acuse de recibo y a una persona. NO
 * adivinar es una decisión de diseño, no una limitación.
 */
export function detectarIntencion(texto: string, opts?: { conAdjunto?: boolean }): Intencion {
  const t = normalizar(texto);

  // La palabra SOLA, no mencionada al pasar: "el trato humano es excelente" no
  // debe apagar el bot. Se pide escribirla sola, así que se exige eso.
  if (t.replace(/[^a-z ]/g, '').trim() === normalizar(PALABRA_HUMANO)) {
    return 'humano';
  }
  // Con adjunto alcanza una pista de pago; sin adjunto se pide algo explícito
  // ("ya pagué", "mando comprobante") para no confundir una pregunta con un aviso.
  if (RE_PAGO.test(t) && (opts?.conAdjunto || /\b(ya|adjunto|envio|mando|te mando|aca|aqui)\b/.test(t))) {
    return 'comprobante-pago';
  }
  if (RE_TURNO.test(t)) {
    return RE_PEDIDO.test(t) ? 'turno-pedido' : 'turno-consulta';
  }
  if (RE_PRECIO.test(t)) {
    return 'precios';
  }
  // HBOT e información van DESPUÉS de turno y precios, por el mismo motivo por
  // el que `turno-pedido` gana a `precios`: "quiero un turno de cámara
  // hiperbárica" es un pedido de turno, no un pedido de folleto, y "cuánto sale
  // la cámara" es precio. Mandar el material en esos casos pierde la intención.
  //
  // Y cualquiera de las dos cede ante una señal clínica: ahí va a una persona.
  if (
    (RE_HBOT.test(t) || RE_IHHT.test(t) || RE_RECOVERY.test(t) || RE_RED_LIGHT.test(t) || RE_INFO.test(t)) &&
    RE_CLINICO.test(t)
  ) {
    return 'generico';
  }
  // Si nombra más de una terapia en el mismo mensaje gana la primera de este
  // orden (HBOT es la que más preguntan). Recovery va ANTES que Red Light a
  // propósito: el circuito incluye red light, así que "recovery con red
  // light" pregunta por Recovery. Es un empate raro y una persona lo completa.
  if (RE_HBOT.test(t)) {
    return 'hbot';
  }
  if (RE_IHHT.test(t)) {
    return 'ihht';
  }
  if (RE_RECOVERY.test(t)) {
    return 'recovery';
  }
  if (RE_RED_LIGHT.test(t)) {
    return 'red-light';
  }
  if (RE_INFO.test(t)) {
    return 'informacion';
  }
  if (RE_HORARIO.test(t) || RE_UBICACION.test(t)) {
    return 'horario-ubicacion';
  }
  return 'generico';
}

// ---------------------------------------------------------------------------
// Armado de la respuesta
// ---------------------------------------------------------------------------

export interface ContextoAutoRespuesta {
  ahora: Date;
  texto: string;
  conAdjunto?: boolean;
  /** Nombre de pila, para saludar. Sin él se saluda sin nombre. */
  nombre?: string;
  /** false = el número no coincide con ninguna ficha. */
  esConocido: boolean;
  /** Próximo turno del paciente, ya en palabras ("el jueves a las 15:00 · HBOT"). */
  proximoTurno?: string;
  /** Última auto-respuesta del hilo, para no repetirse. */
  ultima?: { intencion: Intencion; cuandoISO: string };
  /** Cuándo pidió hablar con una persona (silencia todo lo automático). */
  silencioDesdeISO?: string;
}

/**
 * El pedido de datos al número que NO está en la base: el ÚLTIMO globo de la
 * bienvenida (ver `BIENVENIDA_SALUDO` en config para el porqué del orden).
 *
 * Fuera de horario cambia: avisa que está cerrado, dice CUÁNDO se responde y
 * suma el horario de la semana. El "cuándo" NO se hardcodea — un "mañana" fijo
 * miente los sábados a la noche, que reabren el lunes. Lo calcula
 * `textoProximaApertura` contra el horario real, así que si cambia el horario
 * cambia el mensaje (Andrés, 2026-08-24).
 */
function pedidoDeDatos(abierto: boolean, apertura: string | undefined): string {
  const pedido = `Para poder asesorarte, compartinos por favor:\n\n${PEDIDO_DATOS}`;

  if (abierto) {
    return `${pedido}\n\nEnseguida te contacta alguien del equipo.`;
  }

  // Sin apertura calculable (horario sin ningún día abierto) no se promete una
  // hora que no existe.
  const cuando = apertura ? `te respondemos ${apertura}` : 'te respondemos apenas reabramos';
  return `${pedido}\n\nAhora estamos cerrados: ${cuando}.\nHorario: ${textoHorarioSemanal()}.`;
}

export interface DecisionAutoRespuesta {
  intencion: Intencion;
  /** El texto a mandar por WhatsApp. */
  texto: string;
  /**
   * Mensajes que salen DESPUÉS de `texto`, en globos aparte y con una pausa
   * entre medio. Se usan cuando partir el contenido se lee mejor que un solo
   * globo largo (ver `BIENVENIDA_SALUDO`).
   */
  mensajesSiguientes?: string[];
  /** Además, anotar una solicitud de turno para la bandeja de Recepción. */
  crearSolicitudTurno?: boolean;
  /** Además, dejar un aviso en la vista Avisos. */
  aviso?: { titulo: string; detalle: string };
  /** Además, arrancar el silencio automático de este hilo. */
  activarSilencio?: boolean;
}

function minutosDesde(iso: string, ahora: Date): number {
  return (ahora.getTime() - new Date(iso).getTime()) / MINUTO_MS;
}

/**
 * ¿Esta respuesta cierra con la invitación a la App (`CTA_APP`)?
 *
 * Casi siempre sí: la App es donde la paciente resuelve sola lo que acá le
 * estamos contestando a medias (pedir turno, ver su plan, escribirnos). Las
 * dos excepciones no son gusto:
 *
 * - `humano`: la persona pidió que la dejemos de contestar. Cerrar ese mensaje
 *   vendiéndole la App es exactamente lo contrario de lo que pidió.
 * - `generico` a un número **desconocido**: `CTA_APP` ya es el segundo globo
 *   de la bienvenida (ver `BIENVENIDA_SALUDO`). Dos veces el mismo bloque en
 *   diez segundos se lee como un error, no como insistencia.
 */
export function llevaCtaApp(intencion: Intencion, esConocido: boolean): boolean {
  if (intencion === 'humano') return false;
  if (intencion === 'generico' && !esConocido) return false;
  return true;
}

/** Pega `CTA_APP` al final del texto, separado por un renglón en blanco. */
function conCtaApp(texto: string): string {
  return `${texto.trimEnd()}\n\n${CTA_APP}`;
}

/**
 * Qué contestar (o no contestar) a un mensaje entrante.
 *
 * `undefined` significa **silencio deliberado**: el paciente pidió una persona,
 * o ya se le mandó esta misma respuesta hace un rato. En los dos casos, insistir
 * sería peor que callarse.
 */
export function armarAutoRespuesta(ctx: ContextoAutoRespuesta): DecisionAutoRespuesta | undefined {
  const decision = decidirRespuesta(ctx);
  // El cierre con la App se pega acá, una sola vez, y no caso por caso: así
  // ninguna intención nueva se lo olvida y las dos excepciones viven en un
  // solo lugar (`llevaCtaApp`).
  if (!decision || !llevaCtaApp(decision.intencion, ctx.esConocido)) return decision;
  return { ...decision, texto: conCtaApp(decision.texto) };
}

/** La decisión sin el cierre de la App: qué intención es y qué texto va. */
function decidirRespuesta(ctx: ContextoAutoRespuesta): DecisionAutoRespuesta | undefined {
  const intencion = detectarIntencion(ctx.texto, { conAdjunto: ctx.conAdjunto });

  // Silencio pedido por el paciente: no se manda NADA (ni siquiera el acuse).
  // Salvo que vuelva a escribir "HUMANO", que se le confirma de nuevo.
  if (
    ctx.silencioDesdeISO &&
    minutosDesde(ctx.silencioDesdeISO, ctx.ahora) < MINUTOS_SILENCIO_HUMANO &&
    intencion !== 'humano'
  ) {
    return undefined;
  }

  // Anti-repetición: la MISMA intención dos veces seguidas en poco rato se
  // contesta una sola vez. Una intención distinta sí pasa (un comprobante no
  // puede quedar sin acuse porque hace diez minutos hubo un "hola").
  if (
    ctx.ultima &&
    ctx.ultima.intencion === intencion &&
    minutosDesde(ctx.ultima.cuandoISO, ctx.ahora) < MINUTOS_ENTRE_AUTO_RESPUESTAS
  ) {
    return undefined;
  }

  const hola = ctx.nombre ? `¡Hola ${ctx.nombre}!` : '¡Hola!';
  const abierto = estaAbierto(ctx.ahora);
  const apertura = textoProximaApertura(ctx.ahora);
  // De quién depende la respuesta humana y cuándo llega. Es la frase que baja
  // la ansiedad: el paciente sabe que hay alguien del otro lado y cuándo.
  // Cerrado, al desconocido se le piden nombre y apellido; a quien ya está en
  // la base NO: lo saludamos por su nombre y pedírselo se lee como que no lo
  // reconocemos (captura de producción, 2026-09-15).
  const pedirDatos = ctx.esConocido ? '' : ' Por favor, dejanos tu nombre y apellido para contactarte.';
  const cuandoTeResponden = abierto
    ? 'Enseguida te contacta alguien del equipo.'
    : apertura
      ? `Ahora estamos cerrados: abrimos ${apertura} y te respondemos.${pedirDatos}`
      : 'Te responde alguien del equipo apenas reabramos.';
  // La misma frase después de una coma ("Si tenés dudas, ahora estamos…"):
  // baja SOLO la primera letra. Un `toLowerCase()` entero bajaba también el
  // "Por favor" que viene después de un punto (misma captura).
  const cuandoTeRespondenEnFrase = cuandoTeResponden.charAt(0).toLowerCase() + cuandoTeResponden.slice(1);

  switch (intencion) {
    case 'humano':
      return {
        intencion,
        texto: `${hola} Listo: le avisamos a una persona del equipo y no te mandamos más mensajes automáticos. ${cuandoTeResponden}`,
        activarSilencio: true,
        aviso: {
          titulo: 'Pidió hablar con una persona por WhatsApp',
          detalle: `${ctx.nombre ?? 'Un contacto'} escribió "${PALABRA_HUMANO}": las respuestas automáticas quedaron apagadas en ese chat. Responder desde Mensajes.`,
        },
      };

    case 'comprobante-pago':
      return {
        intencion,
        texto: `${hola} Recibimos tu comprobante 🧾 Lo verificamos y te confirmamos. ${cuandoTeResponden}`,
        aviso: {
          titulo: 'Comprobante de pago por WhatsApp',
          detalle: `${ctx.nombre ?? 'Un contacto'} mandó un comprobante de pago${
            ctx.conAdjunto ? ' con adjunto' : ''
          }. Verificarlo contra MercadoPago o caja y registrarlo. El mensaje está en Mensajes.`,
        },
      };

    case 'turno-pedido':
      return {
        intencion,
        texto: `${hola} ¡Buenísimo! Anotamos tu pedido de turno 📝 Recepción te escribe con los horarios disponibles. ${cuandoTeResponden}`,
        // Va a la bandeja de Solicitudes, que es donde Recepción ya resuelve
        // los pedidos de turno: no se inventa una cola nueva.
        crearSolicitudTurno: ctx.esConocido,
        ...(ctx.esConocido
          ? {}
          : {
              aviso: {
                titulo: 'Pedido de turno de un número desconocido',
                detalle: `Pidió turno por WhatsApp: "${ctx.texto.slice(0, 200)}". El número no coincide con ninguna ficha: crearla y cargar la solicitud.`,
              },
            }),
      };

    case 'turno-consulta':
      return {
        intencion,
        texto: ctx.proximoTurno
          ? `${hola} Tenés turno ${ctx.proximoTurno}. Si querés cambiarlo o sacar otro, decinos. ${cuandoTeResponden}`
          : `${hola} No te encontramos un turno próximo agendado. Si querés sacar uno, escribinos "quiero un turno" y lo anotamos. ${cuandoTeResponden}`,
      };

    case 'precios':
      return {
        intencion,
        texto:
          `${hola} Podés ver todos los precios acá:\n\n` +
          listaDeLinks(LINKS_PRECIOS) +
          `\n\nSi querés que te armemos algo a medida, ${cuandoTeRespondenEnFrase}`,
      };

    case 'hbot':
      return {
        intencion,
        texto:
          `${hola} Te dejamos todo sobre la Cámara Hiperbárica:\n\n` +
          listaDeLinks(LINKS_HBOT) +
          `\n\nSi tenés dudas sobre tu caso en particular, ${cuandoTeRespondenEnFrase}`,
      };

    case 'ihht':
      return {
        intencion,
        texto:
          `${hola} Te dejamos todo sobre el IHHT (Hipoxia-Hiperoxia Intermitente):\n\n` +
          listaDeLinks(LINKS_IHHT) +
          `\n\nSi tenés dudas sobre tu caso en particular, ${cuandoTeRespondenEnFrase}`,
      };

    case 'red-light':
      return {
        intencion,
        texto:
          `${hola} Te dejamos todo sobre Red Light (Fotobiomodulación):\n\n` +
          listaDeLinks(LINKS_RED_LIGHT) +
          `\n\nSi tenés dudas sobre tu caso en particular, ${cuandoTeRespondenEnFrase}`,
      };

    case 'recovery':
      return {
        intencion,
        texto:
          `${hola} Te dejamos todo sobre Recovery Pro (sauna infrarrojo, frío y red light):\n\n` +
          listaDeLinks(LINKS_RECOVERY) +
          `\n\nSi tenés dudas sobre tu caso en particular, ${cuandoTeRespondenEnFrase}`,
      };

    case 'informacion':
      return {
        intencion,
        texto:
          `${hola} Acá tenés toda la información:\n\n` +
          listaDeLinks(LINKS_INFO) +
          `\n\nSi buscás algo puntual, ${cuandoTeRespondenEnFrase}`,
      };

    case 'horario-ubicacion': {
      // Bloques con aire, título arriba y link solo en su renglón (la misma
      // regla que el resto): dirección + mapa, horario + estado, y cómo llegar
      // si hay texto cargado. Antes iban tres renglones pegados y el mapa era
      // el link largo de Google (Andrés, 2026-09-15).
      const estado = abierto ? 'Ahora estamos abiertos, te esperamos 👋' : apertura ? `Abrimos ${apertura}.` : '';
      const comoLlegar = CENTRO_COMO_LLEGAR.length ? `\n\n🚗 Cómo llegar:\n${CENTRO_COMO_LLEGAR.join('\n')}` : '';
      return {
        intencion,
        texto:
          `${hola} Te dejamos la dirección y el horario:\n\n` +
          `📍 ${CENTRO_DIRECCION}\n${CENTRO_MAPA}\n\n` +
          `🕒 Horario: ${textoHorarioSemanal()}.` +
          (estado ? `\n${estado}` : '') +
          comoLlegar,
      };
    }

    default:
      return {
        intencion: 'generico',
        texto: ctx.esConocido
          ? `${hola} Recibimos tu mensaje 👋 ${cuandoTeResponden}${
              ctx.proximoTurno ? ` Te esperamos ${ctx.proximoTurno}.` : ''
            }`
          : BIENVENIDA_SALUDO,
        // Al desconocido le siguen la App y, ÚLTIMO, el pedido de datos: así
        // lo que conteste no puede llegar antes que la pregunta. Al que ya
        // está en la base no, que no necesita que le presenten el centro.
        ...(ctx.esConocido ? {} : { mensajesSiguientes: [CTA_APP, pedidoDeDatos(abierto, apertura)] }),
      };
  }
}
