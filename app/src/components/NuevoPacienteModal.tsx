import { useEffect, useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { IconInfoCircle, IconUserPlus } from '@tabler/icons-react';
import { ORIGENES_LEAD, ORIGENES_LEAD_LABELS } from '@bw/fhir/identifiers';
import type { Patient } from '@medplum/fhirtypes';
import { getDisplayString } from '@medplum/core';
import { medplum } from '../medplum';
import { busquedasPara } from '@bw/lib/busqueda-paciente';
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
  telefonoInicial,
  nombreInicial,
}: {
  abierto: boolean;
  onCerrar: () => void;
  onCreado: (patientId: string) => void;
  /** Prellenado (vista Avisos): teléfono del WhatsApp desconocido, ya en E.164. */
  telefonoInicial?: string;
  /** Prellenado: nombre de perfil de WhatsApp (la recepcionista lo corrige). */
  nombreInicial?: string;
}): JSX.Element {
  const [nombre, setNombre] = useState('');
  const [nombreElegido, setNombreElegido] = useState('');
  const [dni, setDni] = useState('');
  const [telefono, setTelefono] = useState('');
  const [email, setEmail] = useState('');
  const [origen, setOrigen] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fichas que ya existen con este teléfono o DNI. Se AVISA, nunca se bloquea:
  // madre e hijo, o una pareja, comparten teléfono con toda naturalidad, y negar
  // el alta por eso sería peor que el duplicado. La recepcionista es la única
  // que puede distinguir un familiar de la misma persona.
  const [posiblesDuplicados, setPosiblesDuplicados] = useState<Patient[]>([]);

  // Al abrirse con prellenado (desde Avisos), sembrar los campos una vez: el
  // teléfono viene en E.164 de Twilio, que es justo el formato con el que el
  // WhatsApp entrante después encuentra la ficha.
  useEffect(() => {
    if (abierto) {
      if (telefonoInicial) {
        setTelefono(telefonoInicial);
      }
      if (nombreInicial) {
        setNombre(nombreInicial);
      }
    }
  }, [abierto, telefonoInicial, nombreInicial]);

  // Se busca mientras tipea (con una pausa), para que el aviso aparezca ANTES de
  // crear. El caso que esto evita: la persona escribió por WhatsApp, ya tiene
  // ficha con su teléfono, y se le crea una segunda con nombre + DNI — dos
  // fichas sin ningún campo en común, que ni el alta ni bw-dedup-paciente ven.
  useEffect(() => {
    if (!abierto || (!telefono.trim() && !dni.trim())) {
      setPosiblesDuplicados([]);
      return;
    }
    let vigente = true;
    const t = setTimeout(() => {
      void (async () => {
        const porId = new Map<string, Patient>();
        for (const texto of [telefono, dni]) {
          for (const b of busquedasPara(texto)) {
            for (const valor of b.valores) {
              const campo = b.tipo === 'dni' ? 'identifier' : 'telecom';
              const encontrados = await medplum
                .searchResources('Patient', { [campo]: valor, _count: 5 })
                .catch(() => []);
              for (const p of encontrados) {
                if (p.id) {
                  porId.set(p.id, p);
                }
              }
            }
          }
        }
        if (vigente) {
          setPosiblesDuplicados([...porId.values()]);
        }
      })();
    }, 500);
    return () => {
      vigente = false;
      clearTimeout(t);
    };
  }, [abierto, telefono, dni]);

  function limpiar(): void {
    setNombre('');
    setNombreElegido('');
    setDni('');
    setTelefono('');
    setEmail('');
    setOrigen(null);
    setError(null);
    setPosiblesDuplicados([]);
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
        nombreElegido: nombreElegido.trim() || undefined,
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
        <TextInput
          label="Nombre elegido (si difiere)"
          placeholder="Como quiere que le digamos — es el nombre que va a ver en todos lados"
          value={nombreElegido}
          onChange={(e) => setNombreElegido(e.currentTarget.value)}
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

        {posiblesDuplicados.length > 0 && (
          <Alert color="yellow" icon={<IconInfoCircle size={16} />} title="Ya hay una ficha con estos datos">
            <Text size="sm" mb="xs">
              Si es la misma persona, abrí la ficha que ya existe en vez de crear otra. Si son familiares que
              comparten el teléfono, seguí con el alta.
            </Text>
            <Stack gap={4}>
              {posiblesDuplicados.map((p) => (
                <Button
                  key={p.id}
                  variant="light"
                  size="compact-sm"
                  justify="flex-start"
                  onClick={() => {
                    onCreado(p.id as string);
                    onCerrar();
                  }}
                >
                  Abrir {getDisplayString(p)}
                </Button>
              ))}
            </Stack>
          </Alert>
        )}

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
