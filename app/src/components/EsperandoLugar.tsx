import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import { IconHourglass } from '@tabler/icons-react';
import { SERVICIOS, nombreServicioRecepcion } from '@bw/config/catalogo';
import { resumenEspera, type EntradaEspera } from '@bw/lib/lista-espera';
import { cargarEsperas, quitarEspera } from '../lib/espera';

/**
 * Quiénes están esperando lugar, en el orden en que se los llama.
 *
 * Vive en la Agenda a propósito: es la pantalla donde la recepcionista está
 * cuando alguien cancela y queda un hueco. El aviso automático cubre el caso en
 * que el hueco aparece solo; esta lista cubre el otro, que es igual de común —
 * se corrió un turno, sobró una franja, y hay que saber a quién ofrecérsela.
 *
 * Solo muestra esperas vigentes: las vencidas se apagan solas.
 */
export function EsperandoLugar(): JSX.Element | null {
  const [esperas, setEsperas] = useState<EntradaEspera[]>([]);
  const [quitando, setQuitando] = useState<string>();

  const cargar = useCallback((): void => {
    cargarEsperas()
      .then(setEsperas)
      .catch(() => setEsperas([]));
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  if (esperas.length === 0) {
    return null;
  }

  return (
    <Card withBorder radius="md" padding="md">
      <Group gap="xs" mb="sm">
        <IconHourglass size={18} />
        <Text fw={600}>Esperando lugar</Text>
        <Badge variant="light" color="gray">
          {esperas.length}
        </Badge>
        <Text size="xs" c="dimmed">
          por orden de llegada
        </Text>
      </Group>
      <Stack gap={6}>
        {esperas.map((e) => (
          <Group key={e.id} justify="space-between" wrap="nowrap" gap="xs">
            <div style={{ minWidth: 0 }}>
              <Text size="sm" fw={500}>
                {e.pacienteNombre ?? 'Paciente'}
              </Text>
              <Text size="xs" c="dimmed">
                {resumenEspera(e, nombreDeServicio(e.servicioCodigo))}
                {e.nota ? ` · ${e.nota}` : ''}
              </Text>
            </div>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              loading={quitando === e.id}
              onClick={() => {
                if (!e.id) {
                  return;
                }
                setQuitando(e.id);
                quitarEspera(e.id, 'Dada de baja desde la agenda')
                  .then(cargar)
                  .catch(() => undefined)
                  .finally(() => setQuitando(undefined));
              }}
            >
              Quitar
            </Button>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}

function nombreDeServicio(codigo: string): string {
  const s = SERVICIOS.find((x) => x.codigo === codigo);
  return s ? nombreServicioRecepcion(s) : codigo;
}
