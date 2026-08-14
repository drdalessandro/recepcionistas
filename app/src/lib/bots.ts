import type { Communication, Invoice, QuestionnaireResponseItem } from '@medplum/fhirtypes';
import type { EstadoConsentimiento } from '@bw/lib/consentimiento';
import type { ColorSeguridad, EstadoSeguridad } from '@bw/lib/seguridad';
import type { CicloVida } from '@bw/fhir/identifiers';
import { medplum } from '../medplum';

/**
 * Toda la inteligencia vive en los Bots: el front solo orquesta. Estas funciones
 * invocan los Bots de Medplum por nombre. Si el bot no está desplegado todavía,
 * lanzan un error claro (no se calcula nada en el front).
 */

export interface ItemCobroInput {
  tipo: 'servicio' | 'combo' | 'membresia' | 'paquete';
  codigo: string;
  ocupantes?: number;
  fm?: boolean;
  cantidad?: number;
}

/** Extrae un mensaje legible de un error de bot (que suele venir como JSON con stack). */
export function mensajeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const o = JSON.parse(raw) as { errorMessage?: string };
    if (o && typeof o.errorMessage === 'string') {
      return o.errorMessage;
    }
  } catch {
    // no era JSON
  }
  return raw;
}

async function botIdPorNombre(nombre: string): Promise<string> {
  const bot = await medplum.searchOne('Bot', `name=${nombre}`);
  if (!bot?.id) {
    throw new Error(
      `El bot "${nombre}" no está desplegado todavía. Desplegá los bots (npm run deploy:bots) para activar esta función.`,
    );
  }
  return bot.id;
}

/** Llama al bot de cobro y devuelve el Invoice calculado (total en ARS, splits, TC). */
export async function calcularCobro(items: ItemCobroInput[], pacienteRef?: string): Promise<Invoice> {
  const id = await botIdPorNombre('bw-calcular-cobro');
  return (await medplum.executeBot(id, { items, pacienteRef, persistir: false })) as Invoice;
}

export interface ReservaInput {
  pacienteRef: string;
  servicioCodigo: string;
  recursoCodigo: string;
  /** Inicio del turno en ISO (con offset de Argentina). */
  inicio: string;
  ocupantes?: number;
  prescripcionActiva?: boolean;
  /** TB: consentimiento informado firmado (R-03; el documento vive en la HC). */
  consentimientoFirmado?: boolean;
  /** De dónde salió esa afirmación: verificada en el portal o declarada por Recepción. */
  origenConsentimiento?: 'portal' | 'declarado-recepcion';
  autorizacionMedica?: boolean;
  /** Coverage (paquete) con el que se paga el turno: confirma sin seña. */
  coverageId?: string;
  /** Si es false, solo valida (no crea). */
  confirmar?: boolean;
}

export interface IssueValidacion {
  regla: string;
  nivel: string;
  mensaje: string;
}

export interface ResultadoReserva {
  ok: boolean;
  bloqueos: IssueValidacion[];
  advertencias: IssueValidacion[];
  creado: boolean;
  appointmentId?: string;
  slotId?: string;
  /** Si se usó un plan: sesiones restantes tras consumir esta. */
  planRestantes?: number;
}

/** Llama al bot de reserva: valida y (si confirma) crea el turno + Slot ocupado. */
export async function reservarTurno(input: ReservaInput): Promise<ResultadoReserva> {
  const id = await botIdPorNombre('bw-reservar-turno');
  return (await medplum.executeBot(id, input)) as ResultadoReserva;
}

export interface ComboInput {
  pacienteRef: string;
  comboCodigo: string;
  inicio: string;
  autorizacionMedica?: boolean;
  /** Coverage (membresía) con el que se paga el combo: confirma sin seña. */
  coverageId?: string;
  confirmar?: boolean;
  /** Si es false, el bot no manda el WhatsApp por sesión (para la pre-agenda en serie). */
  notificar?: boolean;
}

export interface ItemPlanDTO {
  servicio: string;
  recurso: string;
  desde: string;
  hasta: string;
}

export interface ResultadoCombo {
  ok: boolean;
  bloqueos: IssueValidacion[];
  advertencias: IssueValidacion[];
  creado: boolean;
  plan: ItemPlanDTO[];
  appointmentIds?: string[];
  /** Si se usó una membresía: sesiones restantes tras consumir esta. */
  planRestantes?: number;
}

