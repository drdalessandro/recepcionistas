/**
 * Expansor de combos: de «BIO LONGEVITY a las 10:00 para 2 personas» a la cadena
 * concreta de reservas, con recurso asignado y offset derivado.
 *
 * Todo lo que este archivo hace con los combos vale igual para una sesión
 * suelta: una suelta es una cadena de un tramo. No hay dos caminos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DÓNDE NO HAY REGLAS ESCRITAS A MANO
 *
 * El enunciado dice que HBOT Multiplaza no encadena bien con IHHT, porque seis
 * personas saliendo de la multiplaza contra dos puestos de IHHT son tres tandas
 * de media hora. Buscar acá esa regla es inútil: no está. Lo que hay es el
 * asignador genérico pidiendo `ocupantes` unidades de IHHT en la ventana del
 * tramo siguiente y encontrando dos. El rechazo sale solo; lo único que este
 * archivo agrega es un mensaje que le explique a recepción qué pasó.
 *
 * Lo mismo con la biplaza: que la combinación que encadena sin fricción sea
 * biplaza (2 personas) hacia 2 puestos de IHHT no está declarado en ningún lado.
 * Sale de probar las cámaras en orden y quedarse con la primera donde entran los
 * ocupantes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  aceptar,
  rechazar,
  rechazo,
  type Advertencia,
  type Rechazo,
  type Resultado,
} from '../dominio/rechazos.js';
import {
  horaLocalLegible,
  minutosDesdeMedianocheLocal,
  sumarMinutos,
} from '../dominio/tiempo.js';
import type {
  AgendaOcupada,
  Ocupacion,
  TipoProducto,
  TipoRecurso,
  TramoPlanificado,
  UnidadRecurso,
} from '../dominio/tipos.js';
import type { MotorCompilado } from '../validacion/validar-config.js';
import { derivarCadena, type TramoAEncadenar, type TramoDerivado } from './encadenamiento.js';
import { conOcupaciones, evaluarDisponibilidad } from './ocupacion.js';
import { asignarTumbonas } from './pool-tumbonas.js';

export interface PedidoDeExpansion {
  readonly motor: MotorCompilado;
  readonly producto: { readonly tipo: TipoProducto; readonly codigo: string };
  readonly inicio: Date;
  readonly ocupantes: number;
  readonly agenda: AgendaOcupada;
  /** Fuerza un servicio para un tramo, por número de orden. */
  readonly seleccion?: Readonly<Record<number, string>>;
}

export interface CadenaExpandida {
  readonly tramos: readonly TramoPlanificado[];
  readonly ocupaciones: readonly Ocupacion[];
  readonly inicio: Date;
  readonly fin: Date;
  readonly salidaCliente: Date;
}

/** Expande el producto en su cadena de reservas, o explica por qué no se puede. */
export function expandir(pedido: PedidoDeExpansion): Resultado<CadenaExpandida> {
  const { motor, producto, ocupantes } = pedido;

  if (!Number.isInteger(ocupantes) || ocupantes < 1) {
    return rechazar(
      rechazo('OCUPANTES_INVALIDOS', `La cantidad de ocupantes debe ser un entero de 1 en adelante (se pidió ${ocupantes}).`),
    );
  }

  const tramosDelCatalogo = resolverTramosDelCatalogo(pedido);
  if (!tramosDelCatalogo.ok) return tramosDelCatalogo;

  const variantes = enumerarVariantes(tramosDelCatalogo.valor, pedido.seleccion);
  if (variantes.length === 0) {
    return rechazar(
      rechazo(
        'COMBO_SIN_SERVICIO_APLICABLE',
        `El producto "${producto.codigo}" no ofrece ninguna combinación de servicios aplicable.`,
      ),
    );
  }

  // Se prueban las variantes en orden de preferencia. Si ninguna cierra, se
  // reporta la que llegó más lejos: es la que mejor explica el problema real.
  // Con dos ocupantes, «no entran en la monoplaza» es ruido; «no quedan puestos
  // de IHHT a las 11:00» es la respuesta.
  let mejorIntento: { profundidad: number; rechazos: readonly Rechazo[] } | undefined;

  for (const variante of variantes) {
    const intento = intentarVariante(pedido, variante);
    if (intento.ok) return aceptar(intento.valor);

    if (!mejorIntento || intento.profundidad > mejorIntento.profundidad) {
      mejorIntento = { profundidad: intento.profundidad, rechazos: intento.rechazos };
    }
  }

  return rechazar(...(mejorIntento?.rechazos ?? []));
}

