/**
 * Validador de configuración. Corre **al arrancar**, no al reservar.
 *
 * Una configuración que no cierra es un bug de despliegue, no un caso de uso.
 * Por eso este módulo lanza `ErrorDeConfiguracion` con la lista completa de
 * problemas en vez de fallar en el primero: quien la arregla quiere verlos todos
 * de una vez.
 *
 * El invariante que le da sentido al archivo:
 *
 *     setup + terapia + turnaround <= slot
 *
 * Un recurso que no lo cumple no produce un atraso puntual: produce **atraso
 * acumulativo** a lo largo del día, porque cada turno arranca un poco más tarde
 * que el anterior y nadie recupera esos minutos.
 */

import { ErrorDeConfiguracion } from '../dominio/rechazos.js';
import type {
  Combo,
  Membresia,
  Recurso,
  Servicio,
  TiemposRecurso,
  TipoRecurso,
  UnidadRecurso,
  VersionListaPrecios,
} from '../dominio/tipos.js';
import {
  anclaDerivadaDeEtapas,
  bloqueoRecursoMin,
  derivarCadena,
  duracionCadenaMin,
  salidaClienteMin,
} from '../agenda/encadenamiento.js';
import type { ConfigMotor, NotaNoRatificada } from '../config/tipos.js';

/** Resultado de auditar una configuración, sin lanzar. */
export interface InformeDeConfiguracion {
  readonly problemas: readonly string[];
  readonly noRatificado: readonly NotaNoRatificada[];
  /** Datos que faltan pero que no impiden arrancar (precios sin cargar). */
  readonly faltantes: readonly string[];
  /** Combos cuya duración derivada no coincide con la publicada. */
  readonly discrepanciasDeDuracion: readonly string[];
}

const ES_ENTERO_NO_NEGATIVO = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Audita la configuración y devuelve todo lo encontrado, sin lanzar.
 * `compilarConfig` es quien decide qué es fatal.
 */
export function auditarConfig(config: ConfigMotor): InformeDeConfiguracion {
  const problemas: string[] = [];
  const noRatificado: NotaNoRatificada[] = [];
  const faltantes: string[] = [];
  const discrepanciasDeDuracion: string[] = [];

  validarOperacion(config, problemas);
  const tiposDeclarados = validarRecursos(config, problemas, noRatificado);
  const serviciosPorCodigo = validarServicios(config, tiposDeclarados, problemas);
  validarCombos(config, serviciosPorCodigo, problemas);
  validarMembresias(config, problemas);
  validarListasDePrecios(config, problemas, faltantes, noRatificado);
  validarDuracionesPublicadas(config, serviciosPorCodigo, discrepanciasDeDuracion);

  return { problemas, noRatificado, faltantes, discrepanciasDeDuracion };
}

// ── Operación ───────────────────────────────────────────────────────────────

