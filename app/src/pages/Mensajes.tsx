import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  FileButton,
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
import { IconMessages, IconPaperclip, IconPlus, IconRefresh, IconSend } from '@tabler/icons-react';
import { ResourceInput, useMedplum, useMedplumProfile, useSubscription } from '@medplum/react';
import { createReference, getDisplayString, getReferenceString } from '@medplum/core';
import type { Attachment, Communication, Patient } from '@medplum/fhirtypes';
import { EXT } from '@bw/fhir/identifiers';
import { espejarWhatsApp } from '../lib/bots';

/**
 * Bandeja de conversaciones con los pacientes del portal (recurso Communication).
 * Modelo de hilos compatible con el chat del portal (ThreadInbox):
 *   hilo = Communication topic (sin partOf, payload = asunto);
 *   mensaje = Communication hija (partOf = topic, sent obligatorio);
 *   subject SIEMPRE el Patient (la AccessPolicy del portal filtra por subject).
 * Tiempo real por WebSocket (useSubscription sobre Communication) con polling
 * de respaldo cada 60 s, el mismo patrón que la campanita y Solicitudes.
 */

const POLL_MS = 60_000;

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

function adjuntosDe(c: Communication): Attachment[] {
  return (c.payload ?? [])
    .map((p) => p.contentAttachment)
    .filter((a): a is Attachment => Boolean(a?.url));
}

/** Límite de WhatsApp por archivo (Twilio rechaza medios más grandes). */
const MAX_ADJUNTO_BYTES = 15 * 1024 * 1024;

/** Resumen estilo WhatsApp de un hilo: último mensaje + cantidad sin leer. */
interface ResumenHilo {
  ultimoTexto: string;
  ultimoSent: string;
  /** Mensajes del paciente que Recepción todavía no abrió. */
  sinLeer: number;
}

