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
import { esPlanBW, estadoDeCoverage, planCodigoDeCoverage } from '../fhir/coverage.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { emitirInvoicePlan, enviarWhatsApp, leerTcVigente, notificarPortal, resolverInvoicePlan } from './_shared.js';

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
    // La obra social del paciente (portal, type ActCode HIP) también es un
    // Coverage activo: sin extensiones BW no es un plan — jamás renovarla ni
    // escribirle (estadoDeCoverage defaulta a 'membresia' si falta el tipo).
    if (!esPlanBW(c)) {
      omitidas++;
      continue;
    }
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

    // Cobro mensual vía MercadoPago (R-11). Idempotente por ciclo.
    const planCodigo = planCodigoDeCoverage(c);
    const pacienteRef = c.beneficiary?.reference;
    if (planCodigo) {
      const m = getMembresia(planCodigo);
      const { totalARS } = calcularCobro([{ tipo: 'membresia', codigo: planCodigo }], { tc });
      const descripcion = `Membresía ${m.tier} ${m.intensidad} ${m.variante} · ${ciclo}`;

      // Invoice `issued` (pendiente). Se resuelve acá (tarjeta guardada) o por webhook.
      const cobro = await emitirInvoicePlan(medplum, {
        coverageId: c.id,
        pacienteRef,
        tipo: 'membresia',
        planCodigo,
        descripcion,
        totalARS,
        tc,
        ciclo,
        status: 'issued',
      });
      if (cobro.yaExistia) {
        omitidas++;
        continue;
      }

      const mpToken = event.secrets['MERCADOPAGO_ACCESS_TOKEN']?.valueString;
      const customerId = c.extension?.find((x) => x.url === EXT.mpCustomerId)?.valueString;
      const cardId = c.extension?.find((x) => x.url === EXT.mpCardId)?.valueString;

      if (mpToken && customerId && cardId) {
        // Tarjeta tokenizada por MP (nunca almacenamos datos de tarjeta, Anexo B):
        // card_token efímero desde la tarjeta guardada → pago.
        const resultado = await cobrarTarjetaGuardada(mpToken, {
          montoARS: totalARS,
          descripcion,
          externalReference: cobro.clave,
          customerId,
          cardId,
        });
        if (resultado === 'approved') {
          await resolverInvoicePlan(medplum, { clave: cobro.clave, resultado: 'pagado' });
          await enviarWhatsApp(medplum, event.secrets, {
            template: 'membresia-renovada',
            pacienteRef,
            body: `BioWellness: renovamos tu Membresía ${m.tier} para ${ciclo} ($${totalARS.toLocaleString('es-AR')} con tu tarjeta guardada). Tenés ${m.sesionesMes} sesiones este mes. 💚`,
          });
          // Campanita del portal: constancia del pago acreditado (idempotente por clave).
          await notificarPortal(medplum, {
            tipo: 'pago-recibido',
            pacienteRef,
            ...(cobro.invoiceId ? { about: `Invoice/${cobro.invoiceId}` } : {}),
            identifier: { system: SYSTEM.communication, value: `portal-pago-plan-${c.id}-${ciclo}` },
            texto: `Renovamos tu Membresía ${m.tier} para ${ciclo}: $${totalARS.toLocaleString('es-AR')}. Tenés ${m.sesionesMes} sesiones este mes. 💚`,
          });
        } else if (resultado === 'rejected') {
          await resolverInvoicePlan(medplum, { clave: cobro.clave, resultado: 'rechazado', detalle: 'Cobro automático con tarjeta guardada.' });
          await enviarWhatsApp(medplum, event.secrets, {
            template: 'membresia-pago-rechazado',
            pacienteRef,
            body: `BioWellness: no pudimos cobrar tu membresía de ${ciclo} (tarjeta rechazada). Regularizá el pago en recepción para seguir reservando. 💚`,
          });
        }
        // 'pending' u otro estado no terminal: el webhook lo resuelve.
      } else if (mpToken) {
        // Sin tarjeta guardada: link de pago (el webhook confirma al acreditarse).
        const url = await crearLinkPago(mpToken, event.secrets, {
          montoARS: totalARS,
          descripcion,
          externalReference: cobro.clave,
        });
        await enviarWhatsApp(medplum, event.secrets, {
          template: 'membresia-cobro-link',
          pacienteRef,
          body: url
            ? `BioWellness: se renovó tu Membresía ${m.tier} (${ciclo}). Aboná $${totalARS.toLocaleString('es-AR')} acá: ${url} 💚`
            : `BioWellness: se renovó tu Membresía ${m.tier} (${ciclo}). Acercate a recepción para abonar $${totalARS.toLocaleString('es-AR')}. 💚`,
        });
      } else {
        // Sin MP configurado: queda `issued`; se cobra en recepción (registrar-cobro
        // no aplica acá: la recepción resuelve el Invoice pendiente al cobrar).
        await enviarWhatsApp(medplum, event.secrets, {
          template: 'membresia-renovada',
          pacienteRef,
          body: `BioWellness: renovamos tu Membresía ${m.tier} para ${ciclo}. Aboná $${totalARS.toLocaleString('es-AR')} en tu próxima visita. 💚`,
        });
      }
    }
    renovadas++;
  }

  return { ok: true, renovadas, omitidas, ciclo, fueraDeVentana: renovadas === 0 && omitidas === 0 };
}

