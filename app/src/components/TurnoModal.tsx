import { useEffect, useState } from 'react';
import { Alert, Anchor, Badge, Button, Checkbox, Divider, Group, Modal, NumberFormatter, Select, Stack, Text } from '@mantine/core';
import type { Invoice } from '@medplum/fhirtypes';
import { getReferenceString } from '@medplum/core';
import { useMedplumProfile } from '@medplum/react';
import { medplum } from '../medplum';
import {
  cambiarEstadoTurno,
  cobrarPendiente,
  pagarSena,
  linkMercadoPago,
  mensajeError,
  type EstadoTurno,
  type ResultadoLinkMP,
} from '../lib/bots';
import { colorEstado, labelEstado } from '../lib/estados';
import { MEDIOS_SELECT } from '../lib/medios';
import { EXT, SYSTEM } from '@bw/fhir/identifiers';
import type { TurnoTimeline } from '../lib/timeline';

const fmtVence = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
});

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
  const [saldo, setSaldo] = useState<Invoice | null>(null);
  // R-14: si el turno se pagó con plan hay una sesión que devolver al cancelar.
  const [usaPlan, setUsaPlan] = useState(false);
  const [fuerzaMayor, setFuerzaMayor] = useState(false);
  const perfil = useMedplumProfile();
  const [confirmarCompletar, setConfirmarCompletar] = useState(false);
  const [venceSena, setVenceSena] = useState<Date | null>(null);

  const tentativo = turno?.estado === 'pending' || turno?.estado === 'proposed';
  const saldoPendiente = saldo?.status === 'issued';
  const saldoARS = saldo?.totalGross?.value ?? 0;

  // Saldo restante del turno (Invoice `saldo-{appointmentId}` emitido al cobrar
  // la seña). Si no existe (plan, turno viejo), no se muestra nada. Para los
  // tentativos, en cambio, se lee el vencimiento de la seña (R-19).
  useEffect(() => {
    setSaldo(null);
    setMp(null);
    setError(null);
    setConfirmarCompletar(false);
    setVenceSena(null);
    setFuerzaMayor(false);
    setUsaPlan(false);
    if (!turno) {
      return;
    }
    let vivo = true;
    // ¿El turno se pagó con un plan? Solo entonces hay una sesión que devolver
    // (R-14), y solo entonces tiene sentido ofrecer la excepción.
    medplum
      .readResource('Appointment', turno.appointmentId)
      .then((a) => {
        if (vivo) {
          setUsaPlan(Boolean(a.extension?.some((x) => x.url === EXT.coberturaUsada)));
        }
      })
      .catch(() => undefined);
    if (turno.estado === 'pending' || turno.estado === 'proposed') {
      medplum
        .readResource('Appointment', turno.appointmentId)
        .then((a) => {
          const v = a.extension?.find((x) => x.url === EXT.venceSena)?.valueDateTime;
          if (vivo) {
            setVenceSena(v ? new Date(v) : null);
          }
        })
        .catch(() => undefined);
    } else {
      medplum
        .searchOne('Invoice', `identifier=${SYSTEM.invoice}|saldo-${turno.appointmentId}`)
        .then((inv) => {
          if (vivo) {
            setSaldo(inv ?? null);
          }
        })
        .catch(() => undefined);
    }
    return () => {
      vivo = false;
    };
  }, [turno]);

  async function cambiar(estado: EstadoTurno): Promise<void> {
    if (!turno) {
      return;
    }
    // Completar con saldo impago: primer click advierte, el segundo confirma.
    if (estado === 'fulfilled' && saldoPendiente && !confirmarCompletar) {
      setConfirmarCompletar(true);
      return;
    }
    setCargando(estado);
    setError(null);
    try {
      await cambiarEstadoTurno(turno.appointmentId, estado, {
        // R-14: solo aplica al cancelar. El bot decide si devuelve la sesión;
        // acá solo se declara la excepción.
        fuerzaMayorMedica: estado === 'cancelled' ? fuerzaMayor : undefined,
        declaradaPorRef: perfil ? getReferenceString(perfil) : undefined,
      });
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

  async function generarLinkMP(concepto: 'sena' | 'saldo' = 'sena'): Promise<void> {
    if (!turno) {
      return;
    }
    setCargando('mp');
    setError(null);
    setMp(null);
    try {
      setMp(await linkMercadoPago(turno.appointmentId, concepto));
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setCargando(null);
    }
  }

  async function cobrarSaldo(): Promise<void> {
    if (!saldo?.id || !medioPago) {
      return;
    }
    setCargando('saldo');
    setError(null);
    try {
      const r = await cobrarPendiente(saldo.id, medioPago);
      if (!r.ok) {
        setError(r.mensaje ?? 'No se pudo cobrar el saldo.');
        return;
      }
      setSaldo({ ...saldo, status: 'balanced' });
      setConfirmarCompletar(false);
      onCambiado();
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
              {venceSena && (
                <Text size="sm" c={venceSena.getTime() <= Date.now() ? 'red' : 'orange'}>
                  {venceSena.getTime() <= Date.now()
                    ? `⏰ La seña venció (${fmtVence.format(venceSena)}): el lugar se libera solo en la próxima corrida.`
                    : `⏰ El paciente ya tiene el link de pago por WhatsApp. Vence ${fmtVence.format(venceSena)}; después el lugar se libera solo.`}
                </Text>
              )}
              <Group align="flex-end">
                <Select label="Medio de pago" data={MEDIOS_SELECT} value={medioPago} onChange={setMedioPago} w={180} />
                <Button color="bio" loading={cargando === 'sena'} onClick={() => void registrarSena()}>
                  Registrar seña
                </Button>
                <Button variant="light" loading={cargando === 'mp'} onClick={() => void generarLinkMP('sena')}>
                  Link MercadoPago
                </Button>
              </Group>
            </>
          )}

          {/* Saldo restante (50%) del turno confirmado */}
          {saldoPendiente && (
            <>
              <Divider label="Saldo restante (50%)" labelPosition="center" />
              <Text size="sm">
                Debe: <NumberFormatter prefix="$ " value={saldoARS} thousandSeparator="." decimalSeparator="," />
              </Text>
              <Group align="flex-end">
                <Select label="Medio de pago" data={MEDIOS_SELECT} value={medioPago} onChange={setMedioPago} w={180} />
                <Button color="bio" loading={cargando === 'saldo'} onClick={() => void cobrarSaldo()}>
                  Cobrar saldo
                </Button>
                <Button variant="light" loading={cargando === 'mp'} onClick={() => void generarLinkMP('saldo')}>
                  Link MercadoPago
                </Button>
              </Group>
            </>
          )}
          {saldo?.status === 'balanced' && (
            <Text size="sm" c="teal" fw={600}>
              ✓ Saldo pagado
            </Text>
          )}

          {confirmarCompletar && saldoPendiente && (
            <Alert color="orange" variant="light" title="Saldo pendiente">
              Este turno tiene un saldo de{' '}
              <NumberFormatter prefix="$ " value={saldoARS} thousandSeparator="." decimalSeparator="," /> sin cobrar.
              Cobralo acá arriba, o tocá «Completar igual» si corresponde dejarlo pendiente.
            </Alert>
          )}

          {mp?.ok && mp.url && (
            <Alert color="bio" variant="light">
              Link de pago:{' '}
              <Anchor href={mp.url} target="_blank" rel="noreferrer">
                abrir checkout
              </Anchor>
              {(mp.montoARS ?? mp.senaARS) !== undefined && (
                <Text size="sm">
                  Monto:{' '}
                  <NumberFormatter
                    prefix="$ "
                    value={mp.montoARS ?? mp.senaARS}
                    thousandSeparator="."
                    decimalSeparator=","
                  />
                </Text>
              )}
            </Alert>
          )}
          {mp && !mp.ok && (
            <Alert color="yellow" variant="light">
              {mp.mensaje}
            </Alert>
          )}

          <Divider label="Estado del turno" labelPosition="center" />
          {/* R-14 · cancelar con 24 h o más devuelve la sesión al plan. Sobre esa
              hora ya se consume, salvo fuerza mayor médica — que es una excepción
              real (alguien se descompone) y por eso queda registrada con quién la
              declaró, en vez de resolverse por WhatsApp y sin rastro. */}
          {usaPlan && (
            <Checkbox
              checked={fuerzaMayor}
              onChange={(e) => setFuerzaMayor(e.currentTarget.checked)}
              label="Fuerza mayor médica: devolver la sesión aunque cancele fuera de las 24 h"
            />
          )}
          <Group>
            {ACCIONES.map((a) => (
              <Button
                key={a.estado}
                color={a.color}
                variant={a.estado === 'cancelled' ? 'light' : 'filled'}
                loading={cargando === a.estado}
                onClick={() => void cambiar(a.estado)}
              >
                {a.estado === 'fulfilled' && confirmarCompletar && saldoPendiente ? 'Completar igual' : a.label}
              </Button>
            ))}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
