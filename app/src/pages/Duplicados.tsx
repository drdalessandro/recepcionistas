import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, Select, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconUsersGroup, IconArrowMerge, IconX, IconInfoCircle } from '@tabler/icons-react';
import { useMedplum, useSubscription } from '@medplum/react';
import { getDisplayString } from '@medplum/core';
import type { Patient, Task } from '@medplum/fhirtypes';
import { fusionarPaciente, mensajeError } from '../lib/bots';

/**
 * Posibles fichas duplicadas (Task `posible-duplicado`, las abre bw-dedup-paciente
 * cuando alguien con ficha existente se autoregistra en el portal). Recepción
 * revisa y decide: FUSIONAR (bw-fusionar-paciente: reapunta el login a la ficha
 * canónica, inactiva y enlaza la duplicada, reasigna lo clínico del interín) o
 * descartar. NUNCA hay fusión automática: siempre decide un humano acá.
 * Tiempo real por WebSocket + polling de respaldo, como Solicitudes.
 */

const POLL_MS = 30_000;

const fmtFecha = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});

function pacienteIdDeTask(t: Task): string | undefined {
  const ref = t.for?.reference;
  return ref?.startsWith('Patient/') ? ref.slice('Patient/'.length) : undefined;
}

interface Candidato {
  id: string;
  /** Qué llave coincidió (email/DNI/teléfono) — viene en el display de la referencia. */
  llaves: string;
}

function candidatosDeTask(t: Task): Candidato[] {
  return (t.input ?? [])
    .map((i) => i.valueReference)
    .filter((r): r is NonNullable<typeof r> => Boolean(r?.reference?.startsWith('Patient/')))
    .map((r) => ({ id: (r.reference as string).slice('Patient/'.length), llaves: r.display ?? '' }));
}

export function Duplicados(): JSX.Element {
  const medplum = useMedplum();
  const [tasks, setTasks] = useState<Task[]>();
  const [nombres, setNombres] = useState<Map<string, string>>(new Map());
  const [eleccion, setEleccion] = useState<Record<string, string>>({});
  const [trabajando, setTrabajando] = useState<string>();

  const cargar = useCallback((): void => {
    medplum
      .searchResources('Task', 'code=posible-duplicado&status=requested&_sort=-authored-on&_count=100', {
        cache: 'no-cache',
      })
      .then(async (ts) => {
        setTasks(ts);
        // Nombres de la ficha nueva Y de los candidatos, en un solo batch.
        const ids = [
          ...new Set(
            ts.flatMap((t) => [pacienteIdDeTask(t), ...candidatosDeTask(t).map((c) => c.id)]).filter((x): x is string => Boolean(x)),
          ),
        ];
        if (ids.length > 0) {
          const pacientes = await medplum
            .searchResources('Patient', { _id: ids.join(','), _count: ids.length })
            .catch(() => [] as Patient[]);
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
  }, [medplum]);

  useEffect(() => {
    cargar();
    const interval = window.setInterval(cargar, POLL_MS);
    const onFocus = (): void => cargar();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [cargar]);

  useSubscription('Task?code=posible-duplicado', cargar, {
    onError: () => undefined,
    onWebSocketClose: () => undefined,
  });

  const fusionar = async (t: Task): Promise<void> => {
    const duplicadoId = pacienteIdDeTask(t);
    const candidatos = candidatosDeTask(t);
    const canonicoId = eleccion[t.id ?? ''] ?? candidatos[0]?.id;
    if (!t.id || !duplicadoId || !canonicoId) {
      return;
    }
    setTrabajando(t.id);
    try {
      const r = await fusionarPaciente({ duplicadoId, canonicoId, taskId: t.id });
      if (!r.ok) {
        notifications.show({ color: 'red', title: 'No se pudo fusionar', message: r.mensaje ?? 'Error desconocido.' });
        return;
      }
      notifications.show({
        color: 'teal',
        title: 'Fichas fusionadas',
        message: `Login reapuntado (${r.loginsReapuntados ?? 0}) · ${r.reasignados ?? 0} recursos reasignados a la ficha canónica.`,
      });
      setTasks((prev) => prev?.filter((x) => x.id !== t.id));
    } catch (e) {
      notifications.show({ color: 'red', title: 'No se pudo fusionar', message: mensajeError(e) });
    } finally {
      setTrabajando(undefined);
    }
  };

  const descartar = async (t: Task): Promise<void> => {
    setTrabajando(t.id);
    try {
      await medplum.updateResource<Task>({ ...t, status: 'cancelled' });
      setTasks((prev) => prev?.filter((x) => x.id !== t.id));
    } catch (e) {
      notifications.show({ color: 'red', title: 'No se pudo descartar', message: mensajeError(e) });
    } finally {
      setTrabajando(undefined);
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
        <IconUsersGroup size={22} />
        <Title order={2}>Posibles duplicados</Title>
        <Badge variant="light" color="teal">
          {tasks.length} pendientes
        </Badge>
      </Group>

      {tasks.length === 0 ? (
        <Text c="dimmed">
          No hay fichas duplicadas para revisar. Cuando alguien con ficha existente se registre en el portal, aparece acá.
        </Text>
      ) : (
        tasks.map((t) => {
          const pid = pacienteIdDeTask(t);
          const candidatos = candidatosDeTask(t);
          const elegido = eleccion[t.id ?? ''] ?? candidatos[0]?.id;
          return (
            <Card key={t.id} withBorder radius="md" p="md">
              <Stack gap="sm">
                <div>
                  <Text fw={600}>Ficha nueva: {(pid && nombres.get(pid)) || 'Paciente'}</Text>
                  <Text size="xs" c="dimmed">
                    {t.authoredOn ? fmtFecha.format(new Date(t.authoredOn)) : ''}
                  </Text>
                </div>

                {candidatos.map((c) => (
                  <Text key={c.id} size="sm">
                    • {nombres.get(c.id) ?? `Patient/${c.id}`} — coincide: {c.llaves || 's/d'}
                  </Text>
                ))}

                <Alert color="bio" variant="light" icon={<IconInfoCircle size={16} />} p="xs">
                  La ficha de Recepción (la que tiene la historia) es la canónica: la ficha nueva se inactiva y su login
                  pasa a la elegida. No se borra nada.
                </Alert>

                <Group align="flex-end" wrap="nowrap">
                  <Select
                    label="Ficha canónica"
                    data={candidatos.map((c) => ({ value: c.id, label: nombres.get(c.id) ?? `Patient/${c.id}` }))}
                    value={elegido}
                    onChange={(v) => v && setEleccion((prev) => ({ ...prev, [t.id ?? '']: v }))}
                    style={{ flex: 1 }}
                  />
                  <Button
                    leftSection={<IconArrowMerge size={15} />}
                    loading={trabajando === t.id}
                    disabled={!elegido}
                    onClick={() => void fusionar(t)}
                  >
                    Fusionar
                  </Button>
                  <Button
                    variant="light"
                    color="gray"
                    leftSection={<IconX size={15} />}
                    disabled={trabajando === t.id}
                    onClick={() => void descartar(t)}
                  >
                    No es duplicado
                  </Button>
                </Group>
              </Stack>
            </Card>
          );
        })
      )}
    </Stack>
  );
}
