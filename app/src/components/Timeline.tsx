import { Box, Group, Text, Tooltip } from '@mantine/core';
import type { TimelineData, TurnoTimeline } from '../lib/timeline';
import { colorEstado, labelEstado } from '../lib/estados';

/**
 * Grilla del día ajustada a la pantalla: TODAS las salas y TODO el horario entran
 * sin scroll. Las columnas (franjas de 30') se reparten el ancho en % y las filas
 * (salas) se reparten el alto disponible del viewport.
 */
const NAME_W = 170; // columna de nombres de sala
const HEADER_H = 22;
/** Alto disponible: viewport menos header de la app + título de la página. */
const ALTO_GRILLA = 'calc(100vh - 215px)';

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

interface TurnoPosicionado extends TurnoTimeline {
  /** Offset de asiento dentro de la sala (0 = arriba). */
  asiento: number;
  /** Asientos que ocupa esta reserva (multiplaza: ocupantes; exclusiva: todos). */
  peso: number;
}

/** Asientos que pesa un turno contra la capacidad de la sala. */
function pesoTurno(t: TurnoTimeline, capacidad: number, exclusiva: boolean): number {
  if (exclusiva || capacidad <= 1) {
    return Math.max(1, capacidad);
  }
  return Math.max(1, Math.min(t.ocupantes, capacidad));
}

/**
 * Asigna a cada turno una banda vertical proporcional a las personas que trae
 * (multiplaza: 2 personas = 2/6 del alto de la fila). Los turnos que solapan en
 * el tiempo se apilan en asientos distintos, así ninguno tapa a otro.
 */
function posicionarTurnos(turnos: TurnoTimeline[], capacidad: number, exclusiva: boolean): TurnoPosicionado[] {
  const cap = Math.max(1, capacidad);
  const orden = [...turnos].sort((a, b) => a.inicioMin - b.inicioMin || a.finMin - b.finMin);
  const out: TurnoPosicionado[] = [];
  for (const t of orden) {
    const peso = pesoTurno(t, cap, exclusiva);
    const solapados = out
      .filter((o) => o.inicioMin < t.finMin && t.inicioMin < o.finMin)
      .sort((a, b) => a.asiento - b.asiento);
    let asiento = 0;
    for (const o of solapados) {
      if (asiento + peso <= o.asiento) {
        break;
      }
      asiento = Math.max(asiento, o.asiento + o.peso);
    }
    if (asiento + peso > cap) {
      asiento = Math.max(0, cap - peso); // sobrecupo legado: se superpone al final en vez de desaparecer
    }
    out.push({ ...t, asiento, peso });
  }
  return out;
}

/** Personas ocupando la sala en el minuto `m` (para saber si la franja admite más). */
function ocupacionEn(turnos: TurnoPosicionado[], m: number): number {
  return turnos.filter((t) => m >= t.inicioMin && m < t.finMin).reduce((acc, t) => acc + t.peso, 0);
}