function validarOperacion(config: ConfigMotor, problemas: string[]): void {
  if (!ES_ENTERO_NO_NEGATIVO(config.granularidadAgendaMin) || config.granularidadAgendaMin <= 0) {
    problemas.push('granularidadAgendaMin debe ser un entero positivo.');
  }

  if (config.horario.length === 0) {
    problemas.push('El horario de operación está vacío: el centro no abre nunca.');
  }
  const diasVistos = new Set<number>();
  for (const dia of config.horario) {
    if (diasVistos.has(dia.dia)) {
      problemas.push(`El día ${dia.dia} está declarado dos veces en el horario.`);
    }
    diasVistos.add(dia.dia);
    if (dia.aperturaMin >= dia.cierreMin) {
      problemas.push(
        `Horario del día ${dia.dia}: la apertura (${dia.aperturaMin}) no es anterior al cierre (${dia.cierreMin}).`,
      );
    }
  }

  const franja = config.franjaClinica;
  if (franja.desdeMin >= franja.hastaMin) {
    problemas.push('La franja clínica termina antes de empezar.');
  }
  if (franja.ultimoInicioMin < franja.desdeMin || franja.ultimoInicioMin >= franja.hastaMin) {
    problemas.push(
      `El último inicio de la franja clínica (${franja.ultimoInicioMin}) cae fuera de la franja ` +
        `[${franja.desdeMin}, ${franja.hastaMin}).`,
    );
  }
  for (const dia of franja.dias) {
    if (!diasVistos.has(dia)) {
      problemas.push(
        `La franja clínica incluye el día ${dia}, pero ese día el centro está cerrado.`,
      );
    }
  }

  const ventanas = config.ventanasReservaHoras;
  for (const [nombre, horas] of Object.entries(ventanas)) {
    if (typeof horas !== 'number' || horas <= 0) {
      problemas.push(`La ventana de reserva "${nombre}" debe ser un número de horas positivo.`);
    }
  }

  const pausa = config.pausa;
  if (pausa.bloqueMinimoDias > pausa.diasPorAnioCalendario) {
    problemas.push(
      `El bloque mínimo de pausa (${pausa.bloqueMinimoDias} días) supera el cupo anual ` +
        `(${pausa.diasPorAnioCalendario} días): ninguna pausa sería posible.`,
    );
  }
  if (pausa.baseProporcionalDias <= 0) {
    problemas.push('pausa.baseProporcionalDias debe ser positivo: es el divisor de la proporción.');
  }
  for (const mes of pausa.mesesVentana) {
    if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
      problemas.push(`La ventana de pausa incluye un mes inválido: ${mes}.`);
    }
  }

  if (config.cancelacion.horasParaDevolverSesion < 0) {
    problemas.push('cancelacion.horasParaDevolverSesion no puede ser negativo.');
  }
  if (config.membresia.diasVigenciaCiclo <= 0) {
    problemas.push('membresia.diasVigenciaCiclo debe ser positivo.');
  }
}

// ── Recursos ────────────────────────────────────────────────────────────────

function validarRecursos(
  config: ConfigMotor,
  problemas: string[],
  noRatificado: NotaNoRatificada[],
): Set<TipoRecurso> {
  const tipos = new Set<TipoRecurso>();
  const idsDeUnidad = new Set<string>();

  for (const recurso of config.recursos) {
    if (tipos.has(recurso.tipo)) {
      problemas.push(`El tipo de recurso "${recurso.tipo}" está declarado dos veces.`);
    }
    tipos.add(recurso.tipo);

    validarUnidades(recurso, idsDeUnidad, problemas);

    if (recurso.tiempos && recurso.sinTiempos) {
      problemas.push(
        `El recurso "${recurso.tipo}" declara tiempos y a la vez dice no tenerlos. Es uno o el otro.`,
      );
      continue;
    }
    if (!recurso.tiempos) {
      if (!recurso.sinTiempos?.trim()) {
        problemas.push(
          `El recurso "${recurso.tipo}" no tiene tiempos y tampoco explica por qué ` +
            `(falta "sinTiempos"). Un recurso sin tiempos no se puede agendar, y el motivo ` +
            `tiene que quedar escrito.`,
        );
      }
      continue;
    }

    validarTiempos(recurso.tipo, recurso.tiempos, config.recursos, problemas);
    recolectarNoRatificados(recurso, noRatificado);
  }

  return tipos;
}

