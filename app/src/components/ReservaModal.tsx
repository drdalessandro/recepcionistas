import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  List,
  Modal,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { IconSearch, IconShieldX, IconInfoCircle } from '@tabler/icons-react';
import type { Patient } from '@medplum/fhirtypes';
import { getDisplayString } from '@medplum/core';
import { medplum } from '../medplum';
import { reservarTurno, mensajeError, type ResultadoReserva } from '../lib/bots';
import { SERVICIOS, nombreServicioRecepcion } from '@bw/config/catalogo';
import { RECURSOS_POR_CODIGO, recursosParaCategoria } from '@bw/config/recursos';
import { generarSlots } from '@bw/lib/slots';
import { HORARIO_SEMANAL } from '@bw/config/horario';
import { grillaTurnoMin } from '@bw/config/reglas';

export interface PresetReserva {
  recursoCodigo: string;
  horaMin: number;
  /**
   * Día de la grilla desde la que se clickeó ("YYYY-MM-DD"). Sin esto el modal
   * siempre arrancaba en hoy: al poder navegar la agenda a otro día, clickear un
   * hueco del viernes abría una reserva para HOY y había que acordarse de
   * corregir la fecha a mano. Opcional: quien no navega, no lo manda.
   */
  fechaISO?: string;
}