/** Llama al bot de combo: agenda los componentes en secuencia (HBOT primero). */
export async function reservarCombo(input: ComboInput): Promise<ResultadoCombo> {
  const id = await botIdPorNombre('bw-reservar-combo');
  return (await medplum.executeBot(id, input)) as ResultadoCombo;
}

/**
 * Envía un WhatsApp (y registra Communication).
 *
 * - `pacienteRef` → el teléfono sale de la ficha; `to` → número suelto (E.164),
 *   para responderle a un WhatsApp de número desconocido desde Avisos.
 * - `mensajeId` espeja un mensaje de la bandeja (texto + adjuntos) al WhatsApp:
 *   es lo que hace que responder desde Mensajes llegue al celular del paciente.
 *
 * Devuelve la Communication del envío: `status: 'completed'` = Twilio lo tomó;
 * 'preparation' = faltan credenciales/teléfono; 'entered-in-error' = rechazo.
 */
export async function enviarWhatsApp(input: {
  template: string;
  body: string;
  pacienteRef?: string;
  to?: string;
  mensajeId?: string;
}): Promise<Communication> {
  const id = await botIdPorNombre('bw-enviar-whatsapp');
  return (await medplum.executeBot(id, input)) as Communication;
}

export type EstadoTurno = 'arrived' | 'checked-in' | 'fulfilled' | 'cancelled';

/** Cambia el estado de un turno (check-in/out): el bot actualiza Appointment + Encounter + Slot. */
export async function cambiarEstadoTurno(appointmentId: string, estado: EstadoTurno): Promise<void> {
  const id = await botIdPorNombre('bw-estado-turno');
  await medplum.executeBot(id, { appointmentId, estado });
}

export interface ResultadoSena {
  ok: boolean;
  mensaje?: string;
  totalARS?: number;
  senaARS?: number;
  invoiceId?: string;
  confirmados?: number;
}

/** Registra la seña (50%), confirma el turno y dispara el WhatsApp de confirmación. */
export async function pagarSena(appointmentId: string, medioPago: string): Promise<ResultadoSena> {
  const id = await botIdPorNombre('bw-pagar-sena');
  return (await medplum.executeBot(id, { appointmentId, medioPago })) as ResultadoSena;
}

export interface ResultadoLinkMP {
  ok: boolean;
  mensaje?: string;
  /** Monto del link (seña o saldo, según concepto). */
  montoARS?: number;
  senaARS?: number;
  url?: string;
}

/** Genera un link de MercadoPago para pagar la seña. */
export async function linkMercadoPago(appointmentId: string, concepto: 'sena' | 'saldo' = 'sena'): Promise<ResultadoLinkMP> {
  const id = await botIdPorNombre('bw-link-mercadopago');
  return (await medplum.executeBot(id, { appointmentId, concepto })) as ResultadoLinkMP;
}

export interface AsignarPlanInput {
  pacienteRef: string;
  tipo: 'membresia' | 'paquete';
  planCodigo: string;
  fm?: boolean;
  medioPago?: string;
  cobrar?: boolean;
}

export interface ResultadoAsignarPlan {
  ok: boolean;
  mensaje?: string;
  coverageId?: string;
  invoiceId?: string;
  totalARS?: number;
  sesiones?: number;
  /** true: quedó PENDIENTE de pago (MercadoPago); se activa al acreditarse. */
  pendiente?: boolean;
  /** Link de pago de MercadoPago (flujo pendiente). */
  url?: string;
}

/** Asigna una membresía/paquete al paciente (crea Coverage + cobro inicial + WhatsApp). */
export async function asignarPlan(input: AsignarPlanInput): Promise<ResultadoAsignarPlan> {
  const id = await botIdPorNombre('bw-asignar-plan');
  return (await medplum.executeBot(id, input)) as ResultadoAsignarPlan;
}

export interface AltaPacienteInput {
  nombre?: string;
  firstName?: string;
  lastName?: string;
  dni?: string;
  email?: string;
  telefono?: string;
  tipoCliente?: string;
  /** Canal de origen (lista cerrada ORIGENES_LEAD). */
  origenLead?: string;
  /** 'lead' = todavía no es cliente, solo preguntó (contrato del CRM). */
  cicloVida?: CicloVida;
  /** Qué vino a consultar; va en la tarjeta del pipeline del CRM. */
  interes?: string;
  /** Quién lo registró (Practitioner/…), para el Provenance del CRM. */
  registradoPorRef?: string;
  /** A quién acompañaba, si el lead vino con un paciente. */
  acompanaA?: string;
}

