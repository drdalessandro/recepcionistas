import { describe, it, expect } from 'vitest';
import { buildScheduleMedico, buildSeed, buildSlotMedico, esScheduleDeMedico, horarioDeAgendaMedico } from '../src/seed/builders.js';
import { generarSlots } from '../src/lib/slots.js';
import { getServicio } from '../src/config/catalogo.js';
import { MEDICOS } from '../src/config/medicos.js';
import { SYSTEM } from '../src/fhir/identifiers.js';
import { EXT, INTAKE_QUESTIONNAIRE_URL } from '../src/fhir/identifiers.js';
import { CONSENTIMIENTO_LIBRARY_URL, VERSION_CONSENTIMIENTO, consentSections } from '../src/config/consentimiento-texto.js';

const seed = buildSeed();

describe('Seed — composición', () => {
  it('Construye los grupos de recursos esperados', () => {
    expect(seed.structureDefinitions.length).toBeGreaterThanOrEqual(28);
    // 9 roles internos + Paciente — Portal. Kinesiología y Nutrición entraron
    // con el PB100D; Cardiología y Endocrinología, con la teleconsulta.
    expect(seed.accessPolicies.length).toBe(10);
    // 32 que se ofrecen + 6 RETIRADOS. Los retirados se publican a propósito
    // (con `status: 'retired'`): el seed hace upsert y no borra, así que
    // omitirlos los dejaría `active` en el servidor y el portal los seguiría
    // ofreciendo — que es lo que pasó dos meses con IHHT_EXPRESS/IHHT_PREMIUM.
    expect(seed.activityDefinitions.length).toBe(38);
    expect(seed.activityDefinitions.filter((a) => a.status === 'retired')).toHaveLength(6);
    expect(seed.combos.length).toBe(9);
    expect(seed.membresias.length).toBe(10);
    // 8 servicios base × 3 tramos (Multiplaza y Recovery Pro sumados 2026-08-15)
    // + los 3 de IHHT Express, que se publican RETIRADOS: su servicio base ya no
    // existe, y omitirlos los dejaría `active` vendiéndose en el servidor.
    expect(seed.paquetes.length).toBe(27);
    expect(seed.paquetes.filter((p) => p.status === 'retired')).toHaveLength(3);
    expect(seed.programas.length).toBe(2); // PB100D premium: mensual + 100 días
    expect(seed.locations.length).toBe(14); // 13 + Puesto IV 2 (handoff v9)
    // 14 salas + las 3 agendas médicas publicadas (Conrado, D'Alessandro, Dos Santos).
    expect(seed.schedules.length).toBe(17);
    expect(seed.practitioners.length).toBe(3);
  });
});

