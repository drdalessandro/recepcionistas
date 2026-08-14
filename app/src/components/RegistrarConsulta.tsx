import { useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { IconInfoCircle, IconMessageQuestion } from '@tabler/icons-react';
import { SERVICIOS, CATEGORIA_COMERCIAL } from '@bw/config/catalogo';
import { validarLead } from '@bw/lib/lead';
import { useMedplumProfile } from '@medplum/react';
import { getReferenceString } from '@medplum/core';
import { altaPaciente, mensajeError } from '../lib/bots';

/**
 * Registrar una consulta del mostrador (caso 1 del walk-in): alguien pasó,
 * entró, preguntó y quizá se va sin dejar nada.
 *
 * Hasta ahora eso no dejaba rastro, así que el local —el canal más caro— era el
 * único que no se podía medir. Se registra como **lead** con el modelo que ya
 * usa el CRM (`Patient` con `ciclo-vida-cliente = lead` + tarjeta en su kanban),
 * no como un invento nuevo de este repo.
 *
 * Es de un clic a propósito: **nada es obligatorio salvo qué vino a preguntar**.
 * Si deja nombre o teléfono, mejor —se puede seguir—; si no, igual queda el
 * registro para medir. Pedirle los datos a alguien que solo preguntó un precio
 * es fricción que termina en que no se registre nada.
 */
export function RegistrarConsulta({
  abierto,
  onCerrar,
  onRegistrado,
}: {
  abierto: boolean;
  onCerrar: () => void;
  /** Se llama con el id del lead creado (para poder abrir su ficha). */
  onRegistrado: (patientId: string, anonimo: boolean) => void;
}): JSX.Element {
  // Quién está registrando: va como `agent` del Provenance del CRM. El bot no
  // sabe quién lo llamó, así que se lo manda la app.
  const perfil = useMedplumProfile();
  const [interes, setInteres] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Qué pudo venir a preguntar: las categorías comerciales del catálogo (no los
  // 40 códigos: en el mostrador se pregunta por "la cámara", no por HBOT_MONO).
  const opciones = [
    ...[...new Set(SERVICIOS.map((s) => CATEGORIA_COMERCIAL[s.categoria] ?? s.categoria))].map((c) => ({
      value: c,
      label: c,
    })),
    { value: 'Precios y planes', label: 'Precios y planes' },
    { value: 'Otra cosa', label: 'Otra cosa' },
  ];

  function limpiar(): void {
    setInteres(null);
    setNombre('');
    setTelefono('');
    setError(null);
  }

  async function registrar(): Promise<void> {
    const datos = { nombre: nombre.trim(), telefono: telefono.trim(), interes: interes ?? undefined };
    const v = validarLead(datos);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      const r = await altaPaciente({
        nombre: datos.nombre || undefined,
        telefono: datos.telefono || undefined,
        interes: datos.interes,
        // Contrato del CRM: nace como lead, no como cliente.
        cicloVida: 'lead',
        origenLead: 'walk-in',
        registradoPorRef: perfil ? getReferenceString(perfil) : undefined,
      });
      if (!r.ok || !r.patientId) {
        setError(r.mensaje ?? 'No se pudo registrar la consulta.');
        return;
      }
      onRegistrado(r.patientId, !datos.nombre && !datos.telefono);
      limpiar();
      onCerrar();
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal opened={abierto} onClose={onCerrar} title="Registrar una consulta del mostrador" size="md">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Para saber cuánta gente entra y qué pregunta. Si no quiere dejar sus datos, registrala igual: con el
          interés alcanza.
        </Text>

        <Select
          label="¿Qué vino a consultar?"
          placeholder="Elegí una opción"
          data={opciones}
          value={interes}
          onChange={setInteres}
          searchable
        />

        <Group grow align="flex-start">
          <TextInput
            label="Nombre (si lo deja)"
            placeholder="Opcional"
            value={nombre}
            onChange={(e) => setNombre(e.currentTarget.value)}
          />
          <TextInput
            label="Teléfono (si lo deja)"
            placeholder="Opcional — permite seguirlo después"
            value={telefono}
            onChange={(e) => setTelefono(e.currentTarget.value)}
          />
        </Group>

        {error && (
          <Alert color="orange" icon={<IconInfoCircle size={16} />}>
            {error}
          </Alert>
        )}

        <Group justify="flex-end" mt="xs">
          <Button variant="default" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button leftSection={<IconMessageQuestion size={16} />} onClick={() => void registrar()} loading={guardando}>
            Registrar consulta
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
