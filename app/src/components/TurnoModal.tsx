import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Divider, Group, Modal, NumberFormatter, Select, Stack, Text } from '@mantine/core';
import {
  cambiarEstadoTurno,
  pagarSena,
  linkMercadoPago,
  mensajeError,
  type EstadoTurno,
  type ResultadoLinkMP,
} from '../lib/bots';
import { colorEstado, labelEstado } from '../lib/estados';
import { MEDIOS_SELECT } from '../lib/medios';
import type { TurnoTimeline } from '../lib/timeline';

const ACCIONES: Array<{ estado: EstadoTurno; label: string; color: string }> = [
  { estado: 'arrived', label: 'Llegó', color: 'orange' },
  { estado: 'checked-in', label: 'En curso', color: 'bio' },
  { estado: 'fulfilled', label: 'Completó', color: 'gray' },
  { estado: 'cancelled', label: 'Cancelar', color: 'red' },
];



function fmt(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function TurnoModal({
  turno,
  onClose,
  onCambiado,
}: {
  turno: TurnoTimeline | null;
  onClose: () => void;
  onCambiado: () => void;
}): JSX.Element {
  const [cargando, setCargando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [medioPago, setMedioPago] = useState<string | null>('efectivo');
  const [mp, setMp] = useState<ResultadoLinkMP | null>(null);

  const tentativo = turno?.estado === 'pending' || turno?.estado === 'proposed';

  async function cambiar(estado: EstadoTurno): Promise<void> {
    if (!turno) {
      return;
    }
    setCargando(estado);
    setError(null);
    try {
      await cambiarEstadoTurno(turno.appointmentId, estado);
      onCambiado();
      onClose();
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setCargando(null);
    }
  }

  async function registrarSena(): Promise<void> {
    if (!turno || !medioPago) {
      return;
    }
    setCargando('sena');
    setError(null);
    try {
      const r = await pagarSena(turno.appointmentId, medioPago);
      if (r.ok) {
        onCambiado();
        onClose();
      } else {
        setError(r.mensaje ?? 'No se pudo registrar la seña.');
      }
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setCargando(null);
    }
  }

  async function generarLinkMP(): Promise<void> {
    if (!turno) {
      return;
    }
    setCargando('mp');
    setError(null);
    setMp(null);
    try {
      setMp(await linkMercadoPago(turno.appointmentId));
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setCargando(null);
    }
  }

  return (
    <Modal opened={Boolean(turno)} onClose={onClose} title="Turno" centered>
      {turno && (
        <Stack gap="md">
          <div>
            <Text fw={700} size="lg">
              {turno.servicio}
            </Text>
            <Text>{turno.paciente || 'Paciente'}</Text>
            <Text c="dimmed" size="sm">
              {fmt(turno.inicioMin)}–{fmt(turno.finMin)}
            </Text>
          </div>

          <Group gap="xs">
            <Text size="sm">Estado:</Text>
            <Badge color={colorEstado(turno.estado)} variant="filled">
              {labelEstado(turno.estado)}
            </Badge>
          </Group>

          {error && (
            <Alert color="orange" variant="light">
              {error}
            </Alert>
          )}

          {tentativo && (
            <>
              <Divider label="Seña 50% para confirmar" labelPosition="center" />
              <Group align="flex-end">
                <Select label="Medio de pago" data={MEDIOS_SELECT} value={medioPago} onChange={setMedioPago} w={180} />
                <Button color="bio" loading={cargando === 'sena'} onClick={() => void registrarSena()}>
                  Registrar seña
                </Button>
                <Button variant="light" loading={cargando === 'mp'} onClick={() => void generarLinkMP()}>
                  Link MercadoPago
                </Button>
              </Group>
              {mp?.ok && mp.url && (
                <Alert color="bio" variant="light">
                  Link de pago:{' '}
                  <Anchor href={mp.url} target="_blank" rel="noreferrer">
                    abrir checkout
                  </Anchor>
                  {mp.senaARS !== undefined && (
                    <Text size="sm">
                      Seña: <NumberFormatter prefix="$ " value={mp.senaARS} thousandSeparator="." decimalSeparator="," />
                    </Text>
                  )}
                </Alert>
              )}
              {mp && !mp.ok && (
                <Alert color="yellow" variant="light">
                  {mp.mensaje}
                </Alert>
              )}
            </>
          )}

          <Divider label="Estado del turno" labelPosition="center" />
          <Group>
            {ACCIONES.map((a) => (
              <Button
                key={a.estado}
                color={a.color}
                variant={a.estado === 'cancelled' ? 'light' : 'filled'}
                loading={cargando === a.estado}
                onClick={() => void cambiar(a.estado)}
              >
                {a.label}
              </Button>
            ))}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
