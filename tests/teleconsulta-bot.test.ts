/**
 * Bot `bw-teleconsulta-token` — la cadena de rechazos.
 *
 * Los tests de `tests/teleconsulta.test.ts` cubren las reglas (ventana, claims,
 * roles). Acá se prueba lo que solo existe en el bot: **que cada motivo para
 * NO emitir token efectivamente no lo emita**, y que el que sale esté firmado
 * con la clave del servidor.
 *
 * Es la parte del sistema donde un `if` de más o de menos deja entrar a un
 * desconocido a una consulta médica, así que se prueban los rechazos uno por
 * uno y no solo el camino feliz.
 */
import { describe, expect, it } from 'vitest';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment } from '@medplum/fhirtypes';
import { createHmac } from 'node:crypto';
import { EXT } from '../src/fhir/identifiers.js';
import { handler, type EntradaToken } from '../src/bots/teleconsulta-token.js';

const SECRET = 'a'.repeat(64);
const SALA = 'tc-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const PACIENTE = 'Patient/p1';
const PROFESIONAL = 'Practitioner/d1';

/** Un turno virtual confirmado que está pasando ahora. */
function turno(over: Partial<Appointment> = {}): Appointment {
  const ahora = Date.now();
  return {
    resourceType: 'Appointment',
    id: 'a1',
    status: 'booked',
    description: 'Cardiología por videollamada',
    start: new Date(ahora).toISOString(),
    end: new Date(ahora + 60 * 60_000).toISOString(),
    participant: [
      { actor: { reference: PACIENTE }, status: 'accepted' },
      { actor: { reference: PROFESIONAL }, status: 'accepted' },
    ],
    extension: [{ url: EXT.teleconsultaSala, valueString: SALA }],
    ...over,
  };
}

/** Lo mínimo del cliente que el bot toca: leer el turno y leer un nombre. */
function clienteCon(appt: Appointment | undefined): MedplumClient {
  return {
    readResource: async (tipo: string, _id: string) => {
      if (tipo === 'Appointment') {
        if (!appt) {
          throw new Error('not found');
        }
        return appt;
      }
      return { resourceType: tipo, name: [{ text: 'Ana Pérez' }] };
    },
  } as unknown as MedplumClient;
}

function evento(input: EntradaToken, secretos = true): BotEvent<EntradaToken> {
  const secrets = secretos
    ? {
        JITSI_BASE_URL: { name: 'JITSI_BASE_URL', valueString: 'meet.biowellness.ar' },
        JITSI_APP_ID: { name: 'JITSI_APP_ID', valueString: 'biowellness-teleconsulta' },
        JITSI_JWT_SECRET: { name: 'JITSI_JWT_SECRET', valueString: SECRET },
      }
    : {};
  return { input, secrets } as unknown as BotEvent<EntradaToken>;
}

const pidePaciente: EntradaToken = { appointmentId: 'a1', rol: 'paciente', pacienteRef: PACIENTE };

describe('bw-teleconsulta-token · rechazos', () => {
  it('turno de otro paciente: mismo mensaje que si no existiera', async () => {
    const ajeno = await handler(clienteCon(turno()), evento({ ...pidePaciente, pacienteRef: 'Patient/otro' }));
    const inexistente = await handler(clienteCon(undefined), evento(pidePaciente));
    expect(ajeno.ok).toBe(false);
    expect(ajeno.jwt).toBeUndefined();
    // Contestar distinto le confirmaría a cualquiera si un id de turno existe.
    expect(ajeno.mensaje).toBe(inexistente.mensaje);
  });

  it('un turno presencial no abre ninguna sala', async () => {
    const r = await handler(clienteCon(turno({ extension: [] })), evento(pidePaciente));
    expect(r.ok).toBe(false);
    expect(r.jwt).toBeUndefined();
  });

  it('una tentativa impaga no entra a la consulta', async () => {
    const r = await handler(clienteCon(turno({ status: 'pending' })), evento(pidePaciente));
    expect(r.ok).toBe(false);
    expect(r.jwt).toBeUndefined();
  });

  it('fuera de la ventana no se emite, ni antes ni después', async () => {
    const enUnaHora = new Date(Date.now() + 60 * 60_000);
    const temprano = await handler(
      clienteCon(turno({ start: enUnaHora.toISOString(), end: new Date(enUnaHora.getTime() + 3_600_000).toISOString() })),
      evento(pidePaciente),
    );
    const ayer = new Date(Date.now() - 24 * 3_600_000);
    const tarde = await handler(
      clienteCon(turno({ start: ayer.toISOString(), end: new Date(ayer.getTime() + 3_600_000).toISOString() })),
      evento(pidePaciente),
    );
    expect(temprano.ok).toBe(false);
    expect(tarde.ok).toBe(false);
    expect(temprano.mensaje).not.toBe(tarde.mensaje);
  });

  it('sin los secrets de Jitsi falla CERRADO: no inventa un token', async () => {
    const r = await handler(clienteCon(turno()), evento(pidePaciente, false));
    expect(r.ok).toBe(false);
    expect(r.jwt).toBeUndefined();
  });
});

describe('bw-teleconsulta-token · el token que sale', () => {
  it('viene firmado con la clave del servidor', async () => {
    const r = await handler(clienteCon(turno()), evento(pidePaciente));
    expect(r.ok).toBe(true);
    const [cabecera, cuerpo, firma] = (r.jwt ?? '').split('.');
    expect(cabecera && cuerpo && firma).toBeTruthy();
    const esperada = createHmac('sha256', SECRET).update(`${cabecera}.${cuerpo}`).digest('base64url');
    expect(firma).toBe(esperada);
  });

  it('el paciente entra como member y el profesional como owner', async () => {
    const claims = async (input: EntradaToken): Promise<Record<string, any>> => {
      const r = await handler(clienteCon(turno()), evento(input));
      return JSON.parse(Buffer.from((r.jwt ?? '').split('.')[1] as string, 'base64url').toString());
    };
    const pac = await claims(pidePaciente);
    const prof = await claims({ appointmentId: 'a1', rol: 'profesional', practitionerRef: PROFESIONAL });
    expect(pac.context.user.affiliation).toBe('member');
    expect(prof.context.user.affiliation).toBe('owner');
  });

  it('queda acotado a la sala del turno y vence con la ventana', async () => {
    const r = await handler(clienteCon(turno()), evento(pidePaciente));
    const claims = JSON.parse(Buffer.from((r.jwt ?? '').split('.')[1] as string, 'base64url').toString());
    expect(claims.room).toBe(SALA);
    expect(claims.room).not.toBe('*');
    expect(r.venceISO).toBe(new Date(claims.exp * 1000).toISOString());
    expect(r.sala).toBe(SALA);
  });
});
