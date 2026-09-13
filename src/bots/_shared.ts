/**
 * Helpers compartidos por los bots de agenda (acceden a FHIR; no son "lib pura").
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import { getDisplayString } from '@medplum/core';
import type { Appointment, ChargeItem, Communication, Coverage, Encounter, Flag, Invoice, Slot, Task, TaskInput } from '@medplum/fhirtypes';
import type { ContextoPaciente } from '../lib/borrador.js';
import { COD,
  COD_CONSENTIMIENTO,
  COD_LOINC_CONSENTIMIENTO,
  CONFIG_TC_ID,
  EXT,
  EXT_LINEA_COMERCIAL,
  INTAKE_QUESTIONNAIRE_URL,
  LOINC_CONSENTIMIENTO,
  SYSTEM,
  TIPO_AVISO,
  esMedioPago,
  type MedioPago,
} from '../fhir/identifiers.js';
import { BUSQUEDA_ESPERAS, appointmentAEspera } from '../fhir/lista-espera.js';
import {
  candidatosParaHueco,
  detalleAvisoHueco,
  textoOfertaHueco,
  tituloAvisoHueco,
  type EntradaEspera,
  type HuecoLiberado,
} from '../lib/lista-espera.js';
import { estadoConsentimiento, type RegistroConsentimiento } from '../lib/consentimiento.js';
import { evaluarScreening } from '../lib/screening.js';
import { indiceSolicitudAResolver } from '../lib/solicitudes.js';
import { esPlanBW, estadoDeCoverage, planCodigoDeCoverage } from '../fhir/coverage.js';
import {
  calcularDisponibilidad,
  horarioOfrecido,
  isoHorarioPortal,
  perfilDeReserva,
  type DiaDisponible,
  type Disponibilidad,
  type HorarioDisponible,
  type SolicitudPendiente,
} from '../lib/disponibilidad.js';
import { MERCADOPAGO, type PerfilReserva } from '../config/reglas.js';
import type { IntensidadMembresia, Servicio } from '../domain/types.js';
import { resolverTC } from '../config/tipo-cambio.js';
import { CATEGORIA_COMERCIAL, getServicio, nombreServicioRecepcion } from '../config/catalogo.js';
import { getMembresia } from '../config/membresias.js';
import { claveSemana, perteneceASemana } from '../lib/semana-membresia.js';
import { getPaquete } from '../config/paquetes.js';
import { calcularSenaARS, type ItemCobro, type LineaCobro, type TipoItemCobro } from '../lib/pricing.js';
import { lineaComercialDeItem } from '../lib/cobros.js';
import { cicloMes, motivoNoDisponible, parseClavePlan, saldoPlan } from '../lib/planes.js';
import { evaluarCancelacion, type ReservaRecurso } from '../lib/reglas-turno.js';
import { isoArgentina } from '../lib/sena.js';
import { demoVigente } from '../lib/demo.js';
import { ventana24h } from '../lib/auto-respuesta.js';
import { SECRET_CONTENT_SID_GENERICO, aE164Argentino, contentVariables, nombreSecretContentSid } from '../lib/whatsapp.js';

type Secrets = BotEvent['secrets'];

/** Meta de datos de demostración (tag `demo`); se autodestruyen a las 48 h. */
export const META_DEMO = { tag: [{ system: SYSTEM.demo, code: 'demo' }] };

/** ¿El recurso está etiquetado `demo`? */
export function esRecursoDemo(r: { meta?: { tag?: Array<{ system?: string; code?: string }> } } | undefined): boolean {
  return Boolean(r?.meta?.tag?.some((t) => t.system === SYSTEM.demo && t.code === 'demo'));
}

/**
 * MODO AVIÓN de los pacientes demo: a un Patient con tag `demo` no le sale
 * NINGÚN mensaje real — ni WhatsApp (Twilio) ni email (SES).
 *
 * Por qué acá y no en cada bot: los crons (`bw-recordatorios`,
 * `bw-vencer-tentativas`, `bw-cobro-membresias`) no distinguen demo de real, y
 * este es el único embudo por el que salen los envíos. Sin el guard, una demo
 * de ocupación manda decenas de WhatsApp REALES a números inventados (que
 * pueden ser de gente real, con costo de Twilio) y los emails `@example.com`
 * rebotan en SES dañando la reputación del remitente.
 *
 * La Communication se registra igual, como 'completed' y CON el tag demo: el
 * hilo de Mensajes se ve vivo (sirve para capacitar) y la limpieza de 48 h
 * también se la lleva. Ante la duda (no se pudo leer el Patient) se asume real:
 * mejor un WhatsApp de más a un demo que uno de menos a un paciente.
 */
async function pacienteEsDemo(medplum: MedplumClient, pacienteRef: string | undefined): Promise<boolean> {
  const id = pacienteRef?.split('/')[1];
  if (!id) {
    return false;
  }
  const p = await medplum.readResource('Patient', id).catch(() => undefined);
  return esRecursoDemo(p);
}

/**
 * Tipos demo, en orden de borrado: hijos antes que padres (evita refs colgadas).
 * `Task` primero: sin él, las solicitudes y avisos demo (campanita) quedaban
 * huérfanos para siempre — la limpieza de 48 h no los tocaba.
 */
const TIPOS_DEMO = ['Task', 'Communication', 'Invoice', 'Coverage', 'Flag', 'Appointment', 'Slot', 'Patient'] as const;

/** Milisegundos de espera que pide un 429 de Medplum; undefined si no es 429. */
function esperaPor429(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/too many requests/i.test(msg)) {
    return undefined;
  }
  // El OperationOutcome trae el estado del limitador: {"_msBeforeNext":31575,…}.
  const m = /"_msBeforeNext"\s*:\s*(\d+)/.exec(msg);
  return m ? Number(m[1]) : 30_000;
}

/**
 * Reintenta `fn` esperando lo que pida la CUOTA FHIR de Medplum (429).
 *
 * Medplum limita a 50.000 puntos/minuto por usuario y cada ESCRITURA cuesta
 * 100 (500 escrituras/min). La demo de ocupación crea ~1.400 recursos y la
 * limpieza los borra: cualquiera de las dos se come la cuota en el primer
 * minuto. Sin esto, el generador moría por 429 a mitad de camino y la limpieza
 * TRAGABA los 429 en silencio — reportaba "borrado" dejando restos, y la
 * corrida siguiente apilaba una demo nueva sobre esos restos (turnos dobles).
 *
 * Un error que no es 429 se relanza intacto, sin reintentos.
 */
export async function conEsperaDeCuota<T>(fn: () => Promise<T>, maxEsperas = 10): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await fn();
    } catch (err) {
      const ms = esperaPor429(err);
      if (ms === undefined || intento >= maxEsperas) {
        throw err;
      }
      console.log(`  … cuota FHIR de Medplum llena: espero ${Math.ceil(ms / 1000)} s y sigo`);
      await new Promise((r) => setTimeout(r, ms + 250));
    }
  }
}

export interface ResultadoBorradoDemo {
  borrados: number;
  porTipo: Record<string, number>;
}

/**
 * Borra recursos etiquetados `demo`. Si se pasa `antesDe` (ISO), borra solo los
 * más viejos que esa fecha (`_lastUpdated < antesDe`) — así el cron elimina los
 * que ya cumplieron 48 h. Sin `antesDe`, borra TODOS los demo. Nunca toca datos
 * sin el tag demo.
 */
export async function borrarRecursosDemo(
  medplum: MedplumClient,
  opts: { antesDe?: string } = {},
): Promise<ResultadoBorradoDemo> {
  const porTipo: Record<string, number> = {};
  let borrados = 0;
  // Limpieza AUTOMÁTICA (con corte de 48 h): respeta la vigencia declarada con
  // el tag `demo-hasta` (una demo "hasta el 15/09" vive hasta esa fecha). El
  // borrado explícito (sin corte) se lleva todo, vigente o no.
  const hoy = opts.antesDe ? fechaCivilAR(new Date()) : undefined;
  for (const tipo of TIPOS_DEMO) {
    let query = `_tag=${SYSTEM.demo}|demo&_count=1000`;
    if (opts.antesDe) {
      query += `&_lastUpdated=lt${opts.antesDe}`;
    }
    const recursos = await conEsperaDeCuota(() => medplum.searchResources(tipo, query));
    for (const r of recursos) {
      if (!r.id) {
        continue;
      }
      if (hoy && demoVigente(r.meta, hoy)) {
        continue;
      }
      try {
        // Un 429 acá se ESPERA, no se traga: si se tragara, la limpieza
        // reportaría éxito dejando restos, y la demo siguiente se apilaría
        // encima (turnos duplicados en la misma sala y hora).
        await conEsperaDeCuota(() => medplum.deleteResource(tipo, r.id!));
        porTipo[tipo] = (porTipo[tipo] ?? 0) + 1;
        borrados++;
      } catch {
        // referenciado o ya borrado: seguir
      }
    }
  }
  return { borrados, porTipo };
}

/** Project id del proyecto Medplum (vía el recurso Basic de configuración). */
export async function resolverProjectId(medplum: MedplumClient): Promise<string> {
  const fromProfile = medplum.getProfile()?.meta?.project;
  if (fromProfile) {
    return fromProfile;
  }
  const basic = await medplum.searchOne('Basic', `identifier=${CONFIG_TC_ID}`);
  if (basic?.meta?.project) {
    return basic.meta.project;
  }
  throw new Error('No pude determinar el projectId del proyecto Medplum.');
}

/** TC vigente: del recurso Basic de configuración; si no hay, el default. */
export async function leerTcVigente(medplum: MedplumClient): Promise<number> {
  try {
    const basic = await medplum.searchOne('Basic', `identifier=${CONFIG_TC_ID}`);
    const ext = basic?.extension?.find((e) => e.url === EXT.tcAplicado);
    if (ext?.valueDecimal && ext.valueDecimal > 0) {
      return ext.valueDecimal;
    }
  } catch {
    // sin servidor / sin recurso
  }
  return resolverTC();
}

/**
 * Envía un WhatsApp por Twilio y registra la Communication. Resuelve el teléfono
 * desde el paciente si no se pasa `to`. Si faltan credenciales o teléfono, NO
 * envía pero igual deja la Communication (estado 'preparation'). Los secretos de
 * Twilio se leen de event.secrets (Project Secrets de Medplum).
 */
/**
 * ¿Se le puede escribir texto libre a este paciente? (ventana de 24 h de Meta).
 *
 * Cuenta desde el último mensaje que el paciente mandó **por WhatsApp**. El
 * filtro por canal importa: un mensaje escrito desde el portal también deja una
 * Communication con `sender = Patient`, pero NO abre la ventana de WhatsApp —
 * darlo por bueno haría fallar el envío.
 *
 * Sin paciente (envíos a un número suelto) se asume cerrada: es lo conservador.
 */
async function ventanaWhatsAppAbierta(medplum: MedplumClient, pacienteRef: string | undefined): Promise<boolean> {
  if (!pacienteRef) {
    return false;
  }
  try {
    const recientes = await medplum.searchResources('Communication', `sender=${pacienteRef}&_sort=-sent&_count=5`);
    const ultimoWhatsApp = recientes.find((c) =>
      c.extension?.some((x) => x.url === EXT.canal && x.valueCode === 'whatsapp'),
    );
    return ventana24h(ultimoWhatsApp?.sent, new Date()).abierta;
  } catch {
    // Si no se puede averiguar, se asume cerrada: la plantilla llega siempre,
    // el texto libre no. Nunca dejar de enviar por no poder consultar esto.
    return false;
  }
}

