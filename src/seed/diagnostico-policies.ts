/**
 * Diagnóstico de las AccessPolicies publicadas.
 *
 *   npm run policy:check
 *
 * Compara las policies del servidor contra las que genera el código
 * (`src/fhir/access-policies.ts`) y reporta tres derivas:
 *
 *  - FALTAN: están en el código y no en el servidor → nunca se seedeó.
 *  - SOBRAN: están en el servidor y no en el código → alguien las cargó a mano.
 *  - DUPLICADAS: la misma regla dos veces en el servidor.
 *
 * Por qué existe: **el seed es dueño de estas policies** — hace upsert por
 * `name` y reemplaza el recurso ENTERO, así que todo lo aplicado a mano se
 * pierde (o se duplica) en la próxima corrida. Ya pasó cuatro veces: Coverage
 * HIP, ServiceRequest y Consent se aplicaron a mano y el seed los BORRÓ,
 * dejando al portal en 403; y el 2026-09-08 las seis entradas del PB100D se
 * cargaron a mano sobre las que el seed ya había escrito, y quedaron
 * DUPLICADAS. El portal tiene su `verificar:policy`, pero mira su espejo —
 * este chequeo mira desde el lado que sí es dueño.
 *
 * Un permiso de más que nadie revisó es el riesgo real: por eso las entradas
 * escribibles sin `criteria` se listan aparte, existan o no en el código.
 *
 * SOLO LECTURA: no escribe nada. La deriva se corrige con `npm run seed`.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { AccessPolicy, AccessPolicyResource } from '@medplum/fhirtypes';
import { ACCESS_POLICIES } from '../fhir/access-policies.js';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

/**
 * Clave canónica de una regla: serialización estable de TODOS sus campos, con
 * las claves y los arrays ordenados. Comparar campo por campo dejaría pasar una
 * diferencia en un campo que no anticipamos (`hiddenFields`, `writeConstraint`);
 * así, cualquier diferencia aparece como regla distinta.
 */
export function claveRegla(r: AccessPolicyResource): string {
  const limpio: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r as unknown as Record<string, unknown>)) {
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) {
      continue;
    }
    limpio[k] = Array.isArray(v) ? [...v].map(String).sort() : v;
  }
  return JSON.stringify(limpio, Object.keys(limpio).sort());
}

