import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionIcon, Badge, Group, Indicator, Popover, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconBell, IconInbox, IconMessages } from '@tabler/icons-react';
import { useMedplum, useSubscription } from '@medplum/react';
import type { Bundle, Communication } from '@medplum/fhirtypes';
import type { Vista } from './Shell';

/**
 * Campanita de novedades de Recepción: solicitudes de turno pendientes y mensajes
 * de pacientes sin leer. Tiempo real por WebSocket (useSubscription; requiere la
 * entrada Subscription websocket en la policy "Recepción — Operativo") con polling
 * de respaldo (montar / foco / cada 60 s), igual que la campanita del portal.
 * Tocar una fila navega a la vista correspondiente.
 */

const POLL_MS = 60_000;

/** Mensaje de chat de un paciente que Recepción todavía no leyó. */
function esMensajeNoLeido(c: Communication): boolean {
  return Boolean(c.sender?.reference?.startsWith('Patient/')) && !c.received;
}

export function CampanitaNovedades({ onVista }: { onVista: (v: Vista) => void }): JSX.Element {
  const medplum = useMedplum();
  const [abierta, setAbierta] = useState(false);
  const [solicitudes, setSolicitudes] = useState(0);
  const [mensajes, setMensajes] = useState(0);

  const abiertaRef = useRef(false);
  useEffect(() => {
    abiertaRef.current = abierta;
  }, [abierta]);

  const refrescar = useCallback((): void => {
    // Nunca rompemos el header por la campanita: fallos silenciosos.
    medplum
      .get(`fhir/R4/Task?code=solicitud-turno&status=requested&_count=0&_total=accurate`, { cache: 'no-cache' })
      .then((b) => setSolicitudes((b as Bundle).total ?? 0))
      .catch(() => undefined);
    medplum
      .searchResources(
        'Communication',
        'part-of:missing=false&status=in-progress&received:missing=true&_count=100',
        { cache: 'no-cache' },
      )
      .then((ms) => setMensajes(ms.filter(esMensajeNoLeido).length))
      .catch(() => undefined);
  }, [medplum]);

  useEffect(() => {
    refrescar();
    const onFocus = (): void => refrescar();
    const interval = window.setInterval(refrescar, POLL_MS);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refrescar]);

  // Tiempo real: cualquier alta/cambio de solicitudes o mensajes refresca el badge
  // al instante. Si el WebSocket no está disponible, sigue mandando el polling.
  useSubscription('Task?code=solicitud-turno', refrescar, {
    onError: () => undefined,
    onWebSocketClose: () => undefined,
  });
  useSubscription('Communication?sent:missing=false', refrescar, {
    onError: () => undefined,
    onWebSocketClose: () => undefined,
  });

  const total = solicitudes + mensajes;

  const ir = (v: Vista): void => {
    setAbierta(false);
    onVista(v);
  };

  return (
    <Popover opened={abierta} onChange={setAbierta} position="bottom-end" width={320} radius="md" shadow="md">
      <Popover.Target>
        <Indicator label={total > 9 ? '9+' : total} size={16} color="red" disabled={total === 0} offset={4}>
          <ActionIcon
            variant="default"
            size="lg"
            aria-label="Novedades"
            title="Novedades"
            onClick={() => {
              setAbierta((v) => !v);
              refrescar();
            }}
          >
            <IconBell size={18} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Text fw={700} p="sm" pb={4}>
          Novedades
        </Text>
        <Stack gap={0}>
          <UnstyledButton onClick={() => ir('solicitudes')} p="sm">
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap">
                <IconInbox size={18} />
                <Text size="sm">Solicitudes de turno pendientes</Text>
              </Group>
              <Badge color={solicitudes > 0 ? 'red' : 'gray'} variant={solicitudes > 0 ? 'filled' : 'light'}>
                {solicitudes}
              </Badge>
            </Group>
          </UnstyledButton>
          <UnstyledButton onClick={() => ir('mensajes')} p="sm">
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap">
                <IconMessages size={18} />
                <Text size="sm">Mensajes de pacientes sin leer</Text>
              </Group>
              <Badge color={mensajes > 0 ? 'red' : 'gray'} variant={mensajes > 0 ? 'filled' : 'light'}>
                {mensajes}
              </Badge>
            </Group>
          </UnstyledButton>
          {total === 0 && (
            <Text size="xs" c="dimmed" p="sm" pt={4}>
              Todo al día. Las solicitudes nuevas y los mensajes de pacientes aparecen acá al instante.
            </Text>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