export async function enviarWhatsApp(
  medplum: MedplumClient,
  secrets: Secrets,
  params: {
    template: string;
    body: string;
    /**
     * Variables posicionales para la plantilla aprobada ({{1}}, {{2}}, …).
     * Si la plantilla específica no tiene secret cargado, se usa la genérica
     * con el body completo como única variable; sin plantillas, texto libre.
     */
    variables?: string[];
    pacienteRef?: string;
    to?: string;
    identifier?: { system: string; value: string };
    about?: string;
    /**
     * URLs públicas (presignadas) de adjuntos: cada una sale como mensaje
     * aparte con `MediaUrl` en texto libre (ventana de 24 h). Twilio la
     * descarga en el momento, así que puede ser una URL firmada con expiración.
     */
    mediaUrls?: string[];
    /**
     * Manda SIEMPRE texto libre, sin plantilla. Para respuestas automáticas a un
     * mensaje entrante: por definición caen dentro de la ventana de 24 h de Meta
     * —el paciente acaba de escribir— así que la plantilla no hace falta, y el
     * texto va tal cual se redactó en vez de envuelto en la genérica.
     */
    sinPlantilla?: boolean;
  },
): Promise<Communication> {
  const modoAvion = await pacienteEsDemo(medplum, params.pacienteRef);

  let to = params.to;
  if (!to && params.pacienteRef && !modoAvion) {
    const id = params.pacienteRef.split('/')[1];
    if (id) {
      const p = await medplum.readResource('Patient', id).catch(() => undefined);
      to = p?.telecom?.find((t) => t.system === 'phone' || t.system === 'sms')?.value;
    }
  }

  const sid = secrets['TWILIO_ACCOUNT_SID']?.valueString;
  const token = secrets['TWILIO_AUTH_TOKEN']?.valueString;
  const from = secrets['TWILIO_WHATSAPP_FROM']?.valueString;

  let status: Communication['status'] = 'preparation';
  if (modoAvion) {
    // Modo avión (ver pacienteEsDemo): el hilo lo muestra como enviado, Twilio
    // nunca se entera.
    status = 'completed';
  } else if (to && sid && token && from) {
    // ¿Está abierta la ventana de 24 h de Meta? Si el paciente escribió hace
    // poco, el texto libre está permitido — y es MUCHO mejor que la plantilla:
    // una variable de plantilla no admite saltos de línea (Meta los borra) y la
    // genérica encima prefija "Hola: ", así que un mensaje de tres párrafos
    // llegaba aplastado en un bloque y con el saludo duplicado.
    const enVentana = params.sinPlantilla || (await ventanaWhatsAppAbierta(medplum, params.pacienteRef));

    // Plantillas disponibles: la específica de este mensaje o la genérica
    // ({{1}} = texto completo). Se resuelven SIEMPRE, aunque estemos en ventana:
    // sirven de respaldo si el texto libre resulta rechazado.
    const sidEspecifico = secrets[nombreSecretContentSid(params.template)]?.valueString;
    const sidGenerico = secrets[SECRET_CONTENT_SID_GENERICO]?.valueString;
    const sidDisponible = sidEspecifico ?? sidGenerico;
    // Dentro de la ventana va texto libre; fuera, la plantilla es la única opción.
    const contentSid = enVentana ? undefined : sidDisponible;
    const vars = sidEspecifico && params.variables?.length ? params.variables : [params.body];

    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    // El destino de la ficha puede estar en cualquier formato ("11 6931-5830"):
    // Twilio exige E.164. Sin normalizar, el envío falla en silencio.
    const destino = aE164Argentino(to) ?? to;
    const enviar = async (conSid: string | undefined): Promise<Response> =>
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          From: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
          To: `whatsapp:${destino}`,
          ...(conSid
            ? { ContentSid: conSid, ContentVariables: contentVariables(vars) }
            : { Body: params.body }),
        }),
      });

    // Texto principal (solo si hay cuerpo: un mensaje puede ser solo adjuntos).
    if (params.body) {
      let resp = await enviar(contentSid);
      // Autocuración en las DOS direcciones, porque las dos pueden fallar:
      //  - la plantilla, si Meta la rechaza (sin ejemplos, variables que no
      //    matchean) → se reintenta como texto libre;
      //  - el texto libre, si la ventana estaba cerrada de verdad (p. ej. el
      //    último mensaje del paciente entró por el portal y no por WhatsApp)
      //    → se reintenta con la plantilla, que es lo que Meta sí acepta.
      const respaldo = contentSid ? undefined : sidDisponible;
      if (!resp.ok && (contentSid || respaldo)) {
        console.log(
          `enviarWhatsApp: ${contentSid ? `plantilla ${contentSid}` : 'texto libre'} rechazado (${resp.status}): ` +
            `${(await resp.text().catch(() => '')).slice(0, 300)} — reintento ${contentSid ? 'como texto libre' : 'con plantilla'}`,
        );
        resp = await enviar(respaldo);
      }
      status = resp.ok ? 'completed' : 'entered-in-error';
      if (!resp.ok) {
        // Visible en CloudWatch (Lambda): código y detalle del rechazo de Twilio.
        console.log(`enviarWhatsApp: Twilio respondió ${resp.status} para ${destino}: ${(await resp.text().catch(() => '')).slice(0, 300)}`);
      }
    }

    // Adjuntos: uno por mensaje, en texto libre con MediaUrl (fuera de la
    // ventana de 24 h Meta los rechaza; queda logueado y el texto ya salió).
    for (const mediaUrl of (params.mediaUrls ?? []).filter((u) => /^https?:\/\//i.test(u)).slice(0, 5)) {
      const respMedia = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          From: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
          To: `whatsapp:${destino}`,
          MediaUrl: mediaUrl,
        }),
      });
      if (!respMedia.ok) {
        console.log(
          `enviarWhatsApp: adjunto no salió (${respMedia.status}): ${(await respMedia.text().catch(() => '')).slice(0, 300)}`,
        );
      } else if (!params.body) {
        status = 'completed';
      }
    }
  }

  return medplum.createResource<Communication>({
    resourceType: 'Communication',
    status,
    sent: new Date().toISOString(),
    // Con el tag demo, la limpieza de 48 h también borra estos mensajes.
    ...(modoAvion ? { meta: META_DEMO } : {}),
    ...(params.identifier ? { identifier: [params.identifier] } : {}),
    ...(params.about ? { about: [{ reference: params.about }] } : {}),
    ...(params.pacienteRef
      ? { subject: { reference: params.pacienteRef }, recipient: [{ reference: params.pacienteRef }] }
      : {}),
    // payload solo si hay cuerpo: un payload sin content[x] es FHIR inválido.
    ...(params.body ? { payload: [{ contentString: params.body }] } : {}),
    extension: [
      { url: EXT.canal, valueCode: 'whatsapp' },
      // templateUsado solo si hay template: una extensión sin valor viola ext-1.
      ...(params.template ? [{ url: EXT.templateUsado, valueString: params.template }] : []),
    ],
  });
}

/**
 * Envía un email con `medplum.sendEmail()` (proveedor SES configurado en el
 * servidor) y registra la Communication (canal 'email'). Resuelve el email del
 * paciente si no se pasa `to`. Si no hay destinatario o SES falla, NO interrumpe:
 * igual deja la Communication ('preparation' / 'entered-in-error').
 */
export async function enviarEmail(
  medplum: MedplumClient,
  params: {
    asunto: string;
    cuerpo: string;
    template: string;
    pacienteRef?: string;
    to?: string;
    about?: string;
    /** Remitente con nombre visible (debe ser una identidad SES verificada). */
    from?: string;
  },
): Promise<Communication> {
  // Mismo modo avión que enviarWhatsApp: a un paciente demo no le sale email
  // real — los `@example.com` rebotan en SES y eso daña la reputación del
  // remitente, que es compartida con los emails reales.
  const modoAvion = await pacienteEsDemo(medplum, params.pacienteRef);

  let to = params.to;
  if (!to && params.pacienteRef && !modoAvion) {
    const id = params.pacienteRef.split('/')[1];
    if (id) {
      const p = await medplum.readResource('Patient', id).catch(() => undefined);
      to = p?.telecom?.find((t) => t.system === 'email')?.value;
    }
  }

  let status: Communication['status'] = 'preparation';
  if (modoAvion) {
    status = 'completed';
  } else if (to) {
    try {
      await medplum.sendEmail({
        to,
        subject: params.asunto,
        text: params.cuerpo,
        ...(params.from ? { from: params.from } : {}),
      });
      status = 'completed';
    } catch (err) {
      // Visible en CloudWatch (Lambda) para diagnosticar SES sin adivinar.
      console.error('enviarEmail: SES/medplum.sendEmail falló:', err instanceof Error ? err.message : err);
      status = 'entered-in-error';
    }
  } else {
    console.warn('enviarEmail: sin destinatario (el paciente no tiene email).');
  }

  return medplum.createResource<Communication>({
    resourceType: 'Communication',
    status,
    sent: new Date().toISOString(),
    // Con el tag demo, la limpieza de 48 h también borra estos mensajes.
    ...(modoAvion ? { meta: META_DEMO } : {}),
    ...(params.about ? { about: [{ reference: params.about }] } : {}),
    ...(params.pacienteRef
      ? { subject: { reference: params.pacienteRef }, recipient: [{ reference: params.pacienteRef }] }
      : {}),
    // payload solo si hay cuerpo: un payload sin content[x] es FHIR inválido.
    ...(params.cuerpo ? { payload: [{ contentString: params.cuerpo }] } : {}),
    extension: [
      { url: EXT.canal, valueCode: 'email' },
      // templateUsado solo si hay template: una extensión sin valor viola ext-1.
      ...(params.template ? [{ url: EXT.templateUsado, valueString: params.template }] : []),
    ],
  });
}

/** Códigos de contraindicación activos de un Flag. */
export function extraerCodigos(flag: Flag): string[] {
  return (flag.code?.coding ?? []).map((c) => c.code).filter((c): c is string => Boolean(c));
}

/** Id del Schedule de un recurso físico (por identifier SCH_<codigo>). */
export async function scheduleIdDeRecurso(medplum: MedplumClient, recursoCodigo: string): Promise<string | undefined> {
  const sch = await medplum.searchOne('Schedule', `identifier=${SYSTEM.recursoCodigo}|SCH_${recursoCodigo}`);
  return sch?.id;
}

/** Turnos ocupados del día (todos los recursos), para validar capacidad/desfasaje. */
export async function cargarReservasDelDia(medplum: MedplumClient, dia: Date): Promise<ReservaRecurso[]> {
  const inicioDia = new Date(dia);
  inicioDia.setHours(0, 0, 0, 0);
  const finDia = new Date(dia);
  finDia.setHours(23, 59, 59, 999);
  return cargarReservasEnRango(medplum, inicioDia, finDia);
}

/**
 * Estados de Appointment que NO ocupan sala. Son los mismos que oculta el
 * timeline de recepción (`app/src/lib/timeline.ts`): si las dos pantallas no
 * usaran la misma lista, una mostraría ocupado lo que la otra ofrece libre.
 */
export const ESTADOS_SIN_SALA = new Set(['cancelled', 'entered-in-error', 'waitlist']);

/**
 * Agenda ocupada de un rango [desde, hasta], para la disponibilidad del portal
 * (ventana de hasta 7 días, R-13).
 *
 * Mira **las dos fuentes**: los Slots `busy` y los Appointments vivos. Dice la
 * teoría que alcanza con los Slots, porque cada reserva crea el suyo; dijo la
 * producción que no (2026-09-11: 285 Slots busy contra 511 Appointments vivos,
 * ~2:1 en las catorce salas). Un turno sin su Slot es invisible para el portal
 * y se vuelve a ofrecer: exactamente el bug que vio recepción. Recepción dibuja
 * Appointments y el portal decidía con Slots — dos fuentes de verdad para el
 * mismo hecho, y ya derivaron.
 *
 * La unión solo puede ofrecer de MENOS, nunca de más, que es el lado seguro
 * (y el que el repo ya eligió para las solicitudes pendientes). El de-duplicado
 * es exacto, no heurístico: un Appointment que referencia uno de los Slots ya
 * contados se saltea. Sin eso, la misma reserva pesaría doble y las salas de
 * reserva exclusiva chocarían contra sí mismas.
 *
 * La búsqueda va **acotada por los dos extremos y paginada**. Antes pedía
 * `start ge desde` sin techo y una sola página de 1000: todo lo que no entrara
 * en esa página desaparecía de la agenda ocupada **en silencio**.
 */
export async function cargarReservasEnRango(medplum: MedplumClient, desde: Date, hasta: Date): Promise<ReservaRecurso[]> {
  const reservas: ReservaRecurso[] = [];
  const slotsContados = new Set<string>();

  for await (const pagina of medplum.searchResourcePages('Slot', [
    ['status', 'busy'],
    ['start', `ge${desde.toISOString()}`],
    ['start', `le${hasta.toISOString()}`],
    ['_count', '1000'],
  ])) {
    for (const s of pagina) {
      const codigo = s.extension?.find((x) => x.url === EXT.recursoFisico)?.valueString;
      if (!codigo || !s.start || !s.end) {
        continue;
      }
      if (s.id) {
        slotsContados.add(s.id);
      }
      // Personas de la reserva (Slots viejos sin la extensión cuentan como 1).
      const ocupantes = s.extension?.find((x) => x.url === EXT.ocupantes)?.valueInteger ?? 1;
      reservas.push({ recursoCodigo: codigo, inicio: new Date(s.start), fin: new Date(s.end), ocupantes });
    }
  }

  for await (const pagina of medplum.searchResourcePages('Appointment', [
    ['date', `ge${desde.toISOString()}`],
    ['date', `le${hasta.toISOString()}`],
    ['_count', '1000'],
  ])) {
    for (const a of pagina) {
      const codigo = a.extension?.find((x) => x.url === EXT.recursoFisico)?.valueString;
      if (!codigo || !a.start || !a.end || ESTADOS_SIN_SALA.has(a.status ?? '')) {
        continue;
      }
      // Ya contado como Slot busy: no se cuenta de nuevo.
      if ((a.slot ?? []).some((ref) => slotsContados.has(ref.reference?.split('/')[1] ?? ''))) {
        continue;
      }
      const ocupantes = a.extension?.find((x) => x.url === EXT.ocupantes)?.valueInteger ?? 1;
      reservas.push({ recursoCodigo: codigo, inicio: new Date(a.start), fin: new Date(a.end), ocupantes });
    }
  }

  return reservas;
}

/**
 * Disponibilidad REAL para un paciente (la misma que pinta los chips del
 * portal): deriva su perfil R-13 en el server (tag-fm → FM · membresía →
 * intensidad · si no, público), carga la agenda ocupada de toda la ventana y
 * descuenta las solicitudes pendientes de otros. La usan `bw-disponibilidad`
 * (para ofrecer) y `bw-solicitar-turno` (para rechazar horarios ya tomados —
 * defensa en profundidad, feedback de recepción 2026-08-12).
 */
/**
 * Registros de consentimiento del paciente, como los necesita la lógica pura.
 *
 * `undefined` = NO se pudo consultar (→ 'no-verificable'), distinto de `[]`, que
 * significa "se consultó y no hay ninguno". Esa diferencia es la que hace que
 * todo el circuito falle CERRADO.
 *
 * Lee los dos recursos a propósito: el `Consent` es el hecho legal, y el
 * `DocumentReference` (LOINC 59284-0) cubre las firmas históricas anteriores a
 * que el portal empezara a crear el Consent. De acá sale estado, fecha y código
 * — nunca el contenido del documento.
 *
 * Compartida por `bw-estado-consentimiento` (la señal de Atender) y los bots de
 * reserva (R-20). Si divergieran, el badge diría una cosa y la reserva otra.
 */
export async function leerRegistrosConsentimiento(
  medplum: MedplumClient,
  pacienteRef: string,
): Promise<RegistroConsentimiento[] | undefined> {
  try {
    // Se busca por PACIENTE, no por category: el portal usa la categoría
    // estándar de HL7 y pone el código de Biowellness en `policyRule`.
    const consents = await medplum.searchResources('Consent', { patient: pacienteRef, _count: 50 });
    const registros: RegistroConsentimiento[] = consents.map((c) => ({
      estado: c.status,
      fechaISO: c.dateTime,
      codigo:
        c.policyRule?.coding?.find((cod) => cod.system === SYSTEM.consentimiento)?.code ??
        c.category?.flatMap((cat) => cat.coding ?? []).find((cod) => cod.system === SYSTEM.consentimiento)?.code,
    }));

    const docs = await medplum
      .searchResources('DocumentReference', {
        subject: pacienteRef,
        type: `${LOINC_CONSENTIMIENTO}|${COD_LOINC_CONSENTIMIENTO}`,
        _count: 20,
      })
      .catch(() => []);
    for (const d of docs) {
      // `superseded`/`entered-in-error` no cuentan como firma vigente.
      registros.push({
        estado: d.status === 'current' ? 'active' : 'inactive',
        fechaISO: d.date,
        codigo: COD_CONSENTIMIENTO.atencion,
      });
    }
    return registros;
  } catch {
    return undefined;
  }
}

export interface Screening {
  /** ¿Existe una respuesta completa del cuestionario de ingreso? */
  completo: boolean;
  /** linkIds de riesgo contestados afirmativamente (para el banner). */
  riesgosDeclarados: string[];
  /** Equivalentes en la tabla de contraindicaciones validada (para R-02). */
  contraindicacionesDeclaradas: string[];
}

