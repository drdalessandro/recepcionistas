import { useEffect, useState } from 'react';
import { Alert, Button, Chip, Group, Modal, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { HORARIO_SEMANAL } from '@bw/config/horario';
import { SERVICIOS, getServicio, nombreServicioRecepcion } from '@bw/config/catalogo';
import {
  DIAS_LABEL,
  ESPERA_NOTA_MAX,
  FRANJAS,
  FRANJAS_LABEL,
  finDelDia,
  validarEspera,
  vencimientoPorDefecto,
  type Franja,
} from '@bw/lib/lista-espera';
import { anotarEspera } from '../lib/espera';
import { mensajeError } from '../lib/bots';

/**
 * Anotar a alguien en la lista de espera: no hay lugar y quiere venir.
 *
 * Hasta hoy ese momento no dejaba nada. La persona se iba, y cuando media hora
 * después alguien cancelaba, el hueco quedaba libre sin que nadie se enterara —
 * mientras el portal ya le prometía "te avisamos apenas se libere alguno".
 *
 * Las preferencias son OPCIONALES pero valen la pena: sin ellas se la llama por
 * cualquier horario de esa terapia, y el aviso que no sirve enseña a ignorar los
 * avisos. Con "martes o jueves, a la tarde", solo suena cuando de verdad le sirve.
 */
export function ListaEsperaModal({
  abierto,
  pacienteRef,
  pacienteNombre,
  servicioInicial,
  onCerrar,
  onAnotado,
}: {
  abierto: boolean;
  pacienteRef: string;
  pacienteNombre?: string;
  /** Lo que se estaba intentando reservar cuando no hubo lugar. */
  servicioInicial?: string | null;
  onCerrar: () => void;
  onAnotado?: () => void;
}): JSX.Element {
  const [servicio, setServicio] = useState<string | null>(servicioInicial ?? null);
  const [dias, setDias] = useState<string[]>([]);
  const [franjas, setFranjas] = useState<string[]>([]);
  const [hasta, setHasta] = useState(() => isoDia(vencimientoPorDefecto(new Date())));
  const [nota, setNota] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Al abrir desde "no hay lugar para esto", el servicio viene puesto.
  useEffect(() => {
    if (abierto) {
      setServicio(servicioInicial ?? null);
    }
  }, [abierto, servicioInicial]);

  async function guardar(): Promise<void> {
    const limite = hasta ? finDelDia(new Date(`${hasta}T12:00:00-03:00`)) : undefined;
    const v = validarEspera({ servicioCodigo: servicio ?? undefined, hasta: limite, nota });
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      const ahora = new Date();
      await anotarEspera({
        pacienteRef,
        pacienteNombre,
        servicioCodigo: servicio as string,
        categoria: getServicio(servicio as string).categoria,
        desde: ahora,
        hasta: limite as Date,
        dias: dias.map(Number),
        franjas: franjas as Franja[],
        nota: nota.trim() || undefined,
        creadaEn: ahora,
      });
      setDias([]);
      setFranjas([]);
      setNota('');
      onAnotado?.();
      onCerrar();
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal opened={abierto} onClose={onCerrar} title="Anotar en la lista de espera" size="md">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Cuando se libere un lugar de esta terapia que le sirva, el sistema avisa acá con el teléfono a mano. El lugar
          no queda reservado: se le ofrece y confirma quien conteste primero.
        </Text>

        <Select
          label="¿Qué está esperando?"
          placeholder="Elegí el servicio"
          data={SERVICIOS.map((s) => ({ value: s.codigo, label: nombreServicioRecepcion(s) }))}
          value={servicio}
          onChange={setServicio}
          searchable
        />

        <div>
          <Text size="sm" fw={500}>
            ¿Qué días le sirven?
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            Sin elegir ninguno, cualquier día.
          </Text>
          <Chip.Group multiple value={dias} onChange={setDias}>
            <Group gap="xs">
              {HORARIO_SEMANAL.filter((h) => h.abierto).map((h) => (
                <Chip key={h.dia} value={String(h.dia)} variant="light" size="sm">
                  {DIAS_LABEL[h.dia]?.slice(0, 3)}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        </div>

        <div>
          <Text size="sm" fw={500}>
            ¿En qué franja?
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            Sin elegir ninguna, cualquier horario.
          </Text>
          <Chip.Group multiple value={franjas} onChange={setFranjas}>
            <Group gap="xs">
              {FRANJAS.map((f) => (
                <Chip key={f} value={f} variant="light" size="sm">
                  {FRANJAS_LABEL[f]}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        </div>

        <TextInput
          label="Espera hasta"
          description="Pasada esa fecha deja de recibir avisos sola: nadie tiene que limpiar la lista."
          type="date"
          value={hasta}
          min={isoDia(new Date())}
          onChange={(e) => setHasta(e.currentTarget.value)}
        />

        <Textarea
          label="Nota (opcional)"
          placeholder="Ej.: después de las 19 no puede, prefiere avisarle por WhatsApp"
          autosize
          minRows={2}
          maxLength={ESPERA_NOTA_MAX}
          value={nota}
          onChange={(e) => setNota(e.currentTarget.value)}
        />

        {error && (
          <Alert color="orange" icon={<IconInfoCircle size={16} />}>
            {error}
          </Alert>
        )}

        <Group justify="flex-end" mt="xs">
          <Button variant="default" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button onClick={() => void guardar()} loading={guardando}>
            Anotar en la lista
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Fecha en formato de input nativo (YYYY-MM-DD), en hora de Argentina. */
function isoDia(f: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(f);
}