/**
 * Cobro con tarjeta guardada de MP: genera un card_token efímero desde la tarjeta
 * tokenizada del customer y crea el pago. Devuelve el estado terminal simplificado.
 */
async function cobrarTarjetaGuardada(
  mpToken: string,
  opts: { montoARS: number; descripcion: string; externalReference: string; customerId: string; cardId: string },
): Promise<'approved' | 'rejected' | 'pending'> {
  try {
    const tokenResp = await fetch(`https://api.mercadopago.com/v1/card_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mpToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: opts.cardId }),
    });
    if (!tokenResp.ok) {
      console.error('cobro-membresias: card_tokens falló', tokenResp.status, await tokenResp.text().catch(() => ''));
      return 'rejected';
    }
    const { id: cardToken } = (await tokenResp.json()) as { id: string };

    const pagoResp = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mpToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': opts.externalReference,
      },
      body: JSON.stringify({
        transaction_amount: opts.montoARS,
        token: cardToken,
        description: opts.descripcion,
        installments: 1,
        payer: { type: 'customer', id: opts.customerId },
        external_reference: opts.externalReference,
      }),
    });
    const pago = (await pagoResp.json().catch(() => ({}))) as { status?: string };
    if (!pagoResp.ok) {
      console.error('cobro-membresias: payments falló', pagoResp.status, JSON.stringify(pago).slice(0, 300));
      return 'rejected';
    }
    if (pago.status === 'approved') {
      return 'approved';
    }
    if (pago.status === 'rejected' || pago.status === 'cancelled') {
      return 'rejected';
    }
    return 'pending';
  } catch (err) {
    console.error('cobro-membresias: error cobrando tarjeta guardada:', err instanceof Error ? err.message : err);
    return 'pending'; // sin señal clara: no bloquear; el webhook/reintento resuelve
  }
}

/** Preferencia de checkout de MP para pagar la cuota (link). */
async function crearLinkPago(
  mpToken: string,
  secrets: BotEvent['secrets'],
  opts: { montoARS: number; descripcion: string; externalReference: string },
): Promise<string | undefined> {
  try {
    const appUrl = secrets['APP_BASE_URL']?.valueString ?? 'https://recepcion.biowellness.ar';
    const notifUrl = secrets['MP_WEBHOOK_URL']?.valueString;
    const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mpToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': opts.externalReference,
      },
      body: JSON.stringify({
        items: [{ title: opts.descripcion, quantity: 1, unit_price: opts.montoARS, currency_id: 'ARS' }],
        external_reference: opts.externalReference,
        back_urls: { success: appUrl, pending: appUrl, failure: appUrl },
        auto_return: 'approved',
        ...(notifUrl ? { notification_url: notifUrl } : {}),
      }),
    });
    if (!resp.ok) {
      console.error('cobro-membresias: preferencia MP falló', resp.status);
      return undefined;
    }
    const pref = (await resp.json()) as { init_point?: string; sandbox_init_point?: string };
    return pref.init_point ?? pref.sandbox_init_point;
  } catch {
    return undefined;
  }
}