function validarUnidades(
  recurso: Recurso,
  idsVistos: Set<string>,
  problemas: string[],
): void {
  if (recurso.unidades.length === 0) {
    problemas.push(`El recurso "${recurso.tipo}" no tiene ninguna unidad declarada.`);
  }
  for (const unidad of recurso.unidades) {
    if (idsVistos.has(unidad.id)) {
      problemas.push(`El id de unidad "${unidad.id}" está repetido.`);
    }
    idsVistos.add(unidad.id);

    if (unidad.tipo !== recurso.tipo) {
      problemas.push(
        `La unidad "${unidad.id}" dice ser de tipo "${unidad.tipo}" pero cuelga del recurso "${recurso.tipo}".`,
      );
    }
    if (!Number.isInteger(unidad.capacidad) || unidad.capacidad < 1) {
      problemas.push(`La unidad "${unidad.id}" tiene capacidad inválida (${unidad.capacidad}).`);
    }
    if (recurso.tipo === 'tumbona-red-light' && !unidad.ubicacion) {
      problemas.push(
        `La tumbona "${unidad.id}" no declara ubicación. Sin ubicación no se puede ` +
          `respetar la direccionalidad del pool (Recovery Pro nunca va al área común).`,
      );
    }
  }
}

function validarTiempos(
  tipo: TipoRecurso,
  t: TiemposRecurso,
  recursos: readonly Recurso[],
  problemas: string[],
): void {
  const campos: readonly (readonly [string, unknown])[] = [
    ['slotMin', t.slotMin],
    ['setupMin', t.setupMin],
    ['terapiaMin', t.terapiaMin],
    ['turnaroundMin', t.turnaroundMin],
    ['grillaInicioMin', t.grillaInicioMin],
  ];
  let faltaAlguno = false;
  for (const [nombre, valor] of campos) {
    if (!ES_ENTERO_NO_NEGATIVO(valor)) {
      problemas.push(
        `Recurso "${tipo}": ${nombre} falta o no es un entero no negativo (se recibió ${String(valor)}). ` +
          `Un valor faltante nunca toma un default: se corrige en la configuración.`,
      );
      faltaAlguno = true;
    }
  }
  if (faltaAlguno) return;

  if (t.slotMin <= 0) {
    problemas.push(`Recurso "${tipo}": el slot debe ser positivo.`);
    return;
  }
  if (t.grillaInicioMin <= 0) {
    problemas.push(`Recurso "${tipo}": la grilla de inicio debe ser positiva.`);
    return;
  }

  // ── El invariante ──
  const ocupado = t.setupMin + t.terapiaMin + t.turnaroundMin;
  if (ocupado > t.slotMin) {
    problemas.push(
      `Recurso "${tipo}": setup (${t.setupMin}) + terapia (${t.terapiaMin}) + turnaround ` +
        `(${t.turnaroundMin}) = ${ocupado} min, que supera el slot de ${t.slotMin} min. ` +
        `Un recurso que no cierra genera atraso acumulativo a lo largo del día, no un atraso puntual.`,
    );
  }

  // ── El ancla de salida ──
  if (t.anclaSalidaMin !== undefined) {
    if (!ES_ENTERO_NO_NEGATIVO(t.anclaSalidaMin)) {
      problemas.push(`Recurso "${tipo}": anclaSalidaMin no es un entero no negativo.`);
    } else {
      if (t.anclaSalidaMin < t.setupMin + t.terapiaMin) {
        problemas.push(
          `Recurso "${tipo}": el ancla de salida (${t.anclaSalidaMin}) cae antes de que termine ` +
            `la terapia (setup + terapia = ${t.setupMin + t.terapiaMin}). El cliente no puede salir ` +
            `antes de terminar.`,
        );
      }
      if (t.anclaSalidaMin > bloqueoRecursoMin(t)) {
        problemas.push(
          `Recurso "${tipo}": el ancla de salida (${t.anclaSalidaMin}) cae después de que el recurso ` +
            `se libera (${bloqueoRecursoMin(t)}). El cliente saldría de un recurso ya reasignado.`,
        );
      }
    }
  }

  validarEtapas(tipo, t, recursos, problemas);
}

