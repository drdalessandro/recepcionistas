/**
 * Demanda no cubierta sobre FHIR (transformaciones puras; quien llama hace el I/O).
 *
 * Un pedido de algo que no ofrecemos → `Basic` con el code `SYSTEM.demanda`.
 * `Basic` porque no es un dato clínico ni una tarea de nadie: es un hecho
 * comercial, igual que un movimiento de caja (`src/fhir/caja.ts` usa el mismo
 * recurso con otro code).
 *
 * Es un recurso propio y no un campo del lead a propósito, por dos razones:
 *
 *  - **No se pierde.** El lead solo se crea si la persona es nueva; quien ya
 *    tiene ficha —un paciente que pregunta si hacemos otra cosa— no genera
 *    tarjeta, y el pedido se evaporaba. Acá se registra siempre.
 *  - **Se cuenta.** `Basic?code=<demanda>|` lista todos los pedidos con un
 *    parámetro de búsqueda estándar, sin depender de leer 300 tarjetas del CRM.
 *
 * `subject` apunta a quien lo pidió: cuando el pedido se convierta en servicio,
 * la primera llamada es a los que lo pidieron. Ese es el retorno del dato.
 */
import type { Basic } from '@medplum/fhirtypes';
import { EXT, SYSTEM } from './identifiers.js';
import { normalizarPedido, type PedidoRegistrado } from '../lib/demanda.js';

/** `Basic.code.coding.code` — hoy el único: se pidió algo que no tenemos. */
export const CODIGO_DEMANDA_NO_DISPONIBLE = 'no-disponible';

export interface EntradaDemanda {
  /** El pedido tal como lo dijo (ya validado con `validarPedido`). */
  texto: string;
  /** Clave de agregación (`normalizarPedido`). */
  clave: string;
  /** Quién lo pidió (`Patient/…`), para poder avisarle si algún día lo tenemos. */
  pacienteRef?: string;
  /** Quién lo registró (`Practitioner/…`). */
  registradoPorRef?: string;
  /** Momento del pedido (ISO). Se guarda con precisión de día: `Basic.created` es `date`. */
  fechaISO: string;
}

/** Pedido → Basic listo para crear. */
export function demandaABasic(e: EntradaDemanda): Basic {
  return {
    resourceType: 'Basic',
    code: {
      coding: [{ system: SYSTEM.demanda, code: CODIGO_DEMANDA_NO_DISPONIBLE }],
      // El texto ORIGINAL, no la clave: la clave sirve para contar, el texto
      // para entender qué pidió realmente la persona.
      text: e.texto,
    },
    ...(e.pacienteRef ? { subject: { reference: e.pacienteRef } } : {}),
    // `Basic.author` solo acepta ciertos tipos; el perfil de recepción es un
    // Practitioner. Si viniera otra cosa, mejor sin autor que un recurso inválido.
    ...(e.registradoPorRef?.startsWith('Practitioner/') ? { author: { reference: e.registradoPorRef } } : {}),
    created: e.fechaISO.slice(0, 10),
    extension: [{ url: EXT.demandaClave, valueString: e.clave }],
  };
}

/** Basic → pedido (para armar el reporte). */
export function basicADemanda(b: Basic): (PedidoRegistrado & { pacienteRef?: string }) | undefined {
  const esDemanda = b.code?.coding?.some(
    (c) => c.system === SYSTEM.demanda && c.code === CODIGO_DEMANDA_NO_DISPONIBLE,
  );
  const texto = b.code?.text?.trim();
  if (!esDemanda || !texto) {
    return undefined;
  }
  return {
    texto,
    // Los registrados antes de que existiera la extensión (o por otra vía) se
    // agrupan igual: `agruparDemanda` recalcula la clave desde el texto.
    clave: b.extension?.find((e) => e.url === EXT.demandaClave)?.valueString ?? normalizarPedido(texto),
    fechaISO: b.created ?? b.meta?.lastUpdated,
    pacienteRef: b.subject?.reference,
  };
}
