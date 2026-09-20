import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Box, Card, Center, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { cargarProximos, type DiaAgenda } from '../lib/proximos';
import { TurnoModal } from './TurnoModal';
import type { TurnoTimeline } from '../lib/timeline';
import { colorEstado, labelEstado } from '../lib/estados';

const REFRESCO_MS = 60_000;

function fmt(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function ProximosTurnos({ dias }: { dias: number }): JSX.Element {
  const [data, setData] = useState<DiaAgenda[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turnoSel, setTurnoSel] = useState<TurnoTimeline | null>(null);

  const refrescar = useCallback(async () => {
    setError(null);
    try {
      setData(await cargarProximos(dias));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar la agenda.');
    }
  }, [dias]);

  useEffect(() => {
    setData(null);
    void refrescar();
    const id = setInterval(() => void refrescar(), REFRESCO_MS);
    return () => clearInterval(id);
  }, [refrescar]);

  if (error) {
    return (
      <Alert color="red" icon={<IconInfoCircle size={16} />} title="No se pudo cargar">
        {error}
      </Alert>
    );
  }

  if (data === null) {
    return (
      <Center mih={240}>
        <Loader />
      </Center>
    );
  }

  const totalTurnos = data.reduce((n, d) => n + d.turnos.length, 0);
  if (totalTurnos === 0) {
    return (
      <Text c="dimmed" mt="md">
        No hay turnos agendados en los próximos {dias} días.
      </Text>
    );
  }

  return (
    <Stack gap="lg">
      {data.map((dia) => (
        <Stack key={dia.fecha} gap="xs">
          <Group gap="sm" align="baseline">
            <Text fw={700} tt="capitalize">
              {dia.etiqueta}
            </Text>
            <Text size="sm" c="dimmed">
              {dia.turnos.length} {dia.turnos.length === 1 ? 'turno' : 'turnos'}
            </Text>
            {dia.tentativos > 0 && (
              <Badge color="yellow" variant="light">
                {/* "sin pagar": el contador mezcla presenciales (seña del 50 %)
                    con teleconsultas (el 100 %), y en un turno virtual ningún
                    texto dice "seña". */}
                {dia.tentativos} sin pagar
              </Badge>
            )}
          </Group>

          <Paper withBorder radius="md">
            <Stack gap={0}>
              {dia.turnos.map((t, i) => (
                <Card
                  key={t.appointmentId}
                  padding="sm"
                  radius={0}
                  onClick={() => setTurnoSel(t)}
                  style={{
                    cursor: 'pointer',
                    borderTop: i === 0 ? undefined : '1px solid var(--mantine-color-default-border)',
                  }}
                  className="bw-fila"
                >
                  <Group gap="md" wrap="nowrap" align="center">
                    <Box w={4} h={36} style={{ background: `var(--mantine-color-${colorEstado(t.estado)}-6)`, borderRadius: 4, flexShrink: 0 }} />
                    <Text fw={600} w={64} style={{ flexShrink: 0 }}>
                      {fmt(t.inicioMin)}
                    </Text>
                    <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                      <Text fw={500} lineClamp={1}>
                        {t.servicio}
                      </Text>
                      <Text size="sm" c="dimmed" lineClamp={1}>
                        {t.paciente || 'Paciente'} · {t.recursoNombre}
                      </Text>
                    </Stack>
                    <Badge color={colorEstado(t.estado)} variant="light" style={{ flexShrink: 0 }}>
                      {labelEstado(t.estado)}
                    </Badge>
                  </Group>
                </Card>
              ))}
            </Stack>
          </Paper>
        </Stack>
      ))}

      <style>{`.bw-fila:hover{background:var(--mantine-color-default-hover);}`}</style>

      <TurnoModal turno={turnoSel} onClose={() => setTurnoSel(null)} onCambiado={() => void refrescar()} />
    </Stack>
  );
}