// ── Resolución del catálogo ─────────────────────────────────────────────────

interface TramoDelCatalogo {
  readonly orden: number;
  readonly servicios: readonly string[];
}

function resolverTramosDelCatalogo(
  pedido: PedidoDeExpansion,
): Resultado<readonly TramoDelCatalogo[]> {
  const { motor, producto } = pedido;

  if (producto.tipo === 'suelta') {
    if (!motor.servicioPorCodigo.has(producto.codigo)) {
      return rechazar(
        rechazo('SERVICIO_DESCONOCIDO', `No existe el servicio "${producto.codigo}" en el catálogo.`),
      );
    }
    return aceptar([{ orden: 1, servicios: [producto.codigo] }]);
  }

  const combo = motor.comboPorCodigo.get(producto.codigo);
  if (!combo) {
    return rechazar(
      rechazo('PRODUCTO_DESCONOCIDO', `No existe el combo "${producto.codigo}" en el catálogo.`),
    );
  }
  const enOrden = [...combo.tramos].sort((a, b) => a.orden - b.orden);
  return aceptar(enOrden.map((t) => ({ orden: t.orden, servicios: t.servicios })));
}

/** Producto cartesiano de las alternativas, respetando lo que recepción forzó. */
function enumerarVariantes(
  tramos: readonly TramoDelCatalogo[],
  seleccion: Readonly<Record<number, string>> | undefined,
): string[][] {
  let variantes: string[][] = [[]];
  for (const tramo of tramos) {
    const forzado = seleccion?.[tramo.orden];
    const opciones = forzado
      ? tramo.servicios.filter((s) => s === forzado)
      : [...tramo.servicios];
    // Si recepción forzó algo que el tramo no ofrece, no hay variante posible.
    if (opciones.length === 0) return [];
    const siguiente: string[][] = [];
    for (const parcial of variantes) {
      for (const servicio of opciones) siguiente.push([...parcial, servicio]);
    }
    variantes = siguiente;
  }
  return variantes;
}

// ── Un intento con una combinación concreta de servicios ────────────────────

/**
 * Resultado de probar una combinación concreta de servicios.
 *
 * `profundidad` es cuántos tramos llegó a resolver antes de fallar. Sirve para
 * elegir, entre varias variantes fallidas, cuál explica mejor el problema.
 */
type IntentoDeVariante =
  | { readonly ok: true; readonly valor: CadenaExpandida }
  | { readonly ok: false; readonly profundidad: number; readonly rechazos: readonly Rechazo[] };

