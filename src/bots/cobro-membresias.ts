/**
 * Bot · Cobro recurrente de membresías (cron, días 1-5).
 *
 * Pensado para ejecutarse a diario (Bot con cronString). En los días 1-5 del mes
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
import {
  crearAlertaRecepcion,
  crearPreferenciaMP,
  emitirInvoicePlan,
  enviarWhatsApp,
  leerTcVigente,
  notificarPortal,
  resolverInvoicePlan,
} from './_shared.js';

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

    const planCodigo = planCodigoDeCoverage(c);
    const pacienteRef = c.beneficiary?.reference;

    // ORDEN CRÍTICO: primero la DEUDA, después la marca de "ya facturado".
    //
    // Al revés (como estaba hasta 2026-08-22) hay una ventana fatal: si el
    // proceso muere entre marcar el ciclo y emitir el Invoice, el socio queda
    // como facturado sin que exista la factura. `debeRenovarMembresia` filtra
    // por ese campo, y el cobro solo corre los días 1-5, así que ESE MES NO SE
    // COBRA NUNCA y nadie se entera.
    //
    // En este orden la ventana es inofensiva: si muere después de emitir el
    // Invoice, la próxima corrida vuelve a entrar, `emitirInvoicePlan` es
    // idempotente por ciclo (no duplica) y recién ahí se marca el ciclo.
    let cobro: Awaited<ReturnType<typeof emitirInvoicePlan>> | undefined;
    if (planCodigo) {
      const m = getMembresia(planCodigo);
      const { totalARS } = calcularCobro([{ tipo: 'membresia', codigo: planCodigo }], { tc });
      const descripcion = `Membresía ${m.tier} ${m.intensidad} ${m.variante} · ${ciclo}`;
      cobro = await emitirInvoicePlan(medplum, {
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
    }

    // Reset de sesiones del ciclo + marcar el ciclo como facturado.
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

    // Cobro mensual vía MercadoPago (R-11).
    if (planCodigo && cobro) {
      const m = getMembresia(planCodigo);
      const { totalARS } = calcularCobro([{ tipo: 'membresia', codigo: planCodigo }], { tc });
      const descripcion = `Membresía ${m.tier} ${m.intensidad} ${m.variante} · ${ciclo}`;
      if (cobro.yaExistia) {
        // El Invoice de este ciclo ya estaba: lo emitió una corrida anterior
        // (que quizá murió antes de marcar el ciclo). No se vuelve a cobrar.
        omitidas++;
        continue;
      }

      const mpToken = event.secrets['MERCADOPAGO_ACCESS_TOKEN']?.valueString;
      // ⚠️ HOY ESTE CAMINO NUNCA SE ACTIVA: ningún flujo del sistema ESCRIBE
      // `mp-customer-id` / `mp-card-id`. No existe la captura de tarjeta, así
      // que todas las cuotas salen por link de pago.
      //
      // Se deja el código porque está probado y es el destino, pero que quede
      // dicho: el débito automático es un REQUISITO PENDIENTE, no algo que ya
      // tengamos. Falta tokenizar la tarjeta del socio (MP Bricks en el front
      // con la public key) y guardar el customer + card en el Coverage.
      // Ver docs/mercadopago.md § Débito automático.
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
            body: `Biowellness: renovamos tu Membresía ${m.tier} para ${ciclo} ($${totalARS.toLocaleString('es-AR')} con tu tarjeta guardada). Tenés ${m.sesionesMes} sesiones este mes.`,
          });
          // Campanita del portal: constancia del pago acreditado (idempotente por clave).
          await notificarPortal(medplum, {
            tipo: 'pago-recibido',
            pacienteRef,
            ...(cobro.invoiceId ? { about: `Invoice/${cobro.invoiceId}` } : {}),
            identifier: { system: SYSTEM.communication, value: `portal-pago-plan-${c.id}-${ciclo}` },
            texto: `Renovamos tu Membresía ${m.tier} para ${ciclo}: $${totalARS.toLocaleString('es-AR')}. Tenés ${m.sesionesMes} sesiones este mes.`,
          });
        } else if (resultado === 'rejected') {
          await resolverInvoicePlan(medplum, { clave: cobro.clave, resultado: 'rechazado', detalle: 'Cobro automático con tarjeta guardada.' });
          await enviarWhatsApp(medplum, event.secrets, {
            template: 'membresia-pago-rechazado',
            pacienteRef,
            body: `Biowellness: no pudimos cobrar tu membresía de ${ciclo} (tarjeta rechazada). Regularizá el pago en recepción para seguir reservando.`,
          });
        } else if (resultado === 'error') {
          // ERROR DE SISTEMA (token mal cargado, MP caído) ≠ tarjeta rechazada:
          // acá NO se aplica R-11 ni se le dice "rechazada" al socio — eso, con
          // un token roto, bloqueaba en masa a todos los que tienen tarjeta
          // guardada. El Invoice queda pendiente, se le manda el link (si se
          // puede) y Recepción se entera: el cron NO reintenta este ciclo
          // (el Invoice ya existe), así que sin alerta se perdía el cobro.
          await crearAlertaRecepcion(medplum, {
            titulo: 'Cobro automático de membresía FALLÓ (error de sistema)',
            detalle: `No se pudo cobrar "${descripcion}" ($${totalARS.toLocaleString('es-AR')}) con la tarjeta guardada: MercadoPago no respondió un resultado de pago (¿token vencido o mal cargado? ¿MP caído?). NO es una tarjeta rechazada: no se bloqueó al socio. El Invoice queda pendiente; cobrarlo por link o en mostrador, y revisar MERCADOPAGO_ACCESS_TOKEN si pasa con varios socios.`,
            pacienteRef,
            ...(cobro.invoiceId ? { focusRef: `Invoice/${cobro.invoiceId}` } : {}),
            clave: `mp-error-cobro-${cobro.clave}`,
          });
          await cobrarPorLink(medplum, event.secrets, { clave: cobro.clave, montoARS: totalARS, descripcion, pacienteRef, tier: m.tier, ciclo, invoiceId: cobro.invoiceId });
        }
        // 'pending' u otro estado no terminal: el webhook lo resuelve.
      } else if (mpToken) {
        // Sin tarjeta guardada: link de pago (el webhook confirma al acreditarse).
        await cobrarPorLink(medplum, event.secrets, { clave: cobro.clave, montoARS: totalARS, descripcion, pacienteRef, tier: m.tier, ciclo, invoiceId: cobro.invoiceId });
      } else {
        // Sin MP configurado: queda `issued`; se cobra en recepción (registrar-cobro
        // no aplica acá: la recepción resuelve el Invoice pendiente al cobrar).
        await enviarWhatsApp(medplum, event.secrets, {
          template: 'membresia-renovada',
          pacienteRef,
          body: `Biowellness: renovamos tu Membresía ${m.tier} para ${ciclo}. Aboná $${totalARS.toLocaleString('es-AR')} en tu próxima visita.`,
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
 *
 * 'rejected' significa EXCLUSIVAMENTE que MercadoPago procesó el pago y lo
 * rechazó (tarjeta sin fondos, vencida…): es lo único que dispara R-11 y el
 * WhatsApp de "tarjeta rechazada". Un HTTP de error (401 token roto, 5xx MP
 * caído, red) es 'error': tratarlo como rechazo bloqueaba en masa a todos los
 * socios con tarjeta guardada por un token mal cargado.
 */
