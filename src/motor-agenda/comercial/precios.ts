/**
 * Cotización contra listas de precios versionadas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA LISTA CONGELADA DEL FOUNDING MEMBER
 *
 * El FM no congela el precio de su membresía: congela **la lista completa**
 * vigente el día de su inscripción. La diferencia importa el día que cambia de
 * producto. Si entró en agosto de 2026 con FOCUS y en 2028 pasa a HEALTHSPAN,
 * paga el HEALTHSPAN de agosto de 2026 —un producto que en su momento ni
 * contrató— y no el de 2028.
 *
 * De ahí que el cliente guarde una versión y no un precio, y que las versiones
 * sean inmutables: si alguien editara la lista de agosto de 2026, el beneficio
 * se evaporaría sin que nadie lo notara.
 *
 * Y de ahí también que una versión desconocida sea un rechazo y no un fallback a
 * la lista vigente: cotizarle a un FM contra la lista de hoy es exactamente el
 * error que el programa promete no cometer.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { aceptar, rechazar, rechazo, type Resultado } from '../dominio/rechazos.js';
import type {
  Cliente,
  Cotizacion,
  FormatoMembresia,
  ModalidadMembresia,
  PlazoMembresia,
  VersionListaPrecios,
} from '../dominio/tipos.js';
import type { MotorCompilado } from '../validacion/validar-config.js';
import { fmVigente } from './founding.js';

/** La lista contra la que hay que cotizarle a este cliente, y por qué. */
export interface ListaAplicable {
  readonly lista: VersionListaPrecios;
  readonly motivo: 'vigente' | 'lista-congelada-fm';
}

/** La versión vigente en un instante dado. */
export function versionVigente(
  motor: MotorCompilado,
  ahora: Date,
): VersionListaPrecios | undefined {
  const candidatas = motor.config.listasPrecios.filter(
    (l) => l.vigenteDesde <= ahora && (!l.vigenteHasta || ahora < l.vigenteHasta),
  );
  return candidatas.reduce<VersionListaPrecios | undefined>(
    (masNueva, l) => (!masNueva || l.vigenteDesde > masNueva.vigenteDesde ? l : masNueva),
    undefined,
  );
}

/** Resuelve qué lista aplica: la congelada del FM, o la vigente. */
export function resolverLista(
  motor: MotorCompilado,
  cliente: Cliente,
  ahora: Date,
): Resultado<ListaAplicable> {
  if (fmVigente(cliente)) {
    if (!cliente.fmVersionListaPrecios) {
      // Todo fundador congela una lista el día que se inscribe. Uno sin versión
      // registrada es un dato roto, no un cliente común: cotizarlo contra la
      // lista de hoy le cobraría de más y nadie se enteraría.
      return rechazar(
        rechazo(
          'VERSION_LISTA_DESCONOCIDA',
          `El cliente es Founding Member pero no tiene registrada la versión de lista que ` +
            `congeló al inscribirse. No se cotiza contra la lista vigente: sería cobrarle de más. ` +
            `Hay que cargarle la versión de su fecha de inscripción.`,
          { regla: 'R-09', detalle: { cliente: cliente.id } },
        ),
      );
    }

    const congelada = motor.listaPorVersion.get(cliente.fmVersionListaPrecios);
    if (!congelada) {
      return rechazar(
        rechazo(
          'VERSION_LISTA_DESCONOCIDA',
          `El cliente es Founding Member con la lista "${cliente.fmVersionListaPrecios}" congelada, ` +
            `pero esa versión no existe en el sistema. No se cotiza contra la lista vigente: ` +
            `sería cobrarle de más. Hay que restaurar la versión antes de vender.`,
          { regla: 'R-09', detalle: { version: cliente.fmVersionListaPrecios } },
        ),
      );
    }
    return aceptar({ lista: congelada, motivo: 'lista-congelada-fm' });
  }

  const vigente = versionVigente(motor, ahora);
  if (!vigente) {
    return rechazar(
      rechazo(
        'VERSION_LISTA_DESCONOCIDA',
        `No hay ninguna lista de precios vigente al ${ahora.toISOString()}.`,
      ),
    );
  }
  return aceptar({ lista: vigente, motivo: 'vigente' });
}

// ── Sesiones sueltas ────────────────────────────────────────────────────────

