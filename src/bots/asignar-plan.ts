/**
 * Bot · Asignar plan (membresía o paquete) a un paciente.
 *
 * Dos flujos según el medio de pago del cobro inicial:
 *
 * - **Presencial** (efectivo / tarjeta / transferencia): la plata ya cambió de
 *   manos en el mostrador → Coverage `active`, Invoice `balanced` + ChargeItem,
 *   bienvenida y constancia. (Como siempre.)
 * - **MercadoPago** (pago remoto asincrónico): acá NO hay plata todavía →
 *   Coverage `draft` (plan PENDIENTE, sin sesiones utilizables por R-10),
 *   Invoice `issued` (sin ChargeItem: nada se informa a Administración),
 *   link de pago de MP con external_reference `plan-{coverageId}[-{ciclo}]`
 *   y WhatsApp con el link. La ACTIVACIÓN la hace `resolverInvoicePlan` cuando
 *   el webhook verifica el pago (o cobrar-pendiente si paga en mostrador).
 *
 * El saldo se descuenta al reservar (R-10) y, en membresías, se renueva los
 * días 1-5 (bot bw-cobro-membresias; solo toca coverages `active`).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Coverage } from '@medplum/fhirtypes';
import { getMembresia } from '../config/membresias.js';
import { getPaquete } from '../config/paquetes.js';
import { calcularCobro } from '../lib/pricing.js';
import { cicloMes } from '../lib/planes.js';
import { EXT, SYSTEM, esMedioPago } from '../fhir/identifiers.js';
import { crearPreferenciaMP, emitirInvoicePlan, enviarWhatsApp, leerTcVigente, notificarPortal, resolverInvoicePlan } from './_shared.js';

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
  /** true: el plan quedó PENDIENTE de pago (MP); se activa al acreditarse. */
  pendiente?: boolean;
  /** Link de pago de MercadoPago (flujo pendiente). */
  url?: string;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaAsignarPlan>,
): Promise<ResultadoAsignarPlan> {
  const e = event.input;
  try {
    // Validaciones ANTES de crear nada (un medio inválido no debe dejar un
    // Coverage huérfano).
    const cobrar = e.cobrar !== false;
    if (cobrar && e.medioPago && !esMedioPago(e.medioPago)) {
      return { ok: false, mensaje: `Medio de pago inválido: "${e.medioPago}".` };
    }
    const esRemoto = cobrar && e.medioPago === 'mercadopago';

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

    const { totalARS } = calcularCobro([{ tipo: e.tipo, codigo: e.planCodigo, fm: e.fm }], { tc });

    // Anti-duplicado (flujo pendiente): si el paciente YA tiene este mismo plan
    // esperando el pago, se reutiliza (regenera el link, no crea otro Coverage).
    if (esRemoto) {
      const pendientes = await medplum.searchResources(
        'Coverage',
        `beneficiary=${e.pacienteRef}&status=draft&_count=20`,
      );
      const existente = pendientes.find(
        (c) => c.extension?.find((x) => x.url === EXT.planCodigo)?.valueString === e.planCodigo,
      );
      if (existente?.id) {
        const cicloDraft = existente.extension?.find((x) => x.url === EXT.cicloMes)?.valueString;
        const clave = cicloDraft ? `plan-${existente.id}-${cicloDraft}` : `plan-${existente.id}`;
        let inv = await medplum.searchOne('Invoice', `identifier=${SYSTEM.invoice}|${clave}`);

        // Ya PAGADO (una corrida anterior murió antes de activar): completar la
        // activación en vez de volver a cobrar un plan con la plata adentro.
        if (inv?.status === 'balanced') {
          await resolverInvoicePlan(medplum, { clave, resultado: 'pagado', secrets: event.secrets });
          return {
            ok: true,
            coverageId: existente.id,
            invoiceId: inv.id,
            totalARS: inv.totalGross?.value ?? totalARS,
            sesiones,
            mensaje: 'Este plan ya estaba pagado: se completó la activación (no se cobra de nuevo).',
          };
        }

        // Invoice ausente (crash entre crear el Coverage y emitirlo): emitirlo
        // AHORA — jamás un link de pago cuyo external_reference no tenga Invoice
        // (la plata entraría sin registro).
        if (!inv) {
          const cobro = await emitirInvoicePlan(medplum, {
            coverageId: existente.id,
            pacienteRef: e.pacienteRef,
            tipo: e.tipo,
            planCodigo: e.planCodigo,
            descripcion,
            totalARS,
            tc,
            ciclo: cicloDraft,
            status: 'issued',
          });
          inv = cobro.invoiceId ? await medplum.readResource('Invoice', cobro.invoiceId) : undefined;
        }

        const montoPendiente = inv?.totalGross?.value ?? totalARS;
        const pref = await crearPreferenciaMP(event.secrets, {
          titulo: `${descripcion} · cobro inicial`,
          montoARS: montoPendiente,
          referencia: clave,
          idempotencia: clave,
        });
        // Reenviar el link al paciente (el reintento suele ser porque no le llegó).
        const montoTxt = `$${montoPendiente.toLocaleString('es-AR')}`;
        await enviarWhatsApp(medplum, event.secrets, {
          template: 'plan-link-pago',
          pacienteRef: e.pacienteRef,
          variables: [descripcion, montoTxt, pref.url ?? 'coordinándolo con recepción'],
          body: `Biowellness: ¡reservamos tu ${descripcion}! Para activarla aboná ${montoTxt}${
            pref.url ? ` en este enlace: ${pref.url}` : ' (recepción te pasa el medio de pago)'
          } — cuando se acredite te confirmamos por acá y quedan tus ${sesiones} sesiones disponibles.`,
        });
        return {
          ok: true,
          pendiente: true,
          coverageId: existente.id,
          invoiceId: inv?.id,
          totalARS: montoPendiente,
          sesiones,
          url: pref.url,
          mensaje: 'Este plan ya estaba pendiente de pago: se reutilizó (link regenerado y reenviado).',
        };
      }
    }

    // 2) Crear el Coverage. Presencial: activo. MercadoPago: DRAFT (pendiente
    // de pago; R-10 impide usar sesiones hasta que el webhook lo active).
    const coverage = await medplum.createResource<Coverage>({
      resourceType: 'Coverage',
      status: esRemoto ? 'draft' : 'active',
      beneficiary: { reference: e.pacienteRef },
      subscriber: { reference: e.pacienteRef },
      payor: [{ reference: e.pacienteRef }],
      period: { start: desde.toISOString(), ...(periodEnd ? { end: periodEnd } : {}) },
      extension,
    });

    // 3) Cobro inicial.
    let invoiceId: string | undefined;
    let claveInvoice: string | undefined;
    if (cobrar && coverage.id) {
      const cobro = await emitirInvoicePlan(medplum, {
        coverageId: coverage.id,
        pacienteRef: e.pacienteRef,
        tipo: e.tipo,
        planCodigo: e.planCodigo,
        descripcion,
        totalARS,
        tc,
        ciclo: cicloExt,
        // Pendiente (MP): `issued`, sin medio (se estampa al acreditarse).
        // Presencial: `balanced` + ChargeItem con el medio real.
        status: esRemoto ? 'issued' : 'balanced',
        medioPago: !esRemoto && e.medioPago && esMedioPago(e.medioPago) ? e.medioPago : undefined,
      });
      invoiceId = cobro.invoiceId;
      claveInvoice = cobro.clave;
    }

    // 4) Flujo PENDIENTE (MercadoPago): link + WhatsApp con link + campanita.
    // La bienvenida y el "recibimos tu pago" salen recién al acreditarse.
    if (esRemoto && claveInvoice) {
      const pref = await crearPreferenciaMP(event.secrets, {
        titulo: `${descripcion} · cobro inicial`,
        montoARS: totalARS,
        referencia: claveInvoice,
        idempotencia: claveInvoice,
      });
      const monto = `$${totalARS.toLocaleString('es-AR')}`;
      await enviarWhatsApp(medplum, event.secrets, {
        template: 'plan-link-pago',
        pacienteRef: e.pacienteRef,
        // Plantilla: {{1}} plan · {{2}} monto · {{3}} link (docs/whatsapp-plantillas.md).
        variables: [descripcion, monto, pref.url ?? 'coordinándolo con recepción'],
        body: `Biowellness: ¡reservamos tu ${descripcion}! Para activarla aboná ${monto}${
          pref.url ? ` en este enlace: ${pref.url}` : ' (recepción te pasa el medio de pago)'
        } — cuando se acredite te confirmamos por acá y quedan tus ${sesiones} sesiones disponibles.`,
      });
      await notificarPortal(medplum, {
        tipo: 'general',
        pacienteRef: e.pacienteRef,
        about: invoiceId ? `Invoice/${invoiceId}` : undefined,
        identifier: { system: SYSTEM.communication, value: `portal-plan-link-${claveInvoice}` },
        texto: `Te enviamos el link de pago de tu ${descripcion} (${monto}). Al acreditarse, el plan se activa solo.`,
      });
      return {
        ok: true,
        pendiente: true,
        coverageId: coverage.id,
        invoiceId,
        totalARS,
        sesiones,
        url: pref.url,
        ...(pref.ok ? {} : { mensaje: pref.mensaje }),
      };
    }

    // 5) Flujo PRESENCIAL: bienvenida + constancia (la plata ya está).
    await enviarWhatsApp(medplum, event.secrets, {
      template: 'plan-asignado',
      pacienteRef: e.pacienteRef,
      body: `Biowellness: ¡activamos tu ${descripcion}! Tenés ${sesiones} sesiones${
        e.tipo === 'membresia' ? ' este mes' : ` (vencen el ${new Date(periodEnd!).toLocaleDateString('es-AR')})`
      }. ¡Te esperamos!`,
    });

    if (invoiceId && claveInvoice) {
      await notificarPortal(medplum, {
        tipo: 'pago-recibido',
        pacienteRef: e.pacienteRef,
        about: `Invoice/${invoiceId}`,
        identifier: { system: SYSTEM.communication, value: `portal-pago-${claveInvoice}` },
        texto: `¡Activamos tu ${descripcion}! Recibimos el pago de $${totalARS.toLocaleString('es-AR')}. Tenés ${sesiones} sesiones disponibles.`,
      });
    }

    return { ok: true, coverageId: coverage.id, invoiceId, totalARS, sesiones };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : 'No se pudo asignar el plan.' };
  }
}
