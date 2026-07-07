import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconMessages, IconPlus, IconRefresh, IconSend } from '@tabler/icons-react';
import { ResourceInput, useMedplum, useMedplumProfile } from '@medplum/react';
import { createReference, getDisplayString, getReferenceString } from '@medplum/core';
import type { Communication, Patient } from '@medplum/fhirtypes';

/**
 * Bandeja de conversaciones con los pacientes del portal (recurso Communication).
 * Modelo de hilos compatible con el chat del portal (ThreadInbox):
 *   hilo = Communication topic (sin partOf, payload = asunto);
 *   mensaje = Communication hija (partOf = topic, sent obligatorio);
 *   subject SIEMPRE el Patient (la AccessPolicy del portal filtra por subject).
 * Refresco por polling (20 s); con @medplum/react 5.x y un router se puede
 * reemplazar por ThreadInbox + useSubscription (tiempo real).
 */

const POLL_MS = 20_000;

const fmtHora = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});

function asunto(c: Communication): string {
  // El ThreadInbox del portal guarda el asunto en topic.text; payload es el fallback.
  return c.topic?.text ?? c.payload?.find((p) => p.contentString)?.contentString ?? '(sin asunto)';
}

function texto(c: Communication): string {
  return c.payload?.find((p) => p.contentString)?.contentString ?? '';
}

