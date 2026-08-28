/**
 * Bot · Preferencia semanal de la membresía (R-21).
 *
 * Guarda (o apaga) la preferencia del socio: días con nombre + hora, y el
 * interruptor de la asignación automática (`bw-agenda-semanal`). Pasa por bot
 * porque para el mostrador el `Coverage` es de solo lectura (mínimo privilegio);
 * la lógica de validación vive en `src/lib/semana-membresia.ts`.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Coverage } from '@medplum/fhirtypes';
import { HORARIO_SEMANAL } from '../config/horario.js';
import { getMembresia } from '../config/membresias.js';
import { EXT } from '../fhir/identifiers.js';
import { esPlanBW, estadoDeCoverage, planCodigoDeCoverage } from '../fhir/coverage.js';
import { parsePreferencia, serializarDias, type PreferenciaSemanal } from '../lib/semana-membresia.js';

export interface EntradaPreferenciaSemanal {
  coverageId: string;
  /**
   * Desde el PORTAL viene siempre: el bot verifica que la membresía sea de este
   * paciente antes de escribir (misma defensa que `bw-cancelar-turno`). El
   * mostrador no lo manda: Recepción edita cualquier plan.
   */
  pacienteRef?: string;
  /** Días de la semana elegidos (0=domingo … 6=sábado). */
  dias?: number[];
  /** Hora "HH:mm" (Argentina), la misma para todos los días. */
  hora?: string;
  /** Asignación automática semanal encendida/apagada. */
  activa: boolean;
}

export interface ResultadoPreferenciaSemanal {
  ok: boolean;
  mensaje?: string;
  /** Aviso no bloqueante (p. ej. menos días elegidos que la frecuencia del plan). */
  aviso?: string;
  preferencia?: PreferenciaSemanal;
  activa?: boolean;
}

const LABEL_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EntradaPreferenciaSemanal>,
): Promise<ResultadoPreferenciaSemanal> {
  const e = event.input;
  try {
    const coverage = await medplum.readResource('Coverage', e.coverageId).catch(() => undefined);
    // Mismo mensaje para "no existe" y "no es tuya": responder distinto le
    // confirmaría a cualquiera si un id de Coverage existe o no.
    if (!coverage || (e.pacienteRef && coverage.beneficiary?.reference !== e.pacienteRef)) {
      return { ok: false, mensaje: 'No encontramos esa membresía en tu cuenta.' };
    }
    if (!esPlanBW(coverage) || estadoDeCoverage(coverage).tipo !== 'membresia') {
      return { ok: false, mensaje: 'La agenda semanal es de las membresías (este plan no lo es).' };
    }
    const planCodigo = planCodigoDeCoverage(coverage);
    const frecuencia = planCodigo ? getMembresia(planCodigo).frecuenciaSemanal : undefined;

    // La preferencia se guarda aunque `activa` sea false (pausar ≠ perderla);
    // solo es obligatoria para prender la asignación automática.
    const pref: PreferenciaSemanal | undefined = parsePreferencia(serializarDias(e.dias ?? []), e.hora);
    let aviso: string | undefined;
    if (e.activa && !pref) {
      return { ok: false, mensaje: 'Elegí al menos un día de la semana y una hora válida (HH:mm).' };
    }
    if (pref) {
      const cerrados = pref.dias.filter((d) => !(HORARIO_SEMANAL.find((h) => h.dia === d)?.abierto ?? false));
      if (cerrados.length > 0) {
        return {
          ok: false,
          mensaje: `El centro no abre los ${cerrados.map((d) => LABEL_DIA[d]).join(' ni los ')}.`,
        };
      }
      if (e.activa && frecuencia !== undefined && pref.dias.length !== frecuencia) {
        aviso =
          pref.dias.length < frecuencia
            ? `El plan incluye ${frecuencia} sesiones por semana y elegiste ${pref.dias.length} día(s): quedarán sesiones sin asignar cada semana.`
            : `El plan incluye ${frecuencia} sesiones por semana: de los ${pref.dias.length} días elegidos se asignan a lo sumo ${frecuencia} (R-21).`;
      }
    }

    // Reescribir las tres extensiones de la agenda semanal (las demás quedan).
    const extension = (coverage.extension ?? []).filter(
      (x) => x.url !== EXT.preferenciaDias && x.url !== EXT.preferenciaHora && x.url !== EXT.agendaSemanalActiva,
    );
    if (pref) {
      extension.push({ url: EXT.preferenciaDias, valueString: serializarDias(pref.dias) });
      extension.push({ url: EXT.preferenciaHora, valueString: pref.hora });
    }
    extension.push({ url: EXT.agendaSemanalActiva, valueBoolean: e.activa && Boolean(pref) });
    await medplum.updateResource<Coverage>({ ...coverage, extension });

    return { ok: true, preferencia: pref, activa: e.activa && Boolean(pref), aviso };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : 'No se pudo guardar la preferencia.' };
  }
}