function intentarVariante(
  pedido: PedidoDeExpansion,
  variante: readonly string[],
): IntentoDeVariante {
  const { motor, inicio, ocupantes } = pedido;

  // 1. Traducir los servicios a tramos encadenables (servicio → recurso → tiempos).
  const aEncadenar: TramoAEncadenar[] = [];
  for (const [i, codigo] of variante.entries()) {
    const servicio = motor.servicioPorCodigo.get(codigo);
    if (!servicio) {
      return {
        ok: false,
        profundidad: i,
        rechazos: [rechazo('SERVICIO_DESCONOCIDO', `No existe el servicio "${codigo}".`)],
      };
    }
    const recurso = motor.recursoPorTipo.get(servicio.tipoRecurso);
    if (!recurso?.tiempos) {
      return {
        ok: false,
        profundidad: i,
        rechazos: [
          rechazo(
            'RECURSO_SIN_TIEMPOS',
            `"${servicio.nombre}" se ejecuta en ${recurso?.nombre ?? servicio.tipoRecurso}, que ` +
              `todavía no tiene tiempos definidos${recurso?.sinTiempos ? `: ${recurso.sinTiempos}` : '.'} ` +
              `No se puede agendar hasta que se midan.`,
            { detalle: { servicio: codigo, recurso: servicio.tipoRecurso } },
          ),
        ],
      };
    }
    aEncadenar.push({
      orden: i + 1,
      servicio: codigo,
      tipoRecurso: servicio.tipoRecurso,
      tiempos: recurso.tiempos,
    });
  }

  // 2. El inicio pedido tiene que caer en la grilla del primer recurso. Los
  //    tramos siguientes se alinean solos al derivar; el primero lo elige quien
  //    reserva, así que hay que revisarlo. Una cámara arranca en hora en punto;
  //    una tumbona, cada media hora.
  const primero = aEncadenar[0];
  if (primero) {
    const minutoDelDia = minutosDesdeMedianocheLocal(inicio, motor.config.reloj);
    const grilla = primero.tiempos.grillaInicioMin;
    if (minutoDelDia % grilla !== 0) {
      const recurso = motor.recursoPorTipo.get(primero.tipoRecurso);
      return {
        ok: false,
        profundidad: 0,
        rechazos: [
          rechazo(
            'INICIO_FUERA_DE_GRILLA',
            `${recurso?.nombre ?? primero.tipoRecurso} arranca cada ${grilla} minutos y se pidió ` +
              `a las ${horaLocalLegible(inicio, motor.config.reloj)}.`,
            { detalle: { grillaMin: grilla, minutoDelDia } },
          ),
        ],
      };
    }
  }

  // 3. Derivar los offsets. Acá no interviene la disponibilidad: son los tiempos.
  const cadena = derivarCadena(aEncadenar);

  // 4. Asignar unidades tramo por tramo, acumulando lo que se va tomando para
  //    que un tramo no se pise con otro del mismo plan.
  const tramosPlanificados: TramoPlanificado[] = [];
  const ocupaciones: Ocupacion[] = [];

  for (const derivado of cadena) {
    let agenda = conOcupaciones(pedido.agenda, ocupaciones);

    const asignacion = asignarUnidades({
      motor,
      derivado,
      inicio,
      ocupantes,
      agenda,
      esTramoEncadenado: derivado.orden > 1,
    });
    if (!asignacion.ok) {
      return { ok: false, profundidad: derivado.orden - 1, rechazos: asignacion.rechazos };
    }

    const inicioTramo = sumarMinutos(inicio, derivado.offsetMin);
    const finTramo = sumarMinutos(inicio, derivado.finRecursoMin);
    const nombreServicio =
      motor.servicioPorCodigo.get(derivado.servicio)?.nombre ?? derivado.servicio;

    const propias: Ocupacion[] = asignacion.valor.map((a) => ({
      unidadId: a.unidad.id,
      tipoRecurso: derivado.tipoRecurso,
      inicio: inicioTramo,
      fin: finTramo,
      motivo: nombreServicio,
      plazas: a.plazas,
    }));
    ocupaciones.push(...propias);

    // 5. Las sub-reservas que dispara la secuencia interna del recurso. Hoy sólo
    //    Recovery Pro, que toma una tumbona por ocupante del minuto 28 al 48.
    const subReservas: Ocupacion[] = [];
    for (const toma of derivado.tomasDePool) {
      agenda = conOcupaciones(pedido.agenda, [...ocupaciones, ...subReservas]);
      const desde = sumarMinutos(inicio, toma.desdeMin);
      const hasta = sumarMinutos(inicio, toma.hastaMin);

      const sub = tomarDelPool({
        motor,
        pool: toma.pool,
        consumidorEsRecoveryPro: derivado.tipoRecurso === 'recovery-pro',
        cantidad: ocupantes,
        inicio: desde,
        fin: hasta,
        agenda,
      });
      if (!sub.ok) {
        return { ok: false, profundidad: derivado.orden - 1, rechazos: sub.rechazos };
      }
      for (const unidad of sub.valor) {
        subReservas.push({
          unidadId: unidad.id,
          tipoRecurso: toma.pool,
          inicio: desde,
          fin: hasta,
          motivo: `${nombreServicio} · ${toma.etapa}`,
          plazas: 1,
        });
      }
    }
    ocupaciones.push(...subReservas);

    tramosPlanificados.push({
      orden: derivado.orden,
      servicio: derivado.servicio,
      tipoRecurso: derivado.tipoRecurso,
      offsetMin: derivado.offsetMin,
      unidades: asignacion.valor.map((a) => a.unidad.id),
      inicio: inicioTramo,
      finRecurso: finTramo,
      salidaCliente: sumarMinutos(inicio, derivado.salidaClienteMin),
      subReservas,
    });
  }

  const finMin = cadena.reduce((max, t) => Math.max(max, t.finRecursoMin), 0);
  const salidaMin = cadena.reduce((max, t) => Math.max(max, t.salidaClienteMin), 0);

  return {
    ok: true,
    valor: {
      tramos: tramosPlanificados,
      ocupaciones,
      inicio,
      fin: sumarMinutos(inicio, finMin),
      salidaCliente: sumarMinutos(inicio, salidaMin),
    },
  };
}

