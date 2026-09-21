/**
 * Bot · Purga de la auditoría (cron).
 *
 * Borra los `AuditEvent` que pasaron su plazo de retención. Los plazos y la
 * decisión viven en `src/lib/auditoria.ts` (puros, testeados); acá solo está lo
 * que necesita el servidor: paginar, borrar y no morir en el intento.
 *
 * Existe porque `saveAuditEvents` guarda un evento por CADA interacción,
 * lecturas incluidas. Se activó con la purga escrita de antemano (Andrés,
 * 2026-09-21): un registro que nadie borra deja de ser una decisión y pasa a
 * ser una factura.
 *
 * ACOTADO POR DISEÑO. Un bot de Medplum corre en Lambda con un tope de tiempo,
 * así que esto no intenta vaciar la cola de una: borra hasta `maxBorrados` por
 * corrida y vuelve en la siguiente. Correrlo de más es inocuo —lo ya borrado no
 * está— y correrlo de menos solo retrasa la limpieza.
 *
 * EL CURSOR, que es la parte con trampa. Se pagina por `_lastUpdated`
 * ascendente y se avanza un cursor con lo último visto. Sin eso, los eventos
 * que se CONSERVAN (la evidencia de las firmas) quedarían siempre al frente de
 * la primera página y la purga no llegaría nunca a los de atrás: un bucle que
 * reporta éxito sin borrar nada. Si una página entera comparte el mismo
 * milisegundo, el cursor se empuja 1 ms para que igual haya progreso.
 *
 * La purga NO se audita a sí misma, y eso es del servidor y no nuestro: la
 * guarda de `fhir/repo.ts:2373` es
 * `saveAuditEvents && isResource(resource) && resource.resourceType !== 'AuditEvent'`,
 * así que un `AuditEvent` sobre un `AuditEvent` no se persiste **nunca**, sea
 * quien sea el autor. O sea que borrar no genera cola nueva.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { AuditEvent } from '@medplum/fhirtypes';
import { RETENCION_DIAS, RETENCION_FIRMA_DIAS, corteDeRetencion, decidirPurga } from '../lib/auditoria.js';
import { conEsperaDeCuota } from './_shared.js';

export interface EntradaPurgarAuditoria {
  /** Fecha de referencia ISO (default: ahora). Para pruebas y reprocesos. */
  ahora?: string;
  /** Tope de borrados por corrida. Default 500. */
  maxBorrados?: number;
  /** Tope de páginas por corrida (defensa contra un cursor que no avanza). Default 20. */
  maxPaginas?: number;
  /** Cuántos trae cada página. Default 200. */
  porPagina?: number;
  /** No borra nada: solo cuenta. Para la primera corrida. */
  dryRun?: boolean;
}

export interface ResultadoPurgarAuditoria {
  ok: boolean;
  /** Eventos borrados (o que se habrían borrado, con `dryRun`). */
  borrados: number;
  /** Eventos mirados y conservados: evidencia de firma, o sin fecha. */
  conservados: number;
  /** Los que no se pudieron borrar (permiso, 429 tras los reintentos). */
  fallidos: number;
  /** true si quedó trabajo para la próxima corrida. */
  quedaTrabajo: boolean;
  dryRun: boolean;
  mensaje?: string;
}