/**
 * Lee y EVALÚA el cuestionario de ingreso (screening HBOT/IHHT).
 * `undefined` = no se pudo averiguar.
 *
 * Hasta 2026-08-28 esta lectura solo miraba que EXISTIERA una respuesta
 * completa ("de acá no sale ni una sola respuesta del paciente") — y ese era el
 * agujero del caso real del portal: declarar un neumotórax no tratado producía
 * el mismo "apto" y la misma reserva de HBOT que negar todo, porque nadie
 * abría las respuestas y ningún proceso las convertía en Flag. Ahora se toma la
 * respuesta más RECIENTE y se evalúa con `evaluarScreening`; de acá sigue sin
 * salir el detalle clínico — solo linkIds y códigos, nunca texto del paciente.
 */
export async function leerScreening(medplum: MedplumClient, pacienteRef: string): Promise<Screening | undefined> {
  try {
    const respuestas = await medplum.searchResources('QuestionnaireResponse', {
      subject: pacienteRef,
      questionnaire: INTAKE_QUESTIONNAIRE_URL,
      status: 'completed',
      _sort: '-authored',
      _count: 1,
    });
    const qr = respuestas[0];
    if (!qr) {
      return { completo: false, riesgosDeclarados: [], contraindicacionesDeclaradas: [] };
    }
    const r = evaluarScreening(qr.item);
    return { completo: true, riesgosDeclarados: r.declarados, contraindicacionesDeclaradas: r.codigos };
  } catch {
    return undefined;
  }
}

/**
 * Aptitud del paciente para reservar (R-20): consentimiento general firmado +
 * cuestionario de ingreso completo. Cada campo puede venir `undefined` si no se
 * pudo verificar, y `validarAptitudPaciente` bloquea igual — falla cerrado.
 * `contraindicacionesDeclaradas` alimenta R-02 junto con los Flags: lo que el
 * paciente declaró en el screening cuenta como contraindicación aunque nadie
 * lo haya cargado como Flag.
 */
export async function aptitudDePaciente(
  medplum: MedplumClient,
  pacienteRef: string,
): Promise<{
  consentimientoGeneralFirmado?: boolean;
  screeningCompleto?: boolean;
  contraindicacionesDeclaradas?: string[];
}> {
  const [registros, screening] = await Promise.all([
    leerRegistrosConsentimiento(medplum, pacienteRef),
    leerScreening(medplum, pacienteRef),
  ]);
  const consentimientoGeneralFirmado =
    registros === undefined
      ? undefined
      : estadoConsentimiento(registros, { codigo: COD_CONSENTIMIENTO.atencion }).estado === 'firmado';
  return {
    consentimientoGeneralFirmado,
    screeningCompleto: screening?.completo,
    contraindicacionesDeclaradas: screening?.contraindicacionesDeclaradas,
  };
}

export async function disponibilidadDePaciente(
  medplum: MedplumClient,
  pacienteRef: string,
  servicio: Servicio,
  ahora = new Date(),
): Promise<{ perfil: PerfilReserva; disp: Disponibilidad }> {
  let tagFm = false;
  const intensidades: IntensidadMembresia[] = [];
  try {
    const pacienteId = pacienteRef.split('/')[1]!;
    const paciente = await medplum.readResource('Patient', pacienteId);
    tagFm = paciente.extension?.find((x) => x.url === EXT.tagFm)?.valueBoolean === true;
  } catch {
    // ficha ilegible: se degrada a público (la ventana más corta)
  }
  const coberturas = await medplum.searchResources('Coverage', {
    beneficiary: pacienteRef,
    status: 'active',
    _count: 20,
  });
  for (const c of coberturas) {
    if (!esPlanBW(c) || estadoDeCoverage(c).tipo !== 'membresia') {
      continue;
    }
    const codigo = planCodigoDeCoverage(c);
    if (!codigo) {
      continue;
    }
    try {
      intensidades.push(getMembresia(codigo).intensidad);
    } catch {
      // plan desconocido: no cambia la ventana
    }
  }
  const perfil = perfilDeReserva(tagFm, intensidades);

  // Agenda ocupada de toda la ventana, en una sola búsqueda. Desde las 00:00
  // de hoy: una sesión EN CURSO (arrancó antes de "ahora") también pesa contra
  // la capacidad de los próximos horarios.
  const inicioHoy = new Date(ahora);
  inicioHoy.setHours(0, 0, 0, 0);
  const limite = new Date(ahora.getTime() + 7 * 24 * 60 * 60 * 1000); // techo FM
  const reservas = await cargarReservasEnRango(medplum, inicioHoy, limite);

  // Solicitudes pendientes (decisión 2026-07-26): un horario ya pedido desde el
  // portal deja de ofrecerse mientras Recepción no lo resuelva. Solo cuentan
  // los Task sin resolver Y con horario exacto elegido de los chips; el
  // vencimiento y el filtro por sala los aplica la lógica pura.
  const tasksPendientes = await medplum
    .searchResources('Task', `code=${COD.solicitudTurno}&status=requested,received,accepted,in-progress&_count=200`)
    .catch(() => []);
  const solicitudes = tasksPendientes
    .map((t): SolicitudPendiente | undefined => {
      const inicio = t.input?.find((i) => i.type?.text === 'preferencia-inicio')?.valueDateTime;
      if (!inicio) {
        return undefined; // preferencia en texto libre: no bloquea nada
      }
      return {
        inicio: new Date(inicio),
        servicioCodigo: t.input?.find((i) => i.type?.text === 'terapia-codigo')?.valueString,
        pedidaEn: t.authoredOn ? new Date(t.authoredOn) : undefined,
      };
    })
    .filter((s): s is SolicitudPendiente => Boolean(s));

  return { perfil, disp: calcularDisponibilidad({ servicio, perfil, ahora, reservas, solicitudes }) };
}

/**
 * Al reservar un turno/combo, da por RESUELTA la solicitud de turno pendiente del
 * paciente (Task `solicitud-turno`), para que desaparezca sola de la bandeja de
 * Recepción. Elige con `indiceSolicitudAResolver` (1 pendiente → esa; varias → la
 * que coincida por terapia; sin coincidencia → ninguna). Best-effort: un fallo acá
 * jamás rompe la reserva.
 */
export async function resolverSolicitudTurno(
  medplum: MedplumClient,
  pacienteRef: string,
  codigosReservados: string[],
  appointmentRef: string,
): Promise<void> {
  try {
    const pacienteId = pacienteRef.split('/')[1];
    if (!pacienteId) {
      return;
    }
    const pendientes = await medplum.searchResources(
      'Task',
      `code=${COD.solicitudTurno}&status=requested&patient=${pacienteId}&_sort=authored-on&_count=20`,
    );
    const idx = indiceSolicitudAResolver(
      pendientes.map((t) => ({ terapiaCodigo: t.input?.find((i) => i.type?.text === 'terapia-codigo')?.valueString })),
      codigosReservados,
    );
    const elegida = idx >= 0 ? pendientes[idx] : undefined;
    if (!elegida) {
      return;
    }
    await medplum.updateResource({
      ...elegida,
      status: 'completed',
      output: [
        ...(elegida.output ?? []),
        { type: { text: 'appointment' }, valueReference: { reference: appointmentRef } },
      ],
    });
  } catch {
    // Best-effort: si no se pudo, la solicitud queda para resolver a mano.
  }
}

// ============================================================================
// Contrato de pagos con Administración: helpers de Invoice / ChargeItem.
// ============================================================================

/** Extensión medio-pago del contrato: SIEMPRE valueString con código canónico. */
export function extMedioPago(medio: string): { url: string; valueString: string } {
  if (!esMedioPago(medio)) {
    throw new Error(`Medio de pago inválido: "${medio}". Canónicos: efectivo, tarjeta-debito, tarjeta-credito, transferencia, mercadopago.`);
  }
  return { url: EXT.medioPago, valueString: medio };
}

/** Coding del ChargeItem: servicios → su CATEGORÍA (HBOT, CONSULTA…); resto → su código. */
function codingDeItem(tipo: TipoItemCobro, codigo: string, descripcion: string): { system: string; code: string; display: string } {
  if (tipo === 'servicio') {
    return { system: SYSTEM.servicioCodigo, code: getServicio(codigo).categoria, display: descripcion };
  }
  const system =
    tipo === 'combo' ? SYSTEM.comboCodigo : tipo === 'membresia' ? SYSTEM.membresiaCodigo : SYSTEM.paqueteCodigo;
  return { system, code: codigo, display: descripcion };
}

export interface DatosChargeItem {
  tipo: TipoItemCobro;
  codigo: string;
  descripcion: string;
  /** Monto BRUTO cobrado por esta línea, en ARS. */
  montoARS: number;
  cantidad?: number;
  splitBwUSD?: number;
  splitProfesionalUSD?: number;
}

/**
 * Crea los ChargeItem de un cobro (contrato con Administración): monto en
 * priceOverride.value, fecha en occurrenceDateTime, servicio en code.coding[0].code,
 * profesional en performer[0].actor (consultas) y extensión linea-comercial.
 */
export async function crearChargeItems(
  medplum: MedplumClient,
  opts: { pacienteRef: string; lineas: DatosChargeItem[]; tc: number; fecha?: string },
): Promise<ChargeItem[]> {
  const fecha = opts.fecha ?? new Date().toISOString();
  const creados: ChargeItem[] = [];
  for (const l of opts.lineas) {
    // Profesional (liquidación por médico): consultas → el Practitioner del servicio.
    let performer: ChargeItem['performer'];
    if (l.tipo === 'servicio') {
      const servicio = getServicio(l.codigo);
      if (servicio.practitionerCodigo) {
        const pract = await medplum.searchOne('Practitioner', `identifier=${SYSTEM.medico}|${servicio.practitionerCodigo}`);
        if (pract?.id) {
          performer = [{ actor: { reference: `Practitioner/${pract.id}`, display: pract.name?.[0]?.text } }];
        }
      }
    }
    const categoria = l.tipo === 'servicio' ? getServicio(l.codigo).categoria : undefined;
    const ci = await medplum.createResource<ChargeItem>({
      resourceType: 'ChargeItem',
      status: 'billable',
      subject: { reference: opts.pacienteRef },
      code: { coding: [codingDeItem(l.tipo, l.codigo, l.descripcion)], text: l.descripcion },
      occurrenceDateTime: fecha,
      quantity: { value: l.cantidad ?? 1 },
      priceOverride: { value: l.montoARS, currency: 'ARS' },
      ...(performer ? { performer } : {}),
      extension: [
        { url: EXT_LINEA_COMERCIAL, valueCode: lineaComercialDeItem(l.tipo, categoria) },
        { url: EXT.tcAplicado, valueDecimal: opts.tc },
        ...(l.splitBwUSD != null ? [{ url: EXT.montoSplitBw, valueMoney: { value: l.splitBwUSD, currency: 'USD' as const } }] : []),
        ...(l.splitProfesionalUSD != null
          ? [{ url: EXT.montoSplitProfesional, valueMoney: { value: l.splitProfesionalUSD, currency: 'USD' as const } }]
          : []),
      ],
    });
    creados.push(ci);
  }
  return creados;
}

/** LineaCobro (pricing) → datos del ChargeItem, con su porción de splits. */
export function lineaAChargeItem(l: LineaCobro): DatosChargeItem {
  return {
    tipo: l.tipo,
    codigo: l.codigo,
    descripcion: l.descripcion,
    montoARS: l.subtotalARS,
    cantidad: l.cantidad,
    splitBwUSD: l.split.bwUSD,
    splitProfesionalUSD: l.split.prescriptoresUSD ?? l.split.terapeutaUSD ?? l.split.proveedorUSD,
  };
}

// ============================================================================
// R-11 · Bloqueo administrativo por pago rechazado + alerta a recepción.
// ============================================================================

/** ¿Alguno de los Flags activos es un bloqueo administrativo (R-11)? */
export function tieneBloqueoPago(flags: Flag[]): boolean {
  return flags.some((f) => f.code?.coding?.some((c) => c.system === SYSTEM.bloqueo));
}

/** Marca al paciente con bloqueo de reservas por pago rechazado (idempotente). */
export async function setBloqueoPago(medplum: MedplumClient, pacienteRef: string, motivo: string): Promise<void> {
  const activos = await medplum.searchResources('Flag', `subject=${pacienteRef}&status=active`);
  if (tieneBloqueoPago(activos)) {
    return;
  }
  await medplum.createResource<Flag>({
    resourceType: 'Flag',
    status: 'active',
    category: [{ text: 'administrativo' }],
    code: { coding: [{ system: SYSTEM.bloqueo, code: 'PAGO_RECHAZADO' }], text: motivo },
    subject: { reference: pacienteRef },
  });
}

/** Levanta el bloqueo (pago regularizado): pasa los Flags de bloqueo a inactive. */
export async function quitarBloqueoPago(medplum: MedplumClient, pacienteRef: string): Promise<void> {
  const activos = await medplum.searchResources('Flag', `subject=${pacienteRef}&status=active`);
  for (const f of activos) {
    if (f.code?.coding?.some((c) => c.system === SYSTEM.bloqueo)) {
      await medplum.updateResource<Flag>({ ...f, status: 'inactive' });
    }
  }
}

/**
 * Alerta operativa para recepción → **vista Avisos**.
 *
 * El `code.coding` con `COD.avisoRecepcion` es lo que la hace encontrable: sin
 * él (como estaba hasta 2026-08-12) el Task se creaba con el título solo en
 * `code.text`, y como las búsquedas FHIR por token no miran el texto, ninguna
 * pantalla lo listaba — el aviso quedaba en la base sin que nadie lo viera.
 *
 * `datos` viaja como `Task.input` (mismo patrón que la solicitud de turno):
 * son los campos que la vista necesita en formato máquina para ofrecer
 * acciones (p. ej. responder por WhatsApp a un número desconocido), en vez de
 * tener que parsear el texto del detalle.
 *
 * Con `clave` es idempotente: si ya existe la alerta con ese identifier no se
 * duplica (p. ej. reintentos del webhook de MercadoPago).
 */
