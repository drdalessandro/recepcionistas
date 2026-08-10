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
import { IconCalendarEvent, IconUserHeart, IconChartBar, IconCashBanknote, IconLicense, IconLogout, IconSun, IconMoon, IconInbox, IconMessages, IconUsersGroup } from '@tabler/icons-react';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { getDisplayString } from '@medplum/core';
import { CampanitaNovedades } from './CampanitaNovedades';

export type Vista = 'agenda' | 'solicitudes' | 'duplicados' | 'mensajes' | 'planes' | 'atender' | 'reportes' | 'caja';

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
              Biowellness
            </Title>
            <Text c="dimmed" size="sm" visibleFrom="sm">
              Recepción
            </Text>
          </Group>

          <SegmentedControl
            size="xs"
            value={vista}
            onChange={(v) => onVista(v as Vista)}
            // Orden por frecuencia + urgencia de uso en recepción (decisión de
            // Andrés): la acción del mostrador primero, luego la agenda del día,
            // después lo time-sensitive con badge (solicitudes/mensajes), y al
            // final las tareas ocasionales de mantenimiento/supervisión.
            data={[
              { value: 'atender', label: segLabel(<IconUserHeart size={15} />, 'Atender') },
              { value: 'agenda', label: segLabel(<IconCalendarEvent size={15} />, 'Agenda') },
              { value: 'solicitudes', label: segLabel(<IconInbox size={15} />, 'Solicitudes', solicitudesPendientes, 'red') },
              { value: 'mensajes', label: segLabel(<IconMessages size={15} />, 'Mensajes', mensajesSinLeer) },
              { value: 'planes', label: segLabel(<IconLicense size={15} />, 'Planes') },
              { value: 'duplicados', label: segLabel(<IconUsersGroup size={15} />, 'Duplicados') },
              { value: 'reportes', label: segLabel(<IconChartBar size={15} />, 'Reportes') },
              { value: 'caja', label: segLabel(<IconCashBanknote size={15} />, 'Caja') },
            ]}
          />

          <Group gap="xs" wrap="nowrap">
            <Text size="sm" visibleFrom="lg">
              {profile ? getDisplayString(profile) : ''}
            </Text>
            <CampanitaNovedades
              onVista={onVista}
              onMensajesSinLeer={setMensajesSinLeer}
              onSolicitudesPendientes={setSolicitudesPendientes}
            />
            <ActionIcon
              variant="default"
              size="md"
              onClick={() => setColorScheme(oscuro ? 'light' : 'dark')}
              aria-label={oscuro ? 'Activar modo claro' : 'Activar modo oscuro'}
              title={oscuro ? 'Modo claro' : 'Modo oscuro'}
            >
              {oscuro ? <IconSun size={16} /> : <IconMoon size={16} />}
            </ActionIcon>
            <Button
              size="xs"
              variant="light"
              color="gray"
              leftSection={<IconLogout size={15} />}
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