export interface ResultadoAltaPaciente {
  ok: boolean;
  mensaje?: string;
  patientId?: string;
  creado?: boolean;
  /** Tarjeta creada en el kanban del CRM, si se registró como lead. */
  taskPipelineId?: string;
}

/** Da de alta (o actualiza, sin duplicar) el paciente. No le da acceso al portal. */
export async function altaPaciente(input: AltaPacienteInput): Promise<ResultadoAltaPaciente> {
  const id = await botIdPorNombre('bw-alta-paciente');
  return (await medplum.executeBot(id, input)) as ResultadoAltaPaciente;
}

export type CanalInvitacion = 'whatsapp' | 'email' | 'qr';

export interface ResultadoInvitarPaciente {
  ok: boolean;
  mensaje?: string;
  canal?: CanalInvitacion;
  membershipId?: string;
  link?: string;
  enviado?: boolean;
}

export interface RegistrarCobroInput {
  pacienteRef: string;
  items: ItemCobroInput[];
  /** Pago simple: [{medio}] (monto = total). Mixto: N porciones con montoARS. */
  medios: Array<{ medio: string; montoARS?: number }>;
  clave?: string;
  soloCalcular?: boolean;
}

export interface ResultadoRegistrarCobro {
  ok: boolean;
  mensaje?: string;
  totalARS?: number;
  tcAplicado?: number;
  lineas?: Array<{ descripcion: string; montoARS: number; descuentoPct?: number; descuentoOrigen?: string }>;
  invoices?: Array<{ id: string; medio: string; montoARS: number }>;
  chargeItemIds?: string[];
  yaRegistrado?: boolean;
}

/**
 * Registra un cobro presencial (contrato Administración): ChargeItems + un
 * Invoice `balanced` por medio. Con `soloCalcular` devuelve el monto con los
 * descuentos del cliente (FM / a la carte) sin registrar nada.
 */
export async function registrarCobro(input: RegistrarCobroInput): Promise<ResultadoRegistrarCobro> {
  const id = await botIdPorNombre('bw-registrar-cobro');
  return (await medplum.executeBot(id, input)) as ResultadoRegistrarCobro;
}

export interface ResultadoCobrarPendiente {
  ok: boolean;
  mensaje?: string;
  invoiceId?: string;
}

/** Cobra en recepción un Invoice pendiente de plan (balanced + ChargeItem + quita bloqueo R-11). */
export async function cobrarPendiente(invoiceId: string, medio: string): Promise<ResultadoCobrarPendiente> {
  const id = await botIdPorNombre('bw-cobrar-pendiente');
  return (await medplum.executeBot(id, { invoiceId, medio })) as ResultadoCobrarPendiente;
}

/** Invita al paciente al portal por el canal elegido (WhatsApp / email / QR). */
export async function invitarPaciente(
  pacienteRef: string,
  canal: CanalInvitacion,
  email?: string,
): Promise<ResultadoInvitarPaciente> {
  const id = await botIdPorNombre('bw-invitar-paciente');
  return (await medplum.executeBot(id, { pacienteRef, canal, email })) as ResultadoInvitarPaciente;
}

export interface EntradaFusion {
  duplicadoId: string;
  canonicoId: string;
  taskId?: string;
}

export interface ResultadoFusion {
  ok: boolean;
  mensaje?: string;
  loginsReapuntados?: number;
  reasignados?: number;
}

/** Fusiona una ficha duplicada en la canónica (decisión humana desde la vista Duplicados). */
export async function fusionarPaciente(entrada: EntradaFusion): Promise<ResultadoFusion> {
  const id = await botIdPorNombre('bw-fusionar-paciente');
  return (await medplum.executeBot(id, entrada)) as ResultadoFusion;
}

/**
 * Espeja un mensaje de la bandeja al WhatsApp del paciente (bw-enviar-whatsapp).
 * Con `mensajeId`, el bot lee esa Communication y espeja también sus adjuntos
 * (las URLs Binary salen presignadas y Twilio las descarga como MediaUrl).
 *
 * Devuelve la Communication del envío para que quien llame sepa si SALIÓ:
 * antes esto era fire-and-forget con `.catch(() => undefined)` y un WhatsApp
 * caído se veía igual que uno entregado — la recepcionista creía haber
 * contestado y el paciente nunca recibía nada.
 */
