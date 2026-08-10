import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconCashBanknote, IconInfoCircle, IconLock } from '@tabler/icons-react';
import type { Basic, Invoice, PaymentReconciliation, Task } from '@medplum/fhirtypes';
import { medplum } from '../medplum';
import { mensajeError } from '../lib/bots';
import { EXT, SYSTEM } from '@bw/fhir/identifiers';
import {
  CAJA_FONDO_FIJO_ARS,
  CAJA_TOPE_GASTO_ARS,
  CATEGORIAS_GASTO,
  CATEGORIAS_GASTO_LABELS,
  type TipoMovimientoCaja,
} from '@bw/config/caja';
import { armarArqueo, saldoEsperado, validarGasto, type MovimientoCaja } from '@bw/lib/caja';
import { arqueoAPaymentReconciliation, basicAMovimiento, movimientoABasic, reconciliationAArqueo } from '@bw/fhir/caja';

const ars = (n: number): string => `$${n.toLocaleString('es-AR')}`;

const TIPO_LABELS: Record<TipoMovimientoCaja, string> = {
  egreso: 'Gasto (egreso)',
  reposicion: 'Reposición del fondo',
  ajuste: 'Ajuste (±)',
};

interface EstadoCaja {
  /** Último arqueo (o el fondo fijo si nunca hubo). */
  arranqueARS: number;
  desdeISO: string;
  ultimoArqueo?: { fechaISO: string; contadoARS: number };
  efectivoCobradoARS: number;
  movimientos: Array<{ mov: MovimientoCaja; fechaISO: string; autor?: string }>;
  esperadoARS: number;
}

/**
 * Caja chica (opción 2, Andrés 2026-08-09). El saldo esperado se DERIVA:
 * contado del último arqueo + efectivo cobrado (Invoices balanced con
 * medio-pago=efectivo) + reposiciones/ajustes − egresos. Los ingresos jamás se
 * re-registran acá. Parámetros provisorios en @bw/config/caja.
 */
export function Caja(): JSX.Element {
  const [estado, setEstado] = useState<EstadoCaja | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const cargar = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      // 1) Último arqueo (identifier del sistema de caja, el más reciente).
      const arqueos = await medplum.searchResources('PaymentReconciliation', {
        identifier: `${SYSTEM.caja}|`,
        _sort: '-created',
        _count: '1',
      });
      const ultimo = arqueos[0] ? reconciliationAArqueo(arqueos[0] as PaymentReconciliation) : undefined;
      const desdeISO = ultimo?.fechaISO ?? new Date(0).toISOString();
      const arranqueARS = ultimo?.contadoARS ?? CAJA_FONDO_FIJO_ARS;

      // 2) Efectivo cobrado desde entonces (fuente de verdad: Invoice).
      const invoices = (await medplum.searchResources('Invoice', {
        date: `ge${desdeISO}`,
        status: 'balanced',
        _count: '1000',
      })) as Invoice[];
      const efectivo = invoices.filter((i) =>
        i.extension?.some((e) => e.url === EXT.medioPago && e.valueString === 'efectivo'),
      );
      const efectivoCobradoARS = efectivo.reduce((acc, i) => acc + (i.totalGross?.value ?? 0), 0);

      // 3) Movimientos del período.
      const basics = (await medplum.searchResources('Basic', {
        code: `${SYSTEM.caja}|`,
        _sort: '-_lastUpdated',
        _count: '200',
      })) as Basic[];
      const movimientos: Array<{ mov: MovimientoCaja; fechaISO: string; autor?: string }> = [];
      for (const b of basics) {
        const mov = basicAMovimiento(b);
        const fechaISO = b.meta?.lastUpdated ?? '';
        if (mov && fechaISO > desdeISO) {
          movimientos.push({ mov, fechaISO, autor: b.meta?.author?.display });
        }
      }

      setEstado({
        arranqueARS,
        desdeISO,
        ultimoArqueo: ultimo,
        efectivoCobradoARS,
        movimientos,
        esperadoARS: saldoEsperado(arranqueARS, efectivoCobradoARS, movimientos.map((m) => m.mov)),
      });
    } catch (e) {
      setError(mensajeError(e));
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <Stack gap="lg">
      <Group gap="sm">
        <IconCashBanknote size={28} />
        <Title order={2}>Caja chica</Title>
      </Group>

      {error && (
        <Alert color="orange" icon={<IconInfoCircle size={16} />}>
          {error}
        </Alert>
      )}
      {ok && <Alert color="bio">{ok}</Alert>}

      {estado && (
        <>
          <SimpleGrid cols={{ base: 2, md: 4 }}>
            <Tarjeta titulo="Saldo esperado" valor={ars(estado.esperadoARS)} destacada />
            <Tarjeta titulo="Efectivo cobrado (período)" valor={ars(estado.efectivoCobradoARS)} />
            <Tarjeta
              titulo="Egresos (período)"
              valor={ars(estado.movimientos.filter((m) => m.mov.tipo === 'egreso').reduce((a, m) => a + Math.abs(m.mov.montoARS), 0))}
            />
            <Tarjeta
              titulo="Último arqueo"
              valor={
                estado.ultimoArqueo
                  ? `${ars(estado.ultimoArqueo.contadoARS)} · ${new Date(estado.ultimoArqueo.fechaISO).toLocaleDateString('es-AR')}`
                  : `Sin arqueos (fondo ${ars(CAJA_FONDO_FIJO_ARS)})`
              }
            />
          </SimpleGrid>

          <RegistrarMovimiento onRegistrado={async (msj) => { setOk(msj); await cargar(); }} onError={setError} />

          <MovimientosDelPeriodo movimientos={estado.movimientos} />

          <CerrarCaja estado={estado} onCerrado={async (msj) => { setOk(msj); await cargar(); }} onError={setError} />
        </>
      )}
    </Stack>
  );
}