function validarEtapas(
  tipo: TipoRecurso,
  t: TiemposRecurso,
  recursos: readonly Recurso[],
  problemas: string[],
): void {
  const etapas = t.etapas;
  if (!etapas || etapas.length === 0) return;

  const ordenadas = [...etapas].sort((a, b) => a.desdeMin - b.desdeMin);
  const primera = ordenadas[0];
  if (!primera || primera.desdeMin !== 0) {
    problemas.push(`Recurso "${tipo}": la secuencia interna no arranca en el minuto 0.`);
  }

  for (let i = 0; i < ordenadas.length; i++) {
    const etapa = ordenadas[i];
    if (!etapa) continue;
    if (etapa.hastaMin <= etapa.desdeMin) {
      problemas.push(
        `Recurso "${tipo}", etapa "${etapa.nombre}": termina (${etapa.hastaMin}) antes o cuando ` +
          `empieza (${etapa.desdeMin}).`,
      );
    }
    const siguiente = ordenadas[i + 1];
    if (siguiente && siguiente.desdeMin !== etapa.hastaMin) {
      problemas.push(
        `Recurso "${tipo}": la secuencia interna tiene un salto entre "${etapa.nombre}" ` +
          `(termina en ${etapa.hastaMin}) y "${siguiente.nombre}" (empieza en ${siguiente.desdeMin}). ` +
          `Las etapas tienen que ser contiguas: el desfasaje entre gabinetes depende de que lo sean.`,
      );
    }
    if (etapa.ocupa !== 'propio') {
      const pool = etapa.ocupa.pool;
      if (!recursos.some((r) => r.tipo === pool)) {
        problemas.push(
          `Recurso "${tipo}", etapa "${etapa.nombre}": toma del pool "${pool}", que no existe.`,
        );
      }
    }
  }

  const ultima = ordenadas[ordenadas.length - 1];
  if (ultima && ultima.hastaMin > t.slotMin) {
    problemas.push(
      `Recurso "${tipo}": la secuencia interna termina en el minuto ${ultima.hastaMin}, ` +
        `más allá del slot de ${t.slotMin}.`,
    );
  }

  const anclaEtapas = anclaDerivadaDeEtapas(etapas);
  if (
    anclaEtapas !== undefined &&
    t.anclaSalidaMin !== undefined &&
    t.anclaSalidaMin !== anclaEtapas
  ) {
    problemas.push(
      `Recurso "${tipo}": el ancla declarada (${t.anclaSalidaMin}) contradice a la secuencia interna, ` +
        `donde el cliente sale en el minuto ${anclaEtapas}. Declarar una sola de las dos.`,
    );
  }
}

function recolectarNoRatificados(recurso: Recurso, notas: NotaNoRatificada[]): void {
  const marcas = recurso.tiempos?.noRatificado;
  if (!marcas) return;
  for (const [campo, motivo] of Object.entries(marcas)) {
    if (motivo) notas.push({ ambito: `recurso:${recurso.tipo}.${campo}`, motivo });
  }
}

// ── Catálogo ────────────────────────────────────────────────────────────────

function validarServicios(
  config: ConfigMotor,
  tiposDeclarados: Set<TipoRecurso>,
  problemas: string[],
): Map<string, Servicio> {
  const porCodigo = new Map<string, Servicio>();
  for (const servicio of config.servicios) {
    if (porCodigo.has(servicio.codigo)) {
      problemas.push(`El servicio "${servicio.codigo}" está declarado dos veces.`);
    }
    porCodigo.set(servicio.codigo, servicio);
    if (!tiposDeclarados.has(servicio.tipoRecurso)) {
      problemas.push(
        `El servicio "${servicio.codigo}" se ejecuta sobre "${servicio.tipoRecurso}", que no existe.`,
      );
    }
  }
  return porCodigo;
}

