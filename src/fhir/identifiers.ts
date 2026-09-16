/**
 * Sistemas (URLs canónicas) e identificadores FHIR de Biowellness.
 *
 * Convención: kebab-case para los nombres de extensión, bajo el namespace
 * `https://biowellness.ar/fhir/...`. Centralizado acá para que el seed, los
 * bots y los tests usen exactamente los mismos strings.
 */

const BASE = 'https://biowellness.ar/fhir';

/** URLs base de StructureDefinition de extensiones custom. */
export const EXT = {
  // Patient
  tipoCliente: `${BASE}/StructureDefinition/tipo-cliente`,
  tagFm: `${BASE}/StructureDefinition/tag-fm`,
  tcBloqueoFm: `${BASE}/StructureDefinition/tc-bloqueo-fm`,
  perfilClinico: `${BASE}/StructureDefinition/perfil-clinico`,
  origenLead: `${BASE}/StructureDefinition/origen-lead`,
  /** Fecha de alta de la ficha (valueDate): cohortes mensuales del CRM. */
  fechaAlta: `${BASE}/StructureDefinition/fecha-alta`,
  // Practitioner
  splitPorcentaje: `${BASE}/StructureDefinition/split-porcentaje`,
  tipoContrato: `${BASE}/StructureDefinition/tipo-contrato`,
  // Schedule / Slot
  recursoFisico: `${BASE}/StructureDefinition/recurso-fisico`,
  comparteTumbona: `${BASE}/StructureDefinition/comparte-tumbona`,
  // Appointment
  ordenProtocolo: `${BASE}/StructureDefinition/orden-protocolo`,
  requiereHbotPrevio: `${BASE}/StructureDefinition/requiere-hbot-previo`,
  ocupantes: `${BASE}/StructureDefinition/ocupantes`,
  /** Tipo de ítem del turno (servicio/combo/paquete/membresia), para calcular la seña. */
  itemTipo: `${BASE}/StructureDefinition/item-tipo`,
  /** Código de catálogo del ítem del turno. */
  itemCodigo: `${BASE}/StructureDefinition/item-codigo`,
  /** Coverage (plan) que cubre el turno: si está, no requiere seña. */
  coberturaUsada: `${BASE}/StructureDefinition/cobertura-usada`,
  /** Vencimiento de la tentativa (R-19): si la seña no llega antes, se libera. */
  venceSena: `${BASE}/StructureDefinition/vence-sena`,
  // ActivityDefinition (catálogo)
  precioUsd: `${BASE}/StructureDefinition/precio-usd`,
  precioArs: `${BASE}/StructureDefinition/precio-ars`,
  /** Posición del servicio en la góndola del portal (menor = más arriba). */
  orden: `${BASE}/StructureDefinition/orden`,
  familia: `${BASE}/StructureDefinition/familia`,
  familiaOrden: `${BASE}/StructureDefinition/familia-orden`,
  /**
   * Precio de lista: lo que costaría comprando las sesiones sueltas. Es el
   * ancla del descuento en combos y paquetes ("sueltas te costarían X"). El
   * PORCENTAJE no se guarda a propósito: se deriva de `precio-usd` contra
   * este, así que no puede haber dos números que se contradigan.
   */
  precioUsdLista: `${BASE}/StructureDefinition/precio-usd-lista`,
  /** Paquete: cantidad de sesiones que incluye. */
  sesiones: `${BASE}/StructureDefinition/sesiones`,
  /** Paquete: días de vigencia desde la primera sesión. */
  vigenciaDias: `${BASE}/StructureDefinition/vigencia-dias`,
  /**
   * Descuento Founding Member, en porcentaje. Su AUSENCIA es la regla: está en
   * los paquetes y NO en combos ni membresías, así que ningún front tiene que
   * acordarse de la excepción — si no está la extensión, no hay descuento.
   */
  descuentoFm: `${BASE}/StructureDefinition/descuento-fm`,
  /** Minutos que la agenda tiene que reservar para el combo (no es la suma de las partes). */
  duracionMin: `${BASE}/StructureDefinition/duracion-min`,
  /** Combo/plan de pareja: una sesión es una visita de los DOS. */
  esPareja: `${BASE}/StructureDefinition/es-pareja`,
  /**
   * Membresía: descuento del socio sobre las sesiones que compre **fuera** del
   * plan, en porcentaje (10 Standard / 15 Intensivo). Vive en el dato porque
   * sin él cada front tiene que reimplementar la regla — y hoy `/servicios` le
   * muestra el precio de lista a un socio que en realidad paga menos.
   */
  descuentoALaCarte: `${BASE}/StructureDefinition/descuento-a-la-carte`,
  reglaPricingRecurso: `${BASE}/StructureDefinition/regla-pricing-recurso`,
  splitBw: `${BASE}/StructureDefinition/split-bw`,
  requierePrescripcion: `${BASE}/StructureDefinition/requiere-prescripcion`,
  // PlanDefinition (combos)
  secuenciaOrdenada: `${BASE}/StructureDefinition/secuencia-ordenada`,
  descuentoCombo: `${BASE}/StructureDefinition/descuento-combo`,
  // Coverage / Contract (membresía)
  tier: `${BASE}/StructureDefinition/tier`,
  version: `${BASE}/StructureDefinition/version`,
  sesionesMes: `${BASE}/StructureDefinition/sesiones-mes`,
  sesionesUsadas: `${BASE}/StructureDefinition/sesiones-usadas`,
  precioBloqueadoFm: `${BASE}/StructureDefinition/precio-bloqueado-fm`,
  /** Tipo de cobertura: 'membresia' | 'paquete'. */
  tipoCobertura: `${BASE}/StructureDefinition/tipo-cobertura`,
  /** Código del plan (membresía o paquete) del catálogo. */
  planCodigo: `${BASE}/StructureDefinition/plan-codigo`,
  /** Sesiones totales del paquete. */
  sesionesTotal: `${BASE}/StructureDefinition/sesiones-total`,
  /** Ciclo facturado (YYYY-MM) de la membresía. */
  cicloMes: `${BASE}/StructureDefinition/ciclo-mes`,
  // Coverage — agenda semanal de membresías (R-21)
  /** Días preferidos de la semana, CSV "1,4" (0=domingo … 6=sábado). */
  preferenciaDias: `${BASE}/StructureDefinition/preferencia-dias`,
  /** Hora preferida "HH:mm" (hora de Argentina) para las sesiones de la semana. */
  preferenciaHora: `${BASE}/StructureDefinition/preferencia-hora`,
  /** La asignación semanal automática (bw-agenda-semanal) está activa para este plan. */
  agendaSemanalActiva: `${BASE}/StructureDefinition/agenda-semanal-activa`,
  // Invoice / ChargeItem
  montoSplitBw: `${BASE}/StructureDefinition/monto-split-bw`,
  montoSplitProfesional: `${BASE}/StructureDefinition/monto-split-profesional`,
  tcAplicado: `${BASE}/StructureDefinition/tc-aplicado`,
  /** Marca de que el Invoice es una seña (depósito). */
  esSena: `${BASE}/StructureDefinition/es-sena`,
  /**
   * Medio de pago del Invoice. CONTRATO con Administración: se escribe como
   * **valueString** con uno de los 5 códigos de MEDIOS_PAGO (nunca texto libre).
   */
  medioPago: `${BASE}/StructureDefinition/medio-pago`,
  // Coverage — cobro recurrente MercadoPago (tokenización; nunca datos de tarjeta)
  /** Id de customer de MercadoPago asociado al paciente. */
  mpCustomerId: `${BASE}/StructureDefinition/mp-customer-id`,
  /** Id de la tarjeta guardada en MercadoPago (token del lado de MP). */
  mpCardId: `${BASE}/StructureDefinition/mp-card-id`,
  /**
   * Id de la SUSCRIPCIÓN de MercadoPago (`preapproval`) que debita este plan.
   *
   * La arma Recepción desde el panel de MP —el sistema no crea suscripciones
   * (D16: sin checkout propio)— y pega acá el id. Es lo único que permite
   * atribuir un débito recurrente a esta cobertura: el pago llega como
   * `subscription_authorized_payment`, que trae el `preapproval_id` y no un
   * `external_reference` por ciclo.
   *
   * Sin este id el programa igual se factura, pero nadie lo debita solo: el cron
   * deja un aviso a Recepción en vez de dar por cobrada una plata que no entró.
   */
  mpSuscripcion: `${BASE}/StructureDefinition/mp-suscripcion`,
  // Communication
  canal: `${BASE}/StructureDefinition/canal`,
  templateUsado: `${BASE}/StructureDefinition/template-usado`,
  /**
   * Marca que el mensaje lo escribió el sistema, no una persona (valueCode =
   * la intención de `src/lib/auto-respuesta.ts`). Sirve para tres cosas: que la
   * bandeja lo muestre como automático, que el bot sepa qué contestó la última
   * vez y no se repita, y que los reportes no confundan bot con atención humana.
   */
  autoRespuesta: `${BASE}/StructureDefinition/auto-respuesta`,
  /**
   * En el HILO (topic): desde cuándo el paciente pidió hablar con una persona.
   * Mientras esté vigente no sale nada automático por ese chat.
   */
  silencioAuto: `${BASE}/StructureDefinition/silencio-automatico`,
  /**
   * El mensaje salió de un borrador sugerido: `sin-editar` (se mandó tal cual)
   * o `editado` (la recepcionista lo cambió). Es la métrica que decide si algún
   * día alguna intención puede contestarse sola — sin este dato, esa discusión
   * se daría por intuición.
   */
  borradorUsado: `${BASE}/StructureDefinition/borrador-usado`,
  /**
   * En la SOLICITUD (Task): qué pasó con la propuesta de reserva del asistente
   * (Nivel 4): `confirmada` (se reservó tal cual), `alternativa` (se reservó
   * después de pedir "Otra opción") o `descartada` (Recepción la resolvió a
   * mano). Gemela de `borrador-usado`: es el dato que decide si algún día una
   * solicitud puede resolverse sola.
   */
  propuestaResultado: `${BASE}/StructureDefinition/propuesta-resultado`,
  // Onboarding / invitación al portal
  /** Canal elegido para invitar al paciente al portal (whatsapp / email / qr). */
  canalInvitacion: `${BASE}/StructureDefinition/canal-invitacion`,
  // Caja chica (Basic movimiento / PaymentReconciliation arqueo)
  /** Monto del movimiento en ARS (valueDecimal, siempre positivo). */
  cajaMontoArs: `${BASE}/StructureDefinition/caja-monto-ars`,
  /** Categoría del gasto (valueCode de CATEGORIAS_GASTO). */
  cajaCategoria: `${BASE}/StructureDefinition/caja-categoria`,
  /** Foto/PDF del comprobante (valueAttachment → Binary). */
  cajaComprobante: `${BASE}/StructureDefinition/caja-comprobante`,
  /** Gasto sobre el tope: marcado como autorizado por Administración (valueBoolean). */
  cajaAutorizado: `${BASE}/StructureDefinition/caja-autorizado`,
  /** Arqueo: saldo esperado en ARS (valueDecimal). */
  cajaEsperado: `${BASE}/StructureDefinition/caja-esperado`,
  /** Arqueo: diferencia contado − esperado en ARS (valueDecimal). */
  cajaDiferencia: `${BASE}/StructureDefinition/caja-diferencia`,
  /**
   * Demanda no cubierta: clave normalizada del pedido (`valueString`), la
   * dimensión por la que se AGRUPA el reporte. Se guarda además del texto
   * original para que un cambio futuro en el normalizador no re-agrupe en
   * silencio lo ya registrado.
   */
  demandaClave: `${BASE}/StructureDefinition/demanda-clave`,
  /**
   * R-03 · de dónde salió la afirmación del consentimiento en un turno de
   * Terapia Biológica (`valueCode`: portal | declarado-recepcion). Sin esto el
   * booleano se evaporaba al validar y no quedaba auditoría de quién lo afirmó.
   */
  consentimientoOrigen: `${BASE}/StructureDefinition/consentimiento-origen`,
  /**
   * R-14 · la cancelación tardía se perdonó por **fuerza mayor médica**
   * (valueBoolean). La regla contempla la excepción; sin registrarla, la
   * devolución de una sesión fuera de ventana no se puede auditar después.
   */
  cancelacionFuerzaMayor: `${BASE}/StructureDefinition/cancelacion-fuerza-mayor`,
  /** R-14 · quién declaró la fuerza mayor (valueString con la referencia). */
  cancelacionDeclaradaPor: `${BASE}/StructureDefinition/cancelacion-declarada-por`,
  /**
   * Cuántas veces se movió ESTE turno desde el portal (valueInteger).
   * Sin la extensión el turno cuenta como 0 movimientos. Contrato con el portal,
   * que muestra cuántos le quedan al paciente (docs/handoff-portal-turnos.md).
   */
  movimientos: `${BASE}/StructureDefinition/movimientos`,
  /**
   * Lista de espera · días de la semana que le sirven, CSV con la convención de
   * `Date.getDay()` ("2,4" = martes y jueves). Vacío/ausente = cualquier día.
   * FHIR R4 modela la ventana (`requestedPeriod`) pero no la preferencia dentro
   * de la ventana, que es justo lo que evita avisar de un horario imposible.
   */
  esperaDias: `${BASE}/StructureDefinition/espera-dias`,
  /** Lista de espera · franjas del día que le sirven (CSV: manana|tarde|noche). */
  esperaFranjas: `${BASE}/StructureDefinition/espera-franjas`,
  /**
   * Modalidad de prestación del servicio (`presencial` | `virtual`), en el
   * `ActivityDefinition` del catálogo y en el `ChargeItem` del cobro.
   *
   * En el **turno** la modalidad NO va acá: va en `Appointment.appointmentType`,
   * que es el campo nativo de FHIR para esto (mismo criterio que
   * `serviceType`/`serviceCategory`, ver src/fhir/appointment.ts). La extensión
   * existe para el catálogo, que no tiene campo equivalente, y para que
   * Administración pueda separar presencial de virtual en su P&L sin mirar el
   * turno. Ampliar la lista de valores es compatible; renombrarla no.
   */
  modalidadAtencion: `${BASE}/StructureDefinition/modalidad-atencion`,
  /**
   * Nombre de la sala de videollamada del turno (`tc-<uuid>`, ver
   * `src/lib/teleconsulta.ts`). **El token NO se guarda nunca**: se emite a
   * pedido y vence con la ventana del turno. Lo que persiste es la sala.
   */
  teleconsultaSala: `${BASE}/StructureDefinition/teleconsulta-sala`,
} as const;