function Tarjeta({ titulo, valor, destacada }: { titulo: string; valor: string; destacada?: boolean }): JSX.Element {
  return (
    <Card withBorder padding="md" radius="md">
      <Text size="xs" c="dimmed">
        {titulo}
      </Text>
      <Text fw={700} size={destacada ? 'xl' : 'md'} c={destacada ? 'bio' : undefined}>
        {valor}
      </Text>
    </Card>
  );
}

function RegistrarMovimiento({
  onRegistrado,
  onError,
}: {
  onRegistrado: (msj: string) => Promise<void>;
  onError: (e: string) => void;
}): JSX.Element {
  const [tipo, setTipo] = useState<TipoMovimientoCaja>('egreso');
  const [monto, setMonto] = useState<number | string>('');
  const [categoria, setCategoria] = useState<string | null>(null);
  const [detalle, setDetalle] = useState('');
  const [autorizado, setAutorizado] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [errores, setErrores] = useState<string[]>([]);

  const montoNum = typeof monto === 'number' ? monto : Number(monto) || 0;
  const superaTope = tipo === 'egreso' && montoNum > CAJA_TOPE_GASTO_ARS;

  async function registrar(): Promise<void> {
    setErrores([]);
    if (tipo === 'egreso') {
      const v = validarGasto({ montoARS: montoNum, categoria: categoria ?? undefined, autorizado });
      if (!v.ok) {
        setErrores(v.errores);
        return;
      }
    } else if (!Number.isFinite(montoNum) || montoNum === 0) {
      setErrores(['El monto no puede ser cero.']);
      return;
    }
    setGuardando(true);
    try {
      const mov: MovimientoCaja = {
        tipo,
        montoARS: montoNum,
        ...(tipo === 'egreso' ? { categoria: categoria ?? undefined, autorizado } : {}),
        ...(detalle.trim() ? { detalle: detalle.trim() } : {}),
      };
      await medplum.createResource(movimientoABasic(mov, new Date().toISOString()));
      setMonto('');
      setDetalle('');
      setCategoria(null);
      setAutorizado(false);
      await onRegistrado(`${TIPO_LABELS[tipo]} registrado: ${ars(Math.abs(montoNum))}.`);
    } catch (e) {
      onError(mensajeError(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card withBorder padding="md" radius="md">
      <Title order={4}>Registrar movimiento</Title>
      <Group grow align="flex-end" mt="sm">
        <Select
          label="Tipo"
          data={Object.entries(TIPO_LABELS).map(([value, label]) => ({ value, label }))}
          value={tipo}
          onChange={(v) => setTipo((v as TipoMovimientoCaja) ?? 'egreso')}
        />
        <NumberInput
          label={tipo === 'ajuste' ? 'Monto (± ARS)' : 'Monto (ARS)'}
          value={monto}
          onChange={setMonto}
          min={tipo === 'ajuste' ? undefined : 0}
          thousandSeparator="."
          decimalSeparator=","
        />
        {tipo === 'egreso' && (
          <Select
            label="Categoría"
            placeholder="Elegí el rubro"
            data={CATEGORIAS_GASTO.map((c) => ({ value: c, label: CATEGORIAS_GASTO_LABELS[c] }))}
            value={categoria}
            onChange={setCategoria}
          />
        )}
      </Group>
      <TextInput mt="sm" label="Detalle" placeholder="Ej.: alcohol y algodón — farmacia" value={detalle} onChange={(e) => setDetalle(e.currentTarget.value)} />
      {superaTope && (
        <Checkbox
          mt="sm"
          label={`Supera el tope de ${ars(CAJA_TOPE_GASTO_ARS)}: tengo autorización previa de Administración`}
          checked={autorizado}
          onChange={(e) => setAutorizado(e.currentTarget.checked)}
        />
      )}
      {errores.length > 0 && (
        <Alert color="orange" mt="sm" icon={<IconInfoCircle size={16} />}>
          {errores.join(' ')}
        </Alert>
      )}
      <Group mt="md">
        <Button onClick={() => void registrar()} loading={guardando} disabled={!montoNum}>
          Registrar
        </Button>
      </Group>
    </Card>
  );
}

function MovimientosDelPeriodo({
  movimientos,
}: {
  movimientos: Array<{ mov: MovimientoCaja; fechaISO: string; autor?: string }>;
}): JSX.Element {
  if (movimientos.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Sin movimientos desde el último arqueo.
      </Text>
    );
  }
  return (
    <Card withBorder padding="md" radius="md">
      <Title order={4}>Movimientos del período</Title>
      <Table mt="sm" striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Fecha</Table.Th>
            <Table.Th>Tipo</Table.Th>
            <Table.Th>Categoría</Table.Th>
            <Table.Th>Detalle</Table.Th>
            <Table.Th>Quién</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>Monto</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {movimientos.map((m, i) => (
            <Table.Tr key={i}>
              <Table.Td>{new Date(m.fechaISO).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</Table.Td>
              <Table.Td>
                <Badge variant="light" color={m.mov.tipo === 'egreso' ? 'red' : m.mov.tipo === 'reposicion' ? 'bio' : 'yellow'}>
                  {TIPO_LABELS[m.mov.tipo]}
                </Badge>
                {m.mov.autorizado && (
                  <Badge ml={4} variant="light" color="grape">
                    autorizado
                  </Badge>
                )}
              </Table.Td>
              <Table.Td>{m.mov.categoria ? CATEGORIAS_GASTO_LABELS[m.mov.categoria as keyof typeof CATEGORIAS_GASTO_LABELS] ?? m.mov.categoria : '—'}</Table.Td>
              <Table.Td>{m.mov.detalle ?? '—'}</Table.Td>
              <Table.Td>{m.autor ?? '—'}</Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>
                {m.mov.tipo === 'egreso' ? `−${ars(Math.abs(m.mov.montoARS))}` : ars(m.mov.montoARS)}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}

function CerrarCaja({
  estado,
  onCerrado,
  onError,
}: {
  estado: EstadoCaja;
  onCerrado: (msj: string) => Promise<void>;
  onError: (e: string) => void;
}): JSX.Element {
  const [contado, setContado] = useState<number | string>('');
  const [cerrando, setCerrando] = useState(false);
  const [confirmar, setConfirmar] = useState(false);

  const contadoNum = typeof contado === 'number' ? contado : Number(contado) || 0;

  async function cerrar(): Promise<void> {
    const r = armarArqueo(estado.esperadoARS, contadoNum);
    // Con diferencia: primer click avisa, el segundo confirma (patrón TurnoModal).
    if (!r.cuadra && !confirmar) {
      setConfirmar(true);
      return;
    }
    setCerrando(true);
    try {
      await medplum.createResource(
        arqueoAPaymentReconciliation(r, { desdeISO: estado.desdeISO, hastaISO: new Date().toISOString() }),
      );
      if (!r.cuadra) {
        // Alerta a Administración: la diferencia no puede pasar en silencio.
        await medplum.createResource<Task>({
          resourceType: 'Task',
          status: 'requested',
          intent: 'order',
          priority: 'urgent',
          code: { text: 'Diferencia en arqueo de caja' },
          description: `Arqueo con diferencia de ${ars(r.diferenciaARS)}: contado ${ars(r.contadoARS)} vs esperado ${ars(r.esperadoARS)}. Revisar con Administración.`,
        });
      }
      setContado('');
      setConfirmar(false);
      await onCerrado(
        r.cuadra
          ? `Caja cerrada: ${ars(r.contadoARS)} — cuadra perfecto.`
          : `Caja cerrada CON DIFERENCIA de ${ars(r.diferenciaARS)}. Se avisó a Administración.`,
      );
    } catch (e) {
      onError(mensajeError(e));
    } finally {
      setCerrando(false);
    }
  }

  const dif = contadoNum - estado.esperadoARS;

  return (
    <Card withBorder padding="md" radius="md">
      <Group gap="xs">
        <IconLock size={18} />
        <Title order={4}>Cerrar caja (arqueo)</Title>
      </Group>
      <Text size="sm" c="dimmed" mt={4}>
        Contá el efectivo físico del cajón e ingresá el total. El sistema espera {ars(estado.esperadoARS)}.
      </Text>
      <Group align="flex-end" mt="sm">
        <NumberInput
          label="Efectivo contado (ARS)"
          value={contado}
          onChange={(v) => {
            setContado(v);
            setConfirmar(false);
          }}
          min={0}
          thousandSeparator="."
          decimalSeparator=","
          w={220}
        />
        <Button color={confirmar ? 'red' : 'bio'} onClick={() => void cerrar()} loading={cerrando} disabled={contado === ''}>
          {confirmar ? `Cerrar igual con diferencia de ${ars(dif)}` : 'Cerrar caja'}
        </Button>
      </Group>
      {contado !== '' && dif !== 0 && !confirmar && (
        <Alert color="yellow" mt="sm" icon={<IconInfoCircle size={16} />}>
          Diferencia de {ars(dif)} contra lo esperado. Recontá antes de cerrar; si cerrás así, se avisa a Administración.
        </Alert>
      )}
    </Card>
  );
}
