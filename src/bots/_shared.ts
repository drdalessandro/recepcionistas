/**
 * Helpers compartidos por los bots de agenda (acceden a FHIR; no son "lib pura").
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, ChargeItem, Communication, Coverage, Flag, Invoice, Task } from '@medplum/fhirtypes';
import { COD, 
  CONFIG_TC_ID,
  EXT,
  EXT_LINEA_COMERCIAL,
  SYSTEM,
  esMedioPago,
  type MedioPago,
} from '../fhir/identifiers.js';
import { indiceSolicitudAResolver } from '../lib/solicitudes.js';
import { estadoDeCoverage, planCodigoDeCoverage } from '../fhir/coverage.js';
import { resolverTC } from '../config/tipo-cambio.js';
import { getServicio } from '../config/catalogo.js';
import { getMembresia } from '../config/membresias.js';
import { getPaquete } from '../config/paquetes.js';
import { calcularSenaARS, type ItemCobro, type LineaCobro, type TipoItemCobro } from '../lib/pricing.js';
import { lineaComercialDeItem } from '../lib/cobros.js';
import { motivoNoDisponible, saldoPlan } from '../lib/planes.js';
import type { ReservaRecurso } from '../lib/reglas-turno.js';
import { SECRET_CONTENT_SID_GENERICO, aE164Argentino, contentVariables, nombreSecretContentSid } from '../lib/whatsapp.js';

type Secrets = BotEvent['secrets'];

/** Meta de datos de demostración (tag `demo`); se autodestruyen a las 48 h. */
export const META_DEMO = { tag: [{ system: SYSTEM.demo, code: 'demo' }] };