export async function crearAlertaRecepcion(
  medplum: MedplumClient,
  opts: {
    titulo: string;
    detalle: string;
    pacienteRef?: string;
    focusRef?: string;
    clave?: string;
    /** Subtipo (TIPO_AVISO) para habilitar acciones específicas en la vista. */
    tipo?: string;
    /** Datos estructurados del aviso: {telefono, texto, perfil, …}. */
    datos?: Record<string, string | undefined>;
  },
): Promise<Task> {
  if (opts.clave) {
    const existente = await medplum.searchOne('Task', `identifier=${SYSTEM.task}|${opts.clave}`);
    if (existente) {
      return existente;
    }
  }
  const input: TaskInput[] = [
    ...(opts.tipo ? [{ type: { text: 'tipo' }, valueString: opts.tipo }] : []),
    ...Object.entries(opts.datos ?? {})
      .filter(([, v]) => Boolean(v))
      .map(([k, v]) => ({ type: { text: k }, valueString: v as string })),
  ];
  return medplum.createResource<Task>({
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    priority: 'urgent',
    code: { coding: [{ system: SYSTEM.taskTipo, code: COD.avisoRecepcion }], text: opts.titulo },
    description: opts.detalle,
    authoredOn: new Date().toISOString(),
    ...(input.length ? { input } : {}),
    ...(opts.clave ? { identifier: [{ system: SYSTEM.task, value: opts.clave }] } : {}),
    ...(opts.pacienteRef ? { for: { reference: opts.pacienteRef } } : {}),
    ...(opts.focusRef ? { focus: { reference: opts.focusRef } } : {}),
  });
}

export interface ChequeoHorario {
  ok: boolean;
  /** Grilla fresca para repintar cuando el horario no está. */
  alternativas?: DiaDisponible[];
}

/**
 * ¿El horario pedido está realmente disponible para este paciente?
 *
 * Hay DOS fuentes de verdad distintas y confundirlas rompió producción:
 *
 * - **Terapias** → `disponibilidadDePaciente`: una grilla calculada sobre las
 *   salas, el horario del centro, la capacidad (R-07) y la **ventana del perfil
 *   (R-13)**, que para el público llega a 48 h.
 * - **Consultas médicas** → la **agenda publicada del profesional**
 *   (`Schedule SCH_<codigo>` + sus `Slot`). El médico decide cuándo atiende, y
 *   publica con semanas de anticipación.
 *
 * Validar una consulta contra la grilla de terapias rechazaba TODAS: un turno
 * del 25 de agosto queda fuera de la ventana de 48 h de un paciente público,
 * aunque el Slot del médico esté libre y el portal se lo esté mostrando.
 * Aplicarle R-13 a una consulta además es al revés de lo que se quiere: la
 * consulta es la PUERTA DE ENTRADA — el paciente nuevo es justamente el que
 * tiene la ventana más corta.
 *
 * Para la consulta la prueba es directa y no ambigua: un `Slot` `free` en la
 * agenda de ese profesional, comparado **como instante** (nunca como texto:
 * en el servidor conviven `-03:00` y `Z` con milisegundos).
 */
export async function chequearHorarioDisponible(
  medplum: MedplumClient,
  pacienteRef: string,
  servicio: Servicio,
  inicio: Date,
): Promise<ChequeoHorario> {
  if (servicio.practitionerCodigo) {
    return chequearAgendaMedico(medplum, servicio.practitionerCodigo, inicio);
  }
  const { disp } = await disponibilidadDePaciente(medplum, pacienteRef, servicio);
  return horarioOfrecido(disp.dias, inicio) ? { ok: true } : { ok: false, alternativas: disp.dias };
}

/** Slots libres de la agenda de un médico, y si el pedido está entre ellos. */
async function chequearAgendaMedico(
  medplum: MedplumClient,
  practitionerCodigo: string,
  inicio: Date,
): Promise<ChequeoHorario> {
  const sch = await medplum
    .searchOne('Schedule', `identifier=${SYSTEM.recursoCodigo}|SCH_${practitionerCodigo}`)
    .catch(() => undefined);
  if (!sch?.id) {
    // Sin agenda publicada no hay nada que contradecir: que decida Recepción,
    // como con cualquier código que este chequeo no sabe resolver.
    return { ok: true };
  }
  const libres = await medplum
    .searchResources('Slot', `schedule=Schedule/${sch.id}&status=free&_count=200`)
    .catch(() => [] as Slot[]);

  // Comparación por INSTANTE. Como texto fallaría en silencio en cuanto se
  // crucen los dos formatos de `start` que hay en el servidor.
  const pedido = inicio.getTime();
  if (libres.some((s) => s.start && new Date(s.start).getTime() === pedido)) {
    return { ok: true };
  }
  return { ok: false, alternativas: agruparPorDia(libres) };
}

/** Slots sueltos → la forma `DiaDisponible` que ya sabe pintar el portal. */
function agruparPorDia(slots: Slot[]): DiaDisponible[] {
  const porDia = new Map<string, HorarioDisponible[]>();
  const ahora = Date.now();
  for (const s of slots) {
    if (!s.start || new Date(s.start).getTime() <= ahora) {
      continue;
    }
    const inicio = new Date(s.start);
    const fin = s.end ? new Date(s.end) : new Date(inicio.getTime() + 60 * 60_000);
    // isoHorarioPortal, NO el isoArgentina de sena.ts: ese lleva milisegundos
    // y el portal no reconocería el horario como el mismo.
    const fecha = isoHorarioPortal(inicio).slice(0, 10);
    porDia.set(fecha, [
      ...(porDia.get(fecha) ?? []),
      { inicio: isoHorarioPortal(inicio), fin: isoHorarioPortal(fin) },
    ]);
  }
  return [...porDia.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fecha, horarios]) => ({
      fecha,
      horarios: horarios.sort((x, y) => x.inicio.localeCompare(y.inicio)),
    }));
}

/**
 * ¿Este turno es de este paciente?
 *
 * El portal manda el `appointmentId` que quiera: sin este chequeo, un paciente
 * podría cancelar o mover el turno de otro con solo cambiar un id. La
 * AccessPolicy limita lo que LEE, no lo que le pasa a un bot.
 */
export function esTurnoDelPaciente(appt: Appointment, pacienteRef: string): boolean {
  return (appt.participant ?? []).some((p) => p.actor?.reference === pacienteRef);
}

/** Estados sobre los que el paciente todavía puede actuar desde el portal. */
const ESTADOS_ACCIONABLES = new Set(['proposed', 'pending', 'booked', 'waitlist']);

/**
 * Si el turno NO se puede tocar, devuelve el motivo en castellano; si se puede,
 * `undefined`. El portal ya oculta los botones en estos casos, pero el bot no
 * puede confiar en eso: es la última línea antes de escribir en la agenda.
 */
export function motivoNoAccionable(appt: Appointment, ahora = new Date()): string | undefined {
  if (!ESTADOS_ACCIONABLES.has(appt.status ?? '')) {
    return appt.status === 'cancelled'
      ? 'Ese turno ya estaba cancelado.'
      : 'Ese turno ya no se puede modificar desde la app. Escribinos y lo vemos.';
  }
  if (appt.start && new Date(appt.start).getTime() <= ahora.getTime()) {
    return 'Ese turno ya pasó. Si necesitás otro, pedilo desde la app.';
  }
  return undefined;
}

/**
 * Libera la(s) sala(s) de un turno: pone en `free` los Slot que referencia.
 *
 * Devuelve los que NO se pudieron liberar en vez de tirar: quien llama sigue
 * con lo suyo y decide qué hacer. Cada Slot va en su propio try — con un combo
 * de tres salas, que la primera falle no puede dejar las otras dos tomadas.
 *
 * Un Slot que ya no existe no es un fallo: si se borró, no hay sala tomada por
 * él. Cualquier otro error sí se reporta.
 */
export async function liberarSalasDeTurno(medplum: MedplumClient, appt: Appointment): Promise<string[]> {
  const fallidos: string[] = [];
  for (const s of appt.slot ?? []) {
    const id = s.reference?.split('/')[1];
    if (!id) {
      continue;
    }
    try {
      const slot = await medplum.readResource('Slot', id);
      if (slot.status !== 'free') {
        await medplum.updateResource<Slot>({ ...slot, status: 'free' });
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!/not found/i.test(msg)) {
        fallidos.push(`Slot/${id}: ${msg}`);
      }
    }
  }
  return fallidos;
}

export interface ResultadoCancelacionTurno {
  appointment: Appointment;
  /** true si la sesión volvió al plan (R-14, o fuerza mayor declarada). */
  sesionDevuelta: boolean;
  /** Horas de anticipación con las que se canceló (para el mensaje). */
  horasAnticipacion?: number;
  /** El turno ya venía cancelado: no se hizo nada (idempotente). */
  yaEstabaCancelado: boolean;
}

/**
 * Cancela un turno y deja todo consistente: Encounter cerrado, saldo pendiente
 * anulado, sesión devuelta al plan si R-14 lo permite, lista de espera avisada
 * y sala(s) liberada(s).
 *
 * Vive acá y no en el bot porque **la cancelación entra por dos puertas**: el
 * mostrador (`bw-estado-turno`) y el portal (`bw-cancelar-turno`). Con dos
 * implementaciones, R-14 se aplicaría distinto según dónde apretaron el botón —
 * y la que se desactualice va a ser siempre en contra de alguien.
 *
 * Idempotente: cancelar dos veces no devuelve dos sesiones ni avisa dos veces.
 */