/** Sistemas de codificación / identificadores de negocio. */
export const SYSTEM = {
  servicioCodigo: `${BASE}/CodeSystem/servicio`,
  /**
   * Categoría (terapia) del servicio: `Appointment.serviceCategory`. Agrupa los
   * códigos que son la MISMA exposición (mono/biplaza/multiplaza → `HBOT`). Lo
   * lee el Panel Bio para el acumulado de sesiones. Ver src/fhir/appointment.ts.
   */
  categoriaServicio: `${BASE}/CodeSystem/categoria-servicio`,
  /**
   * Modalidad de atención del turno: `Appointment.appointmentType`.
   * Valores: `presencial` | `virtual` (`MODALIDADES` más abajo).
   */
  modalidadAtencion: `${BASE}/CodeSystem/modalidad-atencion`,
  /**
   * Especialidad del profesional: `PractitionerRole.specialty`.
   *
   * Es un CodeSystem propio y no SNOMED CT a propósito: la lista la define el
   * negocio (qué se ofrece), no la nomenclatura clínica. El mapeo a SNOMED se
   * agrega el día que lo pida el Federador o una obra social, sin tocar nada de
   * esto — se suma un `coding` al lado.
   */
  especialidad: `${BASE}/CodeSystem/especialidad`,
  /**
   * Tipo de documento del paciente en su historia: `DocumentReference.category`.
   * Separa el laboratorio del informe de imágenes y del informe de la consulta,
   * que es lo que el Dashboard necesita para enrutar y el portal para agrupar.
   */
  documentoPaciente: `${BASE}/CodeSystem/documento-paciente`,
  comboCodigo: `${BASE}/CodeSystem/combo`,
  membresiaCodigo: `${BASE}/CodeSystem/membresia`,
  paqueteCodigo: `${BASE}/CodeSystem/paquete`,
  /**
   * Programas (PB100D y los que vengan): productos por TIEMPO, no por sesiones.
   * El portal acepta este system o el de membresía (`src/fhir/programa.ts` del
   * portal, handoff PB100D §2); se usa el propio para que el catálogo no mezcle
   * familias — las membresías derivan variantes de los sufijos del código y un
   * programa no tiene tier ni `_INT_`/`_PAR`.
   */
  programaCodigo: `${BASE}/CodeSystem/programa`,
  /**
   * Conceptos del Plan Bienestar 100 Días: niveles, etapas, acciones, señales.
   * El CodeSystem lo emite el DASHBOARD, no este repo.
   *
   * OJO: **no sirve para acotar lo que escribe la paciente.** Las señales al
   * equipo también llevan un coding de este sistema (`biowellness-plan|
   * sintoma-esfuerzo`), así que un criterio `code=<este sistema>|` las incluye.
   * Para eso está `pb100dTarea`, que distingue acción de señal.
   */
  biowellnessPlan: `${BASE}/CodeSystem/biowellness-plan`,
  /**
   * TIPO de tarea del Plan Bienestar 100 Días: `accion`, `checkin`, `medicion`,
   * `funcional`, `senal`, `cierre`, `apertura`. También lo emite el dashboard.
   *
   * Es el que separa lo de la paciente de lo del equipo, y por eso es el que acota
   * la entrada escribible de Task en la policy del portal: la paciente escribe
   * `accion` y nada más.
   */
  pb100dTarea: `${BASE}/CodeSystem/pb100d-tarea`,
  recursoCodigo: `${BASE}/CodeSystem/recurso-fisico`,
  /**
   * Namespace PUBLICADO que el portal usa para encontrar agendas de médicos
   * (Schedule `bw-sched-{medico}` y sus Slot `bw-slot-*`). Contrato con
   * portal/consulta-medica: no renombrar.
   */
  sidRecurso: `${BASE}/sid/recurso`,
  contraindicacion: `${BASE}/CodeSystem/contraindicacion`,
  medico: `${BASE}/CodeSystem/medico`,
  /** Identifier de Invoice (para deduplicar señas: manual o por pago MP). */
  invoice: `${BASE}/Identifier/invoice`,
  /** Identifier de Communication (para deduplicar recordatorios automáticos). */
  communication: `${BASE}/Identifier/communication`,
  /**
   * Documento (DNI) del paciente **con nuestro namespace**, para deduplicar
   * altas. Es el histórico y guarda el valor TAL COMO SE TIPEÓ ("30.123.456" o
   * "30123456"): las fichas viejas dependen de eso y no se re-normaliza.
   *
   * Para hablar con cualquiera afuera está `SYSTEM_RENAPER_DNI` (ver abajo), que
   * se escribe **en paralelo** y siempre normalizado.
   */
  dni: `${BASE}/Identifier/dni`,
  /**
   * Número de Founding Member (R-09): "1".."100". El value ubica la cohorte
   * (1–50 el 1 a 1 de Andrés, 51–100 la Web founding.html). Es un Identifier
   * y no solo la extensión tag-fm porque los identifiers SÍ son buscables:
   * `Patient?identifier=<system>|` trae el padrón completo para contar cupos.
   */
  fm: `${BASE}/Identifier/fm`,
  /** Tag de datos de demostración (se autodestruyen a las 48 h). */
  demo: `${BASE}/demo`,
  /**
   * Tag hermano de `demo`: hasta qué fecha civil (AR, "YYYY-MM-DD") la demo
   * tiene que seguir viva. Mientras no pase esa fecha, la limpieza de 48 h
   * (`bw-limpiar-demo`) no la toca; `--limpiar` la borra igual.
   */
  demoHasta: `${BASE}/demo-hasta`,
  /** Bloqueos administrativos (R-11: pago rechazado → no se reserva). */
  bloqueo: `${BASE}/CodeSystem/bloqueo`,
  config: `${BASE}/Identifier/config`,
  /**
   * Caja chica de recepción: código de los movimientos (`Basic.code`:
   * egreso/reposicion/ajuste) e identifier de los arqueos
   * (`PaymentReconciliation.identifier`: arqueo-YYYY-MM-DD…). La AccessPolicy
   * de recepción da escritura de Basic SOLO con este code (el config del TC
   * también es Basic y no debe ser tocable desde el mostrador).
   */
  caja: `${BASE}/CodeSystem/caja`,
  /**
   * Demanda no cubierta (`Basic.code`): lo que se pide en el mostrador y NO
   * está en el catálogo. Es el único canal que produce este dato —el que
   * pregunta por Instagram y no lo encuentra se va sin escribir— y por eso
   * tiene su propio code: se lista con `Basic?code=<este system>|` sin
   * mezclarse con la caja chica.
   */
  demanda: `${BASE}/CodeSystem/demanda`,
  /**
   * Consentimientos informados que firma el paciente (`Consent.category`).
   * Acota los permisos por los dos lados: el paciente solo puede firmar
   * consentimientos de Biowellness (no fabricar Consent de cualquier tipo) y
   * recepción solo recibe la señal binaria de esta categoría, nunca el
   * documento ni el resto de la historia.
   */
  consentimiento: `${BASE}/CodeSystem/consentimiento`,
  /** Tipo de Task (p. ej. solicitud de turno desde el portal). */
  taskTipo: `${BASE}/CodeSystem/task-tipo`,
  /** Identifier de Task (para deduplicar alertas automáticas a Recepción). */
  task: `${BASE}/Identifier/task`,
} as const;

