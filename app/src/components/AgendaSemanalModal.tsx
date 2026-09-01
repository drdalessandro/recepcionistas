import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Chip, Group, Modal, Select, Stack, Switch, Text } from '@mantine/core';
import { IconCalendarTime, IconCheck, IconInfoCircle } from '@tabler/icons-react';
import { guardarPreferenciaSemanal, mensajeError, type ResultadoPreferenciaSemanal } from '../lib/bots';
import type { PlanPaciente } from '../lib/planes';
import { MEMBRESIAS_POR_CODIGO } from '@bw/config/membresias';
import { getServicio } from '@bw/config/catalogo';
import { getCombo } from '@bw/config/combos';
import { HORARIO_SEMANAL } from '@bw/config/horario';
import { grillaTurnoMin } from '@bw/config/reglas';
import { EXT } from '@bw/fhir/identifiers';
import { parsePreferencia } from '@bw/lib/semana-membresia';
import { generarSlots } from '@bw/lib/slots';
import { diasSugeridos } from '@bw/lib/serie-turnos';

const LABEL_DIA: Record<number, string> = { 0: 'Dom', 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb' };

const esDiaAbierto = (dia: number): boolean => HORARIO_SEMANAL.find((h) => h.dia === dia)?.abierto ?? false;

/**
 * Preferencia semanal de la membresía (R-21): días con nombre + hora, y el
 * interruptor de la asignación automática. No reserva nada acá: guarda la
 * preferencia en el Coverage (vía `bw-preferencia-semanal`) y el cron
 * `bw-agenda-semanal` reserva cada sesión apenas se abre su ventana R-13.
 */
export function AgendaSemanalModal({
  plan,
  onClose,
  onGuardado,
}: {
  plan: PlanPaciente | null;
  onClose: () => void;
  onGuardado: () => void;
}): JSX.Element {
  const def = plan ? MEMBRESIAS_POR_CODIGO.get(plan.planCodigo) : undefined;
  const frecuencia = def?.frecuenciaSemanal ?? 2;

  const [diasSel, setDiasSel] = useState<number[]>([]);
  const [hora, setHora] = useState<string | null>(null);
  const [activa, setActiva] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoPreferenciaSemanal | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Horas válidas dentro del horario del centro. R-22: la preferencia arranca
  // el combo base del plan, así que la grilla es la del turno (hora en punto).
  const horas = useMemo(() => {
    const desde = new Date();
    desde.setHours(0, 0, 0, 0);
    const paso = def
      ? grillaTurnoMin(getServicio(getCombo(def.comboBaseCodigo).componentes[0].servicioCodigo).categoria)
      : grillaTurnoMin('');
    const dummy = [{ codigo: '_', nombre: '_', tipo: 'SALA' as const, capacidad: 1 }];
    const set = new Set(
      generarSlots(dummy, HORARIO_SEMANAL, { desde, dias: 7 })
        .map((s) => s.inicio.slice(11, 16))
        .filter((hhmm) => (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) % paso === 0),
    );
    return [...set].sort();
  }, [def]);

  // Al abrir: precargar lo guardado en el Coverage; si no hay nada, sugerir.
  useEffect(() => {
    if (!plan) {
      return;
    }
    const ext = plan.coverage.extension ?? [];
    const guardada = parsePreferencia(
      ext.find((x) => x.url === EXT.preferenciaDias)?.valueString,
      ext.find((x) => x.url === EXT.preferenciaHora)?.valueString,
    );
    setDiasSel(guardada?.dias ?? diasSugeridos(frecuencia, esDiaAbierto));
    setHora(guardada?.hora ?? (horas.includes('10:00') ? '10:00' : (horas[0] ?? null)));
    setActiva(guardada ? ext.find((x) => x.url === EXT.agendaSemanalActiva)?.valueBoolean === true : true);
    setResultado(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  async function guardar(): Promise<void> {
    if (!plan || !hora || diasSel.length === 0) {
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      const r = await guardarPreferenciaSemanal({ coverageId: plan.coverageId, dias: diasSel, hora, activa });
      if (r.ok) {
        setResultado(r);
        onGuardado();
      } else {
        setError(r.mensaje ?? 'No se pudo guardar la preferencia.');
      }
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setGuardando(false);
    }
  }

  const diasAbiertos = [1, 2, 3, 4, 5, 6].filter(esDiaAbierto);

  return (
    <Modal opened={Boolean(plan)} onClose={onClose} title="Preferencia semanal de la membresía" size="lg" centered>
      {plan && (
        <Stack gap="md">
          <Group gap="xs">
            <Badge color="bio" size="lg" variant="light">
              {plan.nombre}
            </Badge>
            <Badge color="gray" size="lg" variant="light">
              {frecuencia}x/semana
            </Badge>
          </Group>

          {!resultado && (
            <>
              <Alert color="bio" variant="light" icon={<IconInfoCircle size={16} />}>
                Las sesiones del plan se usan semana a semana (tope {frecuencia} por semana, sin acumular). Con la
                asignación automática, el sistema reserva cada sesión en estos días y a esta hora apenas se abre la
                ventana de reserva del socio; si el horario está tomado busca el más cercano del mismo día y le avisa.
              </Alert>

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
                {diasSel.length !== frecuencia && diasSel.length > 0 && (
                  <Text size="xs" c="orange" mt={4}>
                    {diasSel.length < frecuencia
                      ? `El plan incluye ${frecuencia} sesiones por semana: con ${diasSel.length} día(s) quedarán sesiones sin asignar.`
                      : `El plan incluye ${frecuencia} sesiones por semana: se asignan a lo sumo ${frecuencia} de los ${diasSel.length} días elegidos.`}
                  </Text>
                )}
              </div>

              <Select label="Hora" data={horas} value={hora} onChange={setHora} searchable maw={200} />

              <Switch
                checked={activa}
                onChange={(e) => setActiva(e.currentTarget.checked)}
                label="Reservar automáticamente cada semana"
                description="Apagado, la preferencia queda guardada pero el sistema no reserva nada."
              />
            </>
          )}

          {resultado && (
            <Alert color="bio" variant="light" icon={<IconCheck size={16} />}>
              Preferencia guardada:{' '}
              {resultado.preferencia
                ? `${resultado.preferencia.dias.map((d) => LABEL_DIA[d]).join(' y ')} a las ${resultado.preferencia.hora}`
                : 'sin días'}{' '}
              — asignación automática {resultado.activa ? 'activa' : 'apagada'}.
              {resultado.aviso && (
                <Text size="sm" c="orange" mt={4}>
                  {resultado.aviso}
                </Text>
              )}
            </Alert>
          )}

          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}

          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={onClose}>
              {resultado ? 'Cerrar' : 'Cancelar'}
            </Button>
            {!resultado && (
              <Button
                leftSection={<IconCalendarTime size={16} />}
                onClick={() => void guardar()}
                loading={guardando}
                disabled={!hora || diasSel.length === 0}
              >
                Guardar preferencia
              </Button>
            )}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
