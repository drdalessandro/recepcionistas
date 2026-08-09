import { describe, it, expect } from 'vitest';
import { buildSeed, buildSlotMedico, horarioDeAgendaMedico } from '../src/seed/builders.js';
import { generarSlots } from '../src/lib/slots.js';
import { getServicio } from '../src/config/catalogo.js';
import { MEDICOS } from '../src/config/medicos.js';
import { SYSTEM } from '../src/fhir/identifiers.js';
import { EXT } from '../src/fhir/identifiers.js';

const seed = buildSeed();

describe('Seed — composición', () => {
  it('Construye los grupos de recursos esperados', () => {
    expect(seed.structureDefinitions.length).toBeGreaterThanOrEqual(28);
    expect(seed.accessPolicies.length).toBe(6); // 5 roles internos + Paciente — Portal
    expect(seed.activityDefinitions.length).toBe(36); // 32 + 3 consultas médicas + Chequeo BW (v9: IHHT única)
    expect(seed.combos.length).toBe(9);
    expect(seed.membresias.length).toBe(10);
    expect(seed.paquetes.length).toBe(18);
    expect(seed.locations.length).toBe(14); // 13 + Puesto IV 2 (handoff v9)
    expect(seed.schedules.length).toBe(15); // 14 salas + agenda publicada del Director Médico
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

describe('Seed — Contraindicaciones (validadas por el Director Médico, 2026-08-09)', () => {
  it('CodeSystem ACTIVO: la tabla está aprobada para uso real', () => {
    const cs = seed.contraindicaciones;
    expect(cs.status).toBe('active');
    expect(cs.publisher).toContain('Conrado López Alonso');
    expect((cs.concept?.length ?? 0)).toBeGreaterThan(0);
    const c0 = cs.concept?.[0];
    expect(c0?.property?.some((p) => p.code === 'severidad')).toBe(true);
  });

  it('Ninguna entrada quedó marcada borrador (una sola volvería el CodeSystem a draft)', () => {
    const cs = seed.contraindicaciones;
    const conBorrador = (cs.concept ?? []).filter((c) =>
      c.property?.some((p) => p.code === 'borrador' && p.valueBoolean === true),
    );
    expect(conBorrador).toEqual([]);
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

  it('El paciente solo puede ejecutar los bots del portal (solicitar-turno y disponibilidad)', () => {
    const portal = seed.accessPolicies.find((p) => p.name === 'Paciente — Portal')!;
    const bot = (portal.resource ?? []).find((r) => r.resourceType === 'Bot')!;
    expect(bot.readonly).toBe(true);
    expect(bot.criteria).toBe('Bot?name=bw-solicitar-turno,bw-disponibilidad');
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
    for (const clinico of ['Observation', 'Condition', 'DiagnosticReport', 'DocumentReference', 'CarePlan', 'MedicationRequest']) {
      expect(tipos).not.toContain(clinico);
    }
    // Sí da acceso a lo operativo.
    expect(tipos).toContain('Appointment');
    expect(tipos).toContain('Invoice');
  });
});

describe('Seed — agenda publicada del Director Médico (miércoles 17-20)', () => {
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

  it('Su agenda genera exactamente 3 slots de 60 min los miércoles (17, 18 y 19) y nada otros días', () => {
    const dur = getServicio('CONSULTA_MED_CONRADO').duracionMin;
    const slots = generarSlots(
      [{ codigo: conrado.codigo, nombre: conrado.nombre, tipo: 'CONSULTORIO', capacidad: 1 }],
      horarioDeAgendaMedico(conrado),
      { desde: new Date('2026-07-20T12:00:00-03:00'), dias: 7, granularidadMin: dur },
    );
    expect(slots.map((s) => s.inicio)).toEqual([
      '2026-07-22T17:00:00-03:00',
      '2026-07-22T18:00:00-03:00',
      '2026-07-22T19:00:00-03:00',
    ]);
    // El Slot que persiste el seed lleva la convención bw-slot-* del portal.
    const slot = buildSlotMedico(conrado, slots[0]!, 'Schedule/xyz');
    expect(slot.status).toBe('free');
    expect(slot.identifier?.some((i) => i.system === SYSTEM.sidRecurso && i.value === 'bw-slot-conrado-2026-07-22T17:00:00-03:00')).toBe(true);
  });
});
