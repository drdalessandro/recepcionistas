/**
 * Recursos físicos del centro, con sus tiempos.
 *
 * ⚠️ ESTADO DE RATIFICACIÓN
 * Los tiempos marcados con `noRatificado` son estimaciones y **no** valores
 * acordados. El motor los usa, pero los arrastra como advertencia hasta el plan
 * de reserva, para que nadie los confunda con un número cerrado. El caso más
 * sensible es el turnaround del puesto IHHT: depende del protocolo de higiene de
 * máscara y clip de dedo, que todavía no existe como documento escrito.
 *
 * Invariante que el validador exige a todo recurso agendable:
 *     setup + terapia + turnaround <= slot
 * Un recurso que no cierra no produce un atraso puntual: produce atraso
 * acumulativo a lo largo del día.
 */

import type { Recurso, UnidadRecurso } from '../dominio/tipos.js';

/** Cantidades de unidades. Parámetro, no constante enterrada en el código. */
export interface CantidadesRecursos {
  readonly hbotMonoplaza: number;
  readonly hbotBiplaza: number;
  readonly hbotMultiplaza: number;
  readonly puestosIhht: number;
  readonly gabinetesRecoveryPro: number;
  /** Tumbonas dentro de la sala Recovery Pro. */
  readonly tumbonasEnSala: number;
  /** Tumbonas en el área común. */
  readonly tumbonasStandalone: number;
  readonly compresion: number;
  readonly crioterapia: number;
  readonly camillasMasajes: number;
  readonly consultorios: number;
  readonly salasTb: number;
  /** Ampliable a 4 sin tocar código. */
  readonly puestosIv: number;
}

export const CANTIDADES_SAN_ISIDRO: CantidadesRecursos = {
  hbotMonoplaza: 1,
  hbotBiplaza: 1,
  hbotMultiplaza: 1,
  puestosIhht: 2,
  gabinetesRecoveryPro: 2,
  tumbonasEnSala: 2,
  tumbonasStandalone: 1,
  compresion: 1,
  crioterapia: 1,
  camillasMasajes: 1,
  consultorios: 1,
  salasTb: 1,
  puestosIv: 2,
};

function unidades(
  prefijo: string,
  cantidad: number,
  base: Omit<UnidadRecurso, 'id' | 'nombre'> & { readonly nombreBase: string },
): UnidadRecurso[] {
  const { nombreBase, ...resto } = base;
  return Array.from({ length: cantidad }, (_, i) => ({
    ...resto,
    id: cantidad === 1 ? prefijo : `${prefijo}-${i + 1}`,
    nombre: cantidad === 1 ? nombreBase : `${nombreBase} ${i + 1}`,
  }));
}

