/**
 * Teleconsulta — lógica pura (sin FHIR ni red).
 *
 * Decide **cuándo** se puede entrar a la sala, **qué dice** el token que abre la
 * puerta y **cuándo** un turno virtual amerita un aviso a Recepción. La firma
 * del token, la lectura del turno y la escritura de avisos viven en los bots
 * (`bw-teleconsulta-*`): acá no entra ni FHIR ni `node:crypto`.
 *
 * Por qué la separación importa acá más que en otros módulos: el token es la
 * ÚNICA barrera entre una consulta médica y cualquiera de internet. Que sus
 * reglas sean una función pura con tests, y no ramas adentro de un bot, es lo
 * que permite probar los bordes —el minuto antes, el minuto después, el turno
 * ajeno— sin levantar un servidor.
 *
 * Infraestructura y por qué de cada decisión: docs/teleconsulta-fase0.md.
 * Visión y circuito completo: docs/teleconsulta.md.
 */

/** Parámetros de la teleconsulta. Cambiarlos es una decisión de negocio. */
export const TELECONSULTA = {
  /**
   * Minutos ANTES del inicio en que se habilita el acceso. El paciente prueba
   * cámara y micrófono en la pantalla previa sin presión de reloj.
   */
  accesoAntesMin: 15,
  /**
   * Minutos DESPUÉS del fin en que todavía se emite token. Cubre la consulta
   * que se estira y la reconexión tras un corte, sin dejar la sala abierta
   * para siempre.
   */
  accesoDespuesMin: 60,
  /** Sin profesional pasados estos minutos del inicio → aviso a Recepción. */
  avisoProfesionalAusenteMin: 5,
  /** Sin paciente pasados estos minutos del inicio → aviso a Recepción. */
  avisoPacienteAusenteMin: 10,
  /**
   * Sin paciente pasados estos minutos → Recepción puede marcar `noshow`.
   * No lo marca el sistema solo: la decisión (y el efecto sobre la plata) es
   * de una persona.
   */
  noShowMin: 15,
  /** Duración del slot de la grilla virtual (Andrés, 2026-09-16). */
  slotMin: 60,
} as const;

/** Prefijo del nombre de sala. Ver `nombreSala`. */
export const PREFIJO_SALA = 'tc-';

/**
 * Página de la videollamada en el portal del paciente.
 *
 * **Es contrato con el portal** (confirmado por ellos el 2026-09-17), no una
 * preferencia nuestra: esta ruta viaja escrita en el WhatsApp de 2 h y en el
 * web push, que se mandan a teléfonos y no se pueden corregir después. Si el
 * portal la cambia, se cambia acá en el mismo deploy.
 */
export function rutaTeleconsulta(appointmentId: string): string {
  return `/teleconsulta/${appointmentId}`;
}

/** Rol con el que alguien entra a la sala. */
export type RolSala = 'profesional' | 'paciente';

const MINUTO_MS = 60_000;

/**
 * Nombre de la sala a partir de un UUID.
 *
 * **Nunca lleva el nombre del paciente, su documento ni el id del turno.** El
 * nombre de la sala viaja en URLs, en el historial del navegador y en los logs
 * del servidor de video, que es infraestructura fuera de Medplum. Un UUID no
 * dice nada de nadie.
 */
export function nombreSala(uuid: string): string {
  return `${PREFIJO_SALA}${uuid}`;
}