// ── Asignación de unidades ──────────────────────────────────────────────────

interface UnidadAsignada {
  readonly unidad: UnidadRecurso;
  readonly plazas: number;
}

interface PedidoDeUnidades {
  readonly motor: MotorCompilado;
  readonly derivado: TramoDerivado;
  readonly inicio: Date;
  readonly ocupantes: number;
  readonly agenda: AgendaOcupada;
  readonly esTramoEncadenado: boolean;
}

/**
 * Toma unidades hasta cubrir a todos los ocupantes.
 *
 * Una unidad con capacidad para varios (multiplaza 6, gabinete 2) absorbe a
 * todos los que quepan; una de capacidad 1 (puesto IHHT, tumbona) cubre a uno,
 * así que dos personas necesitan dos.
 */
function asignarUnidades(pedido: PedidoDeUnidades): Resultado<UnidadAsignada[]> {
  const { motor, derivado, inicio, ocupantes, agenda, esTramoEncadenado } = pedido;
  const reloj = motor.config.reloj;

  const recurso = motor.recursoPorTipo.get(derivado.tipoRecurso);
  if (!recurso) {
    return rechazar(
      rechazo('SERVICIO_DESCONOCIDO', `No existe el recurso "${derivado.tipoRecurso}".`),
    );
  }

  const inicioTramo = sumarMinutos(inicio, derivado.offsetMin);
  const finTramo = sumarMinutos(inicio, derivado.finRecursoMin);
  const ventana = `${horaLocalLegible(inicioTramo, reloj)}–${horaLocalLegible(finTramo, reloj)}`;

  // Las tumbonas pasan por el asignador direccional, incluso como tramo suelto.
  if (derivado.tipoRecurso === 'tumbona-red-light') {
    const asignadas = asignarTumbonas({
      consumidor: 'externo',
      cantidad: ocupantes,
      inicio: inicioTramo,
      fin: finTramo,
      tumbonas: recurso.unidades,
      agenda,
      reloj,
    });
    if (!asignadas.ok) return asignadas;
    return aceptar(asignadas.valor.map((unidad) => ({ unidad, plazas: 1 })));
  }

  const asignadas: UnidadAsignada[] = [];
  let restantes = ocupantes;

  for (const unidad of recurso.unidades) {
    if (restantes === 0) break;
    const plazas = Math.min(restantes, unidad.capacidad);
    if (evaluarDisponibilidad(agenda, unidad, inicioTramo, finTramo, plazas).tipo !== 'libre') {
      continue;
    }
    asignadas.push({ unidad, plazas });
    restantes -= plazas;
  }

  if (restantes === 0) return aceptar(asignadas);

  const capacidadTotal = recurso.unidades.reduce((s, u) => s + u.capacidad, 0);
  const libres = asignadas.reduce((s, a) => s + a.plazas, 0);

  // Este es el rechazo que el enunciado describe como «multiplaza no encadena
  // con IHHT». No hay una regla para ese caso: hay un tramo encadenado que pide
  // más lugares de los que quedan, y un mensaje que lo cuenta bien.
  if (esTramoEncadenado) {
    return rechazar(
      rechazo(
        'ENCADENAMIENTO_SIN_CAPACIDAD',
        `Salen ${ocupantes} persona(s) del tramo anterior y ${recurso.nombre} sólo tiene lugar ` +
          `para ${libres} entre ${ventana}. El encadenamiento no cierra: habría que partir el ` +
          `grupo en tandas.`,
        {
          detalle: {
            recurso: recurso.tipo,
            ocupantes,
            lugaresDisponibles: libres,
            unidadesTotales: recurso.unidades.length,
            ventana,
          },
        },
      ),
    );
  }

  if (ocupantes > capacidadTotal) {
    return rechazar(
      rechazo(
        'CAPACIDAD_EXCEDIDA',
        `${recurso.nombre} admite como máximo ${capacidadTotal} persona(s) y se pidieron ${ocupantes}.`,
        { detalle: { recurso: recurso.tipo, capacidadTotal, ocupantes } },
      ),
    );
  }

  return rechazar(
    rechazo(
      'RECURSO_OCUPADO',
      `${recurso.nombre} no tiene lugar para ${ocupantes} persona(s) entre ${ventana}: ` +
        `quedan ${libres}.`,
      { detalle: { recurso: recurso.tipo, ocupantes, lugaresDisponibles: libres, ventana } },
    ),
  );
}

