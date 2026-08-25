/**
 * Migración: sumar a las fichas existentes el DNI con el system **canónico
 * nacional** (RENAPER), además del nuestro.
 *
 *   npm run migrar:dni-renaper            → DRY-RUN: lista qué cambiaría.
 *   npm run migrar:dni-renaper -- --apply → aplica los cambios.
 *
 * Es **aditiva**: agrega un identifier, no toca ni reescribe el que ya está. Una
 * ficha migrada tiene el documento dos veces —"30.123.456" con nuestro system y
 * "30123456" con el de RENAPER— y eso es lo buscado: adentro se sigue
 * encontrando como siempre, y afuera la ficha ya es cruzable con cualquier otro
 * sistema de salud (ver `src/fhir/paciente.ts`).
 *
 * Se saltea:
 *  - las fichas que ya tienen el canónico (idempotente: correrla dos veces no
 *    hace nada la segunda vez);
 *  - las que no tienen documento nuestro (nada que copiar);
 *  - los valores que no llegan a 6 dígitos, que no son un documento.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Patient } from '@medplum/fhirtypes';
import { SYSTEM, SYSTEM_RENAPER_DNI } from '../fhir/identifiers.js';
import { identificadoresDni } from '../fhir/paciente.js';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));

  console.log('=== Migración · DNI con system canónico (RENAPER) ===');
  console.log(apply ? '  MODO: aplicar cambios\n' : '  MODO: dry-run (sin escribir)\n');

  // Solo las fichas que tienen documento con NUESTRO system: son las únicas de
  // las que hay algo que copiar.
  const pacientes = await medplum.searchResources('Patient', `identifier=${SYSTEM.dni}|&_count=1000`);

  let migrados = 0;
  let yaEstaban = 0;
  let sinDocumentoUtil = 0;

  for (const p of pacientes as Patient[]) {
    if (!p.id) {
      continue;
    }
    if ((p.identifier ?? []).some((i) => i.system === SYSTEM_RENAPER_DNI)) {
      yaEstaban++;
      continue;
    }
    const nuestro = (p.identifier ?? []).find((i) => i.system === SYSTEM.dni)?.value;
    const canonico = identificadoresDni(nuestro).find((i) => i.system === SYSTEM_RENAPER_DNI);
    if (!canonico) {
      // Documento ilegible (letras, muy corto): no se inventa nada, se reporta.
      sinDocumentoUtil++;
      console.log(`  ⚠ ${p.id} · documento no utilizable: "${nuestro ?? ''}"`);
      continue;
    }
    console.log(`  + ${p.id} · ${nuestro} → ${canonico.value}`);
    if (apply) {
      await medplum.updateResource<Patient>({
        ...p,
        identifier: [...(p.identifier ?? []), canonico],
      });
    }
    migrados++;
  }

  console.log(
    `\nResumen: ${migrados} ${apply ? 'migradas' : 'a migrar'} · ${yaEstaban} ya tenían el canónico · ${sinDocumentoUtil} con documento no utilizable`,
  );
  if (!apply && migrados > 0) {
    console.log('Para aplicarlo: npm run migrar:dni-renaper -- --apply');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
