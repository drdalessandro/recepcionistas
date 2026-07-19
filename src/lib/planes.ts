/**
 * Saldo de planes (membresías y paquetes) — lógica pura (R-10).
 *
 * - Membresía: N sesiones por mes (no acumulables; se resetean cada ciclo).
 * - Paquete: N sesiones totales con vencimiento (vigencia en días).
 *
 * Un plan está "disponible" para reservar si está activo, no vencido y con saldo.
 */
export type TipoCobertura = 'membresia' | 'paquete';

export interface EstadoPlan {
  tipo: TipoCobertura;
  /** Sesiones del ciclo (membresía) o totales (paquete). */
  total: number;
  usadas: number;
  /** Vencimiento ISO (paquetes). Las membresías no vencen (resetean por ciclo). */
  vencimiento?: string;
  /** El Coverage está activo (status === 'active'). */
  activo: boolean;
}

export interface SaldoPlan {
  restantes: number;
  vencido: boolean;
  agotado: boolean;
  /** Se puede consumir una sesión ahora. */
  disponible: boolean;
}

/** Componentes de una clave de Invoice de plan (`plan-{coverageId}[-{YYYY-MM}]`). */
export interface ClavePlan {
  coverageId: string;
  /** Ciclo YYYY-MM (solo cuotas de membresía). */
  ciclo?: string;
}

/**
 * Parsea la clave de un Invoice de plan: `plan-{coverageId}` (alta inicial /
 * paquete) o `plan-{coverageId}-{YYYY-MM}` (cuota mensual de membresía).
 * Los UUID de Medplum terminan en un grupo de 12 hex, así que el sufijo
 * `-YYYY-MM` nunca es ambiguo. Devuelve undefined si no es clave de plan.
 */
export function parseClavePlan(clave: string): ClavePlan | undefined {
  if (!clave.startsWith('plan-')) {
    return undefined;
  }
  let resto = clave.slice('plan-'.length);
  let ciclo: string | undefined;
  const m = resto.match(/-(\d{4}-\d{2})$/);
  if (m) {
    ciclo = m[1];
    resto = resto.slice(0, -m[0].length);
  }
  return resto ? { coverageId: resto, ciclo } : undefined;
}

export function saldoPlan(plan: EstadoPlan, ahora: Date = new Date()): SaldoPlan {
  const restantes = Math.max(plan.total - plan.usadas, 0);
  const vencido = plan.vencimiento ? new Date(plan.vencimiento).getTime() < ahora.getTime() : false;
  const agotado = restantes <= 0;
  return {
    restantes,
    vencido,
    agotado,
    disponible: plan.activo && !vencido && !agotado,
  };
}

/** Motivo por el que un plan no se puede usar (para mensajes claros). */
export function motivoNoDisponible(saldo: SaldoPlan, activo: boolean): string | undefined {
  if (!activo) {
    return 'El plan no está activo.';
  }
  if (saldo.vencido) {
    return 'El paquete está vencido.';
  }
  if (saldo.agotado) {
    return 'No quedan sesiones en el plan (R-10).';
  }
  return undefined;
}

/** Últimos días del mes en los que se cobra/renueva la membresía (R-11). */
export const DIAS_COBRO_MEMBRESIA = 5;

/** Día del mes (1-31) en zona horaria de Argentina. */
function diaDelMes(d: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-CA', { day: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }).format(d),
  );
}

/** Ciclo de facturación 'YYYY-MM' (zona Argentina) de una fecha. */
export function cicloMes(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires',
  })
    .format(d)
    .slice(0, 7);
}

/**
 * ¿Corresponde renovar (reset de sesiones + cobro mensual) una membresía hoy?
 * Sí cuando estamos en los días 1..5 del mes y el ciclo aún no fue facturado
 * (el `cicloRegistrado` del Coverage es distinto al ciclo actual). Idempotente.
 */
export function debeRenovarMembresia(cicloRegistrado: string | undefined, hoy: Date = new Date()): boolean {
  if (diaDelMes(hoy) > DIAS_COBRO_MEMBRESIA) {
    return false;
  }
  return cicloRegistrado !== cicloMes(hoy);
}