/** Lo que la decisión necesita de un AuditEvent del servidor. */
function aEvento(ae: AuditEvent): Parameters<typeof decidirPurga>[0] {
  return {
    fechaISO: ae.recorded ?? ae.meta?.lastUpdated,
    subtipos: (ae.subtype ?? []).map((s) => s.code),
    entidades: (ae.entity ?? []).map((e) => e.what?.reference),
  };
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaPurgarAuditoria>,
): Promise<ResultadoPurgarAuditoria> {
  const e = event.input ?? {};
  const ahora = e.ahora ? new Date(e.ahora) : new Date();
  const maxBorrados = e.maxBorrados ?? 500;
  const maxPaginas = e.maxPaginas ?? 20;
  const porPagina = e.porPagina ?? 200;
  const dryRun = e.dryRun === true;

  // Solo se MIRA lo que ya pasó el plazo corto: lo más nuevo que eso no es
  // purgable por ninguna de las dos reglas, y traerlo sería leer la tabla
  // entera para descartarla.
  const hasta = corteDeRetencion(ahora, RETENCION_DIAS);

  let borrados = 0;
  let conservados = 0;
  let fallidos = 0;
  let quedaTrabajo = false;
  let cursor: string | undefined;
  // Ids ya mirados en ESTA corrida. El cursor es `ge` y no `gt` para no saltear
  // eventos que compartan milisegundo con el último de la página, así que el
  // borde se relee a propósito: sin esta marca, el que quedó justo en el corte
  // se contaría dos veces (y con `dryRun`, donde no se borra nada, el conteo
  // entero se inflaba).
  const vistos = new Set<string>();

  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    if (borrados >= maxBorrados) {
      quedaTrabajo = true;
      break;
    }
    const filtros = [
      `_lastUpdated=lt${hasta}`,
      ...(cursor ? [`_lastUpdated=ge${cursor}`] : []),
      '_sort=_lastUpdated',
      `_count=${porPagina}`,
    ].join('&');

    let lote: AuditEvent[];
    try {
      lote = await conEsperaDeCuota(() => medplum.searchResources('AuditEvent', filtros));
    } catch (err) {
      // Sin permiso de lectura sobre AuditEvent el bot no puede hacer su
      // trabajo, y decirlo es más útil que devolver ceros como si todo
      // estuviera limpio.
      return {
        ok: false,
        borrados,
        conservados,
        fallidos,
        quedaTrabajo: true,
        dryRun,
        mensaje: `No se pudieron leer los AuditEvent: ${err instanceof Error ? err.message : 'error'}.`,
      };
    }
    if (lote.length === 0) {
      break;
    }

    let nuevosEnLaPagina = 0;
    for (const ae of lote) {
      if (borrados >= maxBorrados) {
        quedaTrabajo = true;
        break;
      }
      if (!ae.id || vistos.has(ae.id)) {
        continue;
      }
      vistos.add(ae.id);
      nuevosEnLaPagina++;
      if (decidirPurga(aEvento(ae), ahora) === 'conservar') {
        conservados++;
        continue;
      }
      if (dryRun) {
        borrados++;
        continue;
      }
      try {
        await conEsperaDeCuota(() => medplum.deleteResource('AuditEvent', ae.id as string));
        borrados++;
      } catch {
        // Uno que no se pudo borrar no frena a los demás: vuelve en la próxima
        // corrida y el contador lo deja a la vista.
        fallidos++;
      }
    }

    // Avanzar el cursor al último visto. Si la página no trajo NADA nuevo
    // —todos ya mirados, o todos del mismo milisegundo— se empuja 1 ms: sin
    // eso, una página de puros conservados se repetiría hasta agotar
    // `maxPaginas` sin avanzar un solo evento.
    const ultima = lote.map((a) => a.meta?.lastUpdated).filter((f): f is string => Boolean(f)).sort().at(-1);
    if (!ultima) {
      break; // sin fecha no hay por dónde seguir paginando
    }
    cursor = nuevosEnLaPagina === 0 ? new Date(new Date(ultima).getTime() + 1).toISOString() : ultima;
    if (lote.length === porPagina) {
      quedaTrabajo = true;
    }
  }

  return {
    ok: true,
    borrados,
    conservados,
    fallidos,
    quedaTrabajo,
    dryRun,
    ...(fallidos > 0 ? { mensaje: `${fallidos} evento(s) no se pudieron borrar; vuelven en la próxima corrida.` } : {}),
    ...(borrados === 0 && conservados === 0 ? { mensaje: 'Nada que purgar.' } : {}),
  };
}

/** Los plazos, re-exportados para que el diagnóstico los muestre sin duplicarlos. */
export { RETENCION_DIAS, RETENCION_FIRMA_DIAS };