/** Códigos de negocio puntuales. */
export const COD = {
  /** Task.code de una solicitud de turno creada desde el portal del paciente. */
  solicitudTurno: 'solicitud-turno',
  /** Task de revisión de fichas duplicadas (bw-dedup-paciente → vista Duplicados). */
  posibleDuplicado: 'posible-duplicado',
  /**
   * Task de aviso automático a Recepción (vista Avisos). Antes estas alertas
   * se creaban SOLO con `code.text`, y como las búsquedas FHIR por token no
   * miran el texto, ninguna pantalla las listaba: el aviso existía en la base
   * y nadie lo veía (WhatsApp de número desconocido, pagos duplicados, seña de
   * reserva vencida, diferencia de arqueo…). El code las hace encontrables.
   */
  avisoRecepcion: 'aviso-recepcion',
} as const;

/**
 * Consentimientos informados del portal.
 *
 * ⚠️ Dónde vive el código: el portal usa la categoría ESTÁNDAR de HL7 en
 * `Consent.category` (`v3-ActCode|IDSCL`) y pone el código de Biowellness en
 * **`Consent.policyRule.coding`** con `SYSTEM.consentimiento`. Por eso ni la
 * policy ni el bot filtran por `category` (verificado contra el recurso real
 * del servidor, 2026-08-14).
 *
 * - `procesamiento-datos-salud`: CONFIRMADO. Lo crea el portal cuando el
 *   paciente sube un PDF de laboratorio y autoriza a procesarlo (Ley 25.326);
 *   la `provision.data` referencia el DocumentReference del estudio.
 * - `atencion` / `terapia-biologica`: PROVISORIOS. El consentimiento general
 *   de atención (el del onboarding paso a paso) parece registrarse como
 *   DocumentReference y no como Consent — pendiente de confirmar contra el
 *   repo del portal (docs/handoff-portal-consentimiento.md).
 */
