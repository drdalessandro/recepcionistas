import { Box, Group, Text, Tooltip } from '@mantine/core';
import { RECURSOS } from '@bw/config/recursos';
import type { MapaSemana as DatosMapa, DiaMapa } from '@bw/lib/mapa-semana';

/**
 * Mapa de ocupación de la semana: 7 filas (días) × horas del centro.
 *
 * Cada celda dice cuántas SALAS están ocupadas en esa hora — no cuántos turnos:
 * la pregunta que contesta es "¿dónde hay lugar?", y para eso una Multiplaza
 * con 4 personas sigue siendo una sala. El detalle vive en la grilla del día:
 * click en una celda → `onDia` con esa fecha.
 */
const TOTAL_SALAS = RECURSOS.length;

const FMT_DIA = new Intl.DateTimeFormat('es-AR', { weekday: 'short', day: 'numeric' });

function fechaDe(dia: DiaMapa): Date {
  const [y, m, d] = dia.fecha.split('-').map(Number);
  return new Date(y as number, (m as number) - 1, d as number);
}

/**
 * Fondo de la celda según cuántas salas están tomadas. El piso arranca en 18%
 * para que "1 sala" ya se distinga de vacío, y satura antes del total: con 11
 * de 14 el centro ESTÁ lleno a fines prácticos (las salas restantes no sirven
 * para cualquier servicio).
 */
function tono(salas: number): string {
  if (salas === 0) {
    return 'transparent';
  }
  const f = Math.min(1, salas / (TOTAL_SALAS - 3));
  return `color-mix(in srgb, var(--mantine-color-bio-6) ${Math.round(18 + f * 82)}%, transparent)`;
}

export function MapaSemana({
  data,
  hoyISO,
  onDia,
}: {
  data: DatosMapa;
  /** "YYYY-MM-DD" de hoy, para resaltar la fila. */
  hoyISO: string;
  /** Click en una celda abierta: ir a la grilla de ese día. */
  onDia: (fecha: string) => void;
}): JSX.Element {
  return (
    <Box style={{ overflowX: 'auto' }}>
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: `92px repeat(${data.horas.length}, minmax(34px, 1fr))`,
          gap: 3,
          minWidth: 640,
        }}
      >
        {/* Encabezado de horas */}
        <Box />
        {data.horas.map((h) => (
          <Text key={h} size="xs" c="dimmed" ta="center" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {String(h).padStart(2, '0')}
          </Text>
        ))}

        {data.dias.map((dia) => {
          const esHoy = dia.fecha === hoyISO;
          return (
            // Un fragment por fila: la grilla es plana, las celdas se ubican solas.
            <Box key={dia.fecha} style={{ display: 'contents' }}>
              <Text
                size="sm"
                fw={esHoy ? 700 : 500}
                c={esHoy ? 'bio' : undefined}
                ta="right"
                pr={8}
                tt="capitalize"
                style={{ alignSelf: 'center', whiteSpace: 'nowrap' }}
              >
                {FMT_DIA.format(fechaDe(dia)).replace(/\./g, '')}
              </Text>

              {dia.celdas.map((c) =>
                c.salas === null ? (
                  <Box
                    key={c.hora}
                    h={34}
                    style={{
                      borderRadius: 5,
                      opacity: 0.45,
                      background:
                        'repeating-linear-gradient(135deg, transparent 0 4px, var(--mantine-color-default-border) 4px 5px)',
                    }}
                  />
                ) : (
                  <Tooltip
                    key={c.hora}
                    label={`${FMT_DIA.format(fechaDe(dia))} ${String(c.hora).padStart(2, '0')}:00 · ${c.salas} de ${TOTAL_SALAS} salas ocupadas`}
                    withArrow
                  >
                    <Box
                      component="button"
                      aria-label={`Abrir ${dia.fecha} a las ${c.hora}:00`}
                      onClick={() => onDia(dia.fecha)}
                      h={34}
                      style={{
                        border: esHoy
                          ? '1px solid var(--mantine-color-bio-4)'
                          : '1px solid var(--mantine-color-default-border)',
                        borderRadius: 5,
                        background: tono(c.salas),
                        color: c.salas / TOTAL_SALAS > 0.4 ? 'white' : 'var(--mantine-color-dimmed)',
                        fontSize: 11,
                        fontWeight: 600,
                        fontVariantNumeric: 'tabular-nums',
                        cursor: 'pointer',
                        padding: 0,
                        width: '100%',
                      }}
                    >
                      {c.salas > 0 ? c.salas : ''}
                    </Box>
                  </Tooltip>
                ),
              )}
            </Box>
          );
        })}
      </Box>

      {/* Escala + referencia */}
      <Group gap={8} mt="md" wrap="wrap">
        <Text size="xs" c="dimmed">
          Vacío
        </Text>
        <Group gap={2}>
          {[0, 2, 4, 6, 9, 11].map((n) => (
            <Box key={n} w={26} h={12} style={{ borderRadius: 3, border: '1px solid var(--mantine-color-default-border)', background: tono(n) }} />
          ))}
        </Group>
        <Text size="xs" c="dimmed">
          Lleno · salas ocupadas de {TOTAL_SALAS} · tocá una celda para abrir ese día
        </Text>
      </Group>
    </Box>
  );
}