export async function cancelarTurnoYLiberar(
  medplum: MedplumClient,
  appt: Appointment,
  opts: {
    fuerzaMayorMedica?: boolean;
    /** Quién declaró la fuerza mayor (recepcionista o el propio paciente). */
    declaradaPorRef?: string;
    /** Texto libre del motivo: va al `cancelationReason` nativo de FHIR. */
    motivo?: string;
    ahora?: Date;
  } = {},
): Promise<ResultadoCancelacionTurno> {
  const ahora = opts.ahora ?? new Date();
  const appointmentId = appt.id as string;
  const estadoPrevio = appt.status;
  const yaEstabaCancelado =
    estadoPrevio === 'cancelled' || estadoPrevio === 'noshow' || estadoPrevio === 'entered-in-error';

  const actualizado = await medplum.updateResource<Appointment>({
    ...appt,
    status: 'cancelled',
    // Motivo en el campo NATIVO de FHIR: cualquier sistema que lea este
    // Appointment lo encuentra donde el estándar dice que está.
    ...(opts.motivo?.trim() ? { cancelationReason: { text: opts.motivo.trim().slice(0, 500) } } : {}),
    // La excepción de R-14 se registra EN el turno: quién la declaró y cuándo,
    // en el mismo lugar que la decisión que habilita.
    ...(opts.fuerzaMayorMedica
      ? {
          extension: [
            ...(appt.extension ?? []).filter(
              (x) => x.url !== EXT.cancelacionFuerzaMayor && x.url !== EXT.cancelacionDeclaradaPor,
            ),
            { url: EXT.cancelacionFuerzaMayor, valueBoolean: true },
            ...(opts.declaradaPorRef ? [{ url: EXT.cancelacionDeclaradaPor, valueString: opts.declaradaPorRef }] : []),
          ],
        }
      : {}),
  });

  // LIBERAR LA SALA VA ACÁ, pegado a la baja del turno, y no al final.
  //
  // Estaba último, después de cerrar el Encounter, anular el saldo, devolver la
  // sesión y avisar a la lista de espera. Si cualquiera de esos fallaba, la
  // función cortaba con el turno YA cancelado y la sala todavía tomada — para
  // siempre y sin que se note: recepción dibuja Appointments, así que el turno
  // cancelado desaparece de su pantalla, y del lado del portal queda un horario
  // que nunca se ofrece. Pasó de verdad (Slot/6407c4dc… · lun 15/09 · camilla).
  //
  // Cancelar un turno ES liberar la sala; lo de abajo es contabilidad y avisos,
  // que pueden fallar y reintentarse. El orden ahora dice eso.
  const salasNoLiberadas = await liberarSalasDeTurno(medplum, appt);

  await cerrarEncounterDeTurno(medplum, appointmentId, 'cancelled');

  // El saldo pendiente (50% restante) no se debe más. La seña YA COBRADA no se
  // toca: su devolución es plata y se decide a mano.
  const saldo = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|saldo-${appointmentId}`);
  if (saldo?.status === 'issued') {
    await medplum.updateResource({ ...saldo, status: 'cancelled' });
  }

  // R-14 · devolver la sesión al plan si canceló a tiempo. Solo si el turno se
  // pagó con un plan y solo si venía de un estado vivo.
  let sesionDevuelta = false;
  let horasAnticipacion: number | undefined;
  const coberturaRef = appt.extension?.find((x) => x.url === EXT.coberturaUsada)?.valueString;
  if (appt.start) {
    const r = evaluarCancelacion(ahora, new Date(appt.start), {
      fuerzaMayorMedica: opts.fuerzaMayorMedica ?? false,
    });
    horasAnticipacion = r.horasRestantes;
    if (coberturaRef && !yaEstabaCancelado && r.devuelveSaldo) {
      await devolverSesionDePlan(medplum, coberturaRef.split('/')[1] as string);
      sesionDevuelta = true;
    }
  }

  // El lugar que se libera es de alguien más: si hay gente en la lista de espera
  // a la que le sirve ESTE horario, Recepción se entera.
  if (!yaEstabaCancelado) {
    await avisarListaDeEspera(medplum, appt);
  }

  // El turno QUEDÓ cancelado, así que no tiramos: decirle al portal que la
  // cancelación falló, cuando en realidad se hizo, es peor. Pero tampoco es
  // mudo — queda en el AuditEvent de la ejecución, y `disponibilidad:check`
  // detecta la sala trabada y dice de qué turno vino.
  if (salasNoLiberadas.length > 0) {
    console.error(
      `bw-cancelar: el turno ${appointmentId} se canceló pero NO se liberó la sala: ${salasNoLiberadas.join(' · ')}`,
    );
  }

  return { appointment: actualizado, sesionDevuelta, horasAnticipacion, yaEstabaCancelado };
}

/** Cierra el Encounter de un turno (si existe). Compartido por los dos caminos. */
export async function cerrarEncounterDeTurno(
  medplum: MedplumClient,
  appointmentId: string,
  status: 'finished' | 'cancelled',
): Promise<void> {
  const enc = await medplum.searchOne('Encounter', `appointment=Appointment/${appointmentId}`);
  if (!enc) {
    return;
  }
  await medplum.updateResource<Encounter>({
    ...enc,
    status,
    period: { ...(enc.period ?? {}), end: new Date().toISOString() },
  });
}

export interface PreferenciaMP {
  ok: boolean;
  url?: string;
  mensaje?: string;
}

/**
 * Crea una preferencia de checkout de MercadoPago y devuelve el link de pago.
 * Compartida por el link manual (bw-link-mercadopago) y el link automático de
 * la reserva tentativa (R-19). Con `expira`, el link deja de aceptar pagos en
 * ese momento (el mismo vencimiento de la seña).
 */
export async function crearPreferenciaMP(
  secrets: Secrets,
  opts: {
    titulo: string;
    montoARS: number;
    /** external_reference del pago (lo enruta el webhook). */
    referencia: string;
    /** Clave de idempotencia del checkout (p. ej. `sena-{appointmentId}`). */
    idempotencia: string;
    appointmentId?: string;
    expira?: Date;
    /**
     * Solo medios de aprobación inmediata (binary_mode de MP): el pago se
     * aprueba o rechaza en el acto, sin quedar "pending". Para la seña es
     * obligatorio: un ticket de Rapipago acredita en días y la tentativa vence
     * en horas — el pago llegaría cuando el lugar ya se liberó.
     */
    soloAprobacionInmediata?: boolean;
  },
): Promise<PreferenciaMP> {
  const token = secrets['MERCADOPAGO_ACCESS_TOKEN']?.valueString;
  if (!token) {
    return { ok: false, mensaje: 'MercadoPago no está configurado (falta MERCADOPAGO_ACCESS_TOKEN en Project Secrets).' };
  }
  const appUrl = secrets['APP_BASE_URL']?.valueString ?? 'https://app.biowellness.ar';
  const notifUrl = secrets['MP_WEBHOOK_URL']?.valueString;
  // Sin webhook NO se genera link: el pago real se acreditaría sin que el
  // sistema se entere (la tentativa vencería con la seña ya cobrada). Antes
  // esto degradaba en silencio; con plata real, mejor frenar con instrucción.
  if (!notifUrl) {
    return {
      ok: false,
      mensaje:
        'Falta el Project Secret MP_WEBHOOK_URL (la URL pública del webhook): sin él, el pago se acreditaría sin confirmar nada. Cargarlo en Medplum (ver docs/puesta-en-produccion.md § MercadoPago) o cobrar en mostrador.',
    };
  }

  const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': opts.idempotencia,
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      items: [{ title: opts.titulo, quantity: 1, unit_price: opts.montoARS, currency_id: 'ARS' }],
      external_reference: opts.referencia,
      ...(opts.appointmentId ? { metadata: { appointmentId: opts.appointmentId } } : {}),
      // Lo que ve el cliente en el resumen de su tarjeta.
      statement_descriptor: 'BIOWELLNESS',
      // Cuotas EXPLÍCITAS. Sin esto cada link aceptaba el máximo que la cuenta
      // ofreciera por default, y el costo del financiamiento no se ve en ningún
      // tablero (R-18: se guardan montos brutos) — aparece recién en la
      // liquidación. Es una decisión comercial: vive en config/reglas.ts.
      payment_methods: { installments: MERCADOPAGO.maxCuotas },
      ...(opts.soloAprobacionInmediata ? { binary_mode: true } : {}),
      back_urls: { success: appUrl, pending: appUrl, failure: appUrl },
      auto_return: 'approved',
      notification_url: notifUrl,
      ...(opts.expira ? { expires: true, expiration_date_to: isoArgentina(opts.expira) } : {}),
    }),
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    return { ok: false, mensaje: `MercadoPago respondió ${resp.status}: ${detalle.slice(0, 400)}` };
  }
  const pref = (await resp.json()) as { init_point?: string; sandbox_init_point?: string };
  const url = pref.init_point ?? pref.sandbox_init_point;
  if (!url) {
    return { ok: false, mensaje: 'MercadoPago no devolvió un link de pago (init_point).' };
  }
  return { ok: true, url };
}

/**
 * Link de pago de la SEÑA de un turno tentativo (R-19): calcula el 50% del ítem
 * del turno y crea la preferencia con el vencimiento de la tentativa (si el
 * Appointment tiene `vence-sena`, el link expira ahí mismo). Devuelve el monto
 * aunque MercadoPago no esté configurado (url queda undefined y el mensaje
 * explica por qué); si el turno no tiene ítem, lanza.
 */
export async function linkSena(
  medplum: MedplumClient,
  secrets: Secrets,
  appt: Appointment,
  opts?: { tc?: number },
): Promise<{ senaARS: number; url?: string; mensaje?: string }> {
  const itemTipo = appt.extension?.find((e) => e.url === EXT.itemTipo)?.valueCode;
  const itemCodigo = appt.extension?.find((e) => e.url === EXT.itemCodigo)?.valueString;
  if (!itemTipo || !itemCodigo || !appt.id) {
    throw new Error('El turno no tiene ítem asociado para calcular la seña.');
  }
  const tc = opts?.tc ?? (await leerTcVigente(medplum));
  const { senaARS } = calcularSenaARS([{ tipo: itemTipo as ItemCobro['tipo'], codigo: itemCodigo }], { tc });
  const venceIso = appt.extension?.find((e) => e.url === EXT.venceSena)?.valueDateTime;
  const pref = await crearPreferenciaMP(secrets, {
    titulo: `Seña 50% · ${appt.description ?? itemCodigo}`,
    montoARS: senaARS,
    // Compat con el webhook: las señas viajan con el appointmentId pelado.
    referencia: appt.id,
    idempotencia: `sena-${appt.id}`,
    appointmentId: appt.id,
    // La seña vence en horas: nada de medios que acrediten en días.
    soloAprobacionInmediata: true,
    ...(venceIso ? { expira: new Date(venceIso) } : {}),
  });
  return { senaARS, url: pref.url, mensaje: pref.mensaje };
}

/**
 * Una notificación de MP llegó por una seña YA registrada: ¿retry benigno o
 * pago doble? Espejo de `autocurarInvoiceSaldado` §1, para señas:
 *  - mismo `mp-{paymentId}` ya registrado → mudo;
 *  - el Invoice era de MP pero sin id registrado (versión vieja) → solo
 *    registra la huella;
 *  - cualquier otro caso → el cliente pagó dos veces (o pagó por MP una seña
 *    ya cobrada en mostrador): alerta idempotente para devolver.
 */
async function registrarPagoSenaMP(medplum: MedplumClient, invoice: Invoice, mpPaymentId: string | undefined): Promise<void> {
  if (!mpPaymentId) {
    return;
  }
  const idNuevo = `mp-${mpPaymentId}`;
  const registrados = (invoice.identifier ?? [])
    .map((i) => i.value)
    .filter((v): v is string => Boolean(v?.startsWith('mp-')));
  if (registrados.includes(idNuevo)) {
    return;
  }
  const medio = invoice.extension?.find((x) => x.url === EXT.medioPago)?.valueString;
  const descripcion = invoice.lineItem?.[0]?.chargeItemCodeableConcept?.text ?? invoice.lineItem?.[0]?.chargeItemReference?.display ?? 'la seña';
  if (registrados.length === 0 && medio === 'mercadopago') {
    await medplum
      .updateResource<Invoice>({
        ...invoice,
        identifier: [...(invoice.identifier ?? []), { system: SYSTEM.invoice, value: idNuevo }],
      })
      .catch(() => undefined);
    return;
  }
  await crearAlertaRecepcion(medplum, {
    titulo: 'Pago DUPLICADO: devolver desde MercadoPago',
    detalle: `MercadoPago acreditó el pago ${mpPaymentId} de "${descripcion}" ($${(invoice.totalGross?.value ?? 0).toLocaleString('es-AR')}), pero esa seña YA estaba cobrada${
      medio ? ` (${medio})` : ''
    }. El cliente pagó dos veces: devolver este pago desde el panel de MercadoPago.`,
    pacienteRef: invoice.subject?.reference,
    focusRef: `Invoice/${invoice.id}`,
    clave: `pago-duplicado-sena-${mpPaymentId}`,
  });
}

export interface ResultadoConfirmacion {
  totalARS: number;
  senaARS: number;
  /** 50% restante que queda como Invoice pendiente (`saldo-{appointmentId}`). */
  saldoARS: number;
  invoiceId?: string;
  saldoInvoiceId?: string;
  confirmados: number;
  yaConfirmado: boolean;
  /** Si está: NO se confirmó (p. ej. pago tardío de una tentativa ya vencida). */
  rechazado?: string;
}

/**
 * Confirma una reserva al cobrarse la seña (50%): emite el Invoice de la seña
 * (`balanced`) Y el Invoice PENDIENTE del saldo restante (`issued`, clave
 * `saldo-{appointmentId}`), pasa el/los turno(s) a 'booked' (combos: todos los
 * componentes) y dispara el WhatsApp de confirmación. El saldo pendiente después
 * se cobra en mostrador (bw-cobrar-pendiente) o con link de MP (concepto saldo).
 * Idempotente: si ya existe el Invoice de esa seña (misma clave), no duplica ni
 * reenvía. La usan el cobro manual y el webhook de MP.
 */
export async function confirmarReserva(
  medplum: MedplumClient,
  secrets: Secrets,
  opts: { appointmentId: string; medioPago?: string; tc?: number; mpPaymentId?: string },
): Promise<ResultadoConfirmacion> {
  const appt = await medplum.readResource('Appointment', opts.appointmentId);
  const itemTipo = appt.extension?.find((e) => e.url === EXT.itemTipo)?.valueCode;
  const itemCodigo = appt.extension?.find((e) => e.url === EXT.itemCodigo)?.valueString;
  if (!itemTipo || !itemCodigo) {
    throw new Error('El turno no tiene ítem asociado para calcular la seña.');
  }

  const tc = opts.tc ?? (await leerTcVigente(medplum));
  const { totalARS, senaARS } = calcularSenaARS([{ tipo: itemTipo as ItemCobro['tipo'], codigo: itemCodigo }], { tc });

  const saldoARS = totalARS - senaARS;
  const claveSena = `sena-${opts.appointmentId}`;
  const claveSaldo = `saldo-${opts.appointmentId}`;

  // Idempotencia: una sola seña por turno. La clave del turno se busca SIEMPRE
  // (cubre seña manual y seña por MP); la clave mp-{paymentId} cubre reintentos
  // del webhook e Invoices viejos que solo tienen esa clave.
  const invoiceKey = opts.mpPaymentId ? `mp-${opts.mpPaymentId}` : claveSena;
  const existente =
    (await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|${claveSena}`)) ??
    (opts.mpPaymentId ? await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|${invoiceKey}`) : undefined);
  if (existente) {
    // Espejo de autocurarInvoiceSaldado §1: un mp-{paymentId} NUEVO sobre una
    // seña ya cobrada = pago doble real → alerta para devolver (los retries
    // del mismo pago son mudos).
    await registrarPagoSenaMP(medplum, existente, opts.mpPaymentId);
    const saldoExistente = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|${claveSaldo}`);
    return {
      totalARS,
      senaARS,
      saldoARS,
      invoiceId: existente.id,
      saldoInvoiceId: saldoExistente?.id,
      confirmados: 0,
      yaConfirmado: true,
    };
  }

  // Pago tardío (R-19): si la tentativa ya venció y se liberó (o el turno se
  // canceló por cualquier motivo), NO se confirma sobre un lugar que quizá ya
  // ocupó otro. Queda la alerta para que Recepción devuelva o reagende.
  // (Después de la idempotencia: un reintento del webhook sobre una seña ya
  // registrada no debe generar la alerta.)
  if (appt.status === 'cancelled' || appt.status === 'noshow' || appt.status === 'entered-in-error') {
    const pacienteRefTarde = appt.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    await crearAlertaRecepcion(medplum, {
      titulo: 'Seña recibida para una reserva vencida/cancelada',
      detalle: `Se acreditó la seña de $${senaARS.toLocaleString('es-AR')}${
        opts.mpPaymentId ? ` (MercadoPago, pago ${opts.mpPaymentId})` : ''
      } de "${appt.description ?? itemCodigo}", pero el turno está ${appt.status}. Reagendar con el paciente o devolver el pago.`,
      pacienteRef: pacienteRefTarde,
      focusRef: `Appointment/${appt.id}`,
      clave: `sena-tardia-${opts.appointmentId}`,
    });
    return {
      totalARS,
      senaARS,
      saldoARS,
      confirmados: 0,
      yaConfirmado: false,
      rechazado: `El turno está ${appt.status}: la seña llegó tarde. Se avisó a Recepción para reagendar o devolver.`,
    };
  }

  // Confirmar el/los turno(s) (todos los componentes del combo si aplica).
  const comboId = appt.identifier?.find((i) => i.system === SYSTEM.comboCodigo)?.value;
  const turnos: Appointment[] = comboId
    ? await medplum.searchResources('Appointment', `identifier=${SYSTEM.comboCodigo}|${comboId}`)
    : [appt];
  let confirmados = 0;
  for (const t of turnos) {
    if (t.status === 'pending' || t.status === 'proposed') {
      await medplum.updateResource({ ...t, status: 'booked' });
      confirmados++;
    }
  }

  const pacienteRef = appt.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;

  // CANDADO: el Invoice de la seña se crea PRIMERO y con create condicional
  // (If-None-Exist por la clave del turno) — es el mismo rol que cumple el
  // JSONPatch `test` en resolverInvoicePlan. De dos invocaciones concurrentes
  // (MP reenvía notificaciones; webhook + mostrador a la vez) el servidor deja
  // pasar UNA sola; la otra recibe el Invoice del ganador y no duplica ni
  // ChargeItems ni WhatsApp. El ganador se reconoce porque el Invoice volvió
  // con SU timestamp (`date`, precisión de ms).
  const fecha = new Date().toISOString();
  const descripcionSena = `Seña 50% · ${appt.description ?? itemCodigo}`;
  const invoice = await medplum.createResourceIfNoneExist<Invoice>(
    {
      resourceType: 'Invoice',
      status: 'balanced',
      date: fecha,
      identifier: [
        // Clave del turno SIEMPRE (permite rastrear la seña desde el Appointment,
        // también cuando entró por MP) + la clave del pago MP si corresponde.
        { system: SYSTEM.invoice, value: claveSena },
        ...(opts.mpPaymentId ? [{ system: SYSTEM.invoice, value: invoiceKey }] : []),
      ],
      ...(pacienteRef ? { subject: { reference: pacienteRef } } : {}),
      lineItem: [
        {
          chargeItemCodeableConcept: { text: descripcionSena },
          priceComponent: [{ type: 'base' as const, amount: { value: senaARS, currency: 'ARS' } }],
        },
      ],
      totalNet: { value: senaARS, currency: 'ARS' },
      totalGross: { value: senaARS, currency: 'ARS' },
      extension: [
        { url: EXT.esSena, valueBoolean: true },
        { url: EXT.tcAplicado, valueDecimal: tc },
        ...(opts.medioPago ? [extMedioPago(opts.medioPago)] : []),
      ],
    },
    `identifier=${SYSTEM.invoice}|${claveSena}`,
  );
  if (invoice.date !== fecha) {
    // Perdimos la carrera: otra invocación registró la seña entre la búsqueda
    // de arriba y este create. Ella termina el registro; acá solo el pago doble.
    await registrarPagoSenaMP(medplum, invoice, opts.mpPaymentId);
    const saldoExistente = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|${claveSaldo}`);
    return {
      totalARS,
      senaARS,
      saldoARS,
      invoiceId: invoice.id,
      saldoInvoiceId: saldoExistente?.id,
      confirmados,
      yaConfirmado: true,
    };
  }

  // Contrato: cada ítem cobrado deja su ChargeItem (acá, la seña del 50%).
  // Se crea DESPUÉS de ganar el candado, así una invocación perdedora no lo
  // duplica; si el bot muere justo acá, queda el lineItem con texto (como los
  // Invoices viejos) y los montos siguen correctos.
  if (pacienteRef) {
    const chargeItems: ChargeItem[] = await crearChargeItems(medplum, {
      pacienteRef,
      tc,
      fecha,
      lineas: [
        {
          tipo: itemTipo as TipoItemCobro,
          codigo: itemCodigo,
          descripcion: descripcionSena,
          montoARS: senaARS,
        },
      ],
    });
    if (chargeItems.length) {
      await medplum.updateResource<Invoice>({
        ...invoice,
        lineItem: chargeItems.map((ci) => ({
          chargeItemReference: { reference: `ChargeItem/${ci.id}`, display: descripcionSena },
          priceComponent: [{ type: 'base' as const, amount: { value: senaARS, currency: 'ARS' } }],
        })),
      });
    }
  }

  // El 50% restante queda como Invoice PENDIENTE (`issued`): aparece en "Pagos
  // pendientes" de Atender y en el modal del turno, y Administración ve seña y
  // saldo como dos Invoices del mismo turno. El ChargeItem del saldo se crea
  // recién al cobrarse (resolverInvoicePlan), igual que las cuotas de planes.
  let saldoInvoiceId: string | undefined;
  if (saldoARS > 0) {
    const descripcionSaldo = `Saldo 50% · ${appt.description ?? itemCodigo}`;
    // Create condicional también acá: si un Invoice de saldo quedó de una
    // corrida anterior (o de una carrera), el servidor devuelve ese.
    const saldoInvoice = await medplum.createResourceIfNoneExist<Invoice>(
      {
        resourceType: 'Invoice',
        status: 'issued',
        date: fecha,
        identifier: [{ system: SYSTEM.invoice, value: claveSaldo }],
        ...(pacienteRef ? { subject: { reference: pacienteRef } } : {}),
        lineItem: [
          {
            chargeItemCodeableConcept: { text: descripcionSaldo },
            priceComponent: [{ type: 'base' as const, amount: { value: saldoARS, currency: 'ARS' } }],
          },
        ],
        totalNet: { value: saldoARS, currency: 'ARS' },
        totalGross: { value: saldoARS, currency: 'ARS' },
        extension: [
          { url: EXT.tcAplicado, valueDecimal: tc },
          // Para crear el ChargeItem correcto (categoría / línea comercial) al cobrarse:
          { url: EXT.itemTipo, valueCode: itemTipo },
          { url: EXT.itemCodigo, valueString: itemCodigo },
        ],
      },
      `identifier=${SYSTEM.invoice}|${claveSaldo}`,
    );
    saldoInvoiceId = saldoInvoice.id;
  }

  const saldoTexto =
    saldoARS > 0 ? `$${saldoARS.toLocaleString('es-AR')} (se abona el día de la sesión)` : 'sin saldo pendiente';
  await enviarWhatsApp(medplum, secrets, {
    template: 'turno-confirmado',
    pacienteRef,
    // Plantilla aprobada: {{1}} turno · {{2}} seña · {{3}} saldo (ver docs/whatsapp-plantillas.md).
    variables: [appt.description ?? 'tu sesión', `$${senaARS.toLocaleString('es-AR')}`, saldoTexto],
    body: `Biowellness: ¡tu turno quedó confirmado! ${appt.description ?? ''}. Recibimos la seña de $${senaARS.toLocaleString('es-AR')}${
      saldoARS > 0 ? ` (saldo restante: $${saldoARS.toLocaleString('es-AR')}, se abona el día de la sesión)` : ''
    }. ¡Te esperamos!`,
  });

  // Campanita del portal: confirmación de la reserva + constancia del pago de la
  // seña. Idempotentes por invoiceKey (la misma clave del Invoice).
  await notificarPortal(medplum, {
    tipo: 'reserva-confirmada',
    pacienteRef,
    about: `Appointment/${appt.id}`,
    identifier: { system: SYSTEM.communication, value: `portal-reserva-${invoiceKey}` },
    texto: `¡Tu turno quedó confirmado!${appt.description ? ` ${appt.description}.` : ''}${
      appt.start ? ` ${fechaTurnoNotif(appt.start)}.` : ''
    } Te esperamos en San Isidro.`,
  });
  await notificarPortal(medplum, {
    tipo: 'pago-recibido',
    pacienteRef,
    about: `Invoice/${invoice.id}`,
    identifier: { system: SYSTEM.communication, value: `portal-pago-${invoiceKey}` },
    texto: `Recibimos tu seña de $${senaARS.toLocaleString('es-AR')}${
      opts.medioPago ? ` (${opts.medioPago})` : ''
    }. ¡Gracias!`,
  });

  return { totalARS, senaARS, saldoARS, invoiceId: invoice.id, saldoInvoiceId, confirmados, yaConfirmado: false };
}

export interface CobroPlan {
  invoiceId?: string;
  yaExistia: boolean;
  clave: string;
}

/**
 * Emite el Invoice de un plan (membresía mensual o paquete inicial). Idempotente
 * por la clave `plan-{coverageId}[-{ciclo}]`: si ya existe, no duplica. La usan el
 * alta del plan (asignar-plan) y el cron de cobro mensual (cobro-membresias).
 *
 * Contrato: `status:'balanced'` = cobrado (crea también el ChargeItem);
 * `status:'issued'` = pendiente de pago (el ChargeItem se crea recién al
 * confirmarse, ver `marcarInvoicePlanPagado`).
 */
export async function emitirInvoicePlan(
  medplum: MedplumClient,
  opts: {
    coverageId: string;
    pacienteRef?: string;
    /** `programa` (PB100D) se factura igual: el Invoice no lleva sesiones. */
    tipo: 'membresia' | 'paquete' | 'programa';
    planCodigo: string;
    descripcion: string;
    totalARS: number;
    tc: number;
    ciclo?: string;
    medioPago?: MedioPago;
    status?: 'balanced' | 'issued';
  },
): Promise<CobroPlan> {
  const key = opts.ciclo ? `plan-${opts.coverageId}-${opts.ciclo}` : `plan-${opts.coverageId}`;
  const status = opts.status ?? 'balanced';
  const existente = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|${key}`);
  if (existente) {
    return { invoiceId: existente.id, yaExistia: true, clave: key };
  }

  const fecha = new Date().toISOString();
  let chargeItems: ChargeItem[] = [];
  if (status === 'balanced' && opts.pacienteRef) {
    chargeItems = await crearChargeItems(medplum, {
      pacienteRef: opts.pacienteRef,
      tc: opts.tc,
      fecha,
      lineas: [{ tipo: opts.tipo, codigo: opts.planCodigo, descripcion: opts.descripcion, montoARS: opts.totalARS }],
    });
  }

  const invoice = await medplum.createResource<Invoice>({
    resourceType: 'Invoice',
    status,
    date: fecha,
    identifier: [{ system: SYSTEM.invoice, value: key }],
    ...(opts.pacienteRef ? { subject: { reference: opts.pacienteRef } } : {}),
    lineItem: chargeItems.length
      ? chargeItems.map((ci) => ({
          chargeItemReference: { reference: `ChargeItem/${ci.id}`, display: opts.descripcion },
          priceComponent: [{ type: 'base' as const, amount: { value: opts.totalARS, currency: 'ARS' } }],
        }))
      : [
          {
            chargeItemCodeableConcept: { text: opts.descripcion },
            priceComponent: [{ type: 'base' as const, amount: { value: opts.totalARS, currency: 'ARS' } }],
          },
        ],
    totalNet: { value: opts.totalARS, currency: 'ARS' },
    totalGross: { value: opts.totalARS, currency: 'ARS' },
    extension: [
      { url: EXT.tcAplicado, valueDecimal: opts.tc },
      // Para poder crear el ChargeItem al confirmarse el pago (webhook):
      { url: EXT.itemTipo, valueCode: opts.tipo },
      { url: EXT.itemCodigo, valueString: opts.planCodigo },
      ...(opts.ciclo ? [{ url: EXT.cicloMes, valueString: opts.ciclo }] : []),
      ...(opts.medioPago ? [extMedioPago(opts.medioPago)] : []),
    ],
  });
  return { invoiceId: invoice.id, yaExistia: false, clave: key };
}