function fmtMin(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" del día LOCAL (no UTC: ver el comentario de `hoy`). */
function fechaLocalISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ReservaModal({
  preset,
  onClose,
  onReservado,
}: {
  preset: PresetReserva | null;
  onClose: () => void;
  onReservado: () => void;
}): JSX.Element {
  // OJO: `toISOString()` es UTC. Con el centro abierto hasta las 22:00 y
  // Argentina en −03:00, entre las 21 y las 22 devolvía YA el día siguiente y el
  // modal arrancaba con la fecha de mañana. Va la fecha LOCAL.
  const hoy = fechaLocalISO(new Date());
  const [query, setQuery] = useState('');
  const [resultados, setResultados] = useState<Patient[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [paciente, setPaciente] = useState<Patient | null>(null);
  const [servicioCodigo, setServicioCodigo] = useState<string | null>(null);
  const [fecha, setFecha] = useState(hoy);
  const [hora, setHora] = useState<string | null>(null);
  const [prescripcion, setPrescripcion] = useState(false);
  const [ocupantes, setOcupantes] = useState('1');
  const [resultado, setResultado] = useState<ResultadoReserva | null>(null);
  const [reservando, setReservando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recurso = preset ? RECURSOS_POR_CODIGO.get(preset.recursoCodigo) : undefined;

  // Servicios que se pueden hacer en esta sala.
  const serviciosCompatibles = useMemo(
    () =>
      preset
        ? SERVICIOS.filter((s) => recursosParaCategoria(s.categoria).some((r) => r.codigo === preset.recursoCodigo))
        : [],
    [preset],
  );

  // Al abrir, precargar hora + resetear el resto.
  useEffect(() => {
    if (preset) {
      setHora(fmtMin(preset.horaMin));
      setFecha(preset.fechaISO ?? hoy);
      setServicioCodigo(null);
      setPaciente(null);
      setResultados(null);
      setQuery('');
      setResultado(null);
      setError(null);
      setPrescripcion(false);
      setOcupantes('1');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  // R-22: la sala decide qué inicios se ofrecen (60' en punto; Recovery Pro cada 30').
  const horas = useMemo(() => {
    const desde = new Date(`${fecha}T00:00:00-03:00`);
    const paso = grillaTurnoMin(recurso?.tipo ?? '');
    const dummy = [{ codigo: '_', nombre: '_', tipo: 'SALA' as const, capacidad: 1 }];
    return generarSlots(dummy, HORARIO_SEMANAL, { desde, dias: 1 })
      .map((s) => s.inicio.slice(11, 16))
      .filter((hhmm) => (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) % paso === 0);
  }, [fecha, recurso]);

  const servicio = servicioCodigo ? SERVICIOS.find((s) => s.codigo === servicioCodigo) : undefined;

  async function buscar(): Promise<void> {
    if (!query.trim()) {
      return;
    }
    setBuscando(true);
    try {
      const esDni = /^\d+$/.test(query.trim());
      const params = esDni ? { identifier: query.trim() } : { name: query.trim() };
      setResultados(await medplum.searchResources('Patient', { ...params, _count: 8 }));
    } finally {
      setBuscando(false);
    }
  }

  async function reservar(): Promise<void> {
    if (!preset || !paciente || !servicioCodigo || !hora) {
      return;
    }
    setReservando(true);
    setError(null);
    setResultado(null);
    try {
      const r = await reservarTurno({
        pacienteRef: `Patient/${paciente.id}`,
        servicioCodigo,
        recursoCodigo: preset.recursoCodigo,
        inicio: `${fecha}T${hora}:00-03:00`,
        ocupantes: Number(ocupantes) || 1,
        prescripcionActiva: prescripcion,
        confirmar: true,
      });
      setResultado(r);
      if (r.creado) {
        onReservado();
        // Con advertencias (p. ej. multiplaza bajo el mínimo de 3) el modal queda
        // abierto para que la recepción las vea; sin advertencias se cierra solo.
        if (r.advertencias.length === 0) {
          onClose();
        }
      }
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setReservando(false);
    }
  }

  return (
    <Modal opened={Boolean(preset)} onClose={onClose} title="Reservar turno" size="lg" centered>
      <Stack gap="md">
        <Group gap="xs">
          <Badge color="bio" size="lg" variant="light">
            {recurso?.nombre ?? preset?.recursoCodigo}
          </Badge>
          <Badge color="gray" size="lg" variant="light">
            {fecha} · {hora}
          </Badge>
        </Group>

        {/* Paciente */}
        {!paciente ? (
          <Stack gap="xs">
            <Group align="flex-end">
              <TextInput
                label="Paciente (nombre o DNI)"
                placeholder="Buscar…"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && void buscar()}
                style={{ flex: 1 }}
              />
              <Button leftSection={<IconSearch size={16} />} onClick={() => void buscar()} loading={buscando}>
                Buscar
              </Button>
            </Group>
            {resultados?.map((p) => (
              <Button key={p.id} variant="default" justify="space-between" onClick={() => setPaciente(p)}>
                {getDisplayString(p)}
              </Button>
            ))}
            {resultados && resultados.length === 0 && (
              <Text size="sm" c="dimmed">
                Sin resultados.
              </Text>
            )}
          </Stack>
        ) : (
          <Group justify="space-between">
            <Text fw={600}>{getDisplayString(paciente)}</Text>
            <Button variant="subtle" size="xs" onClick={() => setPaciente(null)}>
              Cambiar
            </Button>
          </Group>
        )}

        {/* Servicio + hora */}
        <Group grow align="flex-end">
          <Select
            label="Servicio"
            placeholder="Elegí un servicio"
            data={serviciosCompatibles.map((s) => ({ value: s.codigo, label: nombreServicioRecepcion(s) }))}
            value={servicioCodigo}
            onChange={setServicioCodigo}
            searchable
          />
          <Select label="Hora" data={horas} value={hora} onChange={setHora} searchable />
        </Group>

        <TextInput
          type="date"
          label="Fecha"
          value={fecha}
          min={hoy}
          onChange={(e) => {
            setFecha(e.currentTarget.value);
            setHora(null);
          }}
        />

        {recurso && recurso.capacidad > 1 && (
          <Select
            label="Personas"
            description={
              recurso.reservaExclusiva
                ? 'La cámara queda reservada completa para esta reserva (1 o 2 personas juntas).'
                : `Sesión grupal: hasta ${recurso.capacidad} personas.${recurso.minimoPersonas ? ` Mínimo operativo ${recurso.minimoPersonas} (se puede reservar con menos).` : ''}`
            }
            data={Array.from({ length: recurso.capacidad }, (_, i) => String(i + 1))}
            value={ocupantes}
            onChange={(v) => setOcupantes(v ?? '1')}
          />
        )}

        {servicio?.requierePrescripcion && (
          <Switch
            label="Prescripción médica activa (IV / Terapias Biológicas)"
            checked={prescripcion}
            onChange={(e) => setPrescripcion(e.currentTarget.checked)}
          />
        )}

        {error && (
          <Alert color="orange" icon={<IconInfoCircle size={16} />}>
            {error}
          </Alert>
        )}

        {resultado && !resultado.creado && (
          <Alert color="red" title="No se pudo reservar" icon={<IconShieldX size={16} />}>
            <List size="sm">
              {resultado.bloqueos.map((b, i) => (
                <List.Item key={i}>
                  [{b.regla}] {b.mensaje}
                </List.Item>
              ))}
            </List>
          </Alert>
        )}

        {resultado?.creado && resultado.advertencias.length > 0 && (
          <Alert color="yellow" title="Turno reservado, con avisos" icon={<IconInfoCircle size={16} />}>
            <List size="sm">
              {resultado.advertencias.map((a, i) => (
                <List.Item key={i}>
                  [{a.regla}] {a.mensaje}
                </List.Item>
              ))}
            </List>
          </Alert>
        )}

        <Group justify="flex-end">
          {resultado?.creado ? (
            <Button onClick={onClose}>Listo</Button>
          ) : (
            <>
              <Button variant="default" onClick={onClose}>
                Cancelar
              </Button>
              <Button onClick={() => void reservar()} loading={reservando} disabled={!paciente || !servicioCodigo || !hora}>
                Reservar turno
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
