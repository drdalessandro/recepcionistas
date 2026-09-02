import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCalendarCheck, IconCheck, IconInbox, IconSparkles, IconUserHeart } from '@tabler/icons-react';
import { useMedplum, useSubscription } from '@medplum/react';
import { getDisplayString } from '@medplum/core';
import type { Patient, Task } from '@medplum/fhirtypes';
import { EXT } from '@bw/fhir/identifiers';
import { mensajeError, proponerReserva, reservarTurno, type IssueValidacion, type ResultadoPropuestaBot } from '../lib/bots';
import type { ReservaPrefill } from './Atender';

/**
 * Solicitudes de turno del portal (modelo de "solicitud"): el paciente pide y acá
 * Recepción confirma. Lista los Task pendientes (`code=solicitud-turno`,
 * `status=requested`); cada uno se atiende (ir a Atender para reservar con los bots)
 * y luego se marca resuelto. La reserva sigue pasando por los bots (reglas), y al
 * reservar el bot COMPLETA la solicitud solo, así la card desaparece de acá sin
 * tocar nada (tiempo real por WebSocket + polling de respaldo, como la campanita).
 *
 * **Proponer** (Nivel 4, `bw-proponer-reserva`): el asistente lee la solicitud y
 * los horarios reales del paciente y propone la reserva concreta (servicio, sala,
 * horario, personas). Recepción decide: **Reservar** la manda a `bw-reservar-turno`
 * con las reglas de siempre; **Otra opción** vuelve a pedir excluyendo lo ya
 * descartado; **Lo hago a mano** abre Atender prellenado. El asistente nunca
 * escribe en la agenda. Qué pasó con cada propuesta queda en la solicitud
 * (`propuesta-resultado`): es la métrica que decide el paso siguiente.
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
  const ref = t.for?.reference ?? t.requester?.reference;
  return ref?.startsWith('Patient/') ? ref.slice('Patient/'.length) : undefined;
}

/**
 * Lo que el paciente pidió, para prellenar la reserva en Atender: sin esto,
 * Recepción re-tipeaba servicio y horario de memoria y podía confirmar OTRO
 * servicio (pasó en producción: pidió Chequeo, se confirmó una consulta).
 */
function prefillDeTask(t: Task): ReservaPrefill | undefined {
  const servicioCodigo = t.input?.find((i) => i.type?.text === 'terapia-codigo')?.valueString;
  const inicio = t.input?.find((i) => i.type?.text === 'preferencia-inicio')?.valueDateTime;
  return servicioCodigo || inicio ? { servicioCodigo, inicio } : undefined;
}

type ResultadoPropuesta = 'confirmada' | 'alternativa' | 'descartada';

interface EstadoPropuesta {
  cargando: boolean;
  resultado?: ResultadoPropuestaBot;
  /** Inicios que Recepción ya descartó con "Otra opción". */
  excluidos: string[];
  reservando: boolean;
  /** Bloqueos del último intento de Reservar (la propuesta no pasó las reglas). */
  bloqueos?: IssueValidacion[];
}

