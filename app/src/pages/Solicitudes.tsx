import { useEffect, useState } from 'react';
import { Badge, Button, Card, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInbox, IconUserHeart, IconCheck } from '@tabler/icons-react';
import { useMedplum } from '@medplum/react';
import { getDisplayString } from '@medplum/core';
import type { Patient, Task } from '@medplum/fhirtypes';

/**
 * Solicitudes de turno del portal (modelo de "solicitud"): el paciente pide y acá
 * Recepción confirma. Lista los Task pendientes (`code=solicitud-turno`,
 * `status=requested`); cada uno se atiende (ir a Atender para reservar con los bots)
 * y luego se marca resuelto. La reserva sigue pasando por los bots (reglas).
 */
const fmtFecha = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});

function pacienteIdDeTask(t: Task): string | undefined {
  const ref = t.for?.reference ?? t.requester?.reference;
  return ref?.startsWith('Patient/') ? ref.slice('Patient/'.length) : undefined;
}

export function Solicitudes({ onAtender }: { onAtender: (pacienteId: string) => void }): JSX.Element {
  const medplum = useMedplum();
  const [tasks, setTasks] = useState<Task[]>();
  const [nombres, setNombres] = useState<Map<string, string>>(new Map());
  const [resolviendo, setResolviendo] = useState<string>();

  useEffect(() => {
    let vivo = true;
    medplum
      .searchResources('Task', 'code=solicitud-turno&status=requested&_sort=-_lastUpdated&_count=100')
      .then(async (ts) => {
        if (!vivo) {
          return;
        }
        setTasks(ts);
        const ids = [...new Set(ts.map(pacienteIdDeTask).filter((x): x is string => Boolean(x)))];
        if (ids.length > 0) {
          const pacientes = await medplum
            .searchResources('Patient', { _id: ids.join(','), _count: ids.length })
            .catch(() => [] as Patient[]);
          if (!vivo) {
            return;
          }
          const m = new Map<string, string>();
          for (const p of pacientes) {
            if (p.id) {
              m.set(p.id, getDisplayString(p));
            }
          }
          setNombres(m);
        }
      })
      .catch((err) => notifications.show({ color: 'red', title: 'Error', message: String(err?.message ?? err) }));
    return () => {
      vivo = false;
    };
  }, [medplum]);

  const marcarResuelta = async (t: Task): Promise<void> => {
    setResolviendo(t.id);
    try {
      await medplum.updateResource<Task>({ ...t, status: 'completed' });
      setTasks((prev) => prev?.filter((x) => x.id !== t.id));
    } catch (err) {
      notifications.show({ color: 'red', title: 'No se pudo marcar', message: String((err as Error)?.message ?? err) });
    } finally {
      setResolviendo(undefined);
    }
  };

  if (tasks === undefined) {
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  }

  return (
    <Stack gap="md" maw={760} mx="auto">
      <Group gap="xs">
        <IconInbox size={22} />
        <Title order={2}>Solicitudes de turno</Title>
        <Badge variant="light" color="teal">
          {tasks.length} pendientes
        </Badge>
      </Group>

      {tasks.length === 0 ? (
        <Text c="dimmed">No hay solicitudes pendientes. Cuando un paciente pida un turno desde el portal, aparece acá.</Text>
      ) : (
        tasks.map((t) => {
          const pid = pacienteIdDeTask(t);
          return (
            <Card key={t.id} withBorder radius="md" p="md">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ minWidth: 0 }}>
                  <Text fw={600}>{(pid && nombres.get(pid)) || 'Paciente'}</Text>
                  <Text size="sm">{t.description ?? 'Solicitud de turno'}</Text>
                  <Text size="xs" c="dimmed">
                    {t.authoredOn ? fmtFecha.format(new Date(t.authoredOn)) : ''}
                  </Text>
                </div>
                <Group gap="xs" wrap="nowrap">
                  <Button
                    size="xs"
                    leftSection={<IconUserHeart size={15} />}
                    disabled={!pid}
                    onClick={() => pid && onAtender(pid)}
                  >
                    Atender
                  </Button>
                  <Button
                    size="xs"
                    variant="light"
                    color="gray"
                    leftSection={<IconCheck size={15} />}
                    loading={resolviendo === t.id}
                    onClick={() => marcarResuelta(t)}
                  >
                    Marcar resuelta
                  </Button>
                </Group>
              </Group>
            </Card>
          );
        })
      )}
    </Stack>
  );
}