/** ¿Es un nombre de sala de teleconsulta bien formado? */
export function esNombreSala(valor: string | undefined): boolean {
  if (!valor?.startsWith(PREFIJO_SALA)) {
    return false;
  }
  const uuid = valor.slice(PREFIJO_SALA.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

export interface VentanaAcceso {
  desde: Date;
  hasta: Date;
}

/**
 * Ventana en la que se emite token para un turno. Se calcula del turno, no del
 * momento en que alguien pregunta: dos pedidos para el mismo turno dan la misma
 * ventana.
 */
export function ventanaAcceso(inicio: Date, fin: Date): VentanaAcceso {
  return {
    desde: new Date(inicio.getTime() - TELECONSULTA.accesoAntesMin * MINUTO_MS),
    hasta: new Date(fin.getTime() + TELECONSULTA.accesoDespuesMin * MINUTO_MS),
  };
}

/** ¿`ahora` cae dentro de la ventana? Los bordes se incluyen. */
export function accesoPermitido(inicio: Date, fin: Date, ahora: Date): boolean {
  const v = ventanaAcceso(inicio, fin);
  return ahora.getTime() >= v.desde.getTime() && ahora.getTime() <= v.hasta.getTime();
}

/**
 * Por qué no se puede entrar, en castellano y para mostrarle al paciente.
 * `undefined` = se puede entrar.
 *
 * Distingue "todavía no" de "ya no" a propósito: son dos situaciones distintas
 * y el paciente hace cosas distintas con cada una (esperar, o escribirle a
 * Recepción).
 */
export function motivoSinAcceso(inicio: Date, fin: Date, ahora: Date): string | undefined {
  const v = ventanaAcceso(inicio, fin);
  if (ahora.getTime() < v.desde.getTime()) {
    return `Todavía no es la hora. Vas a poder entrar desde ${TELECONSULTA.accesoAntesMin} minutos antes de tu turno.`;
  }
  if (ahora.getTime() > v.hasta.getTime()) {
    return 'Esta videollamada ya terminó. Si necesitás retomar, escribinos y coordinamos.';
  }
  return undefined;
}

/**
 * El dominio del servidor de video, como lo quiere Jitsi: **solo el host**.
 *
 * El secret se llama `JITSI_BASE_URL` y el nombre engaña: no es una URL, es el
 * host pelado (`meet.biowellness.ar`). Va al claim `sub` del token, y Prosody
 * lo compara contra el nombre del `VirtualHost`: con `https://` adelante o una
 * barra al final **no matchea y el token se rechaza**, con un error del lado
 * del servidor que desde el portal se ve como "no se pudo entrar".
 *
 * En vez de pedirle a quien carga el secret que recuerde esa sutileza, se
 * acepta cualquiera de las dos formas y se normaliza. Es la misma idea que
 * `aE164Argentino` con los teléfonos de la ficha: el dato entra como la gente
 * lo escribe y el sistema lo deja como lo necesita la integración.
 */
export function dominioJitsi(valor: string): string {
  return valor
    .trim()
    .replace(/^[a-z]+:\/\//i, '') // https:// · http://
    .replace(/\/+$/, ''); // barra(s) final(es)
}

export interface ClaimsToken {
  iss: string;
  aud: 'jitsi';
  sub: string;
  room: string;
  nbf: number;
  exp: number;
  context: { user: { name: string; affiliation: 'owner' | 'member' } };
}

export interface DatosToken {
  /** Application ID configurado en Prosody (`app_id`). */
  appId: string;
  /** Dominio del servidor de video, ej. "meet.biowellness.ar". */
  dominio: string;
  /** Nombre de la sala (ver `nombreSala`). */
  sala: string;
  /** Nombre visible. **El elegido de la ficha**, nunca documento ni email. */
  nombre: string;
  rol: RolSala;
  inicio: Date;
  fin: Date;
}

/**
 * Los claims del token, **sin firmar**. La firma HS256 la hace el bot con la
 * clave de los Project Secrets: acá no entra `node:crypto`, igual que en
 * `bus-msal.ts`, para que nada de esto pueda arrastrarse al bundle del
 * navegador.
 *
 * Tres cosas que no son negociables y por eso viven acá y no en el bot:
 *  - `room` es UNA sala concreta, jamás `"*"`. Un token comodín abre todas.
 *  - `nbf`/`exp` salen de la ventana del turno, no de un "vale por 2 horas".
 *  - `affiliation` es `owner` SOLO para el profesional. Del lado del servidor,
 *    `mod_token_affiliation` lo traduce a moderador; el paciente entra como
 *    `member` y no puede silenciar ni expulsar a nadie.
 */
export function claimsToken(d: DatosToken): ClaimsToken {
  const v = ventanaAcceso(d.inicio, d.fin);
  return {
    iss: d.appId,
    aud: 'jitsi',
    sub: d.dominio,
    room: d.sala,
    nbf: Math.floor(v.desde.getTime() / 1000),
    exp: Math.floor(v.hasta.getTime() / 1000),
    context: {
      user: {
        name: d.nombre,
        affiliation: d.rol === 'profesional' ? 'owner' : 'member',
      },
    },
  };
}

/** Quién falta en una sala, evaluado en `ahora`. */
export type AvisoTeleconsulta = 'profesional-ausente' | 'paciente-ausente';

export interface PresenciaSala {
  /** ¿El paciente está conectado? */
  pacienteEnLinea: boolean;
  /** ¿El profesional está conectado? */
  profesionalEnLinea: boolean;
}

/**
 * ¿Corresponde avisarle a Recepción que falta alguien?
 *
 * Ventanas "hacia arriba" y evaluación en cada tick, igual que los
 * recordatorios de turno (`src/lib/recordatorios.ts`): si una corrida del cron
 * se saltea, el siguiente tick lo detecta igual. La idempotencia (no avisar dos
 * veces) la resuelve el bot con la clave del aviso.
 *
 * El caso del paciente esperando solo es el que más importa: es el único en el
 * que hay una persona real mirando una pantalla vacía.
 */
export function avisoDue(
  inicio: Date,
  presencia: PresenciaSala,
  ahora: Date,
): AvisoTeleconsulta | undefined {
  const pasadoMin = (ahora.getTime() - inicio.getTime()) / MINUTO_MS;
  if (pasadoMin < 0) {
    return undefined;
  }
  if (presencia.pacienteEnLinea && !presencia.profesionalEnLinea && pasadoMin >= TELECONSULTA.avisoProfesionalAusenteMin) {
    return 'profesional-ausente';
  }
  if (!presencia.pacienteEnLinea && pasadoMin >= TELECONSULTA.avisoPacienteAusenteMin) {
    return 'paciente-ausente';
  }
  return undefined;
}

/**
 * ¿Recepción ya puede marcar el turno como `noshow`?
 *
 * **Habilita, no ejecuta.** Marcar no-show tiene consecuencia sobre la plata
 * (el cobro es total y anticipado), y esa decisión la toma una persona que
 * puede haber hablado con el paciente por teléfono dos minutos antes.
 */
export function habilitaNoShow(inicio: Date, presencia: PresenciaSala, ahora: Date): boolean {
  if (presencia.pacienteEnLinea) {
    return false;
  }
  return (ahora.getTime() - inicio.getTime()) / MINUTO_MS >= TELECONSULTA.noShowMin;
}

/** Minutos que el paciente lleva esperando solo. 0 si no espera. */
export function minutosDeEspera(entroEl: Date | undefined, profesionalEnLinea: boolean, ahora: Date): number {
  if (!entroEl || profesionalEnLinea) {
    return 0;
  }
  return Math.max(0, Math.floor((ahora.getTime() - entroEl.getTime()) / MINUTO_MS));
}