interface PedidoDePool {
  readonly motor: MotorCompilado;
  readonly pool: TipoRecurso;
  readonly consumidorEsRecoveryPro: boolean;
  readonly cantidad: number;
  readonly inicio: Date;
  readonly fin: Date;
  readonly agenda: AgendaOcupada;
}

function tomarDelPool(pedido: PedidoDePool): Resultado<UnidadRecurso[]> {
  const { motor, pool, consumidorEsRecoveryPro, cantidad, inicio, fin, agenda } = pedido;
  const recurso = motor.recursoPorTipo.get(pool);
  if (!recurso) {
    return rechazar(rechazo('SERVICIO_DESCONOCIDO', `No existe el pool "${pool}".`));
  }

  if (pool === 'tumbona-red-light') {
    return asignarTumbonas({
      consumidor: consumidorEsRecoveryPro ? 'recovery-pro' : 'externo',
      cantidad,
      inicio,
      fin,
      tumbonas: recurso.unidades,
      agenda,
      reloj: motor.config.reloj,
    });
  }

  // Pools sin direccionalidad: primero el que esté libre.
  const libres = recurso.unidades.filter(
    (u) => evaluarDisponibilidad(agenda, u, inicio, fin, 1).tipo === 'libre',
  );
  if (libres.length < cantidad) {
    return rechazar(
      rechazo(
        'RECURSO_OCUPADO',
        `${recurso.nombre}: se necesitan ${cantidad} unidad(es) y hay ${libres.length} libre(s).`,
        { detalle: { pool, cantidad, disponibles: libres.length } },
      ),
    );
  }
  return aceptar(libres.slice(0, cantidad));
}

/** Advertencias por los tiempos no ratificados que participaron de la cadena. */
export function advertenciasDeTiempos(
  motor: MotorCompilado,
  tramos: readonly TramoPlanificado[],
): Advertencia[] {
  const advertencias: Advertencia[] = [];
  const vistos = new Set<string>();

  for (const tramo of tramos) {
    const tipos: TipoRecurso[] = [
      tramo.tipoRecurso,
      ...tramo.subReservas.map((s) => s.tipoRecurso),
    ];
    for (const tipo of tipos) {
      const marcas = motor.recursoPorTipo.get(tipo)?.tiempos?.noRatificado;
      if (!marcas) continue;
      for (const [campo, motivo] of Object.entries(marcas)) {
        const clave = `${tipo}.${campo}`;
        if (!motivo || vistos.has(clave)) continue;
        vistos.add(clave);
        advertencias.push({
          codigo: 'TIEMPO_NO_RATIFICADO',
          mensaje: `El plan usa un tiempo todavía no ratificado (${clave}): ${motivo}`,
          detalle: { recurso: tipo, campo },
        });
      }
    }
  }
  return advertencias;
}