export function construirRecursos(cantidades: CantidadesRecursos): Recurso[] {
  return [
    // ── Cámaras hiperbáricas ────────────────────────────────────────────────
    // Las tres comparten tiempos. El ancla de salida es el único invariante que
    // el motor modela del protocolo: el cliente sale del recinto en el minuto 55
    // del slot. Los tres tramos (presurización, isopresión, descenso) y la ATA
    // se registran como datos clínicos de la sesión ejecutada, no como
    // parámetros de agenda: el operador reparte esos minutos según el cliente.
    // Nota clínica: el descenso ya se hace respirando aire, no oxígeno, así que
    // no hace falta ningún intervalo de lavado entre HBOT e IHHT.
    {
      tipo: 'hbot-monoplaza',
      nombre: 'HBOT Monoplaza',
      tiempos: {
        slotMin: 60,
        setupMin: 3,
        terapiaMin: 50,
        turnaroundMin: 5,
        anclaSalidaMin: 55,
        grillaInicioMin: 60,
      },
      unidades: unidades('HBOT-MONO', cantidades.hbotMonoplaza, {
        tipo: 'hbot-monoplaza',
        nombreBase: 'Cámara Monoplaza',
        capacidad: 1,
        compartible: false,
        planta: 'baja',
        equipo: 'Cámara hiperbárica monoplaza',
      }),
    },
    {
      tipo: 'hbot-biplaza',
      nombre: 'HBOT Biplaza',
      tiempos: {
        slotMin: 60,
        setupMin: 3,
        terapiaMin: 50,
        turnaroundMin: 5,
        anclaSalidaMin: 55,
        grillaInicioMin: 60,
      },
      unidades: unidades('HBOT-BI', cantidades.hbotBiplaza, {
        tipo: 'hbot-biplaza',
        nombreBase: 'Cámara Biplaza',
        capacidad: 2,
        // R-04 le cobra el precio de monoplaza al que va solo: está pagando la
        // cámara entera. No se le suma un desconocido.
        compartible: false,
        planta: 'baja',
        equipo: 'Cámara hiperbárica biplaza',
      }),
    },
    {
      tipo: 'hbot-multiplaza',
      nombre: 'HBOT Multiplaza',
      tiempos: {
        slotMin: 60,
        setupMin: 3,
        terapiaMin: 50,
        turnaroundMin: 5,
        anclaSalidaMin: 55,
        grillaInicioMin: 60,
      },
      unidades: unidades('HBOT-MULTI', cantidades.hbotMultiplaza, {
        tipo: 'hbot-multiplaza',
        nombreBase: 'Cámara Multiplaza',
        capacidad: 6,
        // R-06: no hay corte de incorporación. Un cliente puede sumarse a una
        // sesión ya reservada hasta el inicio, sin piso de sesión.
        compartible: true,
        planta: 'baja',
        equipo: 'Cámara hiperbárica multiplaza',
      }),
    },

    // ── IHHT ────────────────────────────────────────────────────────────────
    {
      tipo: 'ihht',
      nombre: 'Puesto IHHT',
      tiempos: {
        slotMin: 30,
        setupMin: 3,
        terapiaMin: 22,
        turnaroundMin: 5,
        grillaInicioMin: 30,
        noRatificado: {
          setupMin: '[PROPUESTA] Estimación, sin medición formal.',
          terapiaMin: '[PROPUESTA] Estimación, sin medición formal.',
          turnaroundMin:
            'BLOQUEANTE — El turnaround depende del protocolo de higiene de máscara ' +
            'y clip de dedo entre cliente y cliente, y ese protocolo TODAVÍA NO EXISTE ' +
            'como documento escrito. Los 5 minutos son una estimación. Si el protocolo ' +
            'real pide más, el slot de 30 deja de cerrar y hay que rehacer la grilla.',
        },
      },
      unidades: unidades('IHHT', cantidades.puestosIhht, {
        tipo: 'ihht',
        nombreBase: 'Puesto IHHT',
        capacidad: 1,
        compartible: false,
        planta: 'baja',
        equipo: 'JAY-20H',
      }),
    },

    // ── Recovery Pro ────────────────────────────────────────────────────────
    // La secuencia interna es protocolo, no sugerencia: es lo que hace posible
    // el desfasaje de 30 minutos entre gabinetes (R-07). La tumbona se libera en
    // el minuto 48, mientras el cliente todavía se está duchando. Si la ducha se
    // hiciera antes de la luz roja, el desfasaje dejaría de cerrar.
    {
      tipo: 'recovery-pro',
      nombre: 'Gabinete Recovery Pro',
      tiempos: {
        slotMin: 60,
        setupMin: 2,
        terapiaMin: 46,
        turnaroundMin: 12,
        // Sin ancla explícita: se deriva de las etapas (el cliente sale a los 56).
        grillaInicioMin: 30,
        etapas: [
          { nombre: 'Sauna', desdeMin: 0, hastaMin: 12, ocupa: 'propio', clientePresente: true },
          { nombre: 'Cold plunge', desdeMin: 12, hastaMin: 15, ocupa: 'propio', clientePresente: true },
          { nombre: 'Sauna', desdeMin: 15, hastaMin: 25, ocupa: 'propio', clientePresente: true },
          { nombre: 'Cold plunge', desdeMin: 25, hastaMin: 28, ocupa: 'propio', clientePresente: true },
          {
            nombre: 'Red Light',
            desdeMin: 28,
            hastaMin: 48,
            ocupa: { pool: 'tumbona-red-light' },
            clientePresente: true,
          },
          { nombre: 'Ducha y vestuario', desdeMin: 48, hastaMin: 56, ocupa: 'propio', clientePresente: true },
          { nombre: 'Salida', desdeMin: 56, hastaMin: 60, ocupa: 'propio', clientePresente: false },
        ],
      },
      unidades: unidades('RP-GAB', cantidades.gabinetesRecoveryPro, {
        tipo: 'recovery-pro',
        nombreBase: 'Gabinete Recovery Pro',
        capacidad: 2,
        // Es un gabinete privado: las dos plazas son de la misma reserva.
        compartible: false,
        planta: 'alta',
      }),
    },

    // ── Pool de tumbonas Red Light ──────────────────────────────────────────
    // No son recursos con dueño fijo: el motor las asigna por disponibilidad.
    // La direccionalidad la da `ubicacion` y la resuelve `pool-tumbonas.ts`.
    {
      tipo: 'tumbona-red-light',
      nombre: 'Tumbona Red Light',
      tiempos: {
        slotMin: 30,
        setupMin: 3,
        terapiaMin: 20,
        turnaroundMin: 7,
        grillaInicioMin: 30,
        noRatificado: {
          setupMin: '[PROPUESTA] Estimación, sin medición formal.',
          terapiaMin: '[PROPUESTA] Estimación, sin medición formal.',
          turnaroundMin: '[PROPUESTA] Estimación, sin medición formal.',
        },
      },
      unidades: [
        ...unidades('RL-SALA', cantidades.tumbonasEnSala, {
          tipo: 'tumbona-red-light',
          nombreBase: 'Tumbona Red Light (sala Recovery Pro)',
          capacidad: 1,
          compartible: false,
          planta: 'alta',
          ubicacion: 'sala-recovery',
        }),
        ...unidades('RL-STANDALONE', cantidades.tumbonasStandalone, {
          tipo: 'tumbona-red-light',
          nombreBase: 'Tumbona Red Light (área común)',
          capacidad: 1,
          compartible: false,
          planta: 'alta',
          ubicacion: 'standalone',
        }),
      ],
    },

    // ── Compresión y frío ───────────────────────────────────────────────────
    {
      tipo: 'compresion',
      nombre: 'Compresión neumática IPC06',
      tiempos: {
        slotMin: 30,
        setupMin: 2,
        terapiaMin: 25,
        turnaroundMin: 3,
        grillaInicioMin: 30,
        noRatificado: {
          setupMin: '[PROPUESTA] Estimación, sin medición formal.',
          terapiaMin: '[PROPUESTA] Estimación, sin medición formal.',
          turnaroundMin: '[PROPUESTA] Estimación, sin medición formal.',
        },
      },
      unidades: unidades('IPC06', cantidades.compresion, {
        tipo: 'compresion',
        nombreBase: 'Compresión neumática',
        capacidad: 1,
        compartible: false,
        planta: 'sin-asignar',
        equipo: 'IPC06',
      }),
    },
    {
      tipo: 'crioterapia',
      nombre: 'Crioterapia COT03',
      tiempos: {
        slotMin: 30,
        setupMin: 2,
        terapiaMin: 25,
        turnaroundMin: 3,
        grillaInicioMin: 30,
        noRatificado: {
          setupMin: '[PROPUESTA] Estimación, sin medición formal.',
          terapiaMin: '[PROPUESTA] Estimación, sin medición formal.',
          turnaroundMin: '[PROPUESTA] Estimación, sin medición formal.',
        },
      },
      unidades: unidades('COT03', cantidades.crioterapia, {
        tipo: 'crioterapia',
        nombreBase: 'Crioterapia',
        capacidad: 1,
        compartible: false,
        planta: 'sin-asignar',
        equipo: 'COT03',
      }),
    },

    // ── Recursos sin tiempos medidos ────────────────────────────────────────
    // No tienen slot en la tabla operativa. Inventarles uno sería peor que no
    // tenerlo: el validador los reporta al arrancar y agendarlos devuelve
    // RECURSO_SIN_TIEMPOS. No hay default silencioso.
    {
      tipo: 'camilla-masajes',
      nombre: 'Camilla de masajes',
      sinTiempos: 'La tabla operativa no define slot, setup, terapia ni turnaround.',
      unidades: unidades('CAMILLA', cantidades.camillasMasajes, {
        tipo: 'camilla-masajes',
        nombreBase: 'Camilla de masajes',
        capacidad: 1,
        compartible: false,
        planta: 'sin-asignar',
      }),
    },
    {
      tipo: 'consultorio',
      nombre: 'Consultorio médico',
      sinTiempos:
        'La duración de una consulta la fija el médico, no el equipamiento. Falta definir el slot.',
      unidades: unidades('CONSULTORIO', cantidades.consultorios, {
        tipo: 'consultorio',
        nombreBase: 'Consultorio médico',
        capacidad: 1,
        compartible: false,
        planta: 'sin-asignar',
      }),
    },
    {
      tipo: 'sala-tb',
      nombre: 'Sala de Terapias Biológicas',
      sinTiempos:
        'Cada terapia biológica tiene su propia duración de preparación y aplicación. Falta la tabla.',
      unidades: unidades('SALA-TB', cantidades.salasTb, {
        tipo: 'sala-tb',
        nombreBase: 'Sala TB',
        capacidad: 1,
        compartible: false,
        planta: 'alta',
      }),
    },
    {
      tipo: 'puesto-iv',
      nombre: 'Puesto IV',
      sinTiempos:
        'La duración depende del protocolo de infusión (hidratación, performance, NAD+). Falta la tabla.',
      unidades: unidades('IV', cantidades.puestosIv, {
        tipo: 'puesto-iv',
        nombreBase: 'Puesto IV',
        capacidad: 1,
        compartible: false,
        planta: 'sin-asignar',
      }),
    },
  ];
}
