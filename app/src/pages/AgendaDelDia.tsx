import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Center, Group, Loader, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import { IconRefresh, IconInfoCircle } from '@tabler/icons-react';
import { cargarTimeline, type TimelineData, type TurnoTimeline } from '../lib/timeline';
import { Timeline } from '../components/Timeline';
import { ProximosTurnos } from '../components/ProximosTurnos';
import { ReservaModal, type PresetReserva } from '../components/ReservaModal';
import { TurnoModal } from '../components/TurnoModal';
import { EsperandoLugar } from '../components/EsperandoLugar';
import { colorEstado, labelEstado } from '../lib/estados';

const REFRESCO_MS = 60_000;

/** Rango visible: hoy (grilla operativa) o ventana de 7/14 días (lista). */
type Rango = 'hoy' | '7' | '14';

export function AgendaDelDia(): JSX.Element {
  const [rango, setRango] = useState<Rango>('hoy');
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [preset, setPreset] = useState<PresetReserva | null>(null);
  const [turnoSel, setTurnoSel] = useState<TurnoTimeline | null>(null);

  const refrescar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      setData(await cargarTimeline());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar la agenda.');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    if (rango !== 'hoy') {
      return;
    }
    void refrescar();
    const id = setInterval(() => void refrescar(), REFRESCO_MS);
    return () => clearInterval(id);
  }, [refrescar, rango]);

  const hoy = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const subtitulo = rango === 'hoy' ? hoy : `Próximos ${rango} días`;

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
          {rango === 'hoy' && <Leyenda />}
          <SegmentedControl
            value={rango}
            onChange={(v) => setRango(v as Rango)}
            data={[
              { value: 'hoy', label: 'Hoy' },
              { value: '7', label: '7 días' },
              { value: '14', label: '14 días' },
            ]}
          />
          {rango === 'hoy' && (
            <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => void refrescar()} loading={cargando}>
              Actualizar
            </Button>
          )}
        </Group>
      </Group>

      {rango === 'hoy' ? (
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
            <Timeline
              data={data}
              onReservar={(recursoCodigo, horaMin) => setPreset({ recursoCodigo, horaMin })}
              onTurno={(t) => setTurnoSel(t)}
            />
          )}
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