/**
 * Activa un plan que estaba PENDIENTE DE PAGO (Coverage `draft`, alta inicial
 * con MercadoPago) cuando su Invoice `plan-…` se acredita. La vigencia arranca
 * en el PAGO, no en la asignación: recalcula ciclo (membresía) o período de
 * vigencia (paquete). Si el Coverage no existe o ya no está `draft`, no hace
 * nada (las cuotas de renovación pasan por acá y son no-op). La bienvenida al
 * paciente sale SOLO acá para el flujo pendiente (nunca antes de la plata).
 */
async function activarPlanPendiente(
  medplum: MedplumClient,
  clave: string,
  invoice: Invoice,
  secrets?: Secrets,
): Promise<void> {
  const parsed = parseClavePlan(clave);
  if (!parsed) {
    return;
  }
  const coverage = await medplum.readResource('Coverage', parsed.coverageId).catch(() => undefined);
  if (!coverage?.id || coverage.status !== 'draft') {
    return;
  }

  // Candado atómico (webhooks de MP concurrentes / mostrador + webhook a la
  // vez): el `test` falla en el server si otra invocación ya activó → solo UNA
  // gana la transición y manda la bienvenida (nunca doble WhatsApp).
  try {
    await medplum.patchResource('Coverage', coverage.id, [
      { op: 'test', path: '/status', value: 'draft' },
      { op: 'replace', path: '/status', value: 'active' },
    ]);
  } catch {
    return; // otra invocación está activando este mismo plan
  }

  const ahora = new Date();
  const tipoCob = coverage.extension?.find((x) => x.url === EXT.tipoCobertura)?.valueCode ?? 'membresia';
  const planCodigo = planCodigoDeCoverage(coverage);
  const extension = (coverage.extension ?? []).filter((x) => x.url !== EXT.cicloMes);
  let periodEnd: string | undefined;
  if (tipoCob === 'membresia') {
    extension.push({ url: EXT.cicloMes, valueString: cicloMes(ahora) });
  } else if (planCodigo) {
    try {
      const p = getPaquete(planCodigo);
      periodEnd = new Date(ahora.getTime() + p.vigenciaDias * 24 * 60 * 60 * 1000).toISOString();
    } catch {
      periodEnd = coverage.period?.end; // plan fuera de catálogo: conserva lo asignado
    }
  }
  await medplum.updateResource<Coverage>({
    ...coverage,
    status: 'active',
    period: { start: ahora.toISOString(), ...(periodEnd ? { end: periodEnd } : {}) },
    extension,
  });

  // Bienvenida + constancia, RECIÉN con el pago acreditado.
  const pacienteRef = coverage.beneficiary?.reference;
  const descripcion = invoice.lineItem?.[0]?.chargeItemCodeableConcept?.text?.split(' · ')[0] ?? 'tu plan';
  const totalARS = invoice.totalGross?.value ?? 0;
  const sesiones =
    coverage.extension?.find((x) => x.url === (tipoCob === 'membresia' ? EXT.sesionesMes : EXT.sesionesTotal))
      ?.valueInteger ?? 0;
  if (secrets) {
    await enviarWhatsApp(medplum, secrets, {
      template: 'plan-asignado',
      identifier: { system: SYSTEM.communication, value: `plan-activado-${clave}` },
      pacienteRef,
      body: `Biowellness: ¡pago acreditado y ${descripcion} activada! Tenés ${sesiones} sesiones${
        tipoCob === 'membresia' ? ' este mes' : ''
      } disponibles. ¡Te esperamos!`,
    });
  }
  await notificarPortal(medplum, {
    tipo: 'pago-recibido',
    pacienteRef,
    about: `Invoice/${invoice.id}`,
    identifier: { system: SYSTEM.communication, value: `portal-pago-${clave}` },
    texto: `¡Activamos ${descripcion}! Recibimos el pago de $${totalARS.toLocaleString('es-AR')}. Tenés ${sesiones} sesiones disponibles.`,
  });
}

/**
 * Un Invoice de plan/saldo YA saldado recibió otra notificación de pago o una
 * invocación llegó tarde a la carrera. Deja el sistema consistente sin duplicar:
 *  1. `mp-{paymentId}` NUEVO sobre un Invoice saldado = PAGO DOBLE real →
 *     alerta idempotente a Recepción para devolver. (Excepción: el primer
 *     webhook de un pago con tarjeta guardada —la renovación se resuelve antes
 *     de que llegue la notificación— solo registra el id, sin alertar.)
 *  2. ChargeItem faltante (crash entre el candado y el registro): lo repara,
 *     solo si el Invoice lleva quieto más de 2 minutos (si es reciente, el
 *     dueño del candado sigue trabajando y crearlo acá lo duplicaría).
 *  3. Completa la activación pendiente del alta inicial (Coverage draft).
 */
