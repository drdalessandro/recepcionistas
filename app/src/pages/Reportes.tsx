import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  NumberFormatter,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconRefresh, IconInfoCircle } from '@tabler/icons-react';
import { cargarReportes, type Reportes } from '../lib/reportes';
import { colorEstado, labelEstado } from '../lib/estados';

function Metric({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <Card withBorder radius="md" padding="lg">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      {children}
    </Card>
  );
}

function Pesos({ value }: { value: number }): JSX.Element {
  return <NumberFormatter prefix="$ " value={value} thousandSeparator="." decimalSeparator="," />;
}

export function Reportes(): JSX.Element {
  const [data, setData] = useState<Reportes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const refrescar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      setData(await cargarReportes());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar los reportes.');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void refrescar();
  }, [refrescar]);

  const hoy = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const maxOcup = data ? Math.max(1, ...data.ocupacion.map((o) => o.turnos)) : 1;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <Stack gap={0}>
          <Title order={2}>Reportes</Title>
          <Text c="dimmed" tt="capitalize">
            {hoy}
          </Text>
        </Stack>
        <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => void refrescar()} loading={cargando}>
          Actualizar
        </Button>
      </Group>

      {error && (
        <Alert color="red" icon={<IconInfoCircle size={16} />} title="No se pudo cargar">
          {error}
        </Alert>
      )}

      {!data && !error && (
        <Center mih={240}>
          <Loader />
        </Center>
      )}

      {data && (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
            <Metric label="Turnos hoy">
              <Text size="2rem" fw={700}>
                {data.hoy.turnos}
              </Text>
              <Group gap={6} mt="xs">
                {data.hoy.porEstado.map((e) => (
                  <Badge key={e.estado} color={colorEstado(e.estado)} variant="light">
                    {labelEstado(e.estado)}: {e.n}
                  </Badge>
                ))}
              </Group>
            </Metric>

            <Metric label="Ingresos hoy">
              <Text size="2rem" fw={700}>
                <Pesos value={data.hoy.ingresosARS} />
              </Text>
              <Text size="sm" c="dimmed">
                {data.hoy.cobros} cobros · señas <Pesos value={data.hoy.senasARS} />
              </Text>
            </Metric>

            <Metric label="A cobrar hoy">
              <Text size="2rem" fw={700} c={data.hoy.aCobrarARS > 0 ? 'orange.7' : undefined}>
                <Pesos value={data.hoy.aCobrarARS} />
              </Text>
              <Text size="sm" c="dimmed">
                {data.hoy.aCobrarN} facturas pendientes · mes <Pesos value={data.mes.aCobrarARS} />
              </Text>
            </Metric>

            <Metric label="WhatsApp hoy">
              <Text size="2rem" fw={700}>
                {data.hoy.whatsapp}
              </Text>
              <Text size="sm" c="dimmed">
                mensajes registrados
              </Text>
            </Metric>

            <Metric label="Ingresos del mes">
              <Text size="2rem" fw={700}>
                <Pesos value={data.mes.ingresosARS} />
              </Text>
              <Text size="sm" c="dimmed">
                {data.mes.turnos} turnos en el mes
              </Text>
            </Metric>
          </SimpleGrid>

          <Card withBorder radius="md" padding="lg">
            <Text fw={600} mb="sm">
              Ocupación de hoy por sala
            </Text>
            {data.ocupacion.length === 0 ? (
              <Text c="dimmed" size="sm">
                Sin turnos hoy.
              </Text>
            ) : (
              <Stack gap="xs">
                {data.ocupacion.map((o) => (
                  <div key={o.sala}>
                    <Group justify="space-between">
                      <Text size="sm">{o.sala}</Text>
                      <Text size="sm" fw={600}>
                        {o.turnos}
                      </Text>
                    </Group>
                    <Progress value={(o.turnos / maxOcup) * 100} color="bio" size="sm" />
                  </div>
                ))}
              </Stack>
            )}
          </Card>

          {/* Caso 11 · el único cuadro que mide lo que NO podemos vender. */}
          <Card withBorder radius="md" padding="lg">
            <Group justify="space-between" align="flex-start" mb="sm">
              <div>
                <Text fw={600}>Nos piden y no tenemos</Text>
                <Text size="sm" c="dimmed">
                  Pedidos del mostrador fuera del catálogo · últimos {data.demanda.dias} días
                </Text>
              </div>
              {data.demanda.total > 0 && (
                <Badge size="lg" variant="light" color="grape">
                  {data.demanda.total}
                </Badge>
              )}
            </Group>
            {data.demanda.pedidos.length === 0 ? (
              <Text c="dimmed" size="sm">
                Todavía no se registró ninguno. Se cargan solos al elegir “Otra cosa” en Registrar consulta.
              </Text>
            ) : (
              <Stack gap="xs">
                {data.demanda.pedidos.map((p) => (
                  <Group key={p.clave} justify="space-between" wrap="nowrap">
                    <Text size="sm" style={{ textTransform: 'capitalize' }}>
                      {p.etiqueta}
                    </Text>
                    <Group gap="xs" wrap="nowrap">
                      {p.ultimaFechaISO && (
                        <Text size="xs" c="dimmed">
                          últ. {diaMes(p.ultimaFechaISO)}
                        </Text>
                      )}
                      <Badge variant="light" color={p.n > 1 ? 'grape' : 'gray'}>
                        {p.n}
                      </Badge>
                    </Group>
                  </Group>
                ))}
              </Stack>
            )}
          </Card>
        </>
      )}
    </Stack>
  );
}

/**
 * `dd/mm` a partir del string ISO, sin pasar por `Date`: `new Date('2026-08-14')`
 * se interpreta como medianoche UTC y en Argentina se muestra un día antes.
 */
function diaMes(iso: string): string {
  const [, mes, dia] = iso.slice(0, 10).split('-');
  return `${dia}/${mes}`;
}
