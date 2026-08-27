import { useCallback, useEffect, useState } from 'react';
import { ActionIcon, Alert, Box, Button, Center, Group, Loader, SegmentedControl, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconRefresh, IconInfoCircle, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { cargarTimeline, type TimelineData, type TurnoTimeline } from '../lib/timeline';
import { cargarMapaSemana } from '../lib/semana';
import { lunesDe, type MapaSemana as DatosMapa } from '@bw/lib/mapa-semana';
import { Timeline } from '../components/Timeline';
import { MapaSemana } from '../components/MapaSemana';
import { ProximosTurnos } from '../components/ProximosTurnos';
import { ReservaModal, type PresetReserva } from '../components/ReservaModal';
import { TurnoModal } from '../components/TurnoModal';
import { EsperandoLugar } from '../components/EsperandoLugar';
import { colorEstado, labelEstado } from '../lib/estados';

const REFRESCO_MS = 60_000;

/** Rango visible: la grilla de UN día, el mapa de la semana, o la lista de 7/14 días. */
type Rango = 'dia' | 'semana' | '7' | '14';

const FMT_LARGO = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
const FMT_CORTO = new Intl.DateTimeFormat('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
const FMT_SEMANA = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'short' });

/** Medianoche local: para comparar días sin que la hora meta ruido. */
function aMedianoche(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** "YYYY-MM-DD" del día LOCAL. Con `toISOString()` (UTC) el día se adelanta a las 21. */
function fechaLocalISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sumarDias(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function AgendaDelDia(): JSX.Element {
  const [rango, setRango] = useState<Rango>('dia');
  const [fecha, setFecha] = useState<Date>(() => aMedianoche(new Date()));
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [preset, setPreset] = useState<PresetReserva | null>(null);
  const [turnoSel, setTurnoSel] = useState<TurnoTimeline | null>(null);
  const [lunes, setLunes] = useState<Date>(() => lunesDe(new Date()));
  const [mapa, setMapa] = useState<DatosMapa | null>(null);
  const [errorMapa, setErrorMapa] = useState<string | null>(null);

  const hoyMin = aMedianoche(new Date()).getTime();
  const esHoy = fecha.getTime() === hoyMin;
  const esPasado = fecha.getTime() < hoyMin;
  const esSemanaActual = lunes.getTime() === lunesDe(new Date()).getTime();

  const refrescar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      setData(await cargarTimeline(fecha));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar la agenda.');
    } finally {
      setCargando(false);
    }
  }, [fecha]);

  useEffect(() => {
    if (rango !== 'dia') {
      return;
    }
    void refrescar();
    // El refresco automático es para la operación del día: otro día no se mueve
    // solo mientras lo mirás, y estar pegándole cada minuto no aporta nada.
    if (!esHoy) {
      return;
    }
    const id = setInterval(() => void refrescar(), REFRESCO_MS);
    return () => clearInterval(id);
  }, [refrescar, rango, esHoy]);

  /** Mueve la grilla `n` días. Sin topes: la agenda médica se publica con semanas. */
  const moverDias = (n: number): void => {
    setData(null);
    setFecha((f) => {
      const x = new Date(f);
      x.setDate(x.getDate() + n);
      return x;
    });
  };

  // El mapa de la semana carga cuando se entra a la vista o se cambia de semana.
  useEffect(() => {
    if (rango !== 'semana') {
      return;
    }
    setMapa(null);
    setErrorMapa(null);
    cargarMapaSemana(lunes).then(setMapa, (e: unknown) => {
      setErrorMapa(e instanceof Error ? e.message : 'Error al cargar la semana.');
    });
  }, [rango, lunes]);

  /** Click en una celda del mapa: caer en la grilla de ese día. */
  const irAlDia = (fechaISO: string): void => {
    const [y, m, d] = fechaISO.split('-').map(Number);
    setData(null);
    setFecha(new Date(y as number, (m as number) - 1, d as number));
    setRango('dia');
  };

  const domingo = sumarDias(lunes, 6);
  const subtitulo =
    rango === 'dia'
      ? FMT_LARGO.format(fecha)
      : rango === 'semana'
        ? `Semana del ${FMT_SEMANA.format(lunes)} al ${FMT_SEMANA.format(domingo)}`.replace(/\./g, '')
        : `Próximos ${rango} días`;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <Stack gap={0}>
          <Title order={2}>Agenda</Title>
          <Text c="dimmed" tt="capitalize">
            {subtitulo}
          </Text>
        </Stack>
        <Group gap="sm">
          {rango === 'dia' && <Leyenda />}
          {rango === 'dia' && (
            <Group gap={4} wrap="nowrap">
              <Tooltip label="Día anterior" withArrow>
                <ActionIcon variant="default" size="lg" aria-label="Día anterior" onClick={() => moverDias(-1)}>
                  <IconChevronLeft size={18} />
                </ActionIcon>
              </Tooltip>
              <Text fw={600} ta="center" tt="capitalize" miw={116} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {FMT_CORTO.format(fecha).replace(/\./g, '')}
              </Text>
              <Tooltip label="Día siguiente" withArrow>
                <ActionIcon variant="default" size="lg" aria-label="Día siguiente" onClick={() => moverDias(1)}>
                  <IconChevronRight size={18} />
                </ActionIcon>
              </Tooltip>
              {/* Resalta cuando SIRVE tocarlo (estás en otro día) y se apaga
                  cuando ya estás en hoy: `disabled` pisaría igual a `filled`. */}
              <Button
                variant={esHoy ? 'default' : 'light'}
                onClick={() => {
                  setData(null);
                  setFecha(aMedianoche(new Date()));
                }}
                disabled={esHoy}
              >
                Hoy
              </Button>
            </Group>
          )}
          {rango === 'semana' && (
            <Group gap={4} wrap="nowrap">
              <Tooltip label="Semana anterior" withArrow>
                <ActionIcon
                  variant="default"
                  size="lg"
                  aria-label="Semana anterior"
                  onClick={() => setLunes((l) => sumarDias(l, -7))}
                >
                  <IconChevronLeft size={18} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Semana siguiente" withArrow>
                <ActionIcon
                  variant="default"
                  size="lg"
                  aria-label="Semana siguiente"
                  onClick={() => setLunes((l) => sumarDias(l, 7))}
                >
                  <IconChevronRight size={18} />
                </ActionIcon>
              </Tooltip>
              <Button
                variant={esSemanaActual ? 'default' : 'light'}
                disabled={esSemanaActual}
                onClick={() => setLunes(lunesDe(new Date()))}
              >
                Esta semana
              </Button>
            </Group>
          )}
          <SegmentedControl
            value={rango}
            onChange={(v) => setRango(v as Rango)}
            data={[
              { value: 'dia', label: 'Día' },
              { value: 'semana', label: 'Semana' },
              { value: '7', label: '7 días' },
              { value: '14', label: '14 días' },
            ]}
          />
          {rango === 'dia' && (
            <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => void refrescar()} loading={cargando}>
              Actualizar
            </Button>
          )}
        </Group>
      </Group>

      {rango === 'dia' ? (
        <>
          {error && (
            <Alert color="red" icon={<IconInfoCircle size={16} />} title="No se pudo cargar">
              {error}
            </Alert>
          )}

          {data === null && !error && (
            <Center mih={240}>
              <Loader />
            </Center>
          )}

          {data && (
            // Un día pasado se mira, no se opera: sin `onReservar` los huecos
            // dejan de ser clickeables. No es una regla nueva — `bw-reservar-turno`
            // ya rechaza el pasado (R-13); esto evita el viaje que termina en error.
            <Box style={{ opacity: esPasado ? 0.62 : 1 }}>
              <Timeline
                data={data}
                onReservar={
                  esPasado
                    ? undefined
                    : (recursoCodigo, horaMin) => setPreset({ recursoCodigo, horaMin, fechaISO: fechaLocalISO(fecha) })
                }
                onTurno={(t) => setTurnoSel(t)}
              />
            </Box>
          )}
        </>
      ) : rango === 'semana' ? (
        <>
          {errorMapa && (
            <Alert color="red" icon={<IconInfoCircle size={16} />} title="No se pudo cargar">
              {errorMapa}
            </Alert>
          )}

          {mapa === null && !errorMapa && (
            <Center mih={240}>
              <Loader />
            </Center>
          )}

          {mapa && <MapaSemana data={mapa} hoyISO={fechaLocalISO(new Date())} onDia={irAlDia} />}
        </>
      ) : (
        <ProximosTurnos dias={Number(rango)} />
      )}

      {/* Debajo de la grilla: cuando se libera una franja, acá está a quién
          ofrecérsela sin salir de la agenda. */}
      <EsperandoLugar />

      <ReservaModal preset={preset} onClose={() => setPreset(null)} onReservado={() => void refrescar()} />
      <TurnoModal turno={turnoSel} onClose={() => setTurnoSel(null)} onCambiado={() => void refrescar()} />
    </Stack>
  );
}