export function Timeline({
  data,
  onReservar,
  onTurno,
}: {
  data: TimelineData;
  onReservar?: (recursoCodigo: string, horaMin: number) => void;
  onTurno?: (turno: TurnoTimeline) => void;
}): JSX.Element {
  if (!data.abierto) {
    return (
      <Text c="dimmed" mt="md">
        El centro está cerrado hoy.
      </Text>
    );
  }

  const totalMin = data.cierreMin - data.aperturaMin;
  const cols: number[] = [];
  for (let m = data.aperturaMin; m < data.cierreMin; m += 30) {
    cols.push(m);
  }
  /** Posición/ancho horizontal en % del track. */
  const pct = (min: number): string => `${(((min - data.aperturaMin) / totalMin) * 100).toFixed(4)}%`;
  const anchoPct = (desdeMin: number, hastaMin: number): string =>
    `${(((hastaMin - desdeMin) / totalMin) * 100).toFixed(4)}%`;

  const turnosPorSala = new Map<string, TurnoPosicionado[]>();
  for (const sala of data.salas) {
    turnosPorSala.set(
      sala.codigo,
      posicionarTurnos(
        data.turnos.filter((t) => t.recursoCodigo === sala.codigo),
        sala.capacidad,
        sala.reservaExclusiva,
      ),
    );
  }

  // Grilla vertical en dos pesos. Las horas en punto son el eje que se lee y sobre
  // el que se edita ("¿qué hay libre a las 14:00?"), así que van gruesas; las medias
  // horas quedan de apoyo. Se dibujan desde `cols` y no con un patrón repetido para
  // que caigan en la hora exacta aunque el centro abra y cierre a la media.
  const BORDE = 'var(--mantine-color-default-border)';
  const BORDE_TENUE = `color-mix(in srgb, ${BORDE} 45%, transparent)`;
  const horas = cols.filter((m) => m % 60 === 0);
  const lineasHora = horas.length
    ? `linear-gradient(to right, ${horas
        .map(
          (m) =>
            `transparent ${pct(m)}, ${BORDE} ${pct(m)}, ${BORDE} calc(${pct(m)} + 2px), transparent calc(${pct(m)} + 2px)`,
        )
        .join(', ')})`
    : 'none';
  const lineasMedia = `repeating-linear-gradient(to right, ${BORDE_TENUE} 0 1px, transparent 1px calc(100% / ${cols.length}))`;
  // El orden importa: la capa de horas se pinta encima de la de medias.
  const lineas = `${lineasHora}, ${lineasMedia}`;
  const ahoraVisible = data.ahoraMin >= data.aperturaMin && data.ahoraMin <= data.cierreMin;

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', height: ALTO_GRILLA, minHeight: 380 }}>
      <style>{`
        .bw-slot:hover{background:var(--mantine-color-bio-light);}
        /* Sin rayas horizontales, la fila se sigue con el mouse: al pasar por
           cualquier punto se tiñe entera y se ve de qué sala es ese hueco. */
        .bw-fila:hover .bw-track{background-color:var(--mantine-color-default-hover);}
      `}</style>

      {/* Encabezado de horas */}
      <Group gap={0} wrap="nowrap" style={{ flexShrink: 0 }}>
        <Box w={NAME_W} style={{ flexShrink: 0 }} />
        <Box style={{ position: 'relative', flex: 1, height: HEADER_H }}>
          {cols.map((m, i) =>
            m % 60 === 0 ? (
              <Text key={i} size="xs" c="dimmed" style={{ position: 'absolute', left: pct(m), top: 2 }}>
                {fmt(m)}
              </Text>
            ) : null,
          )}
        </Box>
      </Group>

      {/* Filas de salas: se reparten el alto disponible */}
      {data.salas.map((sala) => (
        <Group key={sala.codigo} className="bw-fila" gap={0} wrap="nowrap" align="stretch" style={{ flex: 1, minHeight: 0 }}>
          {/* El separador de filas vive SOLO en la columna de nombres: sobre la
              grilla taparía las verticales, que son las que hay que seguir. */}
          <Box
            w={NAME_W}
            px="xs"
            style={{
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              minHeight: 0,
              borderTop: `1px solid ${BORDE}`,
            }}
          >
            <Text fz={12} fw={500} lineClamp={2} lh={1.15}>
              {sala.nombre}
            </Text>
            {sala.comparteEquipo && (
              <Text fz={10} c="grape" lh={1.1}>
                comparte equipo
              </Text>
            )}
          </Box>

          <Box className="bw-track" style={{ position: 'relative', flex: 1, minHeight: 0, backgroundImage: lineas }}>
            {/* Franjas clickeables para reservar: libres, o con aforo restante (multiplaza) */}
            {onReservar &&
              cols.map((m, i) => {
                const cap = Math.max(1, sala.capacidad);
                const usadas = ocupacionEn(turnosPorSala.get(sala.codigo) ?? [], m);
                if (usadas >= cap) {
                  return null; // franja completa
                }
                const aforo = cap > 1 && !sala.reservaExclusiva && usadas > 0 ? ` (${usadas}/${cap} ocupadas)` : '';
                return (
                  <Box
                    key={`slot-${i}`}
                    className="bw-slot"
                    title={`Reservar ${fmt(m)} · ${sala.nombre}${aforo}`}
                    onClick={() => onReservar(sala.codigo, m)}
                    style={{
                      position: 'absolute',
                      left: pct(m),
                      top: 0,
                      width: `${(100 / cols.length).toFixed(4)}%`,
                      height: '100%',
                      cursor: 'pointer',
                    }}
                  />
                );
              })}

            {(turnosPorSala.get(sala.codigo) ?? []).map((t, i) => {
              const cap = Math.max(1, sala.capacidad);
              const compacto = t.peso / cap < 0.5; // banda angosta (multiplaza): una sola línea de texto
              const pers = t.ocupantes > 1 ? ` · ${t.ocupantes} pers.` : '';
              // Los asientos de una sala compartida (Multiplaza) se apilan PEGADOS:
              // así 3 de 6 se leen como una columna llena hasta la mitad y no como
              // tres rayitas sueltas. El aire de 1px y las esquinas redondeadas van
              // solo en los extremos de la pila; entre personas va una hairline.
              const primero = t.asiento === 0;
              const ultimo = t.asiento + t.peso >= cap;
              const r = (esExtremo: boolean): string => (esExtremo ? '5px' : '0px');
              return (
                <Tooltip
                  key={i}
                  label={`${t.paciente || 'Paciente'} · ${t.servicio}${pers} · ${fmt(t.inicioMin)}–${fmt(t.finMin)} · ${labelEstado(t.estado)}`}
                  withArrow
                >
                  <Box
                    onClick={() => onTurno?.(t)}
                    style={{
                      position: 'absolute',
                      left: `calc(${pct(t.inicioMin)} + 1px)`,
                      width: `calc(${anchoPct(t.inicioMin, Math.max(t.finMin, t.inicioMin + 30))} - 2px)`,
                      top: `calc(${((t.asiento / cap) * 100).toFixed(2)}% + ${primero ? 1 : 0}px)`,
                      height: `calc(${((t.peso / cap) * 100).toFixed(2)}% - ${(primero ? 1 : 0) + (ultimo ? 1 : 0)}px)`,
                      background: `var(--mantine-color-${colorEstado(t.estado)}-6)`,
                      color: 'white',
                      borderRadius: `${r(primero)} ${r(primero)} ${r(ultimo)} ${r(ultimo)}`,
                      // Separa a una persona de la de arriba sin abrir un hueco.
                      boxShadow: primero ? undefined : 'inset 0 1px 0 rgba(255,255,255,0.45)',
                      padding: '1px 5px',
                      overflow: 'hidden',
                      cursor: onTurno ? 'pointer' : 'default',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                    }}
                  >
                    <Text fz={11} c="white" fw={700} lineClamp={1} lh={1.2}>
                      {compacto ? `${t.paciente || t.servicio}${pers}` : t.servicio}
                    </Text>
                    {!compacto && (
                      <Text fz={10} c="white" lineClamp={1} lh={1.2}>
                        {(t.paciente || `${fmt(t.inicioMin)}–${fmt(t.finMin)}`) + pers}
                      </Text>
                    )}
                  </Box>
                </Tooltip>
              );
            })}

            {ahoraVisible && (
              <Box
                style={{
                  position: 'absolute',
                  left: pct(data.ahoraMin),
                  top: 0,
                  bottom: 0,
                  // Un punto más gruesa que las horas: sigue siendo la vertical
                  // más fuerte de la grilla ahora que las horas pesan 2px.
                  width: 3,
                  background: 'var(--mantine-color-blue-6)',
                }}
              />
            )}
          </Box>
        </Group>
      ))}
    </Box>
  );
}