export const COD_CONSENTIMIENTO = {
  procesamientoDatosSalud: 'procesamiento-datos-salud',
  atencion: 'atencion',
  terapiaBiologica: 'terapia-biologica',
} as const;

export type CodigoConsentimiento = (typeof COD_CONSENTIMIENTO)[keyof typeof COD_CONSENTIMIENTO];

/**
 * LOINC del documento de consentimiento del paciente. Lo usa el portal como
 * `DocumentReference.type` del consentimiento general firmado, y es el código
 * estándar (interoperable) para "Patient Consent". Acordado con Alejandro
 * (MedTech) el 2026-08-14: el `Consent` es el hecho legal y el
 * `DocumentReference` es la evidencia firmada; se enlazan por `sourceReference`.
 */
export const LOINC_CONSENTIMIENTO = 'http://loinc.org';
export const COD_LOINC_CONSENTIMIENTO = '59284-0';

/**
 * URL canónica del **cuestionario de ingreso** del portal, que incluye el
 * screening de contraindicaciones HBOT/IHHT. Es contrato con el portal
 * (`portal/src/pages/intake.questionnaire.ts`): si cambia allá, el banner de
 * seguridad de Recepción deja de reconocer los screenings completados y todos
 * los pacientes pasan a 'sin-screening'.
 *
 * Lo usa `bw-estado-seguridad` para distinguir "apto" de "nunca contestó nada".
 */
