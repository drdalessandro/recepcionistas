import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Group,
  List,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconCircleCheck, IconInfoCircle, IconShieldCheck } from '@tabler/icons-react';
import type { Patient, Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { QuestionnaireForm } from '@medplum/react';
import { medplum } from '../medplum';
import { registrarIngresoPresencial } from '../lib/bots';
import { CONSENTIMIENTO_LIBRARY_URL } from '@bw/config/consentimiento-texto';
import { INTAKE_QUESTIONNAIRE_URL } from '@bw/fhir/identifiers';
import { validarFirmaPresencial } from '@bw/lib/ingreso';

/**
 * Kiosco del mostrador: el paciente firma el consentimiento y contesta el
 * cuestionario de ingreso en la tablet de Recepción.
 *
 * Existe porque al portal se entra por invitación CON EMAIL, y desde R-20 sin
 * consentimiento y sin screening no se reserva nada: quien cruzaba la puerta sin
 * email —o sin smartphone— quedaba sin camino.
 *
 * Va a pantalla completa y **sin la navegación de Recepción**: la tablet pasa a
 * manos del paciente, y no tiene que poder irse a Caja ni a la agenda. Lo
 * contesta y lo firma ÉL, no la recepcionista — el screening es información
 * clínica y no debe pasar por el mostrador (CLAUDE.md, principio 3).
 *
 * El texto legal y el cuestionario se leen de FHIR (`Library` y `Questionnaire`
 * que publica el seed), así que son la MISMA versión que ve el portal.
 */
export function KioscoIngreso({
  paciente,
  abierto,
  onCerrar,
  onListo,
}: {
  paciente: Patient;
  abierto: boolean;
  onCerrar: () => void;
  /** Se llama al registrar con éxito, para refrescar el banner de Atender. */
  onListo: () => void;
}): JSX.Element {
  const [paso, setPaso] = useState<'consentimiento' | 'cuestionario' | 'listo'>('consentimiento');
  const [texto, setTexto] = useState<SeccionesConsentimiento | null>(null);
  const [cuestionario, setCuestionario] = useState<Questionnaire | null>(null);
  const [nombreFirma, setNombreFirma] = useState('');
  const [dni, setDni] = useState('');
  const [usoDatos, setUsoDatos] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Al abrir se reinicia todo: la tablet pasa de un paciente al siguiente y no
  // puede quedar el nombre del anterior tipeado en la firma.
  useEffect(() => {
    if (!abierto) {
      return;
    }
    setPaso('consentimiento');
    setNombreFirma('');
    setDni(dniDeFicha(paciente));
    setUsoDatos(false);
    setError(null);
    cargarTexto().then(setTexto).catch(() => setTexto(null));
    medplum
      .searchOne('Questionnaire', { url: INTAKE_QUESTIONNAIRE_URL })
      .then((q) => setCuestionario(q ?? null))
      .catch(() => setCuestionario(null));
  }, [abierto, paciente]);

  const firmaValida = validarFirmaPresencial({ pacienteRef: `Patient/${paciente.id}`, nombreFirma, dni }).ok;

  async function registrar(respuesta?: QuestionnaireResponse): Promise<void> {
    setEnviando(true);
    setError(null);
    const r = await registrarIngresoPresencial({
      pacienteRef: `Patient/${paciente.id}`,
      nombreFirma,
      dni,
      usoDatosAceptado: usoDatos,
      respuestasScreening: respuesta?.item,
    });
    setEnviando(false);
    if (!r.ok) {
      setError(r.mensaje ?? 'No se pudo registrar el ingreso.');
      return;
    }
    setPaso('listo');
    onListo();
  }

  return (
    <Modal opened={abierto} onClose={onCerrar} fullScreen withCloseButton={false} padding="lg">
      <Stack maw={800} mx="auto" gap="md">
        {paso === 'consentimiento' && (
          <>
            <Title order={2}>Consentimiento Informado</Title>
            <Text c="dimmed" size="sm">
              Leelo con tranquilidad y firmá abajo con tu nombre completo. Lo hacés una sola vez.
            </Text>

            {texto === null ? (
              <Loader size="sm" />
            ) : (
              <Paper withBorder p="md" mah={420} style={{ overflowY: 'auto' }}>
                <Title order={4}>{texto.titulo}</Title>
                <Text size="sm" c="dimmed" mb="sm">
                  {texto.subtitulo}
                </Text>
                {texto.secciones.map((s) => (
                  <div key={s.heading}>
                    <Text fw={600} mt="sm">
                      {s.heading}
                    </Text>
                    {s.blocks.map((b, i) =>
                      b.type === 'ul' ? (
                        <List key={i} size="sm" spacing={2} mt={4}>
                          {b.items.map((item) => (
                            <List.Item key={item}>{item}</List.Item>
                          ))}
                        </List>
                      ) : (
                        <Text key={i} size="sm" fw={b.type === 'sub' ? 600 : undefined} mt={4}>
                          {b.text}
                        </Text>
                      )
                    )}
                  </div>
                ))}
                <Text size="xs" c="dimmed" mt="md">
                  {texto.pie}
                </Text>
              </Paper>
            )}

            <Divider label="Tu firma" />
            <Group grow align="flex-start">
              <TextInput
                label="Nombre y apellido completo"
                placeholder="Como figura en tu documento"
                value={nombreFirma}
                onChange={(e) => setNombreFirma(e.currentTarget.value)}
                size="md"
              />
              <TextInput
                label="DNI"
                placeholder="30111222"
                value={dni}
                onChange={(e) => setDni(e.currentTarget.value)}
                size="md"
              />
            </Group>
            <Checkbox
              checked={usoDatos}
              onChange={(e) => setUsoDatos(e.currentTarget.checked)}
              label="Autorizo el uso de mis datos en forma anónima para mejorar los protocolos (opcional, y podés revocarlo cuando quieras)"
            />

            {error && (
              <Alert color="red" icon={<IconInfoCircle size={18} />}>
                {error}
              </Alert>
            )}

            <Group justify="space-between">
              <Button variant="subtle" color="gray" onClick={onCerrar}>
                Cancelar
              </Button>
              <Button
                size="md"
                leftSection={<IconShieldCheck size={18} />}
                disabled={!firmaValida || texto === null}
                onClick={() => setPaso('cuestionario')}
              >
                Firmar y continuar
              </Button>
            </Group>
          </>
        )}

        {paso === 'cuestionario' && (
          <>
            <Title order={2}>Cuestionario de ingreso</Title>
            <Text c="dimmed" size="sm">
              Son unas preguntas sobre tu salud. Nos dicen si podés hacer cada terapia con seguridad, así que
              contestá con tranquilidad y con la verdad.
            </Text>
            {enviando ? (
              <Group gap="xs">
                <Loader size="sm" />
                <Text size="sm">Guardando…</Text>
              </Group>
            ) : cuestionario ? (
              <QuestionnaireForm questionnaire={cuestionario} onSubmit={(r) => void registrar(r)} />
            ) : (
              <Alert color="yellow" icon={<IconInfoCircle size={18} />}>
                El cuestionario de ingreso todavía no está cargado en el sistema. Podés registrar solo el
                consentimiento y completarlo después desde el portal.
              </Alert>
            )}
            {error && (
              <Alert color="red" icon={<IconInfoCircle size={18} />}>
                {error}
              </Alert>
            )}
            <Group justify="space-between">
              <Button variant="subtle" color="gray" onClick={() => setPaso('consentimiento')} disabled={enviando}>
                Volver
              </Button>
              {/* El consentimiento y el cuestionario son dos pasos: se puede
                  registrar la firma ahora y dejar el cuestionario para después
                  (aunque sin él R-20 sigue bloqueando la reserva). */}
              <Button variant="light" onClick={() => void registrar()} loading={enviando}>
                Registrar solo el consentimiento
              </Button>
            </Group>
          </>
        )}

        {paso === 'listo' && (
          <Stack align="center" py="xl" gap="md">
            <IconCircleCheck size={56} stroke={1.5} />
            <Title order={3}>¡Listo, gracias!</Title>
            <Text c="dimmed" ta="center" maw={420}>
              Quedó registrado. Ya podés devolverle la tablet a Recepción.
            </Text>
            <Button size="md" onClick={onCerrar}>
              Volver a Recepción
            </Button>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

interface SeccionesConsentimiento {
  titulo: string;
  subtitulo: string;
  pie: string;
  secciones: Array<{
    heading: string;
    blocks: Array<{ type: 'p' | 'sub'; text: string } | { type: 'ul'; items: string[] }>;
  }>;
}

/** El texto legal, leído del `Library` que publica el seed (mismo que el portal). */
async function cargarTexto(): Promise<SeccionesConsentimiento | null> {
  const lib = await medplum.searchOne('Library', { url: CONSENTIMIENTO_LIBRARY_URL });
  const data = lib?.content?.[0]?.data;
  if (!data) {
    return null;
  }
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0))));
}

/** DNI ya cargado en la ficha, para no hacérselo tipear de nuevo. */
function dniDeFicha(paciente: Patient): string {
  const ident = paciente.identifier?.find((i) => /dni|documento/i.test(i.system ?? i.type?.text ?? ''));
  return ident?.value ?? '';
}
