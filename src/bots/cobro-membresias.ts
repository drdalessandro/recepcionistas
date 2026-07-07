/**
 * Bot · Cobro recurrente de membresías (cron, días 1-5).
 *
 * Pensado para ejecutarse a diario (Bot con cronTimer). En los días 1-5 del mes
 * (R-11) renueva cada membresía activa cuyo ciclo aún no fue facturado:
 *   - resetea las sesiones del mes (sesiones-usadas → 0; no acumulables, R-09);
 *   - actualiza el ciclo facturado (ciclo-mes);
 *   - emite el Invoice mensual (idempotente por ciclo);
 *   - envía el WhatsApp de renovación.
 *
 * Idempotente: si se corre varias veces en el mismo día/mes, no duplica cobros
 * (la clave del Invoice incluye el ciclo y `debeRenovarMembresia` ya filtra).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Coverage } from '@medplum/fhirtypes';
import { getMembresia } from '../config/membresias.js';
import { calcularCobro } from '../lib/pricing.js';
import { cicloMes, debeRenovarMembresia } from '../lib/planes.js';
import { estadoDeCoverage, planCodigoDeCoverage } from '../fhir/coverage.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { emitirInvoicePlan, enviarWhatsApp, leerTcVigente, notificarPortal } from './_shared.js';

export interface EntradaCobroMembresias {
  /** Fecha de referencia ISO (default: ahora). Útil para pruebas/reprocesos. */
  hoy?: string;
}

export interface ResultadoCobroMembresias {
  ok: boolean;
  /** Día fuera de la ventana de cobro (1-5): no se hace nada. */
  fueraDeVentana?: boolean;
  /** Membresías renovadas (reset + cobro) en esta corrida. */
  renovadas: number;
  /** Membresías ya facturadas este ciclo (se omiten). */
  omitidas: number;
  ciclo: string;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaCobroMembresias>,
): Promise<ResultadoCobroMembresias> {
  const hoy = event.input?.hoy ? new Date(event.input.hoy) : new Date();
  const ciclo = cicloMes(hoy);
  const tc = await leerTcVigente(medplum);

  // Todas las coberturas activas; filtramos membresías por extensión.
  const coberturas = await medplum.searchResources('Coverage', { status: 'active', _count: 500 });

  let renovadas = 0;
  let omitidas = 0;
  for (const c of coberturas) {
    const estado = estadoDeCoverage(c);
    if (estado.tipo !== 'membresia' || !c.id) {
      continue;
    }
    const cicloRegistrado = c.extension?.find((x) => x.url === EXT.cicloMes)?.valueString;
    if (!debeRenovarMembresia(cicloRegistrado, hoy)) {
      omitidas++;
      continue;
    }

    // Reset de sesiones del ciclo + actualizar ciclo facturado.
    const extension = (c.extension ?? []).map((x) =>
      x.url === EXT.sesionesUsadas
        ? { url: EXT.sesionesUsadas, valueInteger: 0 }
        : x.url === EXT.cicloMes
          ? { url: EXT.cicloMes, valueString: ciclo }
          : x,
    );
    if (!extension.some((x) => x.url === EXT.cicloMes)) {
      extension.push({ url: EXT.cicloMes, valueString: ciclo });
    }
    await medplum.updateResource<Coverage>({ ...c, extension });

    // Cobro mensual (idempotente por ciclo).
    const planCodigo = planCodigoDeCoverage(c);
    const pacienteRef = c.beneficiary?.reference;
    if (planCodigo) {
      const m = getMembresia(planCodigo);
      const { totalARS } = calcularCobro([{ tipo: 'membresia', codigo: planCodigo }], { tc });
      const cobro = await emitirInvoicePlan(medplum, {
        coverageId: c.id,
        pacienteRef,
        descripcion: `Membresía ${m.tier} ${m.intensidad} ${m.variante} · ${ciclo}`,
        totalARS,
        tc,
        ciclo,
      });
      await enviarWhatsApp(medplum, event.secrets, {
        template: 'membresia-renovada',
        pacienteRef,
        body: `BioWellness: renovamos tu Membresía ${m.tier} para ${ciclo}. Tenés ${m.sesionesMes} sesiones disponibles este mes. 💚`,
      });
      // Campanita del portal: constancia de la renovación (misma clave que el Invoice).
      await notificarPortal(medplum, {
        tipo: 'pago-recibido',
        pacienteRef,
        ...(cobro.invoiceId ? { about: `Invoice/${cobro.invoiceId}` } : {}),
        identifier: { system: SYSTEM.communication, value: `portal-pago-plan-${c.id}-${ciclo}` },
        texto: `Renovamos tu Membresía ${m.tier} para ${ciclo}: $${totalARS.toLocaleString('es-AR')}. Tenés ${m.sesionesMes} sesiones este mes. 💚`,
      });
    }
    renovadas++;
  }

  return { ok: true, renovadas, omitidas, ciclo, fueraDeVentana: renovadas === 0 && omitidas === 0 };
}