export const INTAKE_QUESTIONNAIRE_URL = 'https://biowellness.ar/Questionnaire/intake-clinico';

/**
 * Subtipo del aviso (input `tipo` del Task): habilita acciones específicas en
 * la vista Avisos. Sin subtipo, el aviso se muestra igual con "Resolver".
 */
export const TIPO_AVISO = {
  /** WhatsApp entrante cuyo número no coincide con ninguna ficha. */
  whatsappDesconocido: 'whatsapp-desconocido',
  /**
   * Se canceló un turno y hay gente en la lista de espera a la que le sirve.
   * Trae los candidatos en orden de llegada, con teléfono, para ofrecerlo desde
   * la vista Avisos sin tener que buscar cada ficha.
   */
  huecoLiberado: 'hueco-liberado',
  /**
   * El paciente entró a la sala de su teleconsulta. Es el aviso que Recepción
   * ve en tiempo real y el que dispara el llamado al profesional si tarda.
   */
  pacienteEnLinea: 'paciente-en-linea',
  /** Pasó la hora y el profesional no se conectó: hay alguien esperando solo. */
  profesionalAusente: 'profesional-ausente',
  /** El profesional pidió que se le agende un control a este paciente. */
  agendarControl: 'agendar-control',
} as const;

/** Modalidades de atención (lista CERRADA; `SYSTEM.modalidadAtencion`). */
export const MODALIDADES = ['presencial', 'virtual'] as const;
export type Modalidad = (typeof MODALIDADES)[number];

