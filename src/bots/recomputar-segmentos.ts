import { BotEvent, MedplumClient, getReferenceString } from '@medplum/core';
import type { Group, Patient, Observation, DetectedIssue } from '@medplum/fhirtypes';

/**
 * Bot: recomputar-segmentos — materializa la membresía de los Group del CRM.
 *
 * Lee los criterios de cada Group (characteristic[]) y llena member[] con los
 * Patient que los cumplen. Combina criterios clínicos (biomarcador / gate) con
 * comerciales (perfil / ciclo de vida). El criterio se discrimina por el coding
 * `rasgo-segmento` en characteristic.code; `exclude:true` lo niega.
 *
 * Disparo:
 *   - cron (recalcula todos los segmentos), o
 *   - on-demand pasando un Group como input (recalcula solo ese).
 *
 * Escala de clínica: evalúa por paciente; para volúmenes grandes conviene
 * pre-filtrar con SearchParameters propios sobre las extensiones.
 */
const BIO = 'https://bio.medplum.com.ar/fhir';
const RASGO = `${BIO}/CodeSystem/rasgo-segmento`;
const CICLO = `${BIO}/CodeSystem/ciclo-vida-cliente`;
const GATE = `${BIO}/CodeSystem/gate-terapia`;
const LOINC = 'http://loinc.org';
const EXT_PERFIL = `${BIO}/StructureDefinition/perfil-interes`;
const EXT_CICLO = `${BIO}/StructureDefinition/ciclo-vida-cliente`;
const SID_SEGMENTO = `${BIO}/sid/segmento`;

type Comp = '>' | '<' | '>=' | '<=';
interface Crit {
  tipo: 'perfil' | 'ciclo' | 'biomarcador' | 'gate';
  code?: string;        // perfil/ciclo
  loinc?: string;       // biomarcador
  comparator?: Comp;
  value?: number;
  gateCode?: string;    // gate
  exclude: boolean;
}

function parseCriterios(group: Group): Crit[] {
  const out: Crit[] = [];
  for (const ch of group.characteristic ?? []) {
    const rasgo = ch.code?.coding?.find((c) => c.system === RASGO)?.code;
    const exclude = ch.exclude ?? false;
    if (rasgo === 'perfil-interes') {
      out.push({ tipo: 'perfil', code: ch.valueCodeableConcept?.coding?.[0]?.code, exclude });
    } else if (rasgo === 'ciclo-vida') {
      out.push({ tipo: 'ciclo', code: ch.valueCodeableConcept?.coding?.[0]?.code, exclude });
    } else if (rasgo === 'biomarcador') {
      out.push({
        tipo: 'biomarcador',
        loinc: ch.code?.coding?.find((c) => c.system === LOINC)?.code,
        comparator: ch.valueQuantity?.comparator as Comp,
        value: ch.valueQuantity?.value,
        exclude,
      });
    } else if (rasgo === 'gate-terapia') {
      out.push({ tipo: 'gate', gateCode: ch.code?.coding?.find((c) => c.system === GATE)?.code, exclude });
    }
  }
  return out;
}

function meets(comp: Comp, v: number, t: number): boolean {
  return comp === '>' ? v > t : comp === '<' ? v < t : comp === '>=' ? v >= t : v <= t;
}

async function cumple(medplum: MedplumClient, p: Patient, crit: Crit): Promise<boolean> {
  let r = false;
  if (crit.tipo === 'perfil') {
    r = p.extension?.find((e) => e.url === EXT_PERFIL)?.valueCode === crit.code;
  } else if (crit.tipo === 'ciclo') {
    const ext = p.extension?.find((e) => e.url === EXT_CICLO)?.valueCode;
    const tag = p.meta?.tag?.find((t) => t.system === CICLO)?.code;
    r = (ext ?? tag) === crit.code;
  } else if (crit.tipo === 'biomarcador' && crit.loinc && crit.value != null && crit.comparator) {
    const obs = await medplum.searchResources('Observation', {
      patient: getReferenceString(p), code: `${LOINC}|${crit.loinc}`, _sort: '-date', _count: '1',
    });
    const val = (obs[0] as Observation | undefined)?.valueQuantity?.value;
    r = val != null && meets(crit.comparator, val, crit.value);
  } else if (crit.tipo === 'gate' && crit.gateCode) {
    const di = await medplum.searchOne('DetectedIssue', {
      patient: getReferenceString(p), code: `${GATE}|${crit.gateCode}`, status: 'final',
    });
    r = !!di;
  }
  return crit.exclude ? !r : r;
}

async function recomputarGroup(medplum: MedplumClient, group: Group): Promise<number> {
  const criterios = parseCriterios(group);

  // Candidatos: si hay criterio de ciclo (buscable por _tag), pre-filtramos; si no, todos.
  const cicloCrit = criterios.find((c) => c.tipo === 'ciclo' && !c.exclude && c.code);
  const candidatos = cicloCrit
    ? await medplum.searchResources('Patient', { _tag: `${CICLO}|${cicloCrit.code}`, _count: '1000' })
    : await medplum.searchResources('Patient', { _count: '1000' });

  const miembros: Group['member'] = [];
  for (const p of candidatos as Patient[]) {
    let ok = true;
    for (const crit of criterios) {
      if (!(await cumple(medplum, p, crit))) { ok = false; break; }
    }
    if (ok) miembros.push({ entity: { reference: getReferenceString(p) } });
  }

  await medplum.updateResource<Group>({
    ...group,
    quantity: miembros.length,
    member: miembros,
  });
  return miembros.length;
}

export async function handler(medplum: MedplumClient, event: BotEvent<Group | undefined>): Promise<{ segmentos: { nombre: string; miembros: number }[] }> {
  let groups: Group[];
  if (event.input && (event.input as Group).resourceType === 'Group') {
    groups = [event.input as Group];
  } else {
    groups = await medplum.searchResources('Group', { _count: '200' });
    groups = groups.filter((g) => g.identifier?.some((i) => i.system === SID_SEGMENTO));
  }

  const resumen: { nombre: string; miembros: number }[] = [];
  for (const g of groups) {
    const n = await recomputarGroup(medplum, g);
    resumen.push({ nombre: g.name ?? g.id ?? 'segmento', miembros: n });
  }
  return { segmentos: resumen };
}
