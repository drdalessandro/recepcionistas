/**
 * Tabla de contraindicaciones — VALIDADA por el Director Médico.
 *
 * Ni el Manual v8 ni el v9 incluían tabla de contraindicaciones; se cargó una
 * lista estándar de HBOT e IHHT como borrador. El Dr. Conrado López Alonso
 * (Director Médico) la validó tal cual el 2026-08-09 (OK transmitido por
 * Andrés). Las 13 entradas quedan aprobadas para uso real.
 *
 * Cambios futuros: toda entrada NUEVA o modificada entra con
 * `borradorPendienteRevision: true` hasta que el Director Médico la apruebe —
 * eso vuelve el CodeSystem a `draft` y reactiva el aviso del seed solo.
 *
 * Uso (R-02): una contraindicación `absoluta` activa bloquea la confirmación del turno
 * sin autorización médica explícita registrada. Una `relativa` genera advertencia.
 *
 * La recepción solo ve la señal binaria del banner (verde/rojo), nunca el detalle clínico.
 *
 * ## Resolución 2026-09-09 — Dr. Alejandro Sergio D'Alessandro (MN 92179)
 *
 * El Director Médico clasificó las contraindicaciones de HBOT sobre los consensos
 * de la Undersea and Hyperbaric Medical Society (UHMS). Su criterio:
 *
 *   **El neumotórax no tratado (o a tensión) es la ÚNICA absoluta.** Todas las
 *   demás son relativas: requieren evaluación riesgo/beneficio, pre-tratamiento o
 *   estabilización, no la cancelación automática de la sesión.
 *
 * Eso **revierte** la decisión del 1-sep-2026 ("manda el criterio más estricto")
 * para cuatro entradas que el documento de admisión había subido a bloqueo:
 * infección de vías aéreas, convulsiones, claustrofobia y embarazo. La reversión
 * es deliberada y la firma el Director Médico; el documento de admisión sigue
 * siendo la fuente de QUÉ se pregunta, pero no de con qué severidad se bloquea.
 *
 * Sobre fiebre y EPOC dejó una instrucción operativa explícita: *"se resuelven con
 * una pregunta de los técnicos hiperbáricos, no suspender sesiones por esto"*.
 *
 * **Ojo con lo que la severidad NO controla.** Son dos compuertas distintas:
 *   - `validarContraindicaciones` (R-02, bots de reserva) SÍ mira la severidad:
 *     absoluta bloquea sin autorización médica, relativa advierte.
 *   - `estadoSeguridad` (el banner de Atender) NO la mira: cualquier riesgo
 *     declarado en el screening pinta rojo y deja `puedeAvanzar: false`, sea
 *     absoluta o relativa. Bajar una entrada a relativa NO hace que la sesión
 *     avance sola.
 *
 * **Cierre de la resolución (9-sep-2026).** El Director Médico definió las cuatro
 * que habían quedado abiertas: doxorrubicina, bleomicina, marcapasos/DAI y cirugía
 * de oído, nariz o tórax reciente van **absolutas**, *"con posibilidad de consulta
 * médica con el cardiólogo Dr. D'Alessandro Alejandro Sergio"*.
 *
 * Esa consulta no necesita nada nuevo: es la vía de escape que R-02 ya tiene.
 * `validarContraindicaciones(..., { autorizacionMedica: true })` levanta el bloqueo,
 * y para estas cuatro el camino es la consulta con el cardiólogo. Absoluta acá no
 * significa "nunca": significa "no sin que lo vea un médico".
 *
 * Con eso, la clasificación de HBOT queda completa. `HBOT_MEDICACION_INCOMPATIBLE`
 * se partió por droga: agrupaba cuatro fármacos que ahora tienen severidades
 * distintas (doxorrubicina y bleomicina absolutas; cisplatino, disulfiram y
 * mafenida relativas), y agrupadas no se pueden expresar.
 *
 * ## Revisión 2026-09-01 — mapeo del documento de admisión (Andrés → Dalessandro)
 *
 * La especificación "Consentimiento Informado Digital" (25-ago-2026) asigna a
 * varias respuestas del screening un bloqueo que esta tabla tenía como simple
 * advertencia. Andrés decidió (2026-09-01) que **manda el criterio más
 * estricto**: si el documento dice que bloquea, bloquea.
 *
 * Las entradas afectadas vuelven a `borradorPendienteRevision` — que es el
 * mecanismo de esta tabla: el CodeSystem pasa a `draft` y el seed avisa hasta
 * que el Director Médico valide. NO es una formalidad: subir una severidad
 * significa que el sistema va a impedir sesiones que hoy deja pasar con
 * advertencia, y eso lo firma un médico. El propio documento lo pide
 * ("requieren validación del Dr. Dalessandro y la Dra. Dos Santos"), y la
 * tabla vigente la validó el Dr. Conrado: son DOS fuentes clínicas que hay que
 * conciliar en una sola revisión.
 */