/** Tipos demo, en orden de borrado: hijos antes que padres (evita refs colgadas). */
const TIPOS_DEMO = ['Communication', 'Invoice', 'Coverage', 'Flag', 'Appointment', 'Slot', 'Patient'] as const;

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
  for (const tipo of TIPOS_DEMO) {
    let query = `_tag=${SYSTEM.demo}|demo&_count=1000`;
    if (opts.antesDe) {
      query += `&_lastUpdated=lt${opts.antesDe}`;
    }
    const recursos = await medplum.searchResources(tipo, query);
    for (const r of recursos) {
      if (!r.id) {
        continue;
      }
      try {
        await medplum.deleteResource(tipo, r.id);
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
  },
): Promise<Communication> {
  let to = params.to;
  if (!to && params.pacienteRef) {
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
  if (to && sid && token && from) {
    // Producción (fuera de la ventana de 24 h): plantilla aprobada por Meta.
    // Prioridad: Content SID específico de esta plantilla → genérico ({{1}} =
    // texto completo) → texto libre (sandbox / dentro de la ventana de 24 h).
    const sidEspecifico = secrets[nombreSecretContentSid(params.template)]?.valueString;
    const sidGenerico = secrets[SECRET_CONTENT_SID_GENERICO]?.valueString;
    const contentSid = sidEspecifico ?? sidGenerico;
    const vars = sidEspecifico && params.variables?.length ? params.variables : [params.body];

    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    // El destino de la ficha puede estar en cualquier formato ("11 6931-5830"):
    // Twilio exige E.164. Sin normalizar, el envío falla en silencio.
    const destino = aE164Argentino(to) ?? to;
    const enviar = async (porPlantilla: boolean): Promise<Response> =>
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          From: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
          To: `whatsapp:${destino}`,
          ...(porPlantilla && contentSid
            ? { ContentSid: contentSid, ContentVariables: contentVariables(vars) }
            : { Body: params.body }),
        }),
      });

    // Texto principal (solo si hay cuerpo: un mensaje puede ser solo adjuntos).
    if (params.body) {
      let resp = await enviar(Boolean(contentSid));
      if (!resp.ok && contentSid) {
        // Autocuración: si la plantilla falla (rechazada por Meta, sin ejemplos,
        // variables que no matchean…), se reintenta como texto libre — que llega
        // dentro de la ventana de 24 h. El motivo queda en el log (CloudWatch).
        console.log(
          `enviarWhatsApp: plantilla ${contentSid} rechazada (${resp.status}): ${(await resp.text().catch(() => '')).slice(0, 300)} — reintento como texto libre`,
        );
        resp = await enviar(false);
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
  let to = params.to;
  if (!to && params.pacienteRef) {
    const id = params.pacienteRef.split('/')[1];
    if (id) {
      const p = await medplum.readResource('Patient', id).catch(() => undefined);
      to = p?.telecom?.find((t) => t.system === 'email')?.value;
    }
  }

  let status: Communication['status'] = 'preparation';
  if (to) {
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

  const ocupados = await medplum.searchResources('Slot', {
    status: 'busy',
    start: `ge${inicioDia.toISOString()}`,
    _count: 500,
  });

  const reservas: ReservaRecurso[] = [];
  for (const s of ocupados) {
    const codigo = s.extension?.find((x) => x.url === EXT.recursoFisico)?.valueString;
    if (!codigo || !s.start || !s.end || s.start > finDia.toISOString()) {
      continue;
    }
    // Personas de la reserva (Slots viejos sin la extensión cuentan como 1).
    const ocupantes = s.extension?.find((x) => x.url === EXT.ocupantes)?.valueInteger ?? 1;
    reservas.push({ recursoCodigo: codigo, inicio: new Date(s.start), fin: new Date(s.end), ocupantes });
  }
  return reservas;
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

/** Alerta operativa para recepción (aparece como Task / Solicitudes). */
export async function crearAlertaRecepcion(
  medplum: MedplumClient,
  opts: { titulo: string; detalle: string; pacienteRef?: string; focusRef?: string },
): Promise<Task> {
  return medplum.createResource<Task>({
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    priority: 'urgent',
    code: { text: opts.titulo },
    description: opts.detalle,
    authoredOn: new Date().toISOString(),
    ...(opts.pacienteRef ? { for: { reference: opts.pacienteRef } } : {}),
    ...(opts.focusRef ? { focus: { reference: opts.focusRef } } : {}),
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

  // Contrato: cada ítem cobrado deja su ChargeItem (acá, la seña del 50%).
  const fecha = new Date().toISOString();
  const descripcionSena = `Seña 50% · ${appt.description ?? itemCodigo}`;
  let chargeItems: ChargeItem[] = [];
  if (pacienteRef) {
    chargeItems = await crearChargeItems(medplum, {
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
  }

  const invoice = await medplum.createResource<Invoice>({
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
    lineItem: chargeItems.length
      ? chargeItems.map((ci) => ({
          chargeItemReference: { reference: `ChargeItem/${ci.id}`, display: descripcionSena },
          priceComponent: [{ type: 'base' as const, amount: { value: senaARS, currency: 'ARS' } }],
        }))
      : [
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
  });

  // El 50% restante queda como Invoice PENDIENTE (`issued`): aparece en "Pagos
  // pendientes" de Atender y en el modal del turno, y Administración ve seña y
  // saldo como dos Invoices del mismo turno. El ChargeItem del saldo se crea
  // recién al cobrarse (resolverInvoicePlan), igual que las cuotas de planes.
  let saldoInvoiceId: string | undefined;
  if (saldoARS > 0) {
    const saldoExistente = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|${claveSaldo}`);
    if (saldoExistente) {
      saldoInvoiceId = saldoExistente.id;
    } else {
      const descripcionSaldo = `Saldo 50% · ${appt.description ?? itemCodigo}`;
      const saldoInvoice = await medplum.createResource<Invoice>({
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
      });
      saldoInvoiceId = saldoInvoice.id;
    }
  }

  const saldoTexto =
    saldoARS > 0 ? `$${saldoARS.toLocaleString('es-AR')} (se abona el día de la sesión)` : 'sin saldo pendiente';
  await enviarWhatsApp(medplum, secrets, {
    template: 'turno-confirmado',
    pacienteRef,
    // Plantilla aprobada: {{1}} turno · {{2}} seña · {{3}} saldo (ver docs/whatsapp-plantillas.md).
    variables: [appt.description ?? 'tu sesión', `$${senaARS.toLocaleString('es-AR')}`, saldoTexto],
    body: `BioWellness: ¡tu turno quedó confirmado! ${appt.description ?? ''}. Recibimos la seña de $${senaARS.toLocaleString('es-AR')}${
      saldoARS > 0 ? ` (saldo restante: $${saldoARS.toLocaleString('es-AR')}, se abona el día de la sesión)` : ''
    }. ¡Te esperamos! 💚`,
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
    } Te esperamos en San Isidro. 💚`,
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
    tipo: 'membresia' | 'paquete';
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
 * Desenlace del cobro de un plan pendiente (webhook de MP):
 * - `pagado`: Invoice → balanced + medio mercadopago + ChargeItem del plan +
 *   levanta el bloqueo R-11 si lo había.
 * - `rechazado`: Invoice → cancelled + bloqueo de reservas (R-11) + alerta (Task).
 * Idempotente: si el Invoice ya no está `issued`, no repite efectos.
 */
export async function resolverInvoicePlan(
  medplum: MedplumClient,
  opts: { clave: string; resultado: 'pagado' | 'rechazado'; detalle?: string; medio?: MedioPago },
): Promise<{ ok: boolean; invoiceId?: string; mensaje?: string }> {
  const invoice = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|${opts.clave}`);
  if (!invoice?.id) {
    return { ok: false, mensaje: `No existe Invoice con clave ${opts.clave}.` };
  }
  // 'pagado' también recupera un Invoice `cancelled` (el paciente regularizó
  // después de un rechazo: se acredita y se levanta el bloqueo R-11).
  const puedeResolver =
    opts.resultado === 'pagado' ? invoice.status === 'issued' || invoice.status === 'cancelled' : invoice.status === 'issued';
  if (!puedeResolver) {
    return { ok: true, invoiceId: invoice.id, mensaje: `Invoice ya resuelto (${invoice.status}).` };
  }

  const pacienteRef = invoice.subject?.reference;
  const tipo = invoice.extension?.find((e) => e.url === EXT.itemTipo)?.valueCode as TipoItemCobro | undefined;
  const planCodigo = invoice.extension?.find((e) => e.url === EXT.itemCodigo)?.valueString;
  const tc = invoice.extension?.find((e) => e.url === EXT.tcAplicado)?.valueDecimal ?? resolverTC();
  const totalARS = invoice.totalGross?.value ?? 0;
  const descripcion = invoice.lineItem?.[0]?.chargeItemCodeableConcept?.text ?? planCodigo ?? 'Plan';

  if (opts.resultado === 'pagado') {
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
      extension: [...(invoice.extension ?? []).filter((e) => e.url !== EXT.medioPago), extMedioPago(opts.medio ?? 'mercadopago')],
    });
    if (pacienteRef) {
      await quitarBloqueoPago(medplum, pacienteRef);
    }
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

export type TipoNotificacionPortal = 'reserva-confirmada' | 'pago-recibido' | 'recordatorio' | 'general';

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
