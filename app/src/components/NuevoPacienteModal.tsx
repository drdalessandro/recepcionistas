import { useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, TextInput } from '@mantine/core';
import { IconInfoCircle, IconUserPlus } from '@tabler/icons-react';
import { ORIGENES_LEAD, ORIGENES_LEAD_LABELS } from '@bw/fhir/identifiers';
import { altaPaciente, mensajeError } from '../lib/bots';

/** Lista cerrada de canales (docs/canales-acceso.md): el CRM compara por código. */
const ORIGENES_SELECT = ORIGENES_LEAD.map((o) => ({ value: o, label: ORIGENES_LEAD_LABELS[o] }));

/**
 * Alta rápida de paciente (registrar cliente). Crea/actualiza el Patient vía el bot
 * bw-alta-paciente (dedupe por DNI/email/teléfono). No da acceso al portal: eso es
 * la "Invitación al portal", aparte.
 */
export function NuevoPacienteModal({
  abierto,
  onCerrar,
  onCreado,
}: {
  abierto: boolean;
  onCerrar: () => void;
  onCreado: (patientId: string) => void;
}): JSX.Element {
  const [nombre, setNombre] = useState('');
  const [dni, setDni] = useState('');
  const [telefono, setTelefono] = useState('');
  const [email, setEmail] = useState('');
  const [origen, setOrigen] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function limpiar(): void {
    setNombre('');
    setDni('');
    setTelefono('');
    setEmail('');
    setOrigen(null);
    setError(null);
  }

  async function guardar(): Promise<void> {
    if (!nombre.trim()) {
      setError('Ingresá al menos el nombre.');
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      const r = await altaPaciente({
        nombre: nombre.trim(),
        dni: dni.trim() || undefined,
        telefono: telefono.trim() || undefined,
        email: email.trim() || undefined,
        origenLead: origen ?? undefined,
      });
      if (r.ok && r.patientId) {
        limpiar();
        onCreado(r.patientId);
        onCerrar();
      } else {
        setError(r.mensaje ?? 'No se pudo dar de alta.');
      }
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal opened={abierto} onClose={onCerrar} title="Nuevo paciente" centered>
      <Stack gap="sm">
        <TextInput
          label="Nombre y apellido"
          placeholder="Ej.: Ana Pérez"
          value={nombre}
          onChange={(e) => setNombre(e.currentTarget.value)}
          required
          data-autofocus
        />
        <Group grow>
          <TextInput label="DNI" placeholder="30123456" value={dni} onChange={(e) => setDni(e.currentTarget.value)} />
          <TextInput
            label="Teléfono"
            placeholder="+54911..."
            value={telefono}
            onChange={(e) => setTelefono(e.currentTarget.value)}
          />
        </Group>
        <TextInput
          label="Email"
          placeholder="ana@email.com (necesario para el portal)"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
        <Select
          label="¿Cómo nos conoció?"
          placeholder="Canal de origen (para el CRM)"
          data={ORIGENES_SELECT}
          value={origen}
          onChange={setOrigen}
          clearable
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
          <Button leftSection={<IconUserPlus size={16} />} onClick={() => void guardar()} loading={guardando}>
            Dar de alta
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
