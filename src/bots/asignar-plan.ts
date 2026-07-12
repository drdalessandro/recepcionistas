/**
 * Bot · Asignar plan (membresía o paquete) a un paciente.
 *
 * Crea el Coverage del plan (sesiones del ciclo/totales, usadas=0), emite el cobro
 * inicial (membresía: mes en curso; paquete: total, con FM si aplica) y envía el
 * WhatsApp de bienvenida. El saldo se descuenta al reservar (R-10) y, en membresías,
 * se renueva los días 1-5 (bot bw-cobro-membresias).
 *
 * Toda la decisión vive acá: el front solo elige paciente + plan + medio de pago.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Coverage } from '@medplum/fhirtypes';
import { getMembresia } from '../config/membresias.js';
import { getPaquete } from '../config/paquetes.js';
import { calcularCobro } from '../lib/pricing.js';
import { cicloMes } from '../lib/planes.js';
import { EXT, esMedioPago } from '../fhir/identifiers.js';
import { emitirInvoicePlan, enviarWhatsApp, leerTcVigente } from './_shared.js';

export interface EntradaAsignarPlan {
  pacienteRef: string; // "Patient/123"
  tipo: 'membresia' | 'paquete';
  planCodigo: string;
  /** Founding Member: aplica el 20% adicional en paquetes. */
  fm?: boolean;
  /** efectivo / transferencia / tarjeta / mercadopago */
  medioPago?: string;
  tc?: number;
  /** Inicio de vigencia ISO (default: ahora). */
  desde?: string;
  /** Si es false, crea el Coverage pero no emite el cobro inicial. Default true. */
  cobrar?: boolean;
}

export interface ResultadoAsignarPlan {
  ok: boolean;
  mensaje?: string;
  coverageId?: string;
  invoiceId?: string;
  totalARS?: number;
  /** Sesiones del ciclo (membresía) o totales (paquete). */
  sesiones?: number;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaAsignarPlan>,
): Promise<ResultadoAsignarPlan> {
  const e = event.input;
  try {
    const desde = e.desde ? new Date(e.desde) : new Date();
    const tc = e.tc ?? (await leerTcVigente(medplum));

    // 1) Datos del plan + sesiones + vigencia.
    let sesiones: number;
    let descripcion: string;
    let periodEnd: string | undefined;
    let cicloExt: string | undefined;
    const extension: Coverage['extension'] = [
      { url: EXT.tipoCobertura, valueCode: e.tipo },
      { url: EXT.planCodigo, valueString: e.planCodigo },
      { url: EXT.sesionesUsadas, valueInteger: 0 },
    ];

    if (e.tipo === 'membresia') {
      const m = getMembresia(e.planCodigo);
      sesiones = m.sesionesMes;
      descripcion = `Membresía ${m.tier} ${m.intensidad} ${m.variante}`;
      cicloExt = cicloMes(desde);
      extension.push({ url: EXT.sesionesMes, valueInteger: sesiones });
      extension.push({ url: EXT.cicloMes, valueString: cicloExt });
      // Las membresías no vencen: se renuevan por ciclo. Sin period.end.
    } else {
      const p = getPaquete(e.planCodigo);
      sesiones = p.tamano;
      descripcion = `Paquete ${p.codigo}`;
      const fin = new Date(desde.getTime() + p.vigenciaDias * 24 * 60 * 60 * 1000);
      periodEnd = fin.toISOString();
      extension.push({ url: EXT.sesionesTotal, valueInteger: sesiones });
    }

    // 2) Crear el Coverage (plan del paciente).
    const coverage = await medplum.createResource<Coverage>({
      resourceType: 'Coverage',
      status: 'active',
      beneficiary: { reference: e.pacienteRef },
      subscriber: { reference: e.pacienteRef },
      payor: [{ reference: e.pacienteRef }],
      period: { start: desde.toISOString(), ...(periodEnd ? { end: periodEnd } : {}) },
      extension,
    });

    // 3) Cobro inicial (membresía: mes en curso; paquete: total).
    const { totalARS } = calcularCobro([{ tipo: e.tipo, codigo: e.planCodigo, fm: e.fm }], { tc });
    let invoiceId: string | undefined;
    if (e.cobrar !== false && coverage.id) {
      if (e.medioPago && !esMedioPago(e.medioPago)) {
        return { ok: false, mensaje: `Medio de pago inválido: "${e.medioPago}".` };
      }
      const cobro = await emitirInvoicePlan(medplum, {
        coverageId: coverage.id,
        pacienteRef: e.pacienteRef,
        tipo: e.tipo,
        planCodigo: e.planCodigo,
        descripcion,
        totalARS,
        tc,
        ciclo: cicloExt,
        medioPago: e.medioPago && esMedioPago(e.medioPago) ? e.medioPago : undefined,
      });
      invoiceId = cobro.invoiceId;
    }

    // 4) WhatsApp de bienvenida.
    await enviarWhatsApp(medplum, event.secrets, {
      template: 'plan-asignado',
      pacienteRef: e.pacienteRef,
      body: `BioWellness: ¡activamos tu ${descripcion}! Tenés ${sesiones} sesiones${
        e.tipo === 'membresia' ? ' este mes' : ` (vencen el ${new Date(periodEnd!).toLocaleDateString('es-AR')})`
      }. ¡Te esperamos! 💚`,
    });

    return { ok: true, coverageId: coverage.id, invoiceId, totalARS, sesiones };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : 'No se pudo asignar el plan.' };
  }
}
