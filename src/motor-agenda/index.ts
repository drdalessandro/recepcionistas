/**
 * Motor de agenda de Biowellness — API pública.
 *
 * Decide si una reserva es posible, qué recursos físicos bloquea y en qué orden.
 * Es lógica pura: no habla FHIR, no habla red, no tiene reloj propio (el
 * instante «ahora» viaja en la solicitud). El mapeo a Medplum vive en
 * `docs/motor-agenda-fhir.md`.
 *
 * Uso típico:
 *
 * ```ts
 * const motor = compilarConfig(configSanIsidro());   // falla al arrancar si algo no cierra
 * const resultado = evaluarReserva({ motor, solicitud, agenda });
 * if (resultado.ok) {
 *   escribirEnLaAgenda(resultado.valor.ocupaciones);
 * } else {
 *   mostrarleARecepcion(resultado.rechazos);         // todos los motivos, no el primero
 * }
 * ```
 */

// ── Dominio ─────────────────────────────────────────────────────────────────
export type * from './dominio/tipos.js';
export * from './dominio/rechazos.js';
export {
  alinearAGrilla,
  diasEntre,
  fechaHoraLocalLegible,
  horaLocalLegible,
  instanteLocal,
  minutosEntre,
  nombreDia,
  seSuperponen,
  sumarDias,
  sumarMinutos,
  type DiaSemana,
  type RelojLocal,
} from './dominio/tiempo.js';

// ── Configuración ───────────────────────────────────────────────────────────
export {
  CANTIDADES_SAN_ISIDRO,
  RELOJ_BUENOS_AIRES,
  configSanIsidro,
  construirRecursos,
  type CantidadesRecursos,
  type OpcionesConfig,
} from './config/index.js';
export type * from './config/tipos.js';
export { COMBOS, SERVICIOS } from './config/catalogo.js';
export { LISTAS_PRECIOS, LISTA_2026_08, MEMBRESIAS } from './config/comercial.js';

// ── Validación de configuración ─────────────────────────────────────────────
export {
  auditarConfig,
  compilarConfig,
  nombreRecurso,
  type InformeDeConfiguracion,
  type MotorCompilado,
} from './validacion/validar-config.js';

// ── Agenda ──────────────────────────────────────────────────────────────────
export {
  bloqueoRecursoMin,
  derivarCadena,
  duracionCadenaMin,
  salidaClienteMin,
  salidaFinalCadenaMin,
  tomasDePool,
  type TramoAEncadenar,
  type TramoDerivado,
} from './agenda/encadenamiento.js';
export {
  AGENDA_VACIA,
  conOcupaciones,
  contarUnidadesLibres,
  estaDisponible,
  evaluarDisponibilidad,
  plazasLibres,
  unidadesDisponibles,
} from './agenda/ocupacion.js';
export {
  asignarTumbonas,
  type ConsumidorDeTumbona,
  type PedidoDeTumbonas,
} from './agenda/pool-tumbonas.js';
export {
  advertenciasDeTiempos,
  expandir,
  type CadenaExpandida,
  type PedidoDeExpansion,
} from './agenda/expansor.js';

// ── Reglas ──────────────────────────────────────────────────────────────────
export {
  esReservaClinica,
  verificarFranjaClinica,
  verificarHorario,
} from './reglas/calendario.js';
export {
  ventanaDelCliente,
  verificarAutorizacionMedica,
  verificarMora,
  verificarSaldoDeMembresia,
  verificarVentanaDeReserva,
} from './reglas/acceso.js';
export { evaluarReserva, type PedidoDeEvaluacion } from './reglas/motor.js';

// ── Comercial ───────────────────────────────────────────────────────────────
export {
  evaluarFoundingMember,
  explicarFmCaduco,
  fmVigente,
  type EstadoFoundingMember,
  type MotivoFmCaduco,
} from './comercial/founding.js';
export {
  cotizarMembresia,
  cotizarServicio,
  resolverLista,
  versionVigente,
  type ListaAplicable,
} from './comercial/precios.js';
export {
  aplicarPausa,
  diasDePausa,
  diasPausadosEnAnio,
  estaPausadaEn,
  evaluarCancelacion,
  finDeCiclo,
  puedeConsumirSesion,
  saldoDeSesiones,
  type EvaluacionDeCancelacion,
  type FuerzaMayorMedica,
} from './comercial/membresias.js';
