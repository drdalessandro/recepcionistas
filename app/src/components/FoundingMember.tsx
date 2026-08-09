import { useState } from 'react';
import { Alert, Badge, Button, Group, Popover, Stack, Text } from '@mantine/core';
import { IconCrown, IconInfoCircle } from '@tabler/icons-react';
import type { Patient } from '@medplum/fhirtypes';
import { medplum } from '../medplum';
import { mensajeError } from '../lib/bots';
import { SYSTEM } from '@bw/fhir/identifiers';
import { conMarcaFm, numeroFm, sinMarcaFm } from '@bw/fhir/founding';
import { avisoCupoFm, cohorteFm, COHORTE_FM_LABELS, proximoNumeroFm, type AvisoCupoFm } from '@bw/lib/fm';

/**
 * Marca de Founding Member en la ficha (R-09, programa FM-100).
 *
 * El número lo asigna el sistema (máximo del padrón + 1) y el número define la
 * cohorte: 1–50 el 1 a 1 de Andrés, 51–100 la Web (founding.html). El cupo
 * AVISA y nunca bloquea. El padrón se cuenta buscando el identifier
 * `SYSTEM.fm` (por eso la marca es identifier + extensión, ver @bw/fhir/founding).
 *
 * Concurrencia: si dos recepcionistas marcan a la vez pueden repetir número
 * (una sola computadora de mostrador hoy; se asume aceptable).
 */
export function FoundingMember({
  paciente,
  onCambio,
}: {
  paciente: Patient;
  onCambio: (p: Patient) => void;
}): JSX.Element {
  const numero = numeroFm(paciente);
  const [abierto, setAbierto] = useState(false);
  const [propuesta, setPropuesta] = useState<{ numero: number; aviso: AvisoCupoFm } | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function proponer(): Promise<void> {
    setCargando(true);
    setError(null);
    try {
      // Padrón completo de fundadores (≤100 + margen): el identifier es buscable.
      const padron = await medplum.searchResources('Patient', {
        identifier: `${SYSTEM.fm}|`,
        _count: '200',
        _elements: 'identifier',
      });
      const numeros = padron.map((p) => numeroFm(p)).filter((n): n is number => n !== undefined);
      const proximo = proximoNumeroFm(numeros);
      setPropuesta({ numero: proximo, aviso: avisoCupoFm(proximo) });
      setAbierto(true);
    } catch (e) {
      setError(mensajeError(e));
      setAbierto(true);
    } finally {
      setCargando(false);
    }
  }

  async function marcar(): Promise<void> {
    if (!propuesta) {
      return;
    }
    setCargando(true);
    setError(null);
    try {
      const actualizado = await medplum.updateResource(conMarcaFm(paciente, propuesta.numero));
      setAbierto(false);
      setPropuesta(null);
      onCambio(actualizado);
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setCargando(false);
    }
  }

  async function quitar(): Promise<void> {
    setCargando(true);
    setError(null);
    try {
      const actualizado = await medplum.updateResource(sinMarcaFm(paciente));
      setAbierto(false);
      onCambio(actualizado);
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setCargando(false);
    }
  }

  // Ya es FM: badge con número y cohorte + quitar (con confirmación).
  if (numero !== undefined) {
    return (
      <Popover opened={abierto} onChange={setAbierto} position="bottom-start" withArrow shadow="md">
        <Popover.Target>
          <Badge
            size="lg"
            color="yellow"
            variant="filled"
            leftSection={<IconCrown size={14} />}
            style={{ cursor: 'pointer' }}
            onClick={() => setAbierto((v) => !v)}
          >
            Founding Nº {numero} · {COHORTE_FM_LABELS[cohorteFm(numero)]}
          </Badge>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="xs" maw={340}>
            <Text size="sm">
              20% OFF de por vida en sueltas y paquetes, ventana de reserva de 7 días. El número no se
              transfiere.
            </Text>
            {error && (
              <Alert color="orange" icon={<IconInfoCircle size={16} />}>
                {error}
              </Alert>
            )}
            <Group justify="flex-end" gap="xs">
              <Button size="xs" variant="subtle" onClick={() => setAbierto(false)}>
                Cerrar
              </Button>
              <Button size="xs" color="red" variant="light" loading={cargando} onClick={() => void quitar()}>
                Quitar la marca
              </Button>
            </Group>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    );
  }

  // No es FM: proponer número + aviso de cupo antes de confirmar.
  return (
    <Popover opened={abierto} onChange={setAbierto} position="bottom-start" withArrow shadow="md">
      <Popover.Target>
        <Button
          size="xs"
          variant="light"
          color="yellow"
          leftSection={<IconCrown size={14} />}
          loading={cargando && !abierto}
          onClick={() => void proponer()}
        >
          Marcar Founding
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs" maw={340}>
          {propuesta && (
            <>
              <Text size="sm" fw={600}>
                Se le asigna el Nº {propuesta.numero} — cupo {COHORTE_FM_LABELS[cohorteFm(propuesta.numero)]}.
              </Text>
              <Text size="sm">20% OFF de por vida en sueltas y paquetes + ventana de reserva de 7 días.</Text>
              {propuesta.aviso.nivel !== 'ok' && (
                <Alert
                  color={propuesta.aviso.nivel === 'programa-completo' ? 'red' : 'yellow'}
                  icon={<IconInfoCircle size={16} />}
                >
                  {propuesta.aviso.mensaje}
                </Alert>
              )}
            </>
          )}
          {error && (
            <Alert color="orange" icon={<IconInfoCircle size={16} />}>
              {error}
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button size="xs" variant="subtle" onClick={() => setAbierto(false)}>
              Cancelar
            </Button>
            <Button size="xs" color="yellow" loading={cargando} disabled={!propuesta} onClick={() => void marcar()}>
              Confirmar
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
