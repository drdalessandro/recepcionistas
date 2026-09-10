/**
 * Bot · Cobro recurrente de programas (cron diario).
 *
 * La contracara de `bw-cobro-membresias` para los programas por TIEMPO
 * (PB100D, handoff §6.10). Hasta acá los programas no se cobraban nunca: el cron
 * de membresías los saltea a propósito porque su cadencia es otra, y ese hueco
 * estaba documentado en `tests/programas.test.ts` esperando esta decisión.
 *
 * La cadencia la fija el brief §6.10: **cada 30 días desde el alta**, no el mes
 * calendario. Con mes calendario, alguien que compra un 28 pagaría el segundo mes
 * a los tres días.
 *
 * Sólo la modalidad **mensual**. La de 100 días es pago único: su Coverage vence
 * solo y no hay nada que renovar.
 *
 * IDEMPOTENCIA: no lleva marca de "ciclo facturado" en el Coverage. La verdad es
 * el Invoice —`plan-{coverage}-c{N}`, que `emitirInvoicePlan` no duplica—, y así
 * no existe la ventana fatal contra la que avisa `bw-cobro-membresias`: allá, si
 * el proceso muere entre marcar el ciclo y emitir la factura, ese mes no se cobra
 * nunca. Acá no hay dos escrituras que puedan quedar desparejas.
 *
 * PONE LA DEUDA, NO LA COBRA. Emite el Invoice `issued`; la plata la debita la
 * suscripción de MercadoPago que armó Recepción (D16: sin checkout propio), y el
 * webhook la concilia cuando llega. Si la cobertura no tiene suscripción armada,
 * el Invoice igual se emite y queda un aviso a Recepción: mejor una deuda visible
 * que una plata que nadie va a pedir.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Coverage } from '@medplum/fhirtypes';
import { PROGRAMAS_POR_CODIGO } from '../config/programas.js';
import { calcularCobro } from '../lib/pricing.js';
import { ciclosACobrar, claveCicloPrograma } from '../lib/programas.js';
import { esPlanBW, estadoDeCoverage, planCodigoDeCoverage } from '../fhir/coverage.js';
import { EXT, SYSTEM } from '../fhir/identifiers.js';
import { crearAlertaRecepcion, emitirInvoicePlan, leerTcVigente, notificarPortal } from './_shared.js';

export interface EntradaCobroProgramas {
  /** Fecha de referencia ISO (default: ahora). Útil para pruebas y reprocesos. */
  hoy?: string;
}

export interface ResultadoCobroProgramas {
  ok: boolean;
  /** Ciclos facturados en esta corrida. */
  cobrados: number;
  /** Ciclos que ya tenían su Invoice (no se duplican). */
  omitidos: number;
  /** Coberturas facturadas sin suscripción de MP armada: nadie las va a debitar. */
  sinSuscripcion: number;
}

/** El id de la suscripción de MercadoPago que debita esta cobertura, si lo hay. */
export function suscripcionDeCoverage(c: Coverage): string | undefined {
  return c.extension?.find((x) => x.url === EXT.mpSuscripcion)?.valueString;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaCobroProgramas>,
): Promise<ResultadoCobroProgramas> {
  const hoy = event.input?.hoy ? new Date(event.input.hoy) : new Date();
  const tc = await leerTcVigente(medplum);
  const coberturas = await medplum.searchResources('Coverage', { status: 'active', _count: 500 });

  let cobrados = 0;
  let omitidos = 0;
  let sinSuscripcion = 0;

  for (const c of coberturas) {
    // La obra social del paciente también es un Coverage activo: sin extensiones
    // de Biowellness no es un plan nuestro y no se toca.
    if (!esPlanBW(c) || !c.id) {
      continue;
    }
    if (estadoDeCoverage(c).tipo !== 'programa') {
      continue;
    }
    const planCodigo = planCodigoDeCoverage(c);
    const programa = planCodigo ? PROGRAMAS_POR_CODIGO.get(planCodigo) : undefined;
    if (!programa) {
      // Un código que no está en el catálogo es un dato mal cargado. Se avisa y
      // se sigue: `getPrograma` lanzaría y cortaría la corrida entera, y las
      // demás pacientes se quedarían sin cobrar por culpa de una.
      await crearAlertaRecepcion(medplum, {
        titulo: 'Programa con un código que no existe en el catálogo',
        detalle: `La cobertura ${c.id} dice "${planCodigo ?? '(sin código)'}" y no está en el catálogo de programas. No se facturó: revisá el alta.`,
        pacienteRef: c.beneficiary?.reference,
        focusRef: `Coverage/${c.id}`,
        clave: `programa-codigo-desconocido-${c.id}`,
      });
      continue;
    }
    // La de 100 días es pago único: se cobró en el alta y el Coverage vence solo.
    if (programa.modalidad !== 'mensual') {
      continue;
    }

    const pacienteRef = c.beneficiary?.reference;
    const suscripcion = suscripcionDeCoverage(c);

    for (const ciclo of ciclosACobrar(c.period?.start, hoy)) {
      const { totalARS } = calcularCobro([{ tipo: 'programa', codigo: programa.codigo }], { tc });
      const cobro = await emitirInvoicePlan(medplum, {
        coverageId: c.id,
        pacienteRef,
        tipo: 'programa',
        planCodigo: programa.codigo,
        descripcion: `${programa.nombre} · mes ${ciclo.numero}`,
        totalARS,
        tc,
        ciclo: claveCicloPrograma(ciclo.numero),
        status: 'issued',
      });
      if (cobro.yaExistia) {
        omitidos++;
        continue;
      }
      cobrados++;

      if (!suscripcion) {
        sinSuscripcion++;
        await crearAlertaRecepcion(medplum, {
          titulo: 'Programa mensual sin suscripción de MercadoPago',
          detalle:
            `Se facturó el mes ${ciclo.numero} de ${programa.nombre} (cobertura ${c.id}) y no hay suscripción armada, ` +
            'así que no lo va a debitar nadie. Armala en MercadoPago y cargá su id en la cobertura, o mandá el link de pago.',
          pacienteRef,
          focusRef: `Coverage/${c.id}`,
          clave: `programa-sin-suscripcion-${c.id}-${claveCicloPrograma(ciclo.numero)}`,
        });
      }

      await notificarPortal(medplum, {
        tipo: 'general',
        pacienteRef,
        texto: `Se renovó tu ${programa.nombre} por 30 días más.`,
        ...(cobro.invoiceId ? { about: `Invoice/${cobro.invoiceId}` } : {}),
        identifier: { system: SYSTEM.communication, value: `programa-renovado-${c.id}-${claveCicloPrograma(ciclo.numero)}` },
      });
    }
  }

  return { ok: true, cobrados, omitidos, sinSuscripcion };
}