export function Mensajes(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [estado, setEstado] = useState<'in-progress' | 'completed'>('in-progress');
  const [hilos, setHilos] = useState<Communication[]>();
  const [nombres, setNombres] = useState<Map<string, string>>(new Map());
  const [hiloId, setHiloId] = useState<string>();
  const [mensajes, setMensajes] = useState<Communication[]>();
  const [respuesta, setRespuesta] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [nuevoAbierto, setNuevoAbierto] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  const hilo = hilos?.find((h) => h.id === hiloId);

  const cargarHilos = useCallback((): void => {
    // Solo topics con mensajes (mismo criterio que el inbox del portal).
    medplum
      .searchResources(
        'Communication',
        `part-of:missing=true&_has:Communication:part-of:_id:not=null&status=${estado}&_sort=-_lastUpdated&_count=100`,
        { cache: 'no-cache' },
      )
      .then(async (ts) => {
        setHilos(ts);
        const ids = [
          ...new Set(
            ts
              .map((t) => t.subject?.reference)
              .filter((r): r is string => Boolean(r?.startsWith('Patient/')))
              .map((r) => r.slice('Patient/'.length)),
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
  }, [medplum, estado]);

  const cargarMensajes = useCallback(
    (id: string): void => {
      medplum
        .searchResources('Communication', `part-of=Communication/${id}&_sort=sent&_count=200`, { cache: 'no-cache' })
        .then((ms) => {
          setMensajes(ms);
          // Marcar leídos (received) los mensajes del paciente: apaga la campanita
          // de Recepción. Best-effort en segundo plano; no bloquea la lectura.
          const ahora = new Date().toISOString();
          for (const m of ms) {
            if (m.sender?.reference?.startsWith('Patient/') && !m.received) {
              medplum.updateResource<Communication>({ ...m, received: ahora }).catch(() => undefined);
            }
          }
        })
        .catch((err) => notifications.show({ color: 'red', title: 'Error', message: String(err?.message ?? err) }));
    },
    [medplum],
  );

  // Carga inicial + polling (bandeja e hilo abierto).
  useEffect(() => {
    setHilos(undefined);
    cargarHilos();
    const t = window.setInterval(() => {
      cargarHilos();
      if (hiloId) {
        cargarMensajes(hiloId);
      }
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [cargarHilos, cargarMensajes, hiloId]);

  useEffect(() => {
    setMensajes(undefined);
    if (hiloId) {
      cargarMensajes(hiloId);
    }
  }, [hiloId, cargarMensajes]);

  // Autoscroll al fondo cuando llegan mensajes.
  useEffect(() => {
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
  }, [mensajes]);

  const nombreDe = (t: Communication): string => {
    const ref = t.subject?.reference;
    const id = ref?.startsWith('Patient/') ? ref.slice('Patient/'.length) : undefined;
    return (id && nombres.get(id)) || t.subject?.display || 'Paciente';
  };

  const responder = async (): Promise<void> => {
    if (!hilo || !profile || !respuesta.trim()) {
      return;
    }
    setEnviando(true);
    try {
      const msg = await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: 'in-progress',
        sent: new Date().toISOString(),
        subject: hilo.subject,
        sender: createReference(profile) as Communication['sender'],
        ...(hilo.subject ? { recipient: [hilo.subject] as Communication['recipient'] } : {}),
        partOf: [{ reference: `Communication/${hilo.id}` }],
        payload: [{ contentString: respuesta.trim() }],
      });
      setMensajes((prev) => [...(prev ?? []), msg]);
      setRespuesta('');
    } catch (err) {
      notifications.show({ color: 'red', title: 'No se pudo enviar', message: String((err as Error)?.message ?? err) });
    } finally {
      setEnviando(false);
    }
  };

  const cambiarEstadoHilo = async (nuevo: 'in-progress' | 'completed'): Promise<void> => {
    if (!hilo) {
      return;
    }
    try {
      await medplum.updateResource<Communication>({ ...hilo, status: nuevo });
      setHiloId(undefined);
      cargarHilos();
    } catch (err) {
      notifications.show({ color: 'red', title: 'No se pudo cambiar', message: String((err as Error)?.message ?? err) });
    }
  };

  return (
    <Stack gap="md" maw={1100} mx="auto" h="calc(100dvh - 64px - 2 * var(--mantine-spacing-md))">
      <Group gap="xs" justify="space-between">
        <Group gap="xs">
          <IconMessages size={22} />
          <Title order={2}>Mensajes</Title>
          {hilos && (
            <Badge variant="light" color="teal">
              {hilos.length} {estado === 'in-progress' ? 'abiertas' : 'cerradas'}
            </Badge>
          )}
        </Group>
        <Group gap="xs">
          <SegmentedControl
            size="xs"
            value={estado}
            onChange={(v) => {
              setEstado(v as 'in-progress' | 'completed');
              setHiloId(undefined);
            }}
            data={[
              { value: 'in-progress', label: 'Abiertas' },
              { value: 'completed', label: 'Cerradas' },
            ]}
          />
          <Button size="xs" variant="default" leftSection={<IconRefresh size={15} />} onClick={cargarHilos}>
            Actualizar
          </Button>
          <Button size="xs" leftSection={<IconPlus size={15} />} onClick={() => setNuevoAbierto(true)}>
            Nueva conversación
          </Button>
        </Group>
      </Group>

      <Group align="stretch" gap="md" style={{ flex: 1, minHeight: 0 }} wrap="nowrap">
        {/* Lista de conversaciones */}
        <Card withBorder radius="md" p={0} w={340} style={{ overflow: 'hidden' }}>
          <ScrollArea h="100%">
            {hilos === undefined ? (
              <Group justify="center" py="xl">
                <Loader size="sm" />
              </Group>
            ) : hilos.length === 0 ? (
              <Text c="dimmed" p="md" size="sm">
                No hay conversaciones {estado === 'in-progress' ? 'abiertas' : 'cerradas'}. Cuando un paciente
                escriba desde el portal, aparece acá.
              </Text>
            ) : (
              hilos.map((t) => (
                <Box
                  key={t.id}
                  p="sm"
                  style={{ cursor: 'pointer', borderBottom: '1px solid var(--mantine-color-default-border)' }}
                  bg={t.id === hiloId ? 'var(--mantine-color-default-hover)' : undefined}
                  onClick={() => setHiloId(t.id)}
                >
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Text fw={600} size="sm" truncate>
                      {nombreDe(t)}
                    </Text>
                    <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                      {t.meta?.lastUpdated ? fmtHora.format(new Date(t.meta.lastUpdated)) : ''}
                    </Text>
                  </Group>
                  <Text size="sm" c="dimmed" truncate>
                    {asunto(t)}
                  </Text>
                </Box>
              ))
            )}
          </ScrollArea>
        </Card>

        {/* Detalle del hilo */}
        <Card withBorder radius="md" p={0} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {!hilo ? (
            <Group justify="center" style={{ flex: 1 }}>
              <Text c="dimmed">Elegí una conversación de la lista.</Text>
            </Group>
          ) : (
            <>
              <Group justify="space-between" p="sm" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
                <div style={{ minWidth: 0 }}>
                  <Text fw={700}>{nombreDe(hilo)}</Text>
                  <Text size="xs" c="dimmed" truncate>
                    {asunto(hilo)}
                  </Text>
                </div>
                {hilo.status === 'completed' ? (
                  <Button size="xs" variant="light" onClick={() => cambiarEstadoHilo('in-progress')}>
                    Reabrir
                  </Button>
                ) : (
                  <Button size="xs" variant="light" color="gray" onClick={() => cambiarEstadoHilo('completed')}>
                    Cerrar conversación
                  </Button>
                )}
              </Group>

              <ScrollArea style={{ flex: 1 }} viewportRef={viewportRef} p="md">
                {mensajes === undefined ? (
                  <Group justify="center" py="xl">
                    <Loader size="sm" />
                  </Group>
                ) : (
                  <Stack gap="xs">
                    {mensajes.map((m) => {
                      const delPaciente = m.sender?.reference?.startsWith('Patient/');
                      return (
                        <Paper
                          key={m.id}
                          p="sm"
                          radius="md"
                          withBorder={Boolean(delPaciente)}
                          bg={delPaciente ? undefined : 'var(--mantine-primary-color-light)'}
                          maw="80%"
                          style={{ alignSelf: delPaciente ? 'flex-start' : 'flex-end' }}
                        >
                          <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                            {texto(m)}
                          </Text>
                          <Text size="xs" c="dimmed" ta="right">
                            {m.sent ? fmtHora.format(new Date(m.sent)) : ''}
                          </Text>
                        </Paper>
                      );
                    })}
                  </Stack>
                )}
              </ScrollArea>

              <Group p="sm" gap="xs" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }} wrap="nowrap">
                <Textarea
                  style={{ flex: 1 }}
                  autosize
                  minRows={1}
                  maxRows={4}
                  placeholder="Escribí tu respuesta…"
                  value={respuesta}
                  onChange={(e) => setRespuesta(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void responder();
                    }
                  }}
                />
                <Button leftSection={<IconSend size={16} />} loading={enviando} onClick={responder}>
                  Enviar
                </Button>
              </Group>
            </>
          )}
        </Card>
      </Group>

      <NuevaConversacion
        abierto={nuevoAbierto}
        onCerrar={() => setNuevoAbierto(false)}
        onCreada={(id) => {
          setNuevoAbierto(false);
          setEstado('in-progress');
          cargarHilos();
          setHiloId(id);
        }}
      />
    </Stack>
  );
}

function NuevaConversacion({
  abierto,
  onCerrar,
  onCreada,
}: {
  abierto: boolean;
  onCerrar: () => void;
  onCreada: (hiloId: string) => void;
}): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [paciente, setPaciente] = useState<Patient>();
  const [tema, setTema] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [creando, setCreando] = useState(false);

  const crear = async (): Promise<void> => {
    if (!paciente || !profile || !mensaje.trim()) {
      return;
    }
    setCreando(true);
    try {
      const ahora = new Date().toISOString();
      // Hilo (topic) + primer mensaje: el mismo modelo que crea el portal.
      const topic = await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: 'in-progress',
        sent: ahora,
        subject: createReference(paciente),
        sender: createReference(profile) as Communication['sender'],
        recipient: [createReference(paciente)],
        // topic.text = asunto (es lo que muestra el ThreadInbox del portal); payload de fallback.
        topic: { text: tema.trim() || mensaje.trim().slice(0, 60) },
        payload: [{ contentString: tema.trim() || mensaje.trim().slice(0, 60) }],
      });
      await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: 'in-progress',
        sent: ahora,
        subject: createReference(paciente),
        sender: createReference(profile) as Communication['sender'],
        recipient: [createReference(paciente)],
        partOf: [{ reference: getReferenceString(topic) }],
        payload: [{ contentString: mensaje.trim() }],
      });
      setPaciente(undefined);
      setTema('');
      setMensaje('');
      onCreada(topic.id as string);
    } catch (err) {
      notifications.show({ color: 'red', title: 'No se pudo crear', message: String((err as Error)?.message ?? err) });
    } finally {
      setCreando(false);
    }
  };

  return (
    <Modal opened={abierto} onClose={onCerrar} title="Nueva conversación" radius="md">
      <Stack gap="sm">
        <ResourceInput<Patient> resourceType="Patient" name="paciente" label="Paciente" onChange={setPaciente} />
        <TextInput label="Tema (opcional)" value={tema} onChange={(e) => setTema(e.currentTarget.value)} />
        <Textarea
          label="Mensaje"
          autosize
          minRows={2}
          value={mensaje}
          onChange={(e) => setMensaje(e.currentTarget.value)}
          required
        />
        <Button loading={creando} disabled={!paciente || !mensaje.trim()} onClick={crear}>
          Enviar
        </Button>
      </Stack>
    </Modal>
  );
}
