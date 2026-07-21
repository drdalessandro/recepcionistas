import { describe, it, expect } from 'vitest';
import { buildSeed } from '../src/seed/builders.js';
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
    expect(seed.schedules.length).toBe(14);
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
    expect(orden('CONSULTA_MED_DALESSANDRO')).toBe(11);
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

describe('Seed — Contraindicaciones', () => {
  it('CodeSystem en estado draft con conceptos y propiedad severidad', () => {
    const cs = seed.contraindicaciones;
    expect(cs.status).toBe('draft');
    expect((cs.concept?.length ?? 0)).toBeGreaterThan(0);
    const c0 = cs.concept?.[0];
    expect(c0?.property?.some((p) => p.code === 'severidad')).toBe(true);
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
