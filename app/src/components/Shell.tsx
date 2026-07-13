import { useState, type ReactNode } from 'react';
import {
  AppShell,
  Badge,
  Group,
  Title,
  SegmentedControl,
  Button,
  Text,
  ActionIcon,
  useMantineColorScheme,
  useComputedColorScheme,
} from '@mantine/core';
import { IconCalendarEvent, IconUserHeart, IconChartBar, IconLicense, IconLogout, IconSun, IconMoon, IconInbox, IconMessages } from '@tabler/icons-react';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { getDisplayString } from '@medplum/core';
import { CampanitaNovedades } from './CampanitaNovedades';

export type Vista = 'agenda' | 'solicitudes' | 'mensajes' | 'planes' | 'atender' | 'reportes';

interface ShellProps {
  vista: Vista;
  onVista: (v: Vista) => void;
  children: ReactNode;
}

export function Shell({ vista, onVista, children }: ShellProps): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { setColorScheme } = useMantineColorScheme();
  const esquema = useComputedColorScheme('light', { getInitialValueInEffect: true });
  const oscuro = esquema === 'dark';
  const [mensajesSinLeer, setMensajesSinLeer] = useState(0);
  const [solicitudesPendientes, setSolicitudesPendientes] = useState(0);

  return (
    <AppShell header={{ height: 64 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Title order={3} c="bio.7">
              BioWellness
            </Title>
            <Text c="dimmed" size="sm" visibleFrom="sm">
              Recepción
            </Text>
          </Group>

          <SegmentedControl
            value={vista}
            onChange={(v) => onVista(v as Vista)}
            data={[
              { value: 'agenda', label: segLabel(<IconCalendarEvent size={16} />, 'Agenda') },
              { value: 'solicitudes', label: segLabel(<IconInbox size={16} />, 'Solicitudes', solicitudesPendientes, 'red') },
              { value: 'mensajes', label: segLabel(<IconMessages size={16} />, 'Mensajes', mensajesSinLeer) },
              { value: 'planes', label: segLabel(<IconLicense size={16} />, 'Planes y sesiones') },
              { value: 'atender', label: segLabel(<IconUserHeart size={16} />, 'Atender paciente') },
              { value: 'reportes', label: segLabel(<IconChartBar size={16} />, 'Reportes') },
            ]}
          />

          <Group gap="sm" wrap="nowrap">
            <Text size="sm" visibleFrom="sm">
              {profile ? getDisplayString(profile) : ''}
            </Text>
            <CampanitaNovedades
              onVista={onVista}
              onMensajesSinLeer={setMensajesSinLeer}
              onSolicitudesPendientes={setSolicitudesPendientes}
            />
            <ActionIcon
              variant="default"
              size="lg"
              onClick={() => setColorScheme(oscuro ? 'light' : 'dark')}
              aria-label={oscuro ? 'Activar modo claro' : 'Activar modo oscuro'}
              title={oscuro ? 'Modo claro' : 'Modo oscuro'}
            >
              {oscuro ? <IconSun size={18} /> : <IconMoon size={18} />}
            </ActionIcon>
            <Button
              variant="light"
              color="gray"
              leftSection={<IconLogout size={16} />}
              onClick={() => medplum.signOut().then(() => window.location.reload())}
            >
              Salir
            </Button>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}

function segLabel(icon: ReactNode, label: string, pendientes = 0, color = 'teal'): ReactNode {
  return (
    <Group gap={6} wrap="nowrap">
      {icon}
      <span>{label}</span>
      {pendientes > 0 && (
        <Badge size="sm" circle color={color} variant="filled">
          {pendientes > 9 ? '9+' : pendientes}
        </Badge>
      )}
    </Group>
  );
}