export function Mensajes(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [estado, setEstado] = useState<'in-progress' | 'completed'>('in-progress');
  const [hilos, setHilos] = useState<Communication[]>();
  const [resumen, setResumen] = useState<Map<string, ResumenHilo>>(new Map());
  const [nombres, setNombres] = useState<Map<string, string>>(new Map());
  const [hiloId, setHiloId] = useState<string>();
  const [mensajes, setMensajes] = useState<Communication[]>();
  const [respuesta, setRespuesta] = useState('');
  const [archivos, setArchivos] = useState<File[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [nuevoAbierto, setNuevoAbierto] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  const hilo = hilos?.find((h) => h.id === hiloId);
  const totalSinLeer = hilos?.reduce((acc, t) => acc + (resumen.get(t.id ?? '')?.sinLeer ?? 0), 0) ?? 0;
  // Orden estilo WhatsApp: por último mensaje (los hilos sin hijos caen al final por lastUpdated).
  const hilosOrdenados = [...(hilos ?? [])].sort((a, b) => {
    const ta = resumen.get(a.id ?? '')?.ultimoSent || a.meta?.lastUpdated || '';
    const tb = resumen.get(b.id ?? '')?.ultimoSent || b.meta?.lastUpdated || '';
    return tb.localeCompare(ta);
  });

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
        // Últimos mensajes de todos los hilos (una sola búsqueda): alimentan la
        // vista previa, el orden por actividad y el contador de no leídos.
        medplum
          .searchResources('Communication', 'part-of:missing=false&_sort=-sent&_count=250', { cache: 'no-cache' })
          .then((hijos) => {
            const m = new Map<string, ResumenHilo>();
            for (const c of hijos) {
              const padre = c.partOf?.[0]?.reference?.split('/')[1];
              if (!padre) {
                continue;
              }
              const r = m.get(padre) ?? { ultimoTexto: '', ultimoSent: '', sinLeer: 0 };
              if (!r.ultimoSent) {
                // Vienen ordenados de más nuevo a más viejo: el primero es el último mensaje.
                r.ultimoTexto = texto(c) || (adjuntosDe(c).length > 0 ? '📎 Adjunto' : '');
                r.ultimoSent = c.sent ?? c.meta?.lastUpdated ?? '';
              }
              if (c.sender?.reference?.startsWith('Patient/') && !c.received) {
                r.sinLeer++;
              }
              m.set(padre, r);
            }
            setResumen(m);
          })
          .catch(() => undefined);
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
          // El hilo abierto ya no tiene mensajes sin leer: apagar su badge al toque.
          setResumen((prev) => {
            const r = prev.get(id);
            if (!r?.sinLeer) {
              return prev;
            }
            const n = new Map(prev);
            n.set(id, { ...r, sinLeer: 0 });
            return n;
          });
        })
        .catch((err) => notifications.show({ color: 'red', title: 'Error', message: String(err?.message ?? err) }));
    },
    [medplum],
  );

  const refrescarTodo = useCallback((): void => {
    cargarHilos();
    if (hiloId) {
      cargarMensajes(hiloId);
    }
  }, [cargarHilos, cargarMensajes, hiloId]);

  // Carga inicial + polling de RESPALDO (el camino principal es el WebSocket).
  useEffect(() => {
    setHilos(undefined);
    cargarHilos();
    const t = window.setInterval(refrescarTodo, POLL_MS);
    return () => window.clearInterval(t);
  }, [cargarHilos, refrescarTodo]);

  // Tiempo real: cualquier mensaje nuevo (del portal o de otra terminal de
  // Recepción) refresca la bandeja y el hilo abierto al instante.
  useSubscription('Communication?sent:missing=false', refrescarTodo, {
    onError: () => undefined,
    onWebSocketClose: () => undefined,
  });

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
    if (!hilo || !profile || (!respuesta.trim() && archivos.length === 0)) {
      return;
    }
    setEnviando(true);
    try {
      const texto = respuesta.trim();
      // Adjuntos: cada archivo sube como Binary; el server presigna la URL en
      // cada lectura (la burbuja y el portal los ven sin vencimiento).
      const adjuntos: Attachment[] = [];
      for (const f of archivos) {
        adjuntos.push(
          await medplum.createAttachment({
            data: f,
            contentType: f.type || 'application/octet-stream',
            filename: f.name,
          }),
        );
      }
      const msg = await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: 'in-progress',
        sent: new Date().toISOString(),
        subject: hilo.subject,
        sender: createReference(profile) as Communication['sender'],
        ...(hilo.subject ? { recipient: [hilo.subject] as Communication['recipient'] } : {}),
        partOf: [{ reference: `Communication/${hilo.id}` }],
        payload: [...(texto ? [{ contentString: texto }] : []), ...adjuntos.map((a) => ({ contentAttachment: a }))],
      });
      setMensajes((prev) => [...(prev ?? []), msg]);
      setRespuesta('');
      setArchivos([]);
      // Espejo a WhatsApp (texto + adjuntos): el paciente se entera aunque no
      // entre al portal. Fire-and-forget: no bloquea el chat si Twilio falla.
      if (hilo.subject?.reference?.startsWith('Patient/')) {
        espejarWhatsApp(hilo.subject.reference, texto, msg.id).catch(() => undefined);
      }
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
          {totalSinLeer > 0 && (
            <Badge color="teal" variant="filled">
              {totalSinLeer} sin leer
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
              hilosOrdenados.map((t) => {
                const r = resumen.get(t.id ?? '');
                const sinLeer = r?.sinLeer ?? 0;
                const hora = r?.ultimoSent || t.meta?.lastUpdated;
                return (
                  <Box
                    key={t.id}
                    p="sm"
                    style={{ cursor: 'pointer', borderBottom: '1px solid var(--mantine-color-default-border)' }}
                    bg={t.id === hiloId ? 'var(--mantine-color-default-hover)' : undefined}
                    onClick={() => setHiloId(t.id)}
                  >
                    <Group justify="space-between" wrap="nowrap" gap="xs">
                      <Text fw={sinLeer > 0 ? 700 : 600} size="sm" truncate>
                        {nombreDe(t)}
                      </Text>
                      <Text
                        size="xs"
                        c={sinLeer > 0 ? 'teal' : 'dimmed'}
                        fw={sinLeer > 0 ? 700 : undefined}
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        {hora ? fmtHora.format(new Date(hora)) : ''}
                      </Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap" gap="xs">
                      <Text size="sm" c={sinLeer > 0 ? undefined : 'dimmed'} fw={sinLeer > 0 ? 600 : undefined} truncate>
                        {r?.ultimoTexto || asunto(t)}
                      </Text>
                      {sinLeer > 0 && (
                        <Badge color="teal" variant="filled" size="md" circle>
                          {sinLeer > 9 ? '9+' : sinLeer}
                        </Badge>
                      )}
                    </Group>
                  </Box>
                );
              })
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
                      const viaWhatsApp = m.extension?.some((x) => x.url === EXT.canal && x.valueCode === 'whatsapp');
                      const cuerpo = texto(m);
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
                          {cuerpo && (
                            <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                              {cuerpo}
                            </Text>
                          )}
                          {adjuntosDe(m).map((a, i) =>
                            a.contentType?.startsWith('image/') ? (
                              <a key={`${m.id}-adj-${i}`} href={a.url} target="_blank" rel="noreferrer">
                                <img
                                  src={a.url}
                                  alt={a.title ?? 'Imagen adjunta'}
                                  style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 8, display: 'block', marginTop: 6 }}
                                />
                              </a>
                            ) : (
                              <Text key={`${m.id}-adj-${i}`} size="sm" mt={6}>
                                <a href={a.url} target="_blank" rel="noreferrer">
                                  📎 {a.title ?? 'Adjunto'}
                                </a>
                              </Text>
                            ),
                          )}
                          <Text size="xs" c="dimmed" ta="right">
                            {viaWhatsApp ? '📱 WhatsApp · ' : ''}
                            {m.sent ? fmtHora.format(new Date(m.sent)) : ''}
                          </Text>
                        </Paper>
                      );
                    })}
                  </Stack>
                )}
              </ScrollArea>

              <Box style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
                {archivos.length > 0 && (
                  <Group gap={6} px="sm" pt="xs">
                    {archivos.map((f, i) => (
                      <Badge
                        key={`${f.name}-${i}`}
                        variant="light"
                        style={{ cursor: 'pointer', textTransform: 'none' }}
                        title="Quitar adjunto"
                        onClick={() => setArchivos((prev) => prev.filter((_, j) => j !== i))}
                      >
                        📎 {f.name} ✕
                      </Badge>
                    ))}
                  </Group>
                )}
                <Group p="sm" gap="xs" wrap="nowrap">
                  <FileButton
                    multiple
                    onChange={(fs) => {
                      if (fs.some((f) => f.size > MAX_ADJUNTO_BYTES)) {
                        notifications.show({
                          color: 'red',
                          title: 'Archivo muy grande',
                          message: 'WhatsApp acepta hasta 15 MB por archivo.',
                        });
                      }
                      setArchivos((prev) => [...prev, ...fs.filter((f) => f.size <= MAX_ADJUNTO_BYTES)]);
                    }}
                  >
                    {(props) => (
                      <ActionIcon {...props} variant="default" size="lg" title="Adjuntar archivo (PDF, imagen…)">
                        <IconPaperclip size={18} />
                      </ActionIcon>
                    )}
                  </FileButton>
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
                  <Button
                    leftSection={<IconSend size={16} />}
                    loading={enviando}
                    disabled={!respuesta.trim() && archivos.length === 0}
                    onClick={responder}
                  >
                    Enviar
                  </Button>
                </Group>
              </Box>
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
      // Espejo a WhatsApp de la primera línea de la conversación nueva.
      espejarWhatsApp(getReferenceString(createReference(paciente)), mensaje.trim()).catch(() => undefined);
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
