/**
 * Rechazos tipados del motor de agenda.
 *
 * Un rechazo nunca es un booleano. Recepción necesita saber **por qué** no se
 * puede reservar para poder decírselo al cliente, y el motor necesita que la
 * razón sea un dato (no un string armado a mano) para poder testearla.
 *
 * Dos principios:
 *  - El motor devuelve **todos** los rechazos aplicables, no el primero. Si un
 *    turno falla por estar fuera de la ventana de reserva *y* sin autorización
 *    médica, recepción se entera de las dos cosas de una vez en vez de
 *    descubrirlas de a una.
 *  - Cada rechazo referencia su regla (`R-xx`) cuando la tiene, para que el
 *    mensaje sea rastreable hasta el Manual.
 */

/** Motivo de rechazo. El código es el contrato; el mensaje es para la persona. */
export type CodigoRechazo =
  // ── Configuración y catálogo ──
  | 'PRODUCTO_DESCONOCIDO'
  | 'SERVICIO_DESCONOCIDO'
  | 'RECURSO_SIN_TIEMPOS'
  | 'PRECIO_NO_DEFINIDO'
  | 'VERSION_LISTA_DESCONOCIDA'
  | 'SELECCION_DE_TRAMO_INVALIDA'
  | 'COMBO_SIN_SERVICIO_APLICABLE'
  // ── Calendario y horario ──
  | 'CENTRO_CERRADO'
  | 'FUERA_DE_HORARIO'
  | 'NO_TERMINA_ANTES_DEL_CIERRE'
  | 'INICIO_FUERA_DE_GRILLA'
  // ── Capacidad y recursos ──
  | 'RECURSO_OCUPADO'
  | 'CAPACIDAD_EXCEDIDA'
  | 'OCUPANTES_INVALIDOS'
  | 'SIN_TUMBONA_DISPONIBLE'
  | 'TUMBONA_STANDALONE_PROHIBIDA'
  | 'ENCADENAMIENTO_SIN_CAPACIDAD'
  // ── Reglas comerciales y clínicas ──
  | 'SIN_AUTORIZACION_MEDICA'
  | 'FUERA_DE_FRANJA_CLINICA'
  | 'VENTANA_RESERVA_EXCEDIDA'
  | 'RESERVA_EN_PASADO'
  | 'MEMBRESIA_SIN_SALDO'
  | 'MEMBRESIA_INACTIVA'
  | 'CLIENTE_EN_MORA';

/** Un motivo concreto por el que una reserva no se puede hacer. */
export interface Rechazo {
  readonly codigo: CodigoRechazo;
  /** Regla del Manual que lo origina (`'R-03'`, `'R-06'`…), si tiene una. */
  readonly regla?: string;
  /** Texto en español, listo para mostrarle a la recepcionista. */
  readonly mensaje: string;
  /** Datos de apoyo: qué recurso, qué ventana, cuántos ocupantes. */
  readonly detalle?: Readonly<Record<string, unknown>>;
}

/**
 * Resultado de cualquier operación del motor que pueda fallar por reglas de
 * negocio. Se discrimina por `ok`, así TypeScript obliga a mirar los rechazos
 * antes de tocar el valor.
 */
export type Resultado<T> =
  | { readonly ok: true; readonly valor: T; readonly advertencias: readonly Advertencia[] }
  | { readonly ok: false; readonly rechazos: readonly Rechazo[] };

/**
 * Algo que no impide reservar pero que recepción debería ver: un valor de
 * configuración todavía no ratificado que participó del cálculo, una duración
 * derivada que no coincide con la publicada.
 */
export interface Advertencia {
  readonly codigo: string;
  readonly mensaje: string;
  readonly detalle?: Readonly<Record<string, unknown>>;
}

export function aceptar<T>(valor: T, advertencias: readonly Advertencia[] = []): Resultado<T> {
  return { ok: true, valor, advertencias };
}

export function rechazar<T>(...rechazos: readonly Rechazo[]): Resultado<T> {
  return { ok: false, rechazos };
}

/** Construye un rechazo. Existe para que el `codigo` y la `regla` no se separen. */
export function rechazo(
  codigo: CodigoRechazo,
  mensaje: string,
  opciones: { regla?: string; detalle?: Record<string, unknown> } = {},
): Rechazo {
  const r: Rechazo = { codigo, mensaje };
  return {
    ...r,
    ...(opciones.regla ? { regla: opciones.regla } : {}),
    ...(opciones.detalle ? { detalle: opciones.detalle } : {}),
  };
}

/** ¿El resultado trae este código de rechazo? Azúcar para los tests y la UI. */
export function tieneRechazo<T>(resultado: Resultado<T>, codigo: CodigoRechazo): boolean {
  return !resultado.ok && resultado.rechazos.some((r) => r.codigo === codigo);
}

/** Todos los rechazos de una lista de resultados, aplanados y sin duplicar. */
export function juntarRechazos(...resultados: readonly Resultado<unknown>[]): Rechazo[] {
  const juntos: Rechazo[] = [];
  const vistos = new Set<string>();
  for (const resultado of resultados) {
    if (resultado.ok) continue;
    for (const r of resultado.rechazos) {
      const clave = `${r.codigo}|${r.mensaje}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      juntos.push(r);
    }
  }
  return juntos;
}

/** Todas las advertencias de una lista de resultados aceptados. */
export function juntarAdvertencias(...resultados: readonly Resultado<unknown>[]): Advertencia[] {
  return resultados.flatMap((r) => (r.ok ? [...r.advertencias] : []));
}

/**
 * Error de configuración. Se lanza **al arrancar**, nunca durante una reserva:
 * una configuración que no cierra es un bug de despliegue, no un caso de uso.
 */
export class ErrorDeConfiguracion extends Error {
  readonly problemas: readonly string[];

  constructor(problemas: readonly string[]) {
    const lista = problemas.map((p) => `  · ${p}`).join('\n');
    super(
      `La configuración del motor de agenda no es válida ` +
        `(${problemas.length} ${problemas.length === 1 ? 'problema' : 'problemas'}):\n${lista}`,
    );
    this.name = 'ErrorDeConfiguracion';
    this.problemas = problemas;
  }
}