/**
 * Especialidades de los profesionales (`SYSTEM.especialidad`).
 *
 * Lista ABIERTA por diseño, al revés que `ORIGENES_LEAD`: el negocio suma
 * especialidades (Andrés, 2026-09-16: "Médicos, Cardiólogos, Endocrinólogos /
 * Diabetólogos, Hiperbaristas, Nutricionistas, etc") y cada una nueva es un
 * renglón acá más un profesional en `src/config/medicos.ts`. Lo que NO se
 * renombra son los códigos ya publicados: los lee el portal para agrupar la
 * góndola y el Dashboard para enrutar la bandeja.
 *
 * `hiperbarista` está declarada y **todavía sin profesional asignado**: es el
 * médico de la cámara hiperbárica, la puerta de entrada al servicio central de
 * la casa. Pendiente de que Andrés defina quién y a qué precio.
 */
export const ESPECIALIDADES = {
  cardiologia: 'Cardiología',
  endocrinologia: 'Endocrinología y Diabetes',
  nutricion: 'Nutrición',
  hiperbarica: 'Medicina Hiperbárica',
  traumatologia: 'Traumatología y Medicina del Deporte',
  medicinaGeneral: 'Medicina General',
} as const;
export type EspecialidadCodigo = keyof typeof ESPECIALIDADES;