export interface PedidoDeCotizacionDeServicio {
  readonly motor: MotorCompilado;
  readonly servicio: string;
  readonly ocupantes: number;
  readonly cliente: Cliente;
  readonly ahora: Date;
}

/**
 * Cotiza una sesión suelta.
 *
 * El precio tabulado es **por persona** y puede depender de cuántos son, que es
 * lo que dicen R-04 y R-06: la biplaza sale USD 100 por persona con dos y USD
 * 165 con una (precio monoplaza), y la multiplaza USD 80 por persona desde uno,
 * sin piso de sesión.
 */
export function cotizarServicio(pedido: PedidoDeCotizacionDeServicio): Resultado<Cotizacion> {
  const { motor, servicio, ocupantes, cliente, ahora } = pedido;

  if (!motor.servicioPorCodigo.has(servicio)) {
    return rechazar(rechazo('SERVICIO_DESCONOCIDO', `No existe el servicio "${servicio}".`));
  }

  const aplicable = resolverLista(motor, cliente, ahora);
  if (!aplicable.ok) return aplicable;
  const { lista, motivo } = aplicable.valor;

  const precio = lista.servicios.find((p) => p.servicio === servicio);
  const porPersona = precio?.precioPorOcupantesUsd[ocupantes] ?? precio?.precioPorPersonaUsd;

  if (porPersona === undefined) {
    return rechazar(
      rechazo(
        'PRECIO_NO_DEFINIDO',
        `La lista "${lista.version}" no tiene precio para "${servicio}" con ${ocupantes} ocupante(s). ` +
          `No se inventa un número: hay que cargarlo en la lista.`,
        { detalle: { servicio, ocupantes, version: lista.version } },
      ),
    );
  }

  return aceptar({
    totalUsd: redondearMoneda(porPersona * ocupantes),
    porPersonaUsd: redondearMoneda(porPersona),
    ocupantes,
    versionLista: lista.version,
    motivoVersion: motivo,
  });
}

// ── Membresías ──────────────────────────────────────────────────────────────

export interface PedidoDeCotizacionDeMembresia {
  readonly motor: MotorCompilado;
  readonly membresia: string;
  readonly modalidad: ModalidadMembresia;
  readonly formato: FormatoMembresia;
  readonly plazo: PlazoMembresia;
  readonly cliente: Cliente;
  readonly ahora: Date;
}

/**
 * Cotiza una membresía.
 *
 * El precio base de la lista corresponde al plazo trimestral. El plazo mensual
 * sin compromiso lleva el recargo declarado en la propia versión de la lista
 * —así, si el recargo cambia, el FM sigue pagando el de su lista congelada—.
 */
export function cotizarMembresia(
  pedido: PedidoDeCotizacionDeMembresia,
): Resultado<Cotizacion> {
  const { motor, membresia, modalidad, formato, plazo, cliente, ahora } = pedido;

  if (!motor.membresiaPorCodigo.has(membresia)) {
    return rechazar(rechazo('PRODUCTO_DESCONOCIDO', `No existe la membresía "${membresia}".`));
  }

  const aplicable = resolverLista(motor, cliente, ahora);
  if (!aplicable.ok) return aplicable;
  const { lista, motivo } = aplicable.valor;

  const precio = lista.membresias.find(
    (p) => p.membresia === membresia && p.modalidad === modalidad && p.formato === formato,
  );
  if (!precio) {
    return rechazar(
      rechazo(
        'PRECIO_NO_DEFINIDO',
        `La lista "${lista.version}" no tiene precio para ${membresia} ${modalidad} ${formato}.`,
        { detalle: { membresia, modalidad, formato, version: lista.version } },
      ),
    );
  }

  const totalUsd =
    plazo === 'mensual'
      ? precio.precioBaseUsd * (1 + lista.recargoPlazoMensual)
      : precio.precioBaseUsd;

  const personas = formato === 'pareja' ? 2 : 1;

  return aceptar({
    totalUsd: redondearMoneda(totalUsd),
    porPersonaUsd: redondearMoneda(totalUsd / personas),
    ocupantes: personas,
    versionLista: lista.version,
    motivoVersion: motivo,
  });
}

/** Dos decimales, sin arrastrar el error binario de los flotantes. */
function redondearMoneda(valor: number): number {
  return Math.round(valor * 100) / 100;
}