function validarCombos(
  config: ConfigMotor,
  servicios: Map<string, Servicio>,
  problemas: string[],
): void {
  const vistos = new Set<string>();
  for (const combo of config.combos) {
    if (vistos.has(combo.codigo)) {
      problemas.push(`El combo "${combo.codigo}" está declarado dos veces.`);
    }
    vistos.add(combo.codigo);

    if (combo.tramos.length === 0) {
      problemas.push(`El combo "${combo.codigo}" no tiene tramos.`);
      continue;
    }
    const ordenes = combo.tramos.map((t) => t.orden).sort((a, b) => a - b);
    for (let i = 0; i < ordenes.length; i++) {
      if (ordenes[i] !== i + 1) {
        problemas.push(
          `El combo "${combo.codigo}" tiene los órdenes de tramo [${ordenes.join(', ')}]: ` +
            `tienen que ser 1..${ordenes.length} sin huecos ni repeticiones.`,
        );
        break;
      }
    }
    for (const tramo of combo.tramos) {
      if (tramo.servicios.length === 0) {
        problemas.push(`El combo "${combo.codigo}", tramo ${tramo.orden}, no ofrece ningún servicio.`);
      }
      for (const codigo of tramo.servicios) {
        if (!servicios.has(codigo)) {
          problemas.push(
            `El combo "${combo.codigo}", tramo ${tramo.orden}, referencia el servicio "${codigo}", que no existe.`,
          );
        }
      }
    }
  }
}

function validarMembresias(config: ConfigMotor, problemas: string[]): void {
  const combos = new Set(config.combos.map((c) => c.codigo));
  const vistas = new Set<string>();
  for (const m of config.membresias) {
    if (vistas.has(m.codigo)) {
      problemas.push(`La membresía "${m.codigo}" está declarada dos veces.`);
    }
    vistas.add(m.codigo);
    if (!combos.has(m.comboBase)) {
      problemas.push(
        `La membresía "${m.codigo}" se basa en el combo "${m.comboBase}", que no existe.`,
      );
    }
    for (const [modalidad, sesiones] of Object.entries(m.sesionesPorModalidad)) {
      if (!Number.isInteger(sesiones) || sesiones <= 0) {
        problemas.push(
          `La membresía "${m.codigo}", modalidad "${modalidad}", declara ${sesiones} sesiones.`,
        );
      }
    }
  }
}

// ── Precios ─────────────────────────────────────────────────────────────────

function validarListasDePrecios(
  config: ConfigMotor,
  problemas: string[],
  faltantes: string[],
  noRatificado: NotaNoRatificada[],
): void {
  if (config.listasPrecios.length === 0) {
    problemas.push('No hay ninguna versión de lista de precios cargada.');
    return;
  }

  const versiones = new Set<string>();
  for (const lista of config.listasPrecios) {
    if (versiones.has(lista.version)) {
      problemas.push(`La versión de lista "${lista.version}" está declarada dos veces.`);
    }
    versiones.add(lista.version);

    if (lista.vigenteHasta && lista.vigenteHasta <= lista.vigenteDesde) {
      problemas.push(`La lista "${lista.version}" deja de estar vigente antes de empezar.`);
    }
    if (lista.recargoPlazoMensual < 0) {
      problemas.push(`La lista "${lista.version}" tiene un recargo mensual negativo.`);
    }
    validarPreciosDeLista(config, lista, problemas, faltantes);
  }

  noRatificado.push({
    ambito: 'membresias.estructura-y-precios',
    motivo:
      '[PROPUESTA NO RATIFICADA] La estructura de membresías (tiers, modalidades, formatos y ' +
      'precios) está en revisión. Los valores cargados son la propuesta sobre la mesa, no una ' +
      'lista acordada.',
  });
  noRatificado.push({
    ambito: 'pausa.redondeoSesiones',
    motivo:
      'Con 15 días sobre 30 la proporción da exacta (8 → 4), pero un bloque de 20 días da 2,67 ' +
      'sesiones y nadie decidió hacia qué lado redondear.',
  });
  noRatificado.push({
    ambito: 'franjaClinica.bloqueaFlujoNormal',
    motivo:
      'Está en false: el enunciado sólo dice que las reservas clínicas se bloquean fuera de la ' +
      'franja, no que las de bienestar se bloqueen dentro. Falta decisión de producto.',
  });
}