async function cobrarTarjetaGuardada(
  mpToken: string,
  opts: { montoARS: number; descripcion: string; externalReference: string; customerId: string; cardId: string },
): Promise<'approved' | 'rejected' | 'pending' | 'error'> {
  try {
    const tokenResp = await fetch(`https://api.mercadopago.com/v1/card_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mpToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ card_id: opts.cardId }),
    });
    if (!tokenResp.ok) {
      console.error('cobro-membresias: card_tokens falló', tokenResp.status, await tokenResp.text().catch(() => ''));
      return 'error';
    }
    const { id: cardToken } = (await tokenResp.json()) as { id: string };

    const pagoResp = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mpToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': opts.externalReference,
      },
      signal: AbortSignal.timeout(15_000),
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
      return 'error';
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
    return 'error';
  }
}

/**
 * Cuota por link de pago: preferencia compartida (`crearPreferenciaMP`, la
 * misma del link de seña — antes había una copia local con OTRO default de
 * APP_BASE_URL) + WhatsApp. Si el link no se pudo generar, el WhatsApp ofrece
 * pagar en recepción Y queda una alerta: un fallo del cron era invisible y la
 * cuota quedaba pendiente sin que nadie lo supiera.
 */
async function cobrarPorLink(
  medplum: MedplumClient,
  secrets: BotEvent['secrets'],
  opts: { clave: string; montoARS: number; descripcion: string; pacienteRef?: string; tier: string; ciclo: string; invoiceId?: string },
): Promise<void> {
  const pref = await crearPreferenciaMP(secrets, {
    titulo: opts.descripcion,
    montoARS: opts.montoARS,
    referencia: opts.clave,
    idempotencia: opts.clave,
  });
  if (!pref.ok) {
    await crearAlertaRecepcion(medplum, {
      titulo: 'No se pudo generar el link de cobro de una membresía',
      detalle: `"${opts.descripcion}" ($${opts.montoARS.toLocaleString('es-AR')}): ${pref.mensaje ?? 'MercadoPago no respondió.'} El Invoice queda pendiente: cobrar en mostrador o reintentar el link desde Atender.`,
      pacienteRef: opts.pacienteRef,
      ...(opts.invoiceId ? { focusRef: `Invoice/${opts.invoiceId}` } : {}),
      clave: `mp-link-fallo-${opts.clave}`,
    });
  }
  await enviarWhatsApp(medplum, secrets, {
    template: 'membresia-cobro-link',
    pacienteRef: opts.pacienteRef,
    body: pref.url
      ? `Biowellness: se renovó tu Membresía ${opts.tier} (${opts.ciclo}). Aboná $${opts.montoARS.toLocaleString('es-AR')} acá: ${pref.url}`
      : `Biowellness: se renovó tu Membresía ${opts.tier} (${opts.ciclo}). Acercate a recepción para abonar $${opts.montoARS.toLocaleString('es-AR')}.`,
  });
}
