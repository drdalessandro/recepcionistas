/**
 * Médicos que atienden en el consultorio.
 *
 * Hay UN solo consultorio (recurso R_CONSULTORIO, capacidad 1): tres médicos
 * distintos atienden ahí, nunca superpuestos (la regla R-07 de capacidad lo
 * garantiza). El precio de la consulta es por médico y está en ARS (pesos),
 * no en USD.
 */
import type { ModalidadAtencion } from '../domain/types.js';
import type { EspecialidadCodigo } from '../fhir/identifiers.js';

/** Franja de atención semanal de un médico (día 0=domingo … 6=sábado). */
export interface FranjaAgendaMedico {
  dia: number;
  desde: string; // "HH:MM"
  hasta: string; // "HH:MM"
}

export interface Medico {
  codigo: string;
  nombre: string;
  /** Director Médico (honorario fijo mensual, sin split por consulta). */
  esDirector: boolean;
  /**
   * Especialidad publicada (`ESPECIALIDADES` en `src/fhir/identifiers.ts`) →
   * `PractitionerRole.specialty`. Es lo que permite al portal y al Dashboard
   * listar profesionales agrupados por especialidad, que es como los busca el
   * paciente ("un cardiólogo"), no por nombre.
   */
  especialidad?: EspecialidadCodigo;
  /**
   * Precio de la consulta PRESENCIAL en ARS. **Ausente = no atiende
   * presencial** (y entonces no se publica servicio presencial suyo).
   */
  precioConsultaARS?: number;
  /**
   * Precio de la TELECONSULTA en ARS. Ausente = no atiende por videollamada.
   *
   * Es un precio propio y no un recargo: la teleconsulta es otro producto. En
   * el caso del Dr. D'Alessandro conviven las dos (Andrés, 2026-09-16): su
   * evaluación presencial sigue a 120.000 y la consulta de cardiología por
   * video vale 150.000 por el uso de la plataforma y del tablero
   * cardiovascular del Dashboard.
   */
  precioTeleconsultaARS?: number;
  /** Marca de precio provisorio (pendiente de confirmar). */
  precioProvisorio?: boolean;
  /**
   * Agenda PUBLICADA en el portal (Schedule `bw-sched-*` + Slots free que
   * genera el seed). Sin agenda acá, el seed no publica nada para ese médico
   * (su Schedule puede existir creado a mano en el server, como hoy los de
   * la Dra. Dos Santos y el Dr. D'Alessandro).
   */
  agenda?: FranjaAgendaMedico[];
  /**
   * Agenda publicada de la TELECONSULTA. Separada de la presencial porque son
   * ofertas distintas: se puede atender por video en horarios en los que el
   * consultorio está ocupado por otro profesional. Slots de 60 min (Andrés,
   * 2026-09-16).
   */
  agendaTeleconsulta?: FranjaAgendaMedico[];
}