import type { Contraindicacion } from '../domain/types.js';

export const CONTRAINDICACIONES: Contraindicacion[] = [
  // ---- HBOT ----
  {
    codigo: 'HBOT_NEUMOTORAX_NO_TRATADO',
    aplicaA: ['HBOT'],
    descripcion: 'Neumotórax no tratado (contraindicación absoluta de HBOT).',
    severidad: 'absoluta',
  },
  // Era UNA entrada absoluta con las cuatro drogas juntas. La resolución del
  // 9-sep-2026 les da severidades distintas, así que se parte por droga: agrupadas
  // no se pueden expresar. Ninguna tenía pregunta en el screening, así que el
  // reemplazo no rompe ningún mapeo — pero las cinco la necesitan.
  {
    codigo: 'HBOT_DOXORRUBICINA',
    aplicaA: ['HBOT'],
    descripcion: 'Tratamiento con doxorrubicina (cardiotoxicidad grave / interacción farmacológica severa).',
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_BLEOMICINA',
    aplicaA: ['HBOT'],
    descripcion: 'Tratamiento con bleomicina (riesgo de toxicidad pulmonar potenciada por la hiperoxia).',
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_CISPLATINO',
    aplicaA: ['HBOT'],
    descripcion: 'Tratamiento con cisplatino (retraso significativo en la cicatrización de heridas).',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_DISULFIRAM',
    aplicaA: ['HBOT'],
    descripcion:
      'Tratamiento con disulfiram (bloquea la superóxido dismutasa: disminuye la protección contra la toxicidad por oxígeno).',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_EPOC_RETENCION_CO2',
    aplicaA: ['HBOT'],
    // Texto ampliado por resolución del 9-sep-2026: el Director Médico no la
    // acota a la retención de CO2.
    descripcion:
      'Enfermedad pulmonar obstructiva crónica (intolerancia al aumento de oxígeno, pérdida del estímulo hipóxico o atrapamiento aéreo).',
    severidad: 'relativa',
  },
  {
    codigo: 'HBOT_INFECCION_VIA_AEREA',
    aplicaA: ['HBOT'],
    descripcion: 'Infección de vías aéreas superiores o sinusitis activa (riesgo de barotrauma).',
    // Doc de admisión B1: bloquea HBOT. Es la contraindicación transitoria más
    // frecuente y "la que más barotraumas óticos causa" — el documento la
    // señala como la pregunta que no puede faltar si hay que elegir una sola.
    // Relativa por resolución del Director Médico (9-sep-2026, UHMS): obstrucción de la trompa de Eustaquio; dificulta la
    // equipresión del oído medio, no la impide.
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_CONVULSIONES',
    aplicaA: ['HBOT'],
    descripcion: 'Antecedente de convulsiones no controladas / epilepsia.',
    // Doc de admisión A.1 #5: bloquea HBOT (y terapia de contraste, que aún no
    // existe como categoría en el catálogo — ver decisiones-pendientes).
    // Relativa por resolución del Director Médico (9-sep-2026, UHMS): aumento del riesgo de convulsiones inducidas por
    // hiperoxia; se evalúa riesgo/beneficio.
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_FIEBRE_ALTA',
    aplicaA: ['HBOT'],
    descripcion:
      'Fiebre de origen desconocido o hipertermia (incrementa la posibilidad de convulsiones por toxicidad de oxígeno).',
    severidad: 'relativa',
  },
  {
    // NUEVA (doc de admisión A.1 #2): la pregunta `hbot-marcapasos` ya existía
    // en el cuestionario y no tenía código en la tabla — el doc le asigna
    // bloqueo de HBOT salvo certificación del implante para uso hiperbárico.
    codigo: 'HBOT_IMPLANTE_NO_CERTIFICADO',
    aplicaA: ['HBOT'],
    descripcion: 'Marcapasos, desfibrilador u otro implante electrónico sin certificación para uso hiperbárico.',
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    // NUEVA (doc de admisión A.1 #3): `cirugia-reciente-ont` ya se preguntaba
    // pero estaba fuera del screening y no declaraba riesgo.
    codigo: 'HBOT_CIRUGIA_ONT_RECIENTE',
    aplicaA: ['HBOT'],
    descripcion: 'Cirugía de oído, nariz o tórax en los últimos 30 días.',
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_CLAUSTROFOBIA',
    aplicaA: ['HBOT'],
    descripcion: 'Claustrofobia severa.',
    // Doc de admisión A.1 #4: bloquea HBOT.
    // Relativa por resolución del Director Médico (9-sep-2026, UHMS): ansiedad aguda que dificulta la tolerancia al recinto
    // cerrado; no la impide siempre.
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_EMBARAZO',
    aplicaA: ['HBOT', 'IHHT'],
    descripcion: 'Embarazo (evaluación médica requerida).',
    // Doc de admisión B2: bloquea HBOT, IHHT y contraste, y deriva a consulta.
    // Relativa por resolución del Director Médico (9-sep-2026, UHMS): teratógeno fetal cuestionable. De rutina se evita; en
    // emergencia por intoxicación con CO se usa. NOTA: esta entrada también
    // aplica a IHHT, y la resolución del 9-sep cubre HBOT — confirmar IHHT.
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },

  // ---- HBOT · resolución del Director Médico, 9-sep-2026 (UHMS) ----
  // Todas relativas por el mismo criterio: la única absoluta de HBOT es el
  // neumotórax no tratado. Ninguna tiene todavía pregunta en el screening de
  // ingreso, así que HOY NO SE ACTIVAN — ver el handoff de metadata clínica.
  {
    codigo: 'HBOT_ESFEROCITOSIS',
    aplicaA: ['HBOT'],
    descripcion:
      'Esferocitosis congénita o hereditaria (riesgo de hemólisis masiva por estrés oxidativo).',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_HIPOTERMIA',
    aplicaA: ['HBOT'],
    descripcion:
      'Hipotermia (al recalentarse o alterar la respuesta metabólica, incrementa la posibilidad de convulsiones).',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_PACIENTE_DESCOMPENSADO',
    aplicaA: ['HBOT'],
    descripcion:
      'Paciente descompensado con riesgo de complicación que requiera manejo intrahospitalario urgente, no realizable dentro de la cámara.',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_NEUMOTORAX_ESPONTANEO_PREVIO',
    aplicaA: ['HBOT'],
    descripcion:
      'Antecedente de neumotórax espontáneo (mayor riesgo de recurrencia bajo cambios de presión).',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_AIRE_ATRAPADO',
    aplicaA: ['HBOT'],
    descripcion:
      'Embolia gaseosa, neumomediastino, neumoperitoneo o enfisema subcutáneo no drenados (riesgo de expansión gaseosa; el enfisema puede indicar fuga aérea no detectada).',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_BULLAS_PULMONARES',
    aplicaA: ['HBOT'],
    descripcion:
      'Bullas pulmonares (riesgo de ruptura bullosa y neumotórax iatrogénico durante la descompresión).',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_NEUMONIA_PNEUMOCYSTIS',
    aplicaA: ['HBOT'],
    descripcion:
      'Neumonía por Pneumocystis jirovecii (carinii): riesgo elevado de ruptura alveolar y neumotórax.',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_BAROTRAUMA_PREVIO',
    aplicaA: ['HBOT'],
    descripcion:
      'Barotrauma de senos, oído o pulmonar (impedimento para igualar presiones en cavidades aéreas).',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_NEURITIS_OPTICA',
    aplicaA: ['HBOT'],
    descripcion:
      'Neuritis óptica (mayor predisposición a la patología del nervio óptico; cuestionable en la literatura).',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_ACIDOSIS',
    aplicaA: ['HBOT'],
    descripcion:
      'Acidosis (disminuye el umbral de convulsiones inducidas por el oxígeno).',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_ANSIEDAD',
    aplicaA: ['HBOT'],
    descripcion:
      'Ansiedad que dificulta tolerar el entorno o seguir las instrucciones de seguridad.',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },
  {
    codigo: 'HBOT_MAFENIDA',
    aplicaA: ['HBOT'],
    descripcion:
      'Tratamiento con acetato de mafenida (inhibidor de la anhidrasa carbónica: causa acidosis y promueve vasodilatación y convulsiones).',
    severidad: 'relativa',
    borradorPendienteRevision: true,
  },

  // ---- IHHT ----
  {
    codigo: 'IHHT_SCA_RECIENTE',
    aplicaA: ['IHHT'],
    descripcion: 'Síndrome coronario agudo o infarto reciente / angina inestable.',
    severidad: 'absoluta',
  },
  {
    codigo: 'IHHT_INSUF_CARDIACA_DESCOMP',
    aplicaA: ['IHHT'],
    descripcion: 'Insuficiencia cardíaca descompensada.',
    severidad: 'absoluta',
  },
  {
    codigo: 'IHHT_HTP_SEVERA',
    aplicaA: ['IHHT'],
    descripcion: 'Hipertensión pulmonar severa.',
    severidad: 'relativa',
  },
  {
    codigo: 'IHHT_INFECCION_RESPIRATORIA',
    aplicaA: ['IHHT'],
    descripcion: 'Infección respiratoria aguda.',
    severidad: 'relativa',
  },
  {
    codigo: 'IHHT_HTA_NO_CONTROLADA',
    aplicaA: ['IHHT'],
    descripcion: 'Hipertensión arterial no controlada (>180/110).',
    // Doc de admisión A.2 #7: bloquea IHHT.
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    // NUEVA (doc de admisión A.2 #8): la tabla solo tenía EPOC para HBOT
    // (`HBOT_EPOC_RETENCION_CO2`); la pregunta `ihht-epoc` no tenía código.
    codigo: 'IHHT_EPOC_SEVERO',
    aplicaA: ['IHHT'],
    descripcion: 'EPOC severo (estadio IV) o enfermedad pulmonar obstructiva avanzada.',
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
  {
    // NUEVA (doc de admisión A.2 #9): bloquea IHHT **y botas de compresión** —
    // la compresión neumática sobre una trombosis activa es el riesgo obvio, y
    // la tabla no cubría COMPRESION en ninguna entrada.
    codigo: 'IHHT_TVP_ACTIVA',
    aplicaA: ['IHHT', 'COMPRESION'],
    descripcion: 'Trombosis venosa profunda activa o reciente.',
    severidad: 'absoluta',
    borradorPendienteRevision: true,
  },
];

export const CONTRAINDICACIONES_POR_CODIGO: ReadonlyMap<string, Contraindicacion> = new Map(
  CONTRAINDICACIONES.map((c) => [c.codigo, c]),
);