export function Solicitudes({
  onAtender,
}: {
  onAtender: (pacienteId: string, prefill?: ReservaPrefill) => void;
}): JSX.Element {
  const medplum = useMedplum();
  const [tasks, setTasks] = useState<Task[]>();
  const [nombres, setNombres] = useState<Map<string, string>>(new Map());
  const [resolviendo, setResolviendo] = useState<string>();
  const [propuestas, setPropuestas] = useState<Record<string, EstadoPropuesta>>({});

  const cargar = useCallback((): void => {
    medplum
      .searchResources('Task', 'code=solicitud-turno&status=requested&_sort=-_lastUpdated&_count=100', {
        cache: 'no-cache',
      })
      .then(async (ts) => {
        setTasks(ts);
        const ids = [...new Set(ts.map(pacienteIdDeTask).filter((x): x is string => Boolean(x)))];
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

  // Carga inicial + tiempo real (WebSocket) + polling/foco de respaldo: una
  // solicitud nueva aparece sola, y la resuelta (por el bot o a mano) desaparece.
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

  useSubscription('Task?code=solicitud-turno', cargar, {
    onError: () => undefined,
    onWebSocketClose: () => undefined,
  });

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

  const setEstado = (taskId: string, cambio: Partial<EstadoPropuesta>): void =>
    setPropuestas((prev) => {
      const base: EstadoPropuesta = prev[taskId] ?? { cargando: false, excluidos: [], reservando: false };
      return { ...prev, [taskId]: { ...base, ...cambio } };
    });

  /**
   * Métrica del Nivel 4 (gemela de `borrador-usado`): qué pasó con la propuesta.
   * Se lee el Task fresco porque al reservar el bot ya lo completó. Best-effort:
   * no puede frenar una reserva ya hecha.
   */
  const registrarResultado = async (taskId: string, resultado: ResultadoPropuesta): Promise<void> => {
    try {
      const fresco = await medplum.readResource('Task', taskId);
      const ext = (fresco.extension ?? []).filter((x) => x.url !== EXT.propuestaResultado);
      await medplum.updateResource<Task>({
        ...fresco,
        extension: [...ext, { url: EXT.propuestaResultado, valueString: resultado }],
      });
    } catch {
      // la métrica nunca frena la operación
    }
  };

  const proponer = async (t: Task, excluir: string[] = []): Promise<void> => {
    if (!t.id) {
      return;
    }
    setEstado(t.id, { cargando: true, excluidos: excluir, bloqueos: undefined });
    try {
      const r = await proponerReserva(t.id, excluir);
      setEstado(t.id, { cargando: false, resultado: r });
    } catch (err) {
      setEstado(t.id, { cargando: false, resultado: { ok: false, motivo: mensajeError(err) } });
    }
  };

  const reservar = async (t: Task, estado: EstadoPropuesta): Promise<void> => {
    const p = estado.resultado?.propuesta;
    const pacienteRef = estado.resultado?.pacienteRef;
    if (!t.id || !p || !pacienteRef) {
      return;
    }
    setEstado(t.id, { reservando: true, bloqueos: undefined });
    try {
      const r = await reservarTurno({
        pacienteRef,
        servicioCodigo: p.servicioCodigo,
        recursoCodigo: p.recursoCodigo,
        inicio: p.inicio,
        ocupantes: p.ocupantes,
        confirmar: true,
      });
      if (r.creado) {
        await registrarResultado(t.id, estado.excluidos.length > 0 ? 'alternativa' : 'confirmada');
        notifications.show({
          color: 'teal',
          title: 'Turno reservado',
          message: `${p.servicioNombre} · ${p.cuando} · ${p.recursoNombre}`,
        });
        cargar(); // el bot completó la solicitud: la card desaparece
      } else {
        setEstado(t.id, { reservando: false, bloqueos: r.bloqueos });
      }
    } catch (err) {
      setEstado(t.id, { reservando: false });
      notifications.show({ color: 'red', title: 'No se pudo reservar', message: mensajeError(err) });
    }
  };

  const otraOpcion = (t: Task, estado: EstadoPropuesta): void => {
    const actual = estado.resultado?.propuesta?.inicio;
    void proponer(t, actual ? [...estado.excluidos, actual] : estado.excluidos);
  };

  const aMano = async (t: Task, estado: EstadoPropuesta): Promise<void> => {
    const pid = pacienteIdDeTask(t);
    const p = estado.resultado?.propuesta;
    if (!pid || !t.id) {
      return;
    }
    if (p) {
      await registrarResultado(t.id, 'descartada');
    }
    onAtender(pid, p ? { servicioCodigo: p.servicioCodigo, inicio: p.inicio } : prefillDeTask(t));
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
          const estado = t.id ? propuestas[t.id] : undefined;
          const propuesta = estado?.resultado?.propuesta;
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
                  {!estado && (
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconSparkles size={15} />}
                      disabled={!pid}
                      onClick={() => void proponer(t)}
                    >
                      Proponer
                    </Button>
                  )}
                  <Button
                    size="xs"
                    leftSection={<IconUserHeart size={15} />}
                    disabled={!pid}
                    onClick={() => pid && onAtender(pid, prefillDeTask(t))}
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

              {estado?.cargando && (
                <Group gap="xs" mt="sm">
                  <Loader size="xs" />
                  <Text size="sm" c="dimmed">
                    Armando la propuesta…
                  </Text>
                </Group>
              )}

              {estado && !estado.cargando && estado.resultado && !propuesta && (
                <Alert mt="sm" color="gray" variant="light" icon={<IconSparkles size={16} />}>
                  {estado.resultado.motivo ?? 'Sin propuesta: mejor resolvela vos.'}
                </Alert>
              )}

              {estado && !estado.cargando && propuesta && (
                <Alert mt="sm" color="teal" variant="light" icon={<IconCalendarCheck size={16} />}>
                  <Stack gap={6}>
                    <Text size="sm" fw={600}>
                      Propuesta: {propuesta.servicioNombre} · {propuesta.cuando} · {propuesta.recursoNombre}
                      {propuesta.ocupantes > 1 ? ` · ${propuesta.ocupantes} personas` : ''}
                    </Text>
                    <Text size="sm">{propuesta.motivo}</Text>
                    {propuesta.alternativas.length > 0 && (
                      <Text size="xs" c="dimmed">
                        También libres: {propuesta.alternativas.map((a) => a.cuando).join(' · ')}
                      </Text>
                    )}
                    {estado.bloqueos && estado.bloqueos.length > 0 && (
                      <Text size="sm" c="red">
                        No se pudo reservar: {estado.bloqueos.map((b) => `${b.regla} — ${b.mensaje}`).join(' · ')}
                      </Text>
                    )}
                    <Group gap="xs" mt={4}>
                      <Button size="xs" loading={estado.reservando} onClick={() => void reservar(t, estado)}>
                        Reservar
                      </Button>
                      <Button size="xs" variant="light" disabled={estado.reservando} onClick={() => otraOpcion(t, estado)}>
                        Otra opción
                      </Button>
                      <Button size="xs" variant="subtle" color="gray" disabled={estado.reservando} onClick={() => void aMano(t, estado)}>
                        Lo hago a mano
                      </Button>
                    </Group>
                  </Stack>
                </Alert>
              )}
            </Card>
          );
        })
      )}
    </Stack>
  );
}