/** Códigos de `SYSTEM.documentoPaciente`. */
export const DOCUMENTOS_PACIENTE = {
  laboratorio: 'laboratorio',
  imagenes: 'imagenes',
  informePrevio: 'informe-previo',
  informeConsulta: 'informe-consulta',
} as const;

/**
 * Canales de origen del lead (lista CERRADA, docs/canales-acceso.md): se guarda
 * en `Patient.extension` origen-lead como uno de estos códigos, nunca texto
 * libre — así el CRM puede comparar canales.
 */
/**
 * Contrato del CRM (repo `administracion`) — **NO es nuestro, no inventar acá**.
 *
 * El CRM ya modela los leads y este repo los alimenta. Un lead **es un
 * `Patient`** distinguido por su ciclo de vida, no un recurso aparte: por eso el
 * curioso del mostrador entra por el mismo alta que todos y hereda su
 * deduplicación (si vuelve en un mes, se lo encuentra en vez de duplicarlo).
 *
 * Ojo con el namespace: el CRM usa `bio.medplum.com.ar`, distinto del `bw` de
 * este repo. Y no confundir `bio/lead-origen` (Provenance, atribución del CRM)
 * con nuestro `bw/origen-lead` (Patient, canal de adquisición): conviven a
 * propósito, cada uno con su semántica.
 *
 * Fuente: `administracion/src/fhir/systems.ts`. Renombrar rompe su pipeline.
 */
const NS_CRM = 'https://bio.medplum.com.ar/fhir';

/** `Patient.extension` (valueCode) + espejo en `meta.tag`: 'lead' | 'activo'. */
export const EXT_CICLO_VIDA = `${NS_CRM}/StructureDefinition/ciclo-vida-cliente`;
export const SYSTEM_CICLO_VIDA = `${NS_CRM}/CodeSystem/ciclo-vida-cliente`;
export const CICLO_VIDA = ['lead', 'activo'] as const;
export type CicloVida = (typeof CICLO_VIDA)[number];

/** `Task.businessStatus.coding.system` del kanban de leads del CRM. */
export const SYSTEM_ETAPA_PIPELINE = `${NS_CRM}/CodeSystem/etapa-pipeline`;
export const ETAPAS_PIPELINE = ['nuevo', 'contactado', 'evaluacion-agendada', 'convertido', 'perdido'] as const;
export type EtapaPipeline = (typeof ETAPAS_PIPELINE)[number];

/**
 * `Provenance.extension` con la atribución del lead (sub-ext: `fuente`,
 * `utm_source`, `campania`, `referido-por`).
 *
 * OPCIONAL: Administración confirmó (respuesta al handoff, 2026-08-14) que su
 * panel de canales NO lo necesita —para métricas manda nuestro `origen-lead`—.
 * Lo único que aporta es el **chip de fuente** en la tarjeta del kanban.
 *
 * `fuente` es texto PARA MOSTRAR, no un código. Su lector acepta `valueString`
 * o `valueCode` y matchea por `url === 'fuente'`. Si hay más de un Provenance
 * por paciente, toman el más reciente por `recorded`.
 */
export const EXT_LEAD_ORIGEN = `${NS_CRM}/StructureDefinition/lead-origen`;

/** `Task.input[].type.text` con la próxima acción del pipeline. */
export const TASK_INPUT_PROXIMA_ACCION = 'próxima-acción';

export const ORIGENES_LEAD = [
  'instagram',
  'linkedin',
  'google',
  'qr-local',
  'qr-evento',
  'web',
  'telefono',
  'walk-in',
  'acompanante',
  'referido',
  'derivacion',
  'otro',
] as const;