function validarPreciosDeLista(
  config: ConfigMotor,
  lista: VersionListaPrecios,
  problemas: string[],
  faltantes: string[],
): void {
  const membresias = new Map(config.membresias.map((m) => [m.codigo, m] as const));
  const combinacionesVistas = new Set<string>();

  for (const precio of lista.membresias) {
    const clave = `${precio.membresia}|${precio.modalidad}|${precio.formato}`;
    if (combinacionesVistas.has(clave)) {
      problemas.push(`La lista "${lista.version}" repite el precio de ${clave}.`);
    }
    combinacionesVistas.add(clave);
    if (!membresias.has(precio.membresia)) {
      problemas.push(
        `La lista "${lista.version}" pone precio a la membresía "${precio.membresia}", que no existe.`,
      );
    }
    if (!(precio.precioBaseUsd > 0)) {
      problemas.push(`La lista "${lista.version}", ${clave}: el precio base debe ser positivo.`);
    }
  }

  // Toda membresía existente debería tener sus cuatro combinaciones.
  for (const m of config.membresias) {
    for (const modalidad of ['standard', 'intensivo'] as const) {
      for (const formato of ['individual', 'pareja'] as const) {
        const clave = `${m.codigo}|${modalidad}|${formato}`;
        if (!combinacionesVistas.has(clave)) {
          faltantes.push(`Lista "${lista.version}": falta el precio de ${clave}.`);
        }
      }
    }
  }

  const conPrecio = new Set(lista.servicios.map((s) => s.servicio));
  for (const servicio of config.servicios) {
    if (!conPrecio.has(servicio.codigo)) {
      const aviso =
        `Lista "${lista.version}": el servicio "${servicio.codigo}" no tiene precio cargado. ` +
        `Cotizarlo devolverá PRECIO_NO_DEFINIDO en vez de inventar un número.`;
      if (config.exigirCatalogoDePreciosCompleto) problemas.push(aviso);
      else faltantes.push(aviso);
    }
  }

  for (const precio of lista.servicios) {
    if (!config.servicios.some((s) => s.codigo === precio.servicio)) {
      problemas.push(
        `La lista "${lista.version}" pone precio al servicio "${precio.servicio}", que no existe.`,
      );
    }
    const tabulados = Object.entries(precio.precioPorOcupantesUsd);
    if (tabulados.length === 0 && precio.precioPorPersonaUsd === undefined) {
      problemas.push(
        `La lista "${lista.version}", servicio "${precio.servicio}": no declara ningún precio.`,
      );
    }
    for (const [ocupantes, valor] of tabulados) {
      if (!(valor > 0)) {
        problemas.push(
          `La lista "${lista.version}", servicio "${precio.servicio}" con ${ocupantes} ocupante(s): ` +
            `el precio debe ser positivo.`,
        );
      }
    }
  }
}

// ── Duraciones publicadas ───────────────────────────────────────────────────

/**
 * Contrasta la duración **derivada** de cada combo contra la publicada en el
 * Manual. No es un error: es una discrepancia entre el modelo y el catálogo
 * comercial, y quién tiene razón es una decisión de producto.
 */
function validarDuracionesPublicadas(
  config: ConfigMotor,
  servicios: Map<string, Servicio>,
  discrepancias: string[],
): void {
  const tiemposPorTipo = new Map<TipoRecurso, TiemposRecurso>();
  for (const r of config.recursos) {
    if (r.tiempos) tiemposPorTipo.set(r.tipo, r.tiempos);
  }

  for (const combo of config.combos) {
    if (combo.duracionPublicadaMin === undefined) continue;

    for (const variante of variantesDeCombo(combo)) {
      const tramos = [];
      let completo = true;
      for (const [orden, codigo] of variante.entries()) {
        const servicio = servicios.get(codigo);
        const tiempos = servicio ? tiemposPorTipo.get(servicio.tipoRecurso) : undefined;
        if (!servicio || !tiempos) {
          completo = false;
          break;
        }
        tramos.push({ orden: orden + 1, servicio: codigo, tipoRecurso: servicio.tipoRecurso, tiempos });
      }
      if (!completo) continue;

      const derivada = duracionCadenaMin(derivarCadena(tramos));
      if (derivada !== combo.duracionPublicadaMin) {
        discrepancias.push(
          `Combo "${combo.codigo}" (${variante.join(' → ')}): el Manual publica ` +
            `${combo.duracionPublicadaMin} min y el modelo deriva ${derivada} min. ` +
            `O el catálogo o los tiempos del recurso están desactualizados.`,
        );
      }
    }
  }
}