async function autocurarInvoiceSaldado(
  medplum: MedplumClient,
  invoice: Invoice,
  opts: { clave: string; medio?: MedioPago; secrets?: Secrets; mpPaymentId?: string },
): Promise<void> {
  const descripcion = invoice.lineItem?.[0]?.chargeItemCodeableConcept?.text ?? opts.clave;

  // 1) ¿Retry benigno o pago doble?
  if (opts.mpPaymentId) {
    const idNuevo = `mp-${opts.mpPaymentId}`;
    const registrados = (invoice.identifier ?? [])
      .map((i) => i.value)
      .filter((v): v is string => Boolean(v?.startsWith('mp-')));
    if (!registrados.includes(idNuevo)) {
      const medio = invoice.extension?.find((x) => x.url === EXT.medioPago)?.valueString;
      if (registrados.length === 0 && medio === 'mercadopago') {
        await medplum
          .updateResource<Invoice>({
            ...invoice,
            identifier: [...(invoice.identifier ?? []), { system: SYSTEM.invoice, value: idNuevo }],
          })
          .catch(() => undefined);
      } else {
        await crearAlertaRecepcion(medplum, {
          titulo: 'Pago DUPLICADO: devolver desde MercadoPago',
          detalle: `MercadoPago acreditó el pago ${opts.mpPaymentId} de "${descripcion}" ($${(invoice.totalGross?.value ?? 0).toLocaleString('es-AR')}), pero ese cobro YA estaba saldado${
            medio ? ` (${medio})` : ''
          }. El cliente pagó dos veces: devolver este pago desde el panel de MercadoPago.`,
          pacienteRef: invoice.subject?.reference,
          focusRef: `Invoice/${invoice.id}`,
          clave: `pago-duplicado-${opts.clave}-${opts.mpPaymentId}`,
        });
      }
    }
  }

  // 2) ChargeItem faltante (corrida anterior cortada tras el candado).
  const tieneChargeItem = invoice.lineItem?.some((li) => li.chargeItemReference);
  const quietoMs = Date.now() - new Date(invoice.meta?.lastUpdated ?? 0).getTime();
  if (!tieneChargeItem && quietoMs > 2 * 60_000) {
    const pacienteRef = invoice.subject?.reference;
    const tipo = invoice.extension?.find((e) => e.url === EXT.itemTipo)?.valueCode as TipoItemCobro | undefined;
    const planCodigo = invoice.extension?.find((e) => e.url === EXT.itemCodigo)?.valueString;
    const tc = invoice.extension?.find((e) => e.url === EXT.tcAplicado)?.valueDecimal ?? resolverTC();
    const totalARS = invoice.totalGross?.value ?? 0;
    if (pacienteRef && tipo && planCodigo) {
      const chargeItems = await crearChargeItems(medplum, {
        pacienteRef,
        tc,
        fecha: new Date().toISOString(),
        lineas: [{ tipo, codigo: planCodigo, descripcion, montoARS: totalARS }],
      });
      await medplum.updateResource<Invoice>({
        ...invoice,
        lineItem: chargeItems.map((ci) => ({
          chargeItemReference: { reference: `ChargeItem/${ci.id}`, display: descripcion },
          priceComponent: [{ type: 'base' as const, amount: { value: totalARS, currency: 'ARS' } }],
        })),
      });
    }
  }

  // 3) Activación pendiente (no-op si el Coverage ya está activo o no es plan).
  await activarPlanPendiente(medplum, opts.clave, invoice, opts.secrets);
}

/**
 * Desenlace del cobro de un plan pendiente (webhook de MP):
 * - `pagado`: Invoice → balanced + medio mercadopago + ChargeItem del plan +
 *   levanta el bloqueo R-11 si lo había. Si el plan estaba pendiente de pago
 *   (alta inicial con MP, Coverage `draft`), lo ACTIVA recién acá.
 * - `rechazado`: cuota de socio → Invoice `cancelled` + bloqueo R-11 + alerta.
 *   Alta inicial NO concretada (Coverage `draft`) → sin bloqueo y el Invoice
 *   queda `issued` (el link sigue vigente y también se puede cobrar en
 *   mostrador); solo alerta idempotente.
 * Idempotente y ATÓMICO: la transición a `balanced` usa un candado (JSONPatch
 * con `test` de status) para que webhooks concurrentes de MP —que reenvía
 * notificaciones— o webhook+mostrador a la vez nunca dupliquen ChargeItems.
 * Un `mpPaymentId` DISTINTO sobre un Invoice ya saldado = pago doble real →
 * alerta a Recepción para devolver (los retries del mismo pago son mudos).
 */
