import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Chip,
  Divider,
  Group,
  Modal,
  Progress,
  ScrollArea,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { IconCalendarPlus, IconCheck, IconX, IconInfoCircle } from '@tabler/icons-react';
import { reservarCombo, enviarWhatsApp, mensajeError } from '../lib/bots';
import type { PlanPaciente } from '../lib/planes';
import { MEMBRESIAS_POR_CODIGO } from '@bw/config/membresias';
import { HORARIO_SEMANAL } from '@bw/config/horario';
import { generarSlots } from '@bw/lib/slots';
import { generarSerieFechas, diasSugeridos } from '@bw/lib/serie-turnos';

const LABEL_DIA: Record<number, string> = { 0: 'Dom', 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb' };

const fmtDia = new Intl.DateTimeFormat('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' });

function isoDia(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function fmtFecha(f: string): string {
  const [y, m, d] = f.split('-').map(Number);
  return fmtDia.format(new Date(y as number, (m as number) - 1, d as number));
}

interface ResultadoItem {
  fecha: string;
  ok: boolean;
  motivo?: string;
}

const esDiaAbierto = (dia: number): boolean => HORARIO_SEMANAL.find((h) => h.dia === dia)?.abierto ?? false;

export function PreAgendaModal({
  plan,
  pacienteRef,
  onClose,
  onAgendado,
}: {
  plan: PlanPaciente | null;
  pacienteRef: string;
  onClose: () => void;
  onAgendado: () => void;
}): JSX.Element {
  const def = plan ? MEMBRESIAS_POR_CODIGO.get(plan.planCodigo) : undefined;
  const frecuencia = def?.frecuenciaSemanal ?? 2;
  const libres = plan?.saldo.restantes ?? 0;

  const hoyStr = isoDia(new Date());
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);

  const [diasSel, setDiasSel] = useState<number[]>([]);
  const [hora, setHora] = useState<string | null>(null);
  const [fechaInicio, setFechaInicio] = useState(isoDia(manana));
  const [ejecutando, setEjecutando] = useState(false);
  const [resultados, setResultados] = useState<ResultadoItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Horas válidas (franjas de 30 min dentro del horario de la semana).
  const horas = useMemo(() => {
    const desde = new Date();
    desde.setHours(0, 0, 0, 0);
    const dummy = [{ codigo: '_', nombre: '_', tipo: 'SALA' as const, capacidad: 1 }];
    const set = new Set(generarSlots(dummy, HORARIO_SEMANAL, { desde, dias: 7 }).map((s) => s.inicio.slice(11, 16)));
    return [...set].sort();
  }, []);

  // Al abrir: sugerir días según la frecuencia y una hora por defecto.
  useEffect(() => {
    if (!plan) {
      return;
    }
    setDiasSel(diasSugeridos(frecuencia, esDiaAbierto));
    setHora((h) => h ?? (horas.includes('10:00') ? '10:00' : (horas[0] ?? null)));
    setFechaInicio(isoDia(manana));
    setResultados(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  const serie = useMemo(
    () =>
      plan
        ? generarSerieFechas({ desde: fechaInicio, diasSemana: diasSel, cantidad: libres, esDiaAbierto, hoy: hoyStr })
        : [],
    [plan, fechaInicio, diasSel, libres, hoyStr],
  );

  async function reservar(): Promise<void> {
    if (!plan || !hora || serie.length === 0) {
      return;
    }
    setEjecutando(true);
    setError(null);
    const out: ResultadoItem[] = [];
    try {
      for (const fecha of serie) {
        try {
          const r = await reservarCombo({
            pacienteRef,
            comboCodigo: plan.baseCodigo,
            inicio: `${fecha}T${hora}:00-03:00`,
            coverageId: plan.coverageId,
            notificar: false,
            confirmar: true,
          });
          out.push(r.creado ? { fecha, ok: true } : { fecha, ok: false, motivo: r.bloqueos[0]?.mensaje ?? 'No se pudo agendar.' });
        } catch (e) {
          out.push({ fecha, ok: false, motivo: mensajeError(e) });
        }
        setResultados([...out]);
      }

      // Un solo WhatsApp de resumen (best-effort; no frena el flujo si falla).
      const agendadas = out.filter((o) => o.ok).length;
      if (agendadas > 0) {
        try {
          await enviarWhatsApp({
            pacienteRef,
            template: 'serie-agendada',
            body: `Biowellness: te dejamos agendadas ${agendadas} ${agendadas === 1 ? 'sesión' : 'sesiones'} de tu ${plan.nombre} este mes. ¡Te esperamos! 💚`,
          });
        } catch {
          // sin Twilio configurado igual queda registrada la Communication
        }
      }
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setEjecutando(false);
      onAgendado();
    }
  }

  const diasAbiertos = [1, 2, 3, 4, 5, 6].filter(esDiaAbierto);
  const agendadas = resultados?.filter((r) => r.ok).length ?? 0;
  const terminado = resultados !== null && !ejecutando;

  return (
    <Modal opened={Boolean(plan)} onClose={onClose} title="Pre-agendar las sesiones del mes" size="lg" centered>
      {plan && (
        <Stack gap="md">
          <Group gap="xs">
            <Badge color="bio" size="lg" variant="light">
              {plan.nombre}
            </Badge>
            <Badge color="gray" size="lg" variant="light">
              {libres} {libres === 1 ? 'sesión por agendar' : 'sesiones por agendar'} · {frecuencia}x/semana
            </Badge>
          </Group>

          {!resultados && (
            <>
              <div>
                <Text size="sm" fw={500} mb={4}>
                  Días de la semana
                </Text>
                <Chip.Group
                  multiple
                  value={diasSel.map(String)}
                  onChange={(v) => setDiasSel(v.map(Number).sort((a, b) => a - b))}
                >
                  <Group gap="xs">
                    {diasAbiertos.map((d) => (
                      <Chip key={d} value={String(d)} variant="light">
                        {LABEL_DIA[d]}
                      </Chip>
                    ))}
                  </Group>
                </Chip.Group>
              </div>

              <Group grow align="flex-end">
                <Select label="Hora" data={horas} value={hora} onChange={setHora} searchable />
                <DateField label="Desde" value={fechaInicio} min={hoyStr} onChange={setFechaInicio} />
              </Group>

              <Divider />

              {serie.length === 0 ? (
                <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
                  Elegí al menos un día abierto y una hora para ver la propuesta.
                </Alert>
              ) : (
                <Stack gap="xs">
                  <Text size="sm" c="dimmed">
                    Se agendarán {serie.length} {serie.length === 1 ? 'turno' : 'turnos'} de {plan.nombre} a las {hora}:
                  </Text>
                  <ScrollArea.Autosize mah={180}>
                    <Group gap="xs">
                      {serie.map((f) => (
                        <Badge key={f} variant="outline" color="gray" tt="capitalize">
                          {fmtFecha(f)}
                        </Badge>
                      ))}
                    </Group>
                  </ScrollArea.Autosize>
                  {serie.length < libres && (
                    <Text size="xs" c="orange">
                      Sólo entraron {serie.length} de {libres} en la ventana. Las demás quedan para agendar manualmente.
                    </Text>
                  )}
                </Stack>
              )}
            </>
          )}

          {resultados && (
            <Stack gap="xs">
              {ejecutando && <Progress value={(resultados.length / serie.length) * 100} animated />}
              <ScrollArea.Autosize mah={260}>
                <Stack gap={6}>
                  {resultados.map((r) => (
                    <Group key={r.fecha} gap="xs" wrap="nowrap">
                      {r.ok ? (
                        <IconCheck size={16} color="var(--mantine-color-bio-6)" style={{ flexShrink: 0 }} />
                      ) : (
                        <IconX size={16} color="var(--mantine-color-red-6)" style={{ flexShrink: 0 }} />
                      )}
                      <Text size="sm" tt="capitalize" w={120} style={{ flexShrink: 0 }}>
                        {fmtFecha(r.fecha)} · {hora}
                      </Text>
                      {!r.ok && (
                        <Text size="sm" c="dimmed" lineClamp={1}>
                          {r.motivo}
                        </Text>
                      )}
                    </Group>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
              {terminado && (
                <Alert color={agendadas === serie.length ? 'bio' : 'yellow'} variant="light">
                  {agendadas} de {serie.length} {serie.length === 1 ? 'sesión agendada' : 'sesiones agendadas'}.
                  {agendadas < serie.length && ' Las que fallaron quedan para reintentar o agendar a mano.'}
                </Alert>
              )}
            </Stack>
          )}

          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}

          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={onClose}>
              {terminado ? 'Cerrar' : 'Cancelar'}
            </Button>
            {!resultados && (
              <Button
                leftSection={<IconCalendarPlus size={16} />}
                onClick={() => void reservar()}
                loading={ejecutando}
                disabled={!hora || serie.length === 0}
              >
                Reservar {serie.length > 0 ? `${serie.length} ${serie.length === 1 ? 'sesión' : 'sesiones'}` : ''}
              </Button>
            )}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

/** Campo de fecha nativo (mismo enfoque que ReservaModal, sin dependencia extra). */
function DateField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: string;
  min: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <input
        type="date"
        value={value}
        min={min}
        onChange={(e) => onChange(e.currentTarget.value)}
        style={{
          height: 36,
          padding: '0 12px',
          borderRadius: 8,
          border: '1px solid var(--mantine-color-default-border)',
          background: 'var(--mantine-color-body)',
          color: 'var(--mantine-color-text)',
          colorScheme: 'light dark',
          fontSize: 14,
          fontFamily: 'inherit',
        }}
      />
    </Stack>
  );
}