/** Todas las combinaciones de servicios alternativos de un combo. */
function variantesDeCombo(combo: Combo): string[][] {
  const enOrden = [...combo.tramos].sort((a, b) => a.orden - b.orden);
  let variantes: string[][] = [[]];
  for (const tramo of enOrden) {
    const siguiente: string[][] = [];
    for (const parcial of variantes) {
      for (const servicio of tramo.servicios) siguiente.push([...parcial, servicio]);
    }
    variantes = siguiente;
  }
  return variantes;
}

// ── Índice compilado ────────────────────────────────────────────────────────

/** La configuración validada, con los índices que el motor usa en caliente. */
export interface MotorCompilado {
  readonly config: ConfigMotor;
  readonly recursoPorTipo: ReadonlyMap<TipoRecurso, Recurso>;
  readonly servicioPorCodigo: ReadonlyMap<string, Servicio>;
  readonly comboPorCodigo: ReadonlyMap<string, Combo>;
  readonly membresiaPorCodigo: ReadonlyMap<string, Membresia>;
  readonly listaPorVersion: ReadonlyMap<string, VersionListaPrecios>;
  readonly unidadPorId: ReadonlyMap<string, UnidadRecurso>;
  readonly informe: InformeDeConfiguracion;
}

/**
 * Valida la configuración y devuelve el motor listo para usar.
 *
 * Lanza `ErrorDeConfiguracion` si algo no cierra. Con
 * `config.exigirRatificacion`, los valores no ratificados también son fatales:
 * es el interruptor que se prende el día que el Manual cierre sus pendientes.
 */
export function compilarConfig(config: ConfigMotor): MotorCompilado {
  const informe = auditarConfig(config);

  const fatales = [...informe.problemas];
  if (config.exigirRatificacion && informe.noRatificado.length > 0) {
    for (const nota of informe.noRatificado) {
      fatales.push(
        `Valor no ratificado con exigirRatificacion activo — ${nota.ambito}: ${nota.motivo}`,
      );
    }
  }
  if (fatales.length > 0) throw new ErrorDeConfiguracion(fatales);

  const unidadPorId = new Map<string, UnidadRecurso>();
  for (const recurso of config.recursos) {
    for (const unidad of recurso.unidades) unidadPorId.set(unidad.id, unidad);
  }

  return {
    config,
    recursoPorTipo: new Map(config.recursos.map((r) => [r.tipo, r] as const)),
    servicioPorCodigo: new Map(config.servicios.map((s) => [s.codigo, s] as const)),
    comboPorCodigo: new Map(config.combos.map((c) => [c.codigo, c] as const)),
    membresiaPorCodigo: new Map(config.membresias.map((m) => [m.codigo, m] as const)),
    listaPorVersion: new Map(config.listasPrecios.map((l) => [l.version, l] as const)),
    unidadPorId,
    informe,
  };
}

/** Nombre legible de un tipo de recurso, para los mensajes de recepción. */
export function nombreRecurso(motor: MotorCompilado, tipo: TipoRecurso): string {
  return motor.recursoPorTipo.get(tipo)?.nombre ?? tipo;
}

export { salidaClienteMin, bloqueoRecursoMin };