/** Línea legible, con el mismo formato que el `verificar:policy` del portal. */
function describir(r: AccessPolicyResource): string {
  const modo = r.readonly ? 'solo lectura' : 'lectura y escritura';
  const criterio = r.criteria ?? '(sin criterio: todo el tipo)';
  const extra = [
    r.readonlyFields?.length ? `campos de solo lectura: ${r.readonlyFields.length}` : '',
    r.hiddenFields?.length ? `campos ocultos: ${r.hiddenFields.length}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `${String(r.resourceType).padEnd(22)}${modo.padEnd(21)}${criterio}${extra ? `  [${extra}]` : ''}`;
}

/** Cuenta cuántas veces aparece cada clave. */
function contar(reglas: AccessPolicyResource[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of reglas) {
    const k = claveRegla(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export interface Deriva {
  nombre: string;
  faltan: AccessPolicyResource[];
  sobran: AccessPolicyResource[];
  duplicadas: Array<{ regla: AccessPolicyResource; veces: number }>;
  ausente: boolean;
}

export function compararPolicy(esperada: AccessPolicy, servidor: AccessPolicy | undefined): Deriva {
  const nombre = esperada.name ?? '(sin nombre)';
  if (!servidor) {
    return { nombre, faltan: esperada.resource ?? [], sobran: [], duplicadas: [], ausente: true };
  }
  const enCodigo = contar(esperada.resource ?? []);
  const enServidor = contar(servidor.resource ?? []);
  // Índice clave → regla, para poder imprimir la regla y no la clave cruda.
  const muestra = new Map<string, AccessPolicyResource>();
  for (const r of [...(esperada.resource ?? []), ...(servidor.resource ?? [])]) {
    muestra.set(claveRegla(r), r);
  }

  const faltan = [...enCodigo.keys()].filter((k) => !enServidor.has(k)).map((k) => muestra.get(k)!);
  const sobran = [...enServidor.keys()].filter((k) => !enCodigo.has(k)).map((k) => muestra.get(k)!);
  const duplicadas = [...enServidor.entries()]
    .filter(([, n]) => n > 1)
    .map(([k, n]) => ({ regla: muestra.get(k)!, veces: n }));

  return { nombre, faltan, sobran, duplicadas, ausente: false };
}

async function main(): Promise<void> {
  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log(`Conectado a ${process.env.MEDPLUM_BASE_URL}\n`);
  console.log('=== AccessPolicies: código vs servidor ===');
  console.log('Fuente de verdad: src/fhir/access-policies.ts (el seed reemplaza la policy entera).\n');

  const publicadas = await medplum.searchResources('AccessPolicy', { _count: 100 });
  const porNombre = new Map<string, AccessPolicy[]>();
  for (const p of publicadas) {
    const n = p.name ?? '(sin nombre)';
    porNombre.set(n, [...(porNombre.get(n) ?? []), p]);
  }

  const derivas: Deriva[] = [];
  for (const esperada of ACCESS_POLICIES) {
    const nombre = esperada.name ?? '(sin nombre)';
    const enServidor = porNombre.get(nombre) ?? [];
    // Dos policies con el MISMO nombre rompen el upsert: `searchOne` toma una
    // sola y la otra queda viva, vieja y aplicada a quien la tenga asignada.
    if (enServidor.length > 1) {
      console.log(`✗ ${nombre}: ${enServidor.length} policies con el mismo nombre en el servidor`);
      console.log(`    ${enServidor.map((p) => `AccessPolicy/${p.id}`).join(', ')}`);
      console.log('    → El seed actualiza UNA sola; dar de baja las sobrantes desde el admin.\n');
    }
    const d = compararPolicy(esperada, enServidor[0]);
    derivas.push(d);

    const ok = !d.ausente && d.faltan.length === 0 && d.sobran.length === 0 && d.duplicadas.length === 0;
    const total = enServidor[0]?.resource?.length ?? 0;
    console.log(
      `${ok ? '✓' : '✗'} ${nombre.padEnd(34)} ${String(esperada.resource?.length ?? 0).padStart(3)} en el código · ` +
        `${d.ausente ? 'NO EXISTE en el servidor' : `${String(total).padStart(3)} en el servidor`}`,
    );
    for (const r of d.faltan) {
      console.log(`    FALTA      ${describir(r)}`);
    }
    for (const r of d.sobran) {
      console.log(`    SOBRA      ${describir(r)}`);
    }
    for (const { regla, veces } of d.duplicadas) {
      console.log(`    DUPLICADA (×${veces}) ${describir(regla)}`);
    }
  }

  // Permisos abiertos: escritura sin `criteria` = acceso a los recursos de
  // TODOS los pacientes. `Binary` es la excepción conocida y preexistente
  // (adjuntos de mensajes y consentimientos), igual que en tests/programas.test.ts.
  const policyPaciente = porNombre.get('Paciente — Portal')?.[0];
  const abiertas = (policyPaciente?.resource ?? []).filter((r) => !r.readonly && !r.criteria);
  const inesperadas = abiertas.filter((r) => r.resourceType !== 'Binary');
  console.log(`\n=== Escritura sin criteria en "Paciente — Portal": ${abiertas.length} ===`);
  for (const r of abiertas) {
    console.log(`  ${r.resourceType === 'Binary' ? '·' : '!'} ${describir(r)}`);
  }
  if (inesperadas.length > 0) {
    console.log('  → Le da al paciente acceso a los recursos de TODOS. Revisar YA.');
  }

  const conDeriva = derivas.filter(
    (d) => d.ausente || d.faltan.length > 0 || d.sobran.length > 0 || d.duplicadas.length > 0,
  );
  console.log('\n=== Veredicto ===');
  if (conDeriva.length === 0 && inesperadas.length === 0) {
    console.log('✓ Las policies del servidor coinciden con el código.');
    return;
  }
  if (conDeriva.length > 0) {
    console.log(`✗ ${conDeriva.length} policy(s) con deriva: ${conDeriva.map((d) => d.nombre).join(', ')}`);
    console.log('  → Se corrige con `npm run seed`: reemplaza cada policy entera desde el código.');
    console.log('  → Si alguna entrada del servidor DEBE quedarse, agregarla al código primero:');
    console.log('    lo que no esté en src/fhir/access-policies.ts lo borra la próxima corrida.');
  }
  if (inesperadas.length > 0) {
    console.log('✗ Hay escritura sin criteria fuera de Binary (arriba, con !).');
  }
  process.exitCode = 1;
}

// El import desde los tests no debe ejecutar el CLI (ni intentar conectarse).
if (process.argv[1]?.endsWith('diagnostico-policies.ts')) {
  main().catch((err) => {
    console.error('Diagnóstico de policies falló:', err);
    process.exitCode = 1;
  });
}