export const MEDICOS: Medico[] = [
  {
    codigo: 'MED_DALESSANDRO',
    // Nombre COMPLETO (MN 92179), unificado con el Dashboard clínico por
    // decisión de Andrés (2026-09-17). Antes acá estaba el corto —"Dr. Alejandro
    // D'Alessandro"— y el Dashboard tenía el completo: dos formas del mismo
    // nombre que no se rompían pero se leían raro al mirar los dos lados, y que
    // además hacían que `claveNombre` diera las dos fichas por personas
    // distintas (ver src/fhir/practitioner.ts y `medicos:consolidar`).
    //
    // El cambio NO reescribe el pasado: los turnos ya creados guardan el nombre
    // del servicio en su `description`, y ahí sigue el corto. Es correcto —un
    // turno dice lo que decía el día que se reservó— y por eso no hay migración.
    nombre: "Dr. Alejandro Sergio D'Alessandro",
    esDirector: false,
    especialidad: 'cardiologia',
    precioConsultaARS: 120_000,
    // Teleconsulta de cardiología (Andrés, 2026-09-16). NO reemplaza a su
    // evaluación presencial de 120.000: son dos productos. Los 150.000 pagan
    // además el uso de la plataforma y del tablero cardiovascular.
    precioTeleconsultaARS: 150_000,
    // Definido por Andrés (2026-08-13).
    agenda: [
      { dia: 2, desde: '16:00', hasta: '20:00' }, // Martes
      { dia: 3, desde: '08:00', hasta: '12:00' }, // Miércoles
      { dia: 4, desde: '16:00', hasta: '20:00' }, // Jueves
    ],
    // Teleconsulta cardiológica: LUNES y VIERNES de 18 a 20 (Andrés,
    // 2026-09-17). Son días que NO toca su agenda presencial, y el viernes el
    // consultorio lo tiene el Dr. Conrado (17-20) — que es exactamente para lo
    // que existe una agenda de video aparte: atender por videollamada en
    // horarios en los que el consultorio está ocupado por otro profesional.
    agendaTeleconsulta: [
      { dia: 1, desde: '18:00', hasta: '20:00' }, // Lunes
      { dia: 5, desde: '18:00', hasta: '20:00' }, // Viernes
    ],
  },
  {
    codigo: 'MED_DOS_SANTOS',
    nombre: 'Dra. Stephanie Dos Santos',
    esDirector: false,
    especialidad: 'medicinaGeneral',
    precioConsultaARS: 120_000,
    // Definido por Andrés (2026-08-13).
    agenda: [{ dia: 3, desde: '17:00', hasta: '20:00' }], // Miércoles
  },
  {
    codigo: 'MED_CONRADO',
    nombre: 'Dr. Conrado López Alonso',
    esDirector: true,
    especialidad: 'traumatologia',
    // PROVISORIO: el Director Médico cobra más; confirmar monto con Andrés.
    precioConsultaARS: 150_000,
    precioProvisorio: true,
    // Andrés (2026-08-13): pasa a VIERNES 17-20. Antes era miércoles 17-20
    // (Alejandro, 2026-07-26), que chocaba con la Dra. Dos Santos por el
    // único consultorio. Al mover la franja, el seed borra los slots libres
    // del miércoles que ya no corresponden (ver reconciliación en seed/index).
    agenda: [{ dia: 5, desde: '17:00', hasta: '20:00' }],
  },
  {
    // Teleconsulta de endocrinología y diabetes (Andrés, 2026-09-16).
    // Sin `precioConsultaARS`: por ahora atiende SOLO por videollamada, así que
    // no compite por el único consultorio.
    codigo: 'MED_ALBARELLOS',
    nombre: 'Dra. Malena Albarellos',
    esDirector: false,
    especialidad: 'endocrinologia',
    precioTeleconsultaARS: 150_000,
    // ⚠️ Sin agenda publicada todavía: el seed no publica Slots suyos y el
    // portal no la ofrece. Falta que Andrés defina sus franjas.
  },
  {
    // Médico de la cámara hiperbárica (Andrés, 2026-09-16).
    //
    // Queda SIN precio a propósito: el `Practitioner` se crea —así puede
    // figurar como profesional del turno y en el listado por especialidad—
    // pero **no se publica ningún servicio suyo** hasta que Andrés defina el
    // precio de la consulta hiperbárica. Un servicio sin precio confirmado en
    // la góndola es peor que uno que todavía no está.
    codigo: 'MED_CARRIERI',
    nombre: 'Dr. Nicolás Carrieri',
    esDirector: false,
    especialidad: 'hiperbarica',
  },
];

export const MEDICOS_POR_CODIGO: ReadonlyMap<string, Medico> = new Map(MEDICOS.map((m) => [m.codigo, m]));

/** Código de servicio de consulta PRESENCIAL (p. ej. CONSULTA_MED_DALESSANDRO). */
export function codigoConsulta(medicoCodigo: string): string {
  return `CONSULTA_${medicoCodigo}`;
}

/**
 * Código de servicio de TELECONSULTA (p. ej. TELECONSULTA_MED_DALESSANDRO).
 *
 * Código propio y no una variante del presencial: son productos distintos, con
 * precio distinto, y el contrato con Administración es que **los códigos no
 * cambian nunca**. Que el mismo médico tenga dos es exactamente lo que se
 * quiere poder facturar y contar por separado.
 */
export function codigoTeleconsulta(medicoCodigo: string): string {
  return `TELECONSULTA_${medicoCodigo}`;
}

/**
 * Identifier del `Schedule` donde vive la agenda publicada de un profesional
 * **para esa modalidad**.
 *
 * Una sola función, y la usan los tres lados que tienen que coincidir o el
 * sistema se parte: el seed que publica los Slots, `bw-disponibilidad` que los
 * lista y `bw-reservar-turno` que los pasa a `busy`. Si divergieran, el portal
 * ofrecería horarios de una agenda y la reserva marcaría los de la otra.
 *
 * La respuesta sale de la CONFIG, no de lo que haya en el servidor: un médico
 * **sin** `agendaTeleconsulta` sigue teniendo una sola agenda (`SCH_<codigo>`)
 * y sus dos modalidades comparten los horarios, exactamente como hasta hoy.
 * Recién cuando alguien le define franjas de video aparece la segunda agenda.
 * Por eso agregar esta función no movió ni un turno: es un no-op hasta que hay
 * franjas.
 */
export function codigoAgenda(medicoCodigo: string, modalidad: ModalidadAtencion = 'presencial'): string {
  const m = MEDICOS_POR_CODIGO.get(medicoCodigo);
  return modalidad === 'virtual' && (m?.agendaTeleconsulta?.length ?? 0) > 0
    ? `SCH_TELE_${medicoCodigo}`
    : `SCH_${medicoCodigo}`;
}

/** ¿Este profesional publica agenda de video separada de la presencial? */
export function tieneAgendaTeleconsulta(m: Medico): boolean {
  return (m.agendaTeleconsulta?.length ?? 0) > 0;
}