export type OrigenLead = (typeof ORIGENES_LEAD)[number];

export function esOrigenLead(v: string | undefined | null): v is OrigenLead {
  return Boolean(v) && (ORIGENES_LEAD as readonly string[]).includes(v as string);
}

/** Etiquetas para la UI (el valor persistido es SIEMPRE el código canónico). */
export const ORIGENES_LEAD_LABELS: Record<OrigenLead, string> = {
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  google: 'Google (Maps / búsqueda)',
  'qr-local': 'QR en el local',
  'qr-evento': 'QR en evento',
  web: 'Sitio web / portal',
  telefono: 'Teléfono',
  'walk-in': 'Mostrador (walk-in)',
  acompanante: 'Acompañante de un paciente',
  referido: 'Referido',
  derivacion: 'Derivación médica',
  otro: 'Otro',
};

/**
 * DNI con el system **canónico nacional** (RENAPER).
 *
 * No es nuestro: es el identificador con el que el resto del sistema de salud
 * argentino nombra a una persona. Lo usa el Federador de Pacientes del
 * Ministerio de Salud —`GET /fhir/Patient?identifier=http://www.renaper.gob.ar/dni|23327755`—
 * y es el que aparece en los `Patient` federados junto a los de cada hospital y
 * laboratorio (verificado contra la guía técnica Patient/FEDERADOR, OCT2025).
 *
 * Se escribe **además** del nuestro, nunca en lugar de él: una ficha lleva los
 * dos identifiers con el mismo documento. Cuesta un renglón y hace que la ficha
 * sea cruzable con cualquier otro sistema sin tabla de equivalencias ni
 * migración posterior. Mismo criterio que ya usamos con el CRM: cuando el otro
 * ya tiene un identificador, se usa el suyo en vez de inventar uno.
 *
 * ⚠️ Es `http://`, no `https://`: así está publicado el system y un token search
 * de FHIR compara el string exacto. "Corregirlo" rompe el match.
 *
 * (El perfil `Patient` de AR Core también slicea el documento; no se pudo
 * verificar su URL desde este entorno —`guias.hl7.org.ar` está bloqueado por el
 * proxy—. Si difiere, es esta única constante la que cambia.)
 */
export const SYSTEM_RENAPER_DNI = 'http://www.renaper.gob.ar/dni';

/** Clave del recurso de configuración de Tipo de Cambio (Basic). */
export const CONFIG_TC_ID = 'config-tipo-cambio';

/** Moneda de lista del catálogo. */
export const MONEDA_LISTA = 'USD' as const;

// ============================================================================
// CONTRATO DE PAGOS con Administración (repo `administracion`) — INAMOVIBLE.
// El bot kpis-finanzas y los tableros de Andrés leen EXACTAMENTE estos códigos
// y URLs. Cambiarlos rompe los reportes. Ver docs/bots.md § Contrato de pagos.
// ============================================================================

/** Los 5 medios de pago canónicos. La UI de cobro es un select de ESTOS valores. */
export const MEDIOS_PAGO = [
  'efectivo',
  'tarjeta-debito',
  'tarjeta-credito',
  'transferencia',
  'mercadopago',
] as const;

export type MedioPago = (typeof MEDIOS_PAGO)[number];

export function esMedioPago(v: string | undefined | null): v is MedioPago {
  return Boolean(v) && (MEDIOS_PAGO as readonly string[]).includes(v as string);
}

/** Etiquetas para la UI (el valor persistido es SIEMPRE el código canónico). */
export const MEDIOS_PAGO_LABELS: Record<MedioPago, string> = {
  efectivo: 'Efectivo',
  'tarjeta-debito': 'Tarjeta débito',
  'tarjeta-credito': 'Tarjeta crédito',
  transferencia: 'Transferencia',
  mercadopago: 'MercadoPago',
};

/** Líneas comerciales del ChargeItem (las lee kpis-finanzas de administracion). */
export const LINEAS_COMERCIALES = [
  'membresias',
  'sueltas-combos',
  'paquetes',
  'iv-tb',
  'consultas',
  'otros',
] as const;

export type LineaComercial = (typeof LINEAS_COMERCIALES)[number];

/**
 * Extensión linea-comercial del ChargeItem (valueCode). ⚠️ El system es del
 * dominio del repo administracion (bio.medplum.com.ar), NO del nuestro: no
 * "corregirlo" — es el string exacto que lee el tablero.
 */
export const EXT_LINEA_COMERCIAL = 'https://bio.medplum.com.ar/fhir/StructureDefinition/linea-comercial';