export async function resolverInvoicePlan(
  medplum: MedplumClient,
  opts: {
    clave: string;
    resultado: 'pagado' | 'rechazado';
    detalle?: string;
    medio?: MedioPago;
    secrets?: Secrets;
    /** Id del pago de MercadoPago (webhook): se registra como identifier `mp-{id}`. */
    mpPaymentId?: string;
  },
): Promise<{ ok: boolean; invoiceId?: string; mensaje?: string }> {
  const invoice = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|${opts.clave}`);
  if (!invoice?.id) {
    // Plata real acreditada sin registro interno: JAMÁS en silencio.
    if (opts.resultado === 'pagado' && opts.mpPaymentId) {
      await crearAlertaRecepcion(medplum, {
        titulo: 'Pago acreditado SIN registro interno',
        detalle: `MercadoPago acreditó el pago ${opts.mpPaymentId} con referencia "${opts.clave}", pero no existe ningún Invoice con esa clave. Verificar el pago en el panel de MP y registrarlo (o devolverlo) a mano.`,
        clave: `pago-sin-invoice-${opts.clave}-${opts.mpPaymentId}`,
      });
    }
    return { ok: false, mensaje: `No existe Invoice con clave ${opts.clave}.` };
  }
  // 'pagado' también recupera un Invoice `cancelled` (el paciente regularizó
  // después de un rechazo: se acredita y se levanta el bloqueo R-11).
  const puedeResolver =
    opts.resultado === 'pagado' ? invoice.status === 'issued' || invoice.status === 'cancelled' : invoice.status === 'issued';
  if (!puedeResolver) {
    if (opts.resultado === 'pagado' && invoice.status === 'balanced') {
      await autocurarInvoiceSaldado(medplum, invoice, opts);
    }
    return { ok: true, invoiceId: invoice.id, mensaje: `Invoice ya resuelto (${invoice.status}).` };
  }

  // Rechazo de un ALTA INICIAL nunca concretada (plan pendiente de pago): no
  // es una cuota impaga de un socio — sin bloqueo R-11 y el pendiente sigue
  // cobrable (link vigente / mostrador).
  if (opts.resultado === 'rechazado') {
    const parsed = parseClavePlan(opts.clave);
    if (parsed) {
      const cov = await medplum.readResource('Coverage', parsed.coverageId).catch(() => undefined);
      if (cov?.status === 'draft') {
        await crearAlertaRecepcion(medplum, {
          titulo: 'Pago inicial de plan rechazado',
          detalle: `MercadoPago rechazó el pago inicial de un plan pendiente ($${(invoice.totalGross?.value ?? 0).toLocaleString('es-AR')}). ${opts.detalle ?? ''} El plan sigue pendiente: el link continúa vigente y también puede cobrarse en mostrador.`,
          pacienteRef: invoice.subject?.reference,
          focusRef: `Invoice/${invoice.id}`,
          clave: `plan-rechazo-inicial-${opts.clave}`,
        });
        return { ok: true, invoiceId: invoice.id, mensaje: 'Pago inicial rechazado: el plan sigue pendiente (sin bloqueo R-11).' };
      }
    }
  }

  const pacienteRef = invoice.subject?.reference;
  const tipo = invoice.extension?.find((e) => e.url === EXT.itemTipo)?.valueCode as TipoItemCobro | undefined;
  const planCodigo = invoice.extension?.find((e) => e.url === EXT.itemCodigo)?.valueString;
  const tc = invoice.extension?.find((e) => e.url === EXT.tcAplicado)?.valueDecimal ?? resolverTC();
  const totalARS = invoice.totalGross?.value ?? 0;
  const descripcion = invoice.lineItem?.[0]?.chargeItemCodeableConcept?.text ?? planCodigo ?? 'Plan';

  if (opts.resultado === 'pagado') {
    // CANDADO atómico (JSONPatch `test`): de dos invocaciones concurrentes
    // (MP reenvía webhooks; webhook + mostrador a la vez) solo UNA gana la
    // transición a balanced y crea el ChargeItem. La otra completa lo que
    // falte sin duplicar nada.
    try {
      await medplum.patchResource('Invoice', invoice.id, [
        { op: 'test', path: '/status', value: invoice.status },
        { op: 'replace', path: '/status', value: 'balanced' },
      ]);
    } catch {
      const fresco = await medplum.readResource('Invoice', invoice.id).catch(() => undefined);
      if (fresco?.status === 'balanced') {
        await autocurarInvoiceSaldado(medplum, fresco, opts);
      }
      return { ok: true, invoiceId: invoice.id, mensaje: 'Invoice resuelto por una invocación concurrente.' };
    }

    const fecha = new Date().toISOString();
    let lineItem = invoice.lineItem;
    if (pacienteRef && tipo && planCodigo) {
      const chargeItems = await crearChargeItems(medplum, {
        pacienteRef,
        tc,
        fecha,
        lineas: [{ tipo, codigo: planCodigo, descripcion, montoARS: totalARS }],
      });
      lineItem = chargeItems.map((ci) => ({
        chargeItemReference: { reference: `ChargeItem/${ci.id}`, display: descripcion },
        priceComponent: [{ type: 'base' as const, amount: { value: totalARS, currency: 'ARS' } }],
      }));
    }
    await medplum.updateResource<Invoice>({
      ...invoice,
      status: 'balanced',
      date: fecha,
      lineItem,
      totalNet: { value: totalARS, currency: 'ARS' },
      // Rastro del pago de MP (como las señas): permite distinguir un retry
      // benigno del webhook de un PAGO DOBLE real (identifier mp-{paymentId}).
      identifier: [
        ...(invoice.identifier ?? []),
        ...(opts.mpPaymentId && !invoice.identifier?.some((i) => i.value === `mp-${opts.mpPaymentId}`)
          ? [{ system: SYSTEM.invoice, value: `mp-${opts.mpPaymentId}` }]
          : []),
      ],
      extension: [...(invoice.extension ?? []).filter((e) => e.url !== EXT.medioPago), extMedioPago(opts.medio ?? 'mercadopago')],
    });
    if (pacienteRef) {
      await quitarBloqueoPago(medplum, pacienteRef);
    }
    // Plan pendiente de pago (alta inicial): la plata ya está → activarlo.
    await activarPlanPendiente(medplum, opts.clave, invoice, opts.secrets);
    return { ok: true, invoiceId: invoice.id };
  }

  // Rechazado: Invoice cancelled + bloqueo R-11 + alerta a recepción.
  await medplum.updateResource<Invoice>({ ...invoice, status: 'cancelled' });
  if (pacienteRef) {
    await setBloqueoPago(medplum, pacienteRef, `Cobro de ${descripcion} rechazado por MercadoPago (R-11).`);
    await crearAlertaRecepcion(medplum, {
      titulo: 'Pago de membresía rechazado',
      detalle: `MercadoPago rechazó el cobro de "${descripcion}" ($${totalARS.toLocaleString('es-AR')}). ${opts.detalle ?? ''} El paciente queda bloqueado para nuevas reservas hasta regularizar (R-11).`,
      pacienteRef,
      focusRef: `Invoice/${invoice.id}`,
    });
  }
  return { ok: true, invoiceId: invoice.id };
}

export interface ConsumoPlan {
  coverage: Coverage;
  restantes: number;
  planCodigo: string;
}

/**
 * Consume una sesión de un plan (membresía o paquete) al reservar un turno.
 *
 * Valida (R-10) que el plan esté disponible (activo, no vencido, con saldo) y que
 * la base del plan coincida con lo que se reserva:
 *  - membresía → su `comboBaseCodigo` debe ser el combo del turno;
 *  - paquete   → su `servicioBaseCodigo` debe ser el servicio del turno.
 * Si todo OK, incrementa `sesiones-usadas` en el Coverage. Lanza si no procede.
 *
 * No es idempotente por sí sola: el bot que reserva decide cuándo llamarla (una
 * vez por turno creado con plan).
 */
/**
 * Un turno se liberó: si hay gente esperando ESE lugar, avisarle a Recepción.
 *
 * Es la contracara de la lista de espera. Sin esto, el hueco que deja una
 * cancelación desaparece en silencio — y desde que R-14 devuelve la sesión al
 * cancelar a tiempo (2026-08-14) van a liberarse más lugares y antes.
 *
 * **No le escribe al paciente por su cuenta, a propósito.** El lugar no queda
 * tomado: ofrecerlo automáticamente a alguien es una decisión comercial (y sin
 * mecanismo de reserva provisoria, dos personas pueden decir que sí al mismo
 * turno). El bot deja el aviso con los candidatos en orden y el texto listo;
 * Recepción decide y manda el WhatsApp de un clic desde la vista Avisos.
 *
 * Best-effort en todo: liberar el turno nunca puede fallar por la lista de
 * espera. Devuelve cuántos candidatos entraron en el aviso (0 = no hubo).
 */
export async function avisarListaDeEspera(
  medplum: MedplumClient,
  liberado: Appointment,
  ahora: Date = new Date(),
): Promise<number> {
  try {
    if (!liberado.start || !liberado.id) {
      return 0;
    }
    const inicio = new Date(liberado.start);
    const fin = liberado.end ? new Date(liberado.end) : inicio;
    const servicioCodigo = liberado.serviceType?.[0]?.coding?.find((c) => c.system === SYSTEM.servicioCodigo)?.code;
    // La categoría es la dimensión del match. Los turnos anteriores a
    // `clasificacionDeServicio` no la tienen: se deriva del código de servicio.
    let categoria = liberado.serviceCategory?.[0]?.coding?.find((c) => c.system === SYSTEM.categoriaServicio)?.code;
    let servicio;
    if (servicioCodigo) {
      try {
        servicio = getServicio(servicioCodigo);
        categoria = categoria ?? servicio.categoria;
      } catch {
        // servicio fuera del catálogo (dado de baja): queda la categoría del turno
      }
    }
    if (!categoria) {
      return 0;
    }
    const dejoElHueco = liberado.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    const hueco: HuecoLiberado = {
      inicio,
      fin,
      categoria,
      ...(servicioCodigo ? { servicioCodigo } : {}),
      ...(dejoElHueco ? { pacienteRef: dejoElHueco } : {}),
    };

    const esperas = await medplum.searchResources('Appointment', BUSQUEDA_ESPERAS);
    const entradas = esperas
      .map(appointmentAEspera)
      .filter((e): e is EntradaEspera => Boolean(e));
    const candidatos = candidatosParaHueco(entradas, hueco, ahora);
    if (candidatos.length === 0) {
      return 0;
    }

    // El teléfono vive en la ficha, no en la espera (una copia envejece). Son
    // tres lecturas como mucho, y solo cuando hay a quién avisarle.
    const conTelefono = await Promise.all(
      candidatos.map(async (c) => {
        const id = c.pacienteRef.split('/')[1];
        if (!id) {
          return c;
        }
        const p = await medplum.readResource('Patient', id).catch(() => undefined);
        const telefono = p?.telecom?.find((t) => t.system === 'phone' || t.system === 'sms')?.value;
        return { ...c, telefono, pacienteNombre: c.pacienteNombre ?? (p ? getDisplayString(p) : undefined) };
      }),
    );

    const nombreServicio = servicio
      ? nombreServicioRecepcion(servicio)
      : (CATEGORIA_COMERCIAL[categoria as keyof typeof CATEGORIA_COMERCIAL] ?? categoria);
    const datos: Record<string, string | undefined> = {
      cuando: inicio.toISOString(),
      servicio: nombreServicio,
      // El texto ya escrito: que la recepcionista no tenga que redactar el
      // ofrecimiento con la persona esperando del otro lado.
      oferta: textoOfertaHueco(hueco, nombreServicio),
    };
    conTelefono.forEach((c, i) => {
      datos[`candidato-${i + 1}`] = c.pacienteNombre ?? 'Paciente';
      datos[`telefono-${i + 1}`] = c.telefono;
      datos[`paciente-${i + 1}`] = c.pacienteRef;
      // Id de la espera: con esto la vista puede darla de baja cuando se resuelve.
      datos[`espera-${i + 1}`] = c.id;
    });

    await crearAlertaRecepcion(medplum, {
      titulo: tituloAvisoHueco(conTelefono),
      detalle: detalleAvisoHueco(hueco, conTelefono, nombreServicio),
      focusRef: `Appointment/${liberado.id}`,
      // Idempotente: cancelar dos veces el mismo turno no duplica el aviso.
      clave: `hueco-${liberado.id}`,
      tipo: TIPO_AVISO.huecoLiberado,
      datos,
    });
    return conTelefono.length;
  } catch {
    return 0;
  }
}

/**
 * Devuelve una sesión al plan (R-14): la operación inversa de
 * `consumirSesionDePlan`, para cuando un turno se cancela a tiempo.
 *
 * Existía el consumo y NO existía la devolución, así que quien cancelaba con la
 * anticipación que pide la regla perdía igual la sesión que había pagado. El
 * error iba siempre en contra del paciente.
 *
 * Nunca baja de 0: si la cuenta ya estaba en cero (o alguien canceló dos veces),
 * devolver de más le regalaría sesiones al plan.
 */
export async function devolverSesionDePlan(
  medplum: MedplumClient,
  coverageId: string,
): Promise<{ usadas: number } | undefined> {
  try {
    const coverage = await medplum.readResource('Coverage', coverageId);
    const extension = [...(coverage.extension ?? [])];
    const idx = extension.findIndex((x) => x.url === EXT.sesionesUsadas);
    const usadas = idx >= 0 ? (extension[idx]!.valueInteger ?? 0) : 0;
    if (usadas <= 0) {
      return { usadas: 0 };
    }
    const nuevas = usadas - 1;
    extension[idx] = { url: EXT.sesionesUsadas, valueInteger: nuevas };
    await medplum.updateResource<Coverage>({ ...coverage, extension });
    return { usadas: nuevas };
  } catch {
    // Best-effort: la cancelación del turno no puede fallar por esto. Queda la
    // sesión sin devolver y Recepción puede corregirla a mano.
    return undefined;
  }
}

export async function consumirSesionDePlan(
  medplum: MedplumClient,
  coverageId: string,
  reservado: { tipo: 'servicio' | 'combo'; codigo: string },
  ahora: Date = new Date(),
): Promise<ConsumoPlan> {
  const coverage = await medplum.readResource('Coverage', coverageId);
  const estado = estadoDeCoverage(coverage);
  const saldo = saldoPlan(estado, ahora);
  const motivo = motivoNoDisponible(saldo, estado.activo);
  if (motivo) {
    throw new Error(motivo);
  }

  const planCodigo = planCodigoDeCoverage(coverage);
  if (!planCodigo) {
    throw new Error('El plan no tiene código asociado.');
  }

  // La base del plan debe coincidir con lo reservado.
  if (estado.tipo === 'membresia') {
    const base = getMembresia(planCodigo).comboBaseCodigo;
    if (reservado.tipo !== 'combo' || reservado.codigo !== base) {
      throw new Error(`Este turno no corresponde a la membresía (base ${base}).`);
    }
  } else {
    const base = getPaquete(planCodigo).servicioBaseCodigo;
    if (reservado.tipo !== 'servicio' || reservado.codigo !== base) {
      throw new Error(`Este turno no corresponde al paquete (base ${base}).`);
    }
  }

  // Incrementar sesiones-usadas (crea la extensión si no existía).
  const extension = [...(coverage.extension ?? [])];
  const idx = extension.findIndex((x) => x.url === EXT.sesionesUsadas);
  const nuevasUsadas = estado.usadas + 1;
  if (idx >= 0) {
    extension[idx] = { url: EXT.sesionesUsadas, valueInteger: nuevasUsadas };
  } else {
    extension.push({ url: EXT.sesionesUsadas, valueInteger: nuevasUsadas });
  }
  const actualizado = await medplum.updateResource<Coverage>({ ...coverage, extension });

  return {
    coverage: actualizado,
    restantes: Math.max(estado.total - nuevasUsadas, 0),
    planCodigo,
  };
}

/* ------------------------------------------------------------------ */
/* Notificaciones del portal (campanita de Novedades)                  */
/* Contrato: docs/mensajeria-y-notificaciones.md del repo portal.      */
/* ------------------------------------------------------------------ */

/** CodeSystem compartido con el portal. NO cambiar sin tocar el portal. */
export const NOTIFICACION_SYSTEM = 'https://biowellness.ar/fhir/CodeSystem/notificacion';

export type TipoNotificacionPortal = 'reserva-confirmada' | 'reserva-vencida' | 'pago-recibido' | 'recordatorio' | 'general';

const fmtTurnoNotif = new Intl.DateTimeFormat('es-AR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});

/** Formatea el inicio de un turno para el texto de una notificación. */
export function fechaTurnoNotif(iso: string | undefined): string {
  return iso ? fmtTurnoNotif.format(new Date(iso)) : '';
}

/**
 * Crea la notificación que enciende la campanita del portal del paciente.
 * No envía nada por fuera (el WhatsApp/email van aparte): es una Communication
 * con category del CodeSystem propio, `in-progress` = no leída (el portal la
 * pasa a `completed` al abrirla). Sin `partOf` ni hijos, así NUNCA aparece en
 * el chat. Idempotente por `identifier` (opcional) y NUNCA interrumpe el flujo
 * que la dispara: ante cualquier error, loguea y devuelve undefined.
 */
export async function notificarPortal(
  medplum: MedplumClient,
  params: {
    tipo: TipoNotificacionPortal;
    /** Referencia FHIR del paciente, ej. "Patient/123". Sin paciente no se notifica. */
    pacienteRef?: string;
    texto: string;
    /** El recurso real: "Appointment/…", "Invoice/…", "CarePlan/…". El tap navega ahí. */
    about?: string;
    /** Idempotencia opcional (mismo patrón que los recordatorios). */
    identifier?: { system: string; value: string };
  },
): Promise<Communication | undefined> {
  if (!params.pacienteRef) {
    return undefined;
  }
  try {
    if (params.identifier) {
      const existente = await medplum.searchOne(
        'Communication',
        `identifier=${params.identifier.system}|${params.identifier.value}`,
      );
      if (existente) {
        return existente;
      }
    }
    return await medplum.createResource<Communication>({
      resourceType: 'Communication',
      status: 'in-progress',
      sent: new Date().toISOString(),
      subject: { reference: params.pacienteRef },
      recipient: [{ reference: params.pacienteRef }],
      category: [{ coding: [{ system: NOTIFICACION_SYSTEM, code: params.tipo }] }],
      ...(params.about ? { about: [{ reference: params.about }] } : {}),
      ...(params.identifier ? { identifier: [params.identifier] } : {}),
      payload: [{ contentString: params.texto }],
    });
  } catch (err) {
    console.error('notificarPortal falló (no interrumpe):', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Agenda semanal de membresías (R-21)                                 */
/* ------------------------------------------------------------------ */

const fmtCivilAR = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'America/Argentina/Buenos_Aires',
});

/** Día civil "YYYY-MM-DD" en hora de Argentina (los bots corren en UTC). */
export function fechaCivilAR(d: Date): string {
  return fmtCivilAR.format(d);
}

/** Estados de Appointment que NO cuentan como sesión de la semana. */
const ESTADOS_SIN_SESION = new Set(['cancelled', 'entered-in-error', 'noshow']);

/**
 * Fechas civiles (AR) que ya tienen una sesión de ESTE plan alrededor de
 * `alrededorDe` (una semana antes y dos después: cubre la semana actual y la
 * próxima con margen). Un combo de N componentes cuenta UNA sola vez: se agrupa
 * por el identifier de combo (los componentes comparten fecha igual, pero el
 * set también sirve para contar sin duplicar).
 */
export async function fechasConSesionDelPlan(
  medplum: MedplumClient,
  pacienteRef: string,
  coverageId: string,
  alrededorDe: Date,
): Promise<Set<string>> {
  const desde = new Date(alrededorDe.getTime() - 8 * 24 * 60 * 60 * 1000);
  const hasta = new Date(alrededorDe.getTime() + 15 * 24 * 60 * 60 * 1000);
  const turnos = await medplum.searchResources('Appointment', {
    patient: pacienteRef,
    date: `ge${desde.toISOString()}`,
    'date:missing': 'false',
    _count: 200,
  });
  const fechas = new Set<string>();
  for (const t of turnos) {
    if (!t.start || ESTADOS_SIN_SESION.has(t.status ?? '')) {
      continue;
    }
    if (new Date(t.start).getTime() > hasta.getTime()) {
      continue;
    }
    const cobertura = t.extension?.find((x) => x.url === EXT.coberturaUsada)?.valueString;
    if (cobertura !== `Coverage/${coverageId}`) {
      continue;
    }
    fechas.add(fechaCivilAR(new Date(t.start)));
  }
  return fechas;
}

/**
 * R-21 · Cuántas sesiones de este plan tiene la semana calendario (AR) a la que
 * pertenece `inicioTurno`. La usa `bw-reservar-combo` cuando recibe `perfil`
 * (portal / asignación automática); el mostrador no manda `perfil` y queda
 * libre, igual que con la ventana R-13.
 */
export async function sesionesDelPlanEnSemana(
  medplum: MedplumClient,
  pacienteRef: string,
  coverageId: string,
  inicioTurno: Date,
): Promise<number> {
  const fechas = await fechasConSesionDelPlan(medplum, pacienteRef, coverageId, inicioTurno);
  const civil = fechaCivilAR(inicioTurno);
  const [y, m, d] = civil.split('-').map(Number);
  const lunesISO = claveSemana(new Date(y!, m! - 1, d!));
  return [...fechas].filter((f) => perteneceASemana(f, lunesISO)).length;
}

// ============================================================================
// Ficha resumida del paciente para los asistentes (borrador, propuesta de reserva)
// ============================================================================

/**
 * Lo que Recepción ya ve del paciente en pantalla, reunido en un solo lugar.
 *
 * Deliberadamente NO incluye nada clínico: ni screening, ni contraindicaciones,
 * ni documentos. Del consentimiento solo viaja la señal binaria, que es lo mismo
 * que ve el banner de Atender.
 */
export async function contextoPacienteResumido(medplum: MedplumClient, pacienteRef: string): Promise<ContextoPaciente> {
  const paciente = await medplum.readResource('Patient', pacienteRef.split('/')[1] as string).catch(() => undefined);

  const [appt, coberturas, saldos, flags] = await Promise.all([
    medplum
      .searchOne(
        'Appointment',
        `patient=${pacienteRef}&status=booked,arrived&date=ge${new Date().toISOString()}&_sort=date&_count=1`,
      )
      .catch(() => undefined),
    medplum.searchResources('Coverage', `beneficiary=${pacienteRef}&status=active&_count=10`).catch(() => [] as Coverage[]),
    medplum
      .searchResources('Invoice', `subject=${pacienteRef}&status=issued&_count=20`)
      .catch(() => [] as Invoice[]),
    medplum.searchResources('Flag', `subject=${pacienteRef}&status=active&_count=20`).catch(() => [] as Flag[]),
  ]);

  // `esPlanBW` primero: la obra social del paciente también es un Coverage
  // activo, y `estadoDeCoverage` la interpretaría como membresía.
  //
  // Y de los planes BW gana el que TIENE sesiones: un programa (PB100D) vende
  // tiempo y su contador es 0, así que si se elige primero el asistente diría
  // "le quedan 0 sesiones" y taparía la membresía real del mismo paciente.
  const planes = coberturas.filter((c) => esPlanBW(c));
  const plan = planes.find((c) => estadoDeCoverage(c).tipo !== 'programa') ?? planes[0];
  const estado = plan ? estadoDeCoverage(plan) : undefined;
  const saldoARS = saldos.reduce((acc, i) => acc + (i.totalGross?.value ?? 0), 0);
  const nombre = paciente ? getDisplayString(paciente) || undefined : undefined;

  return {
    ...(nombre ? { nombre } : {}),
    ...(appt?.start
      ? { proximoTurno: `el ${fechaTurnoNotif(appt.start)}${appt.description ? ` · ${appt.description}` : ''}` }
      : {}),
    ...(plan && estado
      ? {
          plan: {
            nombre: planCodigoDeCoverage(plan) ?? estado.tipo,
            // Un programa no tiene sesiones que contar: `sesionesRestantes` va
            // sin definir y `textoContexto` omite la línea, en vez de afirmar
            // un "0" que se leería como plan agotado.
            ...(estado.tipo === 'programa'
              ? {}
              : { sesionesRestantes: Math.max(0, estado.total - estado.usadas) }),
          },
        }
      : {}),
    ...(saldoARS > 0 ? { saldoARS } : {}),
    ...(tieneBloqueoPago(flags) ? { bloqueadoPorPago: true } : {}),
  };
}