export async function espejarWhatsApp(pacienteRef: string, body: string, mensajeId?: string): Promise<Communication> {
  return enviarWhatsApp({ pacienteRef, template: 'mensaje-recepcion', body, mensajeId });
}

export interface EstadoConsentimientoBot {
  ok: boolean;
  estado: EstadoConsentimiento;
  fechaISO?: string;
  mensaje?: string;
}

/**
 * ¿El paciente firmó el consentimiento en el portal? (bw-estado-consentimiento).
 *
 * Devuelve SOLO la señal binaria: el documento y el resto de la historia nunca
 * salen del lado clínico. Falla CERRADO — si el bot no está deployado, no hay
 * permisos o se cae la red, devuelve 'no-verificable', jamás 'firmado': dar por
 * bueno un consentimiento que no se pudo verificar habilitaría una Terapia
 * Biológica sin respaldo (R-03).
 */
export async function estadoConsentimientoPaciente(
  pacienteRef: string,
  codigo?: string,
): Promise<EstadoConsentimientoBot> {
  try {
    const id = await botIdPorNombre('bw-estado-consentimiento');
    const r = (await medplum.executeBot(id, { pacienteRef, codigo })) as EstadoConsentimientoBot;
    return r?.estado ? r : { ok: false, estado: 'no-verificable' };
  } catch (e) {
    return { ok: false, estado: 'no-verificable', mensaje: mensajeError(e) };
  }
}

export interface IngresoPresencialInput {
  pacienteRef: string;
  nombreFirma: string;
  dni: string;
  email?: string;
  usoDatosAceptado?: boolean;
  respuestasScreening?: QuestionnaireResponseItem[];
}

export interface ResultadoIngresoPresencial {
  ok: boolean;
  consentId?: string;
  documentReferenceId?: string;
  questionnaireResponseId?: string;
  mensaje?: string;
}

/**
 * Registra el consentimiento firmado y el cuestionario de ingreso del paciente
 * que está PRESENTE en el mostrador (bw-ingreso-presencial).
 *
 * Escribe el bot y no la app porque la policy de recepción no incluye `Consent`,
 * `DocumentReference` ni `QuestionnaireResponse` — ni debe.
 */
export async function registrarIngresoPresencial(
  input: IngresoPresencialInput,
): Promise<ResultadoIngresoPresencial> {
  try {
    const id = await botIdPorNombre('bw-ingreso-presencial');
    const r = (await medplum.executeBot(id, input)) as ResultadoIngresoPresencial;
    return r?.ok ? r : { ok: false, mensaje: r?.mensaje ?? 'No se pudo registrar el ingreso.' };
  } catch (e) {
    return { ok: false, mensaje: mensajeError(e) };
  }
}

export interface EstadoSeguridadBot {
  ok: boolean;
  estado: EstadoSeguridad;
  color: ColorSeguridad;
  puedeAvanzar: boolean;
  mensaje?: string;
}

/**
 * Estado de seguridad del paciente para el banner (bw-estado-seguridad).
 *
 * Va por bot y no por lectura directa porque distinguir "apto" de "nunca
 * contestó nada" obliga a mirar el cuestionario de ingreso, y la policy de
 * recepción no incluye `QuestionnaireResponse` (ni debe: sería abrirle la
 * historia clínica). De acá sale un color, nunca el detalle.
 *
 * Falla CERRADO: sin bot, sin permisos o sin red devuelve 'no-verificable'.
 * Antes este banner hacía `.catch(() => 'verde')` y un error de lectura se veía
 * igual que "paciente apto" — el bug que este bot vino a cerrar.
 */
export async function estadoSeguridadPaciente(pacienteRef: string): Promise<EstadoSeguridadBot> {
  const noVerificable = (mensaje?: string): EstadoSeguridadBot => ({
    ok: false,
    estado: 'no-verificable',
    color: 'gris',
    puedeAvanzar: false,
    ...(mensaje ? { mensaje } : {}),
  });
  try {
    const id = await botIdPorNombre('bw-estado-seguridad');
    const r = (await medplum.executeBot(id, { pacienteRef })) as EstadoSeguridadBot;
    return r?.estado ? r : noVerificable();
  } catch (e) {
    return noVerificable(mensajeError(e));
  }
}