/**
 * "En curso" (`checked-in`) salió de la leyenda: Recepción ya no puede marcarlo
 * —se sacó de las acciones del turno el 2026-08-15, porque el Encounter lo abre
 * "Llegó" y nada financiero ni de reportes dependía de él—, así que el chip
 * describía un estado que nadie podía producir.
 *
 * El código SIGUE vivo en `lib/estados.ts`: los turnos históricos que quedaron
 * en `checked-in` se tienen que seguir viendo con su color y su etiqueta.
 */
const ESTADOS_LEYENDA = ['pending', 'booked', 'arrived', 'fulfilled'];

function Leyenda(): JSX.Element {
  return (
    <Group gap="md" visibleFrom="lg">
      {ESTADOS_LEYENDA.map((e) => (
        <Group gap={6} key={e}>
          <Box w={16} h={12} style={{ background: `var(--mantine-color-${colorEstado(e)}-6)`, borderRadius: 3 }} />
          <Text size="xs" c="dimmed">
            {labelEstado(e)}
          </Text>
        </Group>
      ))}
      <Group gap={6}>
        {/* Mismo grosor que la línea real de la grilla (3px). */}
        <Box w={3} h={14} style={{ background: 'var(--mantine-color-blue-6)' }} />
        <Text size="xs" c="dimmed">
          Ahora
        </Text>
      </Group>
    </Group>
  );
}
