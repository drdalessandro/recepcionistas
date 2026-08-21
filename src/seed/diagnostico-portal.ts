/**
 * Diagnóstico del acceso al portal de un paciente.
 *
 *   npm run portal:check -- paciente@dominio.com
 *   npm run portal:check -- Patient/77b6616f-...
 *
 * Responde la pregunta que el bot `bw-invitar-paciente` no puede responder solo:
 * **por qué no sale el link de activación**. Reproduce paso a paso el camino del
 * bot (sin invitar, sin mandar nada) e imprime dónde se corta.
 *
 * Existe porque el fallo es MUDO por diseño en las dos puntas:
 *  - el `invite` de Medplum crea el link solo para usuarios nuevos
 *    (`if (!existingUser)`), y no avisa que no lo creó;
 *  - `auth/resetpassword` responde **200 aunque no encuentre al usuario**
 *    (anti-enumeración de cuentas, OWASP): "OK" no significa "lo hice".
 *
 * SOLO LECTURA: no invita, no crea solicitudes, no manda WhatsApp ni email.
 */
import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Bundle, Patient, ProjectMembership, UserSecurityRequest } from '@medplum/fhirtypes';

function requireEnv(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  }
  return v;
}

function emailsDe(p: Patient): string[] {
  return (p.telecom ?? []).filter((t) => t.system === 'email').map((t) => t.value ?? '(vacío)');
}

function nombreDe(p: Patient): string {
  const armado = [p.name?.[0]?.given?.join(' '), p.name?.[0]?.family].filter(Boolean).join(' ');
  return p.name?.[0]?.text ?? (armado || '(sin nombre)');
}

async function main(): Promise<void> {
  const arg = process.argv[2]?.trim();
  if (!arg) {
    console.error('Uso: npm run portal:check -- paciente@dominio.com   (o Patient/<id>)');
    process.exitCode = 1;
    return;
  }

  const medplum = new MedplumClient({ baseUrl: requireEnv('MEDPLUM_BASE_URL'), fetch });
  await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  console.log(`Conectado a ${process.env.MEDPLUM_BASE_URL}\n`);

  // 1) El/los paciente(s).
  let pacientes: Patient[];
  if (arg.startsWith('Patient/')) {
    pacientes = [await medplum.readResource('Patient', arg.split('/')[1] as string)];
  } else {
    pacientes = await medplum.searchResources('Patient', `telecom=${encodeURIComponent(arg.toLowerCase())}&_count=20`);
  }
  if (pacientes.length === 0) {
    console.log(`✗ Ningún Patient con ese email/id. (Ojo: la búsqueda es exacta y en minúsculas.)`);
    return;
  }
  if (pacientes.length > 1) {
    console.log(`⚠️  ${pacientes.length} pacientes comparten ese email — revisar duplicados (pestaña Duplicados).`);
  }

  for (const p of pacientes) {
    console.log(`=== ${nombreDe(p)} · Patient/${p.id} ===`);

    // 2) Emails de la ficha. Más de uno = el bot elige el PRIMERO si no se le pasa
    //    uno explícito, así que el "usuario del portal" puede cambiar sin querer.
    const emails = emailsDe(p);
    console.log(`\n[1/4] Emails en la ficha: ${emails.length === 0 ? '(ninguno)' : ''}`);
    for (const em of emails) {
      console.log(`  · ${em}${em !== em.toLowerCase() ? '  ⚠️ tiene mayúsculas' : ''}`);
    }
    if (emails.length > 1) {
      console.log('  ⚠️  MÁS DE UN EMAIL: puede haber una cuenta de login por cada uno. El bot usa el');
      console.log('     primero si no se le indica cuál, así que conviene dejar solo el correcto.');
    }

    // 3) La membership del portal (la cuenta de login ligada a esta ficha).
    console.log('\n[2/4] Acceso al portal (ProjectMembership):');
    const memberships = (await medplum
      .searchResources('ProjectMembership', `profile=Patient/${p.id}&_count=20`)
      .catch(() => [])) as ProjectMembership[];
    if (memberships.length === 0) {
      console.log('  ✗ Sin acceso creado todavía. Invitalo desde Atender → Invitar al portal.');
      console.log('    (Si la invitación "falló", igual pudo crearse: volvé a correr esto.)');
      continue;
    }
    for (const m of memberships) {
      console.log(`  · ProjectMembership/${m.id} → ${m.user?.reference ?? '(sin user)'}`);
    }

    // 4) Las solicitudes de contraseña de cada usuario: el link vive acá.
    for (const m of memberships) {
      const userId = m.user?.reference?.split('/')[1];
      if (!userId) {
        continue;
      }
      console.log(`\n[3/4] Solicitudes de contraseña de User/${userId}:`);
      const bundle = (await medplum
        .get(`fhir/R4/UserSecurityRequest?user=User/${userId}&_sort=-_lastUpdated&_count=5`)
        .catch((err) => {
          console.log(`  ✗ No pude leerlas: ${(err as Error).message}`);
          return undefined;
        })) as Bundle<UserSecurityRequest> | undefined;
      const solicitudes = bundle?.entry?.map((e) => e.resource).filter(Boolean) as UserSecurityRequest[] | undefined;

      if (!solicitudes || solicitudes.length === 0) {
        console.log('  ✗ NINGUNA. Es la causa del "no pude generar el link de activación".');
        console.log('    Lo más probable: el User quedó FUERA del proyecto (server-scoped), y entonces');
        console.log('    `auth/resetpassword` no lo encuentra (y responde OK igual, sin crear nada).');
        console.log('    Salida: borrar ese User viejo en Medplum (admin) y volver a invitar.');
        continue;
      }
      for (const s of solicitudes) {
        const usable = Boolean(s.secret) && !s.used;
        console.log(
          `  ${usable ? '✓' : '·'} ${s.id} · tipo=${s.type ?? '?'} · ${s.used ? 'YA USADA' : 'sin usar'}` +
            `${s.secret ? '' : ' · SIN SECRET (no legible)'} · ${s.meta?.lastUpdated?.slice(0, 16).replace('T', ' ') ?? ''}`,
        );
      }
      const vigente = solicitudes.find((s) => s.secret && !s.used);
      console.log('\n[4/4] Veredicto:');
      if (vigente) {
        const base = (process.env.PORTAL_BASE_URL ?? 'https://app.biowellness.ar').replace(/\/+$/, '');
        console.log('  ✓ Hay una solicitud vigente: el bot PUEDE generar el link.');
        console.log(`    ${base}/setpassword/${vigente.id}/${vigente.secret}`);
        console.log('    (Sensible: entregalo por el canal del paciente, no lo pegues en otro lado.)');
      } else if (solicitudes.some((s) => s.used)) {
        console.log('  ⚠️  Todas las solicitudes están USADAS: este paciente YA activó su cuenta.');
        console.log('     No necesita link de activación sino recuperar la contraseña. Hoy eso depende');
        console.log('     de "¿Olvidaste tu contraseña?" del portal (roto: ver docs/handoff-portal-reset-password.md),');
        console.log('     o de reinvitar — que ahora reintenta generar una solicitud nueva.');
      } else {
        console.log('  ✗ Hay solicitudes pero ninguna usable (sin secret legible).');
      }
    }
  }
}

main().catch((err) => {
  console.error('portal:check falló:', err);
  process.exitCode = 1;
});
