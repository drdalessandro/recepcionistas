import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, Stack, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconBrandWhatsapp, IconCheck, IconSend, IconUserPlus } from '@tabler/icons-react';
import { useMedplum, useSubscription } from '@medplum/react';
import type { Task } from '@medplum/fhirtypes';
import { COD, TIPO_AVISO } from '@bw/fhir/identifiers';
import { enviarWhatsApp, mensajeError } from '../lib/bots';
import { NuevoPacienteModal } from '../components/NuevoPacienteModal';

/**
 * Avisos automáticos del sistema a Recepción (`Task code=aviso-recepcion`).
 *
 * Hasta 2026-08-12 estas alertas se creaban solo con el título en `code.text`:
 * como las búsquedas FHIR por token no miran el texto, NINGUNA pantalla las
 * listaba y el aviso moría en la base (WhatsApp de número desconocido, pago
 * duplicado a devolver, pago acreditado sin registro, seña de reserva vencida,
 * diferencia de arqueo de caja). Esta vista es donde aparecen.
 *
 * El aviso de WhatsApp desconocido trae teléfono y texto en `input`, así que se
 * le puede responder por WhatsApp o crearle la ficha sin salir de acá.
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

function dato(t: Task, campo: string): string | undefined {
  return t.input?.find((i) => i.type?.text === campo)?.valueString;
}

export function Avisos({ onAtender }: { onAtender: (pacienteId: string) => void }): JSX.Element {
  const medplum = useMedplum();
  const [tasks, setTasks] = useState<Task[]>();
  const [resolviendo, setResolviendo] = useState<string>();
  const [respondiendo, setRespondiendo] = useState<string>();
  const [borradores, setBorradores] = useState<Record<string, string>>({});
  const [enviando, setEnviando] = useState<string>();
  const [altaDe, setAltaDe] = useState<Task>();

  const cargar = useCallback((): void => {
    medplum
      .searchResources('Task', `code=${COD.avisoRecepcion}&status=requested&_sort=-_lastUpdated&_count=100`, {
        cache: 'no-cache',
      })
      .then(setTasks)
      .catch((err) => notifications.show({ color: 'red', title: 'Error', message: mensajeError(err) }));
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

  useSubscription(`Task?code=${COD.avisoRecepcion}`, cargar, {
    onError: () => undefined,
    onWebSocketClose: () => undefined,
  });

  async function resolver(t: Task): Promise<void> {
    setResolviendo(t.id);
    try {
      await medplum.updateResource<Task>({ ...t, status: 'completed' });
      setTasks((prev) => prev?.filter((x) => x.id !== t.id));
    } catch (err) {
      notifications.show({ color: 'red', title: 'No se pudo resolver', message: mensajeError(err) });
    } finally {
      setResolviendo(undefined);
    }
  }

  /**
   * Responde por WhatsApp al número del aviso (sin ficha: va por `to`).
   * Ventana de 24 h de Meta: dentro, sale como texto libre; fuera, el bot cae
   * a la plantilla genérica aprobada. El resultado se reporta tal cual.
   */
  async function responder(t: Task): Promise<void> {
    const telefono = dato(t, 'telefono');
    const texto = (borradores[t.id ?? ''] ?? '').trim();
    if (!telefono || !texto) {
      return;
    }
    setEnviando(t.id);
    try {
      // Misma plantilla que las respuestas de Mensajes: sin Content SID propio
      // cae a la genérica aprobada ({{1}} = el texto), que es lo que queremos.
      const comm = await enviarWhatsApp({ to: telefono, template: 'mensaje-recepcion', body: texto });
      if (comm.status === 'completed') {
        notifications.show({ color: 'teal', title: 'Respuesta enviada', message: `WhatsApp enviado a ${telefono}.` });
        setBorradores((prev) => ({ ...prev, [t.id ?? '']: '' }));
        setRespondiendo(undefined);
      } else {
        notifications.show({
          color: 'orange',
          title: 'No salió',
          message:
            comm.status === 'preparation'
              ? 'Faltan credenciales de Twilio o el número es inválido.'
              : 'Twilio rechazó el mensaje. Revisalo con npm run whatsapp:entregas.',
        });
      }
    } catch (err) {
      notifications.show({ color: 'red', title: 'Error al enviar', message: mensajeError(err) });
    } finally {
      setEnviando(undefined);
    }
  }

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
        <IconAlertTriangle size={22} />
        <Title order={2}>Avisos</Title>
        <Badge variant="light" color={tasks.length > 0 ? 'red' : 'teal'}>
          {tasks.length} pendientes
        </Badge>
      </Group>

      {tasks.length === 0 ? (
        <Text c="dimmed">
          Nada pendiente. Acá aparecen los avisos del sistema: WhatsApp de números desconocidos, pagos que necesitan
          revisión y diferencias de caja.
        </Text>
      ) : (
        tasks.map((t) => {
          const esWhatsApp = dato(t, 'tipo') === TIPO_AVISO.whatsappDesconocido;
          const telefono = dato(t, 'telefono');
          const perfil = dato(t, 'perfil');
          const id = t.id ?? '';
          return (
            <Card key={t.id} withBorder radius="md" p="md">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ minWidth: 0 }}>
                  <Group gap="xs">
                    <Text fw={600}>{t.code?.text ?? 'Aviso'}</Text>
                    {esWhatsApp && (
                      <Badge size="sm" variant="light" color="green" leftSection={<IconBrandWhatsapp size={12} />}>
                        WhatsApp
                      </Badge>
                    )}
                  </Group>
                  {esWhatsApp && telefono && (
                    <Text size="sm" fw={500}>
                      {telefono}
                      {perfil ? ` · ${perfil}` : ''}
                    </Text>
                  )}
                  <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                    {esWhatsApp ? `“${dato(t, 'texto') ?? ''}”` : (t.description ?? '')}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t.authoredOn ? fmtFecha.format(new Date(t.authoredOn)) : ''}
                  </Text>
                </div>
                <Group gap="xs" wrap="nowrap">
                  {esWhatsApp && telefono && (
                    <>
                      <Button
                        size="xs"
                        variant="light"
                        color="green"
                        leftSection={<IconBrandWhatsapp size={15} />}
                        onClick={() => setRespondiendo(respondiendo === id ? undefined : id)}
                      >
                        Responder
                      </Button>
                      <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconUserPlus size={15} />}
                        onClick={() => setAltaDe(t)}
                      >
                        Crear ficha
                      </Button>
                    </>
                  )}
                  <Button
                    size="xs"
                    variant="light"
                    color="gray"
                    leftSection={<IconCheck size={15} />}
                    loading={resolviendo === t.id}
                    onClick={() => resolver(t)}
                  >
                    Resolver
                  </Button>
                </Group>
              </Group>

              {respondiendo === id && (
                <Stack gap="xs" mt="sm">
                  <Textarea
                    autosize
                    minRows={2}
                    placeholder="Escribí la respuesta que le llega por WhatsApp…"
                    value={borradores[id] ?? ''}
                    onChange={(e) => setBorradores((prev) => ({ ...prev, [id]: e.currentTarget.value }))}
                  />
                  <Group justify="space-between">
                    <Text size="xs" c="dimmed">
                      Si pasaron más de 24 h desde su mensaje, WhatsApp solo permite plantillas: el sistema usa la
                      genérica aprobada.
                    </Text>
                    <Button
                      size="xs"
                      leftSection={<IconSend size={15} />}
                      loading={enviando === id}
                      disabled={!(borradores[id] ?? '').trim()}
                      onClick={() => responder(t)}
                    >
                      Enviar
                    </Button>
                  </Group>
                </Stack>
              )}
            </Card>
          );
        })
      )}

      <Alert variant="light" color="gray">
        Al crear la ficha con el teléfono, los próximos WhatsApp de esa persona entran solos a <b>Mensajes</b>.
      </Alert>

      <NuevoPacienteModal
        abierto={Boolean(altaDe)}
        telefonoInicial={altaDe ? dato(altaDe, 'telefono') : undefined}
        nombreInicial={altaDe ? dato(altaDe, 'perfil') : undefined}
        onCerrar={() => setAltaDe(undefined)}
        onCreado={(pacienteId) => {
          // Con la ficha creada el aviso ya cumplió: se resuelve solo y se
          // abre el paciente para seguir (reservar, invitar al portal…).
          if (altaDe) {
            void resolver(altaDe);
          }
          setAltaDe(undefined);
          onAtender(pacienteId);
        }}
      />
    </Stack>
  );
}