describe('Seed — ActivityDefinition (servicios)', () => {
  it('Cada servicio tiene url, identifier y extensión precio-usd', () => {
    for (const ad of seed.activityDefinitions) {
      expect(ad.url).toMatch(/ActivityDefinition\//);
      expect(ad.identifier?.[0]?.value).toBeTruthy();
      const precio = ad.extension?.find((e) => e.url === EXT.precioUsd);
      expect(typeof precio?.valueDecimal).toBe('number');
    }
  });

  it('Chequeo Biowellness: precio-ars de consulta y descripción en voz de paciente (portal)', () => {
    const chequeo = seed.activityDefinitions.find((ad) => ad.name === 'CHEQUEO_BW')!;
    expect(chequeo.identifier?.[0]?.value).toBe('CHEQUEO_BW');
    expect(chequeo.extension?.find((e) => e.url === EXT.precioArs)?.valueDecimal).toBe(120000);
    expect(chequeo.description).toMatch(/evaluación inicial/i);
    expect(chequeo.timingTiming?.repeat?.duration).toBe(60);
  });

  it('Góndola comercial (handoff v2): orden 10-95, títulos comerciales y topic de vidriera', () => {
    const orden = (name: string): number | undefined =>
      seed.activityDefinitions.find((ad) => ad.name === name)?.extension?.find((e) => e.url === EXT.orden)?.valueInteger;
    // Todos los servicios llevan la extensión (sin ella, el portal los tira al final).
    for (const ad of seed.activityDefinitions) {
      expect(ad.extension?.some((e) => e.url === EXT.orden), `${ad.name} sin orden`).toBe(true);
    }
    // La góndola: Evaluación arriba, Cámara Hiperbárica 20-22, IV 90, Biológicas 95 al cierre.
    expect(orden('CHEQUEO_BW')).toBe(10);
    // Addendum 2.1: consultas separadas — Dos Santos primera, Conrado sección propia.
    expect(orden('CONSULTA_MED_DOS_SANTOS')).toBe(11);
    expect(orden('CONSULTA_MED_DALESSANDRO')).toBe(12);
    expect(orden('CONSULTA_MED_CONRADO')).toBe(13);
    const topicDe = (name: string): string | undefined =>
      seed.activityDefinitions.find((ad) => ad.name === name)?.topic?.[0]?.text;
    expect(topicDe('CONSULTA_MED_DOS_SANTOS')).toBe('Consulta Médica');
    expect(topicDe('CONSULTA_MED_DALESSANDRO')).toBe('Consulta Médica');
    expect(topicDe('CONSULTA_MED_CONRADO')).toBe('Consulta Director Médico');
    const conrado = seed.activityDefinitions.find((ad) => ad.name === 'CONSULTA_MED_CONRADO')!;
    expect(conrado.description).toMatch(/No realiza las Evaluaciones/);
    expect(conrado.extension?.find((e) => e.url === EXT.precioArs)?.valueDecimal).toBe(150000);
    expect(conrado.title).toBe('Consulta médica — Dr. Conrado López Alonso');
    // La góndola vende "Evaluación Biowellness" sin nombre de médico (el
    // paciente lo elige al reservar); recepción lo re-agrega en el display.
    expect(seed.activityDefinitions.find((ad) => ad.name === 'CONSULTA_MED_DOS_SANTOS')?.title).toBe('Evaluación Biowellness');
    expect(seed.activityDefinitions.find((ad) => ad.name === 'CONSULTA_MED_DALESSANDRO')?.title).toBe('Evaluación Biowellness');
    expect(orden('HBOT_MONO')).toBe(20);
    expect(orden('HBOT_MULTIPLAZA')).toBe(22);
    expect(orden('IHHT')).toBe(30);
    expect(orden('RECOVERY_PRO')).toBe(40);
    expect(orden('IV_NAD')).toBe(90);
    expect(orden('CELULAS_MADRE')).toBe(95);
    // Títulos comerciales sin códigos de equipo; los códigos de negocio intactos.
    const compresion = seed.activityDefinitions.find((ad) => ad.name === 'COMPRESION')!;
    expect(compresion.title).toBe('Compresión Neumática');
    expect(compresion.title).not.toMatch(/IPC06/);
    expect(seed.activityDefinitions.find((ad) => ad.name === 'CRIO')?.title).not.toMatch(/COT03/);
    expect(seed.activityDefinitions.find((ad) => ad.name === 'HBOT_MONO')?.title).toBe('Cámara Hiperbárica (HBOT) — Monoplaza');
    // Topic = sección comercial, no el código interno de categoría.
    expect(compresion.topic?.[0]?.text).toBe('Compresión');
    expect(seed.activityDefinitions.find((ad) => ad.name === 'CHEQUEO_BW')?.topic?.[0]?.text).toBe('Evaluación');
  });
});

describe('Seed — Combos (PlanDefinition)', () => {
  it('Tienen secuencia ordenada y orden-protocolo en cada acción', () => {
    for (const combo of seed.combos) {
      const sec = combo.extension?.find((e) => e.url === EXT.secuenciaOrdenada);
      expect(sec?.valueBoolean).toBe(true);
      for (const action of combo.action ?? []) {
        const orden = action.extension?.find((e) => e.url === EXT.ordenProtocolo);
        expect(typeof orden?.valueInteger).toBe('number');
      }
    }
  });
});

describe('Seed — Contraindicaciones · gobernanza de la validación médica', () => {
  const conBorrador = (): unknown[] =>
    (seed.contraindicaciones.concept ?? []).filter((c) =>
      c.property?.some((p) => p.code === 'borrador' && p.valueBoolean === true),
    );

  it('El CodeSystem se publica con severidad y autor', () => {
    const cs = seed.contraindicaciones;
    expect(cs.publisher).toContain('Conrado López Alonso');
    expect((cs.concept?.length ?? 0)).toBeGreaterThan(0);
    expect(cs.concept?.[0]?.property?.some((p) => p.code === 'severidad')).toBe(true);
  });

  /**
   * El invariante REAL de esta tabla no es "está siempre validada", sino que el
   * estado del CodeSystem no puede mentir sobre si lo está. Desde 2026-09-01
   * hay entradas en revisión (subidas de severidad del doc de admisión), y
   * mientras las haya el recurso tiene que salir en `draft` y decirlo en el
   * título — es lo que hace que la validación médica no se olvide.
   */
  it('Con entradas en borrador: el CodeSystem sale en draft y lo dice en el título', () => {
    const cs = seed.contraindicaciones;
    if (conBorrador().length > 0) {
      expect(cs.status).toBe('draft');
      expect(cs.title).toMatch(/BORRADOR/i);
    } else {
      expect(cs.status).toBe('active');
      expect(cs.title).not.toMatch(/BORRADOR/i);
    }
  });

  it('No queda NINGUNA entrada en borrador: la tabla está firmada', () => {
    // 9-sep-2026: firma conjunta del Dr. D'Alessandro (MN 92179) y el Dr. Conrado
    // López Alonso. Este test es el acta. Si alguien agrega o modifica una entrada,
    // tiene que entrar como borrador —y entonces esto falla, el CodeSystem vuelve a
    // `draft` y el seed avisa— hasta que un Director Médico la firme.
    const enBorrador = (seed.contraindicaciones.concept ?? [])
      .filter((c) => c.property?.some((p) => p.code === 'borrador' && p.valueBoolean === true))
      .map((c) => c.code);
    expect(enBorrador).toEqual([]);
  });

  it('El CodeSystem firmado sale `active` y lleva a los dos Directores Médicos', () => {
    const cs = seed.contraindicaciones;
    expect(cs.status).toBe('active');
    expect(cs.title).not.toMatch(/BORRADOR/i);
    expect(cs.publisher).toContain("D'Alessandro");
    expect(cs.publisher).toContain('Conrado López Alonso');
    expect(cs.date).toBe('2026-09-09');
  });

  it('La ÚNICA absoluta de HBOT es el neumotórax no tratado (resolución UHMS del 9-sep-2026)', () => {
    // El criterio del Director Médico, escrito como test: si alguien vuelve a
    // subir una entrada de HBOT a `absoluta` sin registrarlo, esto avisa.
    // Marcapasos y cirugía de oído/nariz/tórax siguen absolutas porque su
    // severidad quedó explícitamente pendiente en esa misma resolución.
    const absolutasHbot = (seed.contraindicaciones.concept ?? [])
      .filter((c) => c.property?.some((p) => p.code === 'aplicaA' && (p.valueString ?? '').includes('HBOT')))
      .filter((c) => c.property?.some((p) => p.code === 'severidad' && p.valueString === 'absoluta'))
      .map((c) => c.code)
      .sort();
    // Las cuatro que no son el neumotórax son las que el Director Médico dejó
    // absolutas el 9-sep-2026 "con posibilidad de consulta médica con el
    // cardiólogo": absoluta acá no es "nunca", es "no sin que lo vea un médico"
    // — la vía de escape `autorizacionMedica` de R-02.
    expect(absolutasHbot).toEqual([
      'HBOT_BLEOMICINA',
      'HBOT_CIRUGIA_ONT_RECIENTE',
      'HBOT_DOXORRUBICINA',
      'HBOT_IMPLANTE_NO_CERTIFICADO',
      'HBOT_NEUMOTORAX_NO_TRATADO',
    ]);
  });
});

describe('Seed — AccessPolicy Paciente — Portal (los dos usos de Coverage)', () => {
  it('Mantiene la lectura amplia Y la escritura acotada a type ActCode HIP', () => {
    const portal = seed.accessPolicies.find((p) => p.name === 'Paciente — Portal')!;
    const coverages = (portal.resource ?? []).filter((r) => r.resourceType === 'Coverage');
    // Readonly amplia: el paciente ve sus planes BW.
    expect(coverages.some((r) => r.readonly === true && r.criteria === 'Coverage?beneficiary=%patient')).toBe(true);
    // Escritura SOLO de su obra social/prepaga (portal → "Datos de cobertura").
    // Sin esta entrada, el próximo seed pisa la policy aplicada a mano y el
    // guardado de cobertura del portal rompe con 403.
    expect(
      coverages.some(
        (r) =>
          !r.readonly &&
          r.criteria === 'Coverage?beneficiary=%patient&type=http://terminology.hl7.org/CodeSystem/v3-ActCode|HIP',
      ),
    ).toBe(true);
  });

  it('Estudios de laboratorio: lee todos los suyos, pero solo puede CREAR propuestas', () => {
    const portal = seed.accessPolicies.find((p) => p.name === 'Paciente — Portal')!;
    const srs = (portal.resource ?? []).filter((r) => r.resourceType === 'ServiceRequest');
    // Sin ninguna entrada, hasta la búsqueda del portal daba 403 (2026-08-13).
    expect(srs).toHaveLength(2);
    // Lectura amplia: también las órdenes que le indica el médico.
    expect(srs.some((r) => r.readonly === true && r.criteria === 'ServiceRequest?subject=%patient')).toBe(true);
    // Escritura acotada: jamás una orden médica autorizada.
    const escribible = srs.find((r) => !r.readonly)!;
    expect(escribible.criteria).toBe('ServiceRequest?subject=%patient&intent=proposal,plan');
    expect(escribible.criteria).not.toContain('intent=order');
  });

  it('Consentimientos: lee y firma los suyos, sin filtrar por category (la entrada que el seed borraba)', () => {
    // docs/recepcionistaschequeohandoff.md decía que el espejo del portal tenía
    // una entrada Consent aplicada A MANO que no estaba en este array: cada
    // `npm run seed` la borraba y dejaba la firma del portal en 403.
    const portal = seed.accessPolicies.find((p) => p.name === 'Paciente — Portal')!;
    const consents = (portal.resource ?? []).filter((r) => r.resourceType === 'Consent');
    expect(consents).toHaveLength(2);
    expect(consents.some((r) => r.readonly === true && r.criteria === 'Consent?patient=%patient')).toBe(true);
    const escribible = consents.find((r) => !r.readonly)!;
    expect(escribible.criteria).toBe('Consent?patient=%patient');
    // NO acotar por category: el portal usa v3-ActCode|IDSCL y pone el código
    // de BW en policyRule. Un criteria por category rompe la firma con 403
    // (verificado contra el recurso real del servidor, 2026-08-14).
    expect(escribible.criteria).not.toContain('category=');
  });

  it('El paciente solo puede ejecutar los bots del portal, y ninguno más', () => {
    const portal = seed.accessPolicies.find((p) => p.name === 'Paciente — Portal')!;
    const bot = (portal.resource ?? []).find((r) => r.resourceType === 'Bot')!;
    expect(bot.readonly).toBe(true);

    const permitidos = (bot.criteria ?? '').replace('Bot?name=', '').split(',');
    expect(permitidos.sort()).toEqual(
      [
        'bw-cancelar-turno',
        'bw-disponibilidad',
        'bw-mover-turno',
        'bw-preferencia-semanal',
        'bw-solicitar-turno',
        // Teleconsulta (2026-09-16): entrar a SU videollamada y registrar que
        // entró. Los dos verifican que el turno sea del paciente antes de hacer
        // nada; el token sale acotado a esa sala y a la ventana del turno.
        'bw-teleconsulta-presencia',
        'bw-teleconsulta-token',
      ].sort(),
    );

    // Lo que importa no es el string sino QUÉ queda afuera: un bot de más acá es
    // un paciente cobrando, invitando o fusionando fichas desde su celular.
    for (const prohibido of [
      'bw-registrar-cobro',
      'bw-invitar-paciente',
      'bw-fusionar-paciente',
      'bw-asignar-plan',
      'bw-reservar-turno',
      'bw-estado-turno',
    ]) {
      expect(permitidos).not.toContain(prohibido);
    }
  });

  it('El paciente NO puede automarcarse Founding ni tocar su identidad (readonlyFields)', () => {
    // Sin esto, un paciente con su token podría escribirse tag-fm en su propio
    // Patient y darse el 20% off + ventana de 7 días (R-09), o cambiarse el DNI.
    const portal = seed.accessPolicies.find((p) => p.name === 'Paciente — Portal')!;
    const propio = (portal.resource ?? []).find(
      (r) => r.resourceType === 'Patient' && r.criteria === 'Patient?_id=%patient.id',
    )!;
    expect(propio.readonlyFields).toContain('Patient.identifier');
    expect(propio.readonlyFields?.some((f) => f.includes('tag-fm'))).toBe(true);
    expect(propio.readonlyFields?.some((f) => f.includes('tipo-cliente'))).toBe(true);
    expect(propio.readonlyFields?.some((f) => f.includes('tc-bloqueo-fm'))).toBe(true);
  });
});

describe('Seed — AccessPolicy de recepción (privacidad por diseño)', () => {
  it('No otorga acceso a recursos clínicos sensibles', () => {
    const recep = seed.accessPolicies.find((p) => p.name === 'Recepción — Operativo')!;
    const tipos = (recep.resource ?? []).map((r) => r.resourceType);
    // Consent incluido: recepción NO lee el consentimiento directo — recibe la
    // señal binaria por el bot bw-estado-consentimiento (principio 3).
    for (const clinico of ['Observation', 'Condition', 'DiagnosticReport', 'DocumentReference', 'CarePlan', 'MedicationRequest', 'Consent', 'QuestionnaireResponse']) {
      expect(tipos).not.toContain(clinico);
    }
    // Sí da acceso a lo operativo.
    expect(tipos).toContain('Appointment');
    expect(tipos).toContain('Invoice');
  });

  it('Portal: la policy del paciente permite Subscription websocket (campanita de mensajes, ya estaba)', () => {
    // Regresión del feedback 2026-08-12: la campanita del portal necesita esta
    // entrada. YA EXISTÍA (entrada "Chat en tiempo real"); este test evita que
    // se pierda — y que se duplique.
    const paciente = seed.accessPolicies.find((p) => p.name === 'Paciente — Portal')!;
    const subs = (paciente.resource ?? []).filter((r) => r.resourceType === 'Subscription');
    expect(subs).toHaveLength(1);
    expect(subs[0]?.criteria).toBe('Subscription?type=websocket');
  });

  it('Basic: SOLO caja chica y demanda no cubierta (el config del TC no se toca del mostrador)', () => {
    const recep = seed.accessPolicies.find((p) => p.name === 'Recepción — Operativo')!;
    const basicos = (recep.resource ?? []).filter((r) => r.resourceType === 'Basic');
    // Una sola entrada con los dos codes en OR, no dos entradas del mismo
    // resourceType: así no depende de cómo resuelve el servidor policies que
    // compiten por el mismo tipo.
    expect(basicos).toHaveLength(1);
    expect(basicos[0]?.criteria).toBe(
      'Basic?code=https://biowellness.ar/fhir/CodeSystem/caja|,https://biowellness.ar/fhir/CodeSystem/demanda|',
    );
    expect(basicos[0]?.readonly).toBeUndefined();
    // Lo que este test cuida de verdad: el Basic del TC (identifier `config`)
    // sigue fuera de alcance. Sin criteria, el mostrador podría cambiar el
    // tipo de cambio de todo el centro.
    expect(basicos[0]?.criteria).not.toContain('/Identifier/config');
  });
});

describe('Seed — agenda publicada del Director Médico (viernes 17-20)', () => {
  const conrado = MEDICOS.find((m) => m.codigo === 'MED_CONRADO')!;

  it('El Schedule lleva el identifier canónico Y el del contrato del portal, con el Practitioner como actor', () => {
    const sch = seed.schedules.find((s) =>
      s.identifier?.some((i) => i.value === 'SCH_MED_CONRADO'),
    )!;
    expect(sch).toBeDefined();
    expect(sch.active).toBe(true);
    // Contrato del portal: namespace sid/recurso, valor que contiene "conrado".
    const delPortal = sch.identifier?.find((i) => i.system === SYSTEM.sidRecurso);
    expect(delPortal?.value).toBe('bw-sched-conrado');
    expect(sch.actor?.[0]?.reference).toContain('Practitioner?identifier=');
    expect(sch.actor?.[0]?.reference).toContain('MED_CONRADO');
  });

  it('Su agenda genera exactamente 3 slots de 60 min los viernes (17, 18 y 19) y nada otros días', () => {
    const dur = getServicio('CONSULTA_MED_CONRADO').duracionMin;
    const slots = generarSlots(
      [{ codigo: conrado.codigo, nombre: conrado.nombre, tipo: 'CONSULTORIO', capacidad: 1 }],
      horarioDeAgendaMedico(conrado),
      { desde: new Date('2026-07-20T12:00:00-03:00'), dias: 7, granularidadMin: dur },
    );
    // Viernes 24/07 (antes era miércoles 22/07: Andrés lo movió el 2026-08-13).
    expect(slots.map((s) => s.inicio)).toEqual([
      '2026-07-24T17:00:00-03:00',
      '2026-07-24T18:00:00-03:00',
      '2026-07-24T19:00:00-03:00',
    ]);
    // El Slot que persiste el seed lleva la convención bw-slot-* del portal.
    const slot = buildSlotMedico(conrado, slots[0]!, 'Schedule/xyz');
    expect(slot.status).toBe('free');
    expect(slot.identifier?.some((i) => i.system === SYSTEM.sidRecurso && i.value === 'bw-slot-conrado-2026-07-24T17:00:00-03:00')).toBe(true);
  });
});

describe('Seed — agendas de médicos (portal → Consulta médica)', () => {
  it('El Schedule de un médico NO es "ajeno": limpiar --apply no puede borrar su agenda', () => {
    const conAgenda = MEDICOS.filter((m) => (m.agenda?.length ?? 0) > 0);
    expect(conAgenda.length).toBeGreaterThan(0);
    for (const m of conAgenda) {
      expect(esScheduleDeMedico(buildScheduleMedico(m))).toBe(true);
    }
    // Un Schedule cualquiera (o uno hecho a mano sin el identifier canónico) sí lo es.
    expect(esScheduleDeMedico({ resourceType: 'Schedule', actor: [] })).toBe(false);
  });

  it('La agenda declarada se traduce a horario semanal (solo los días con franjas quedan abiertos)', () => {
    const conrado = MEDICOS.find((m) => m.codigo === 'MED_CONRADO')!;
    const horario = horarioDeAgendaMedico(conrado);
    expect(horario).toHaveLength(7);
    const abiertos = horario.filter((h) => h.abierto).map((h) => h.dia);
    expect(abiertos).toEqual(conrado.agenda!.map((f) => f.dia));
  });

  it('El seed solo publica Schedule de los médicos CON agenda declarada', () => {
    const publicados = seed.schedules.filter((s) => esScheduleDeMedico(s));
    expect(publicados).toHaveLength(MEDICOS.filter((m) => (m.agenda?.length ?? 0) > 0).length);
  });

  // El kiosco del mostrador y el portal dependen de que estos DOS recursos
  // existan en el servidor con la URL canónica exacta. Si alguien cambia una y
  // no la otra, el circuito se rompe en silencio: el kiosco se queda sin
  // formulario y `bw-estado-seguridad` deja de encontrar los screenings
  // completados — con lo cual TODO paciente pasa a 'sin-screening' y R-20
  // bloquea todas las reservas. Falla cerrado, pero falla.
  describe('contrato con el portal: consentimiento y cuestionario de ingreso', () => {
    it('el Questionnaire se publica con la URL canónica que busca el bot', () => {
      expect(seed.cuestionarioIngreso.url).toBe(INTAKE_QUESTIONNAIRE_URL);
      expect(seed.cuestionarioIngreso.status).toBe('active');
      expect(seed.cuestionarioIngreso.subjectType).toContain('Patient');
    });

    it('el Questionnaire conserva las preguntas de screening HBOT/IHHT', () => {
      const linkIds = JSON.stringify(seed.cuestionarioIngreso.item ?? []);
      // Sin estas, el cuestionario deja de ser un screening de contraindicaciones.
      expect(linkIds).toContain('cirugia-reciente-ont');
      expect(linkIds).toContain('medicacion');
    });

    it('el Library del consentimiento se publica versionado y con el texto adentro', () => {
      expect(seed.consentimiento.url).toBe(CONSENTIMIENTO_LIBRARY_URL);
      expect(seed.consentimiento.version).toBe(VERSION_CONSENTIMIENTO);
      expect(seed.consentimiento.status).toBe('active');
      const data = seed.consentimiento.content?.[0]?.data;
      expect(data).toBeTruthy();
      const contenido = JSON.parse(Buffer.from(data as string, 'base64').toString('utf-8'));
      // Las ocho secciones del documento legal viajan completas.
      expect(contenido.secciones).toHaveLength(consentSections.length);
      expect(contenido.secciones.map((s: { heading: string }) => s.heading)).toEqual(
        consentSections.map((s) => s.heading),
      );
    });

    it('las dos apps pueden LEER los dos recursos (si no, el kiosco abre vacío)', () => {
      const paciente = seed.accessPolicies.find((p) => p.name?.includes('Paciente'));
      const recepcion = seed.accessPolicies.find((p) => p.name?.includes('Recepción'));
      for (const policy of [paciente, recepcion]) {
        expect(policy).toBeDefined();
        const tipos = (policy!.resource ?? []).map((r) => r.resourceType);
        expect(tipos).toContain('Library');
        expect(tipos).toContain('Questionnaire');
      }
    });
  });
});
