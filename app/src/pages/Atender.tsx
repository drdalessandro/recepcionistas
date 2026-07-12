import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  List,
  Loader,
  NumberFormatter,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconSearch,
  IconShieldCheck,
  IconShieldX,
  IconCash,
  IconCalendarPlus,
  IconInfoCircle,
  IconLicense,
  IconUserPlus,
} from '@tabler/icons-react';
import type { Patient } from '@medplum/fhirtypes';
import { getDisplayString } from '@medplum/core';
import { medplum } from '../medplum';
import {
  registrarCobro,
  reservarTurno,
  reservarCombo,
  asignarPlan,
  mensajeError,
  type ResultadoReserva,
  type ResultadoCombo,
  type ResultadoRegistrarCobro,
} from '../lib/bots';
import { cargarPlanesActivos, planUsable, type PlanPaciente } from '../lib/planes';
import { MEDIOS_SELECT } from '../lib/medios';
import { SYSTEM } from '@bw/fhir/identifiers';
import { PreAgendaModal } from '../components/PreAgendaModal';
import { InvitarPortal } from '../components/InvitarPortal';
import { NuevoPacienteModal } from '../components/NuevoPacienteModal';
import { SERVICIOS } from '@bw/config/catalogo';
import { COMBOS } from '@bw/config/combos';
import { MEMBRESIAS } from '@bw/config/membresias';
import { PAQUETES } from '@bw/config/paquetes';
import { recursosParaCategoria } from '@bw/config/recursos';
import { generarSlots } from '@bw/lib/slots';
import { HORARIO_SEMANAL } from '@bw/config/horario';

export function Atender({
  pacienteInicialId,
  onPacienteInicialCargado,
}: {
  /** Si viene, se abre directo la ficha de ese paciente (p. ej. desde Planes y sesiones). */
  pacienteInicialId?: string | null;
  onPacienteInicialCargado?: () => void;
} = {}): JSX.Element {
  const [query, setQuery] = useState('');
  const [resultados, setResultados] = useState<Patient[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [seleccionado, setSeleccionado] = useState<Patient | null>(null);
  const [altaAbierta, setAltaAbierta] = useState(false);

  useEffect(() => {
    if (!pacienteInicialId) {
      return;
    }
    let cancelado = false;
    medplum
      .readResource('Patient', pacienteInicialId)
      .then((p) => {
        if (!cancelado) {
          setSeleccionado(p);
          onPacienteInicialCargado?.();
        }
      })
      .catch(() => undefined);
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pacienteInicialId]);

  async function buscar(): Promise<void> {
    if (!query.trim()) {
      return;
    }
    setBuscando(true);
    setSeleccionado(null);
    try {
      const esDni = /^\d+$/.test(query.trim());
      const params = esDni ? { identifier: query.trim() } : { name: query.trim() };
      setResultados(await medplum.searchResources('Patient', { ...params, _count: 10 }));
    } finally {
      setBuscando(false);
    }
  }

  async function abrirReciénCreado(patientId: string): Promise<void> {
    const p = await medplum.readResource('Patient', patientId);
    setResultados(null);
    setSeleccionado(p);
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center">
        <Title order={2}>Atender paciente</Title>
        <Button variant="light" leftSection={<IconUserPlus size={16} />} onClick={() => setAltaAbierta(true)}>
          Nuevo paciente
        </Button>
      </Group>

      <NuevoPacienteModal
        abierto={altaAbierta}
        onCerrar={() => setAltaAbierta(false)}
        onCreado={(id) => void abrirReciénCreado(id)}
      />

      <Group align="flex-end">
        <TextInput
          label="Buscar por nombre o DNI"
          placeholder="Ej.: Pérez o 30123456"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && void buscar()}
          w={360}
          size="md"
        />
        <Button leftSection={<IconSearch size={16} />} onClick={() => void buscar()} loading={buscando}>
          Buscar
        </Button>
      </Group>

      {!seleccionado && resultados && resultados.length === 0 && (
        <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
          No se encontraron pacientes. (En el entorno de prueba puede que aún no haya pacientes cargados.)
        </Alert>
      )}

      {!seleccionado &&
        resultados &&
        resultados.length > 0 &&
        resultados.map((p) => (
          <Card key={p.id} withBorder padding="md" radius="md" onClick={() => setSeleccionado(p)} style={{ cursor: 'pointer' }}>
            <Group justify="space-between">
              <Text fw={600}>{getDisplayString(p)}</Text>
              <Badge variant="light">{p.birthDate ?? 'sin fecha'}</Badge>
            </Group>
          </Card>
        ))}

      {seleccionado && <FichaPaciente paciente={seleccionado} onVolver={() => setSeleccionado(null)} />}
    </Stack>
  );
}

function FichaPaciente({ paciente, onVolver }: { paciente: Patient; onVolver: () => void }): JSX.Element {
  const [planes, setPlanes] = useState<PlanPaciente[]>([]);

  const recargarPlanes = useCallback(async (): Promise<void> => {
    try {
      setPlanes(await cargarPlanesActivos(paciente.id!));
    } catch {
      setPlanes([]);
    }
  }, [paciente.id]);

  useEffect(() => {
    void recargarPlanes();
  }, [recargarPlanes]);

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={3}>{getDisplayString(paciente)}</Title>
        <Button variant="subtle" onClick={onVolver}>
          ← Volver a la búsqueda
        </Button>
      </Group>
      <BannerSeguridad pacienteId={paciente.id!} />
      <InvitarPortal paciente={paciente} />
      <PanelPlanes paciente={paciente} planes={planes} onCambio={recargarPlanes} />
      <PanelReserva paciente={paciente} planes={planes} onReservado={recargarPlanes} />
      <PanelCobro paciente={paciente} />
    </Stack>
  );
}

/** Planes (membresías/paquetes) del paciente: muestra saldo y permite asignar uno. */
function PanelPlanes({
  paciente,
  planes,
  onCambio,
}: {
  paciente: Patient;
  planes: PlanPaciente[];
  onCambio: () => Promise<void>;
}): JSX.Element {
  const [tipo, setTipo] = useState<'membresia' | 'paquete'>('membresia');
  const [planCodigo, setPlanCodigo] = useState<string | null>(null);
  const [fm, setFm] = useState(false);
  const [medioPago, setMedioPago] = useState<string>('efectivo');
  const [asignando, setAsignando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [preAgenda, setPreAgenda] = useState<PlanPaciente | null>(null);

  const opciones =
    tipo === 'membresia'
      ? MEMBRESIAS.map((m) => ({ value: m.codigo, label: `${m.tier} ${m.intensidad} ${m.variante}` }))
      : PAQUETES.map((p) => ({ value: p.codigo, label: p.codigo }));

  async function asignar(): Promise<void> {
    if (!planCodigo) {
      return;
    }
    setAsignando(true);
    setError(null);
    setOk(null);
    try {
      const r = await asignarPlan({
        pacienteRef: `Patient/${paciente.id}`,
        tipo,
        planCodigo,
        fm: tipo === 'paquete' ? fm : undefined,
        medioPago,
      });
      if (r.ok) {
        setOk(`Plan activado: ${r.sesiones} sesiones. Cobro inicial $${(r.totalARS ?? 0).toLocaleString('es-AR')}.`);
        setPlanCodigo(null);
        await onCambio();
      } else {
        setError(r.mensaje ?? 'No se pudo asignar el plan.');
      }
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setAsignando(false);
    }
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Group gap="xs" mb="sm">
        <IconLicense size={18} />
        <Text fw={600}>Planes (membresías / paquetes)</Text>
      </Group>

      {planes.length === 0 ? (
        <Text size="sm" c="dimmed" mb="sm">
          El paciente no tiene planes activos.
        </Text>
      ) : (
        <Stack gap="xs" mb="md">
          {planes.map((p) => (
            <Group key={p.coverageId} justify="space-between">
              <Text size="sm" fw={500}>
                {p.nombre}
              </Text>
              <Group gap="xs">
                <Badge color={p.saldo.disponible ? 'bio' : 'gray'} variant="light">
                  {p.saldo.restantes}/{p.estado.total} sesiones
                </Badge>
                {p.saldo.vencido && <Badge color="red">vencido</Badge>}
                {p.saldo.agotado && !p.saldo.vencido && <Badge color="orange">agotado (R-10)</Badge>}
                {p.estado.tipo === 'membresia' && p.saldo.disponible && p.saldo.restantes > 0 && (
                  <Button
                    size="compact-sm"
                    variant="light"
                    leftSection={<IconCalendarPlus size={14} />}
                    onClick={() => setPreAgenda(p)}
                  >
                    Pre-agendar mes
                  </Button>
                )}
              </Group>
            </Group>
          ))}
        </Stack>
      )}

      <Group grow align="flex-end">
        <Select
          label="Tipo"
          data={[
            { value: 'membresia', label: 'Membresía (mensual)' },
            { value: 'paquete', label: 'Paquete (sesiones)' },
          ]}
          value={tipo}
          onChange={(v) => {
            setTipo((v as 'membresia' | 'paquete') ?? 'membresia');
            setPlanCodigo(null);
          }}
        />
        <Select
          label="Plan"
          placeholder="Elegí el plan"
          data={opciones}
          value={planCodigo}
          onChange={setPlanCodigo}
          searchable
        />
        <Select
          label="Medio de pago (cobro inicial)"
          data={MEDIOS_SELECT}
          value={medioPago}
          onChange={(v) => setMedioPago(v ?? 'efectivo')}
        />
      </Group>

      {tipo === 'paquete' && (
        <Switch mt="sm" label="Founding Member (20% OFF)" checked={fm} onChange={(e) => setFm(e.currentTarget.checked)} />
      )}

      <Group mt="md">
        <Button onClick={() => void asignar()} loading={asignando} disabled={!planCodigo}>
          Asignar plan
        </Button>
      </Group>

      {error && (
        <Alert color="orange" mt="md" icon={<IconInfoCircle size={16} />}>
          {error}
        </Alert>
      )}
      {ok && (
        <Alert color="bio" mt="md" title="Plan asignado ✓">
          {ok}
        </Alert>
      )}

      <PreAgendaModal
        plan={preAgenda}
        pacienteRef={`Patient/${paciente.id}`}
        onClose={() => setPreAgenda(null)}
        onAgendado={() => void onCambio()}
      />
    </Card>
  );
}

/**
 * Banner de seguridad: señal binaria verde/rojo (clínico) + banner administrativo
 * aparte si hay bloqueo de pagos (R-11). La recepción NO ve el detalle clínico.
 */
function BannerSeguridad({ pacienteId }: { pacienteId: string }): JSX.Element {
  const [estado, setEstado] = useState<'cargando' | 'verde' | 'rojo'>('cargando');
  const [bloqueoPago, setBloqueoPago] = useState(false);

  useEffect(() => {
    let activo = true;
    medplum
      .searchResources('Flag', { subject: `Patient/${pacienteId}`, status: 'active', _count: 20 })
      .then((flags) => {
        if (!activo) {
          return;
        }
        const esBloqueo = (f: (typeof flags)[number]): boolean =>
          Boolean(f.code?.coding?.some((c) => c.system === SYSTEM.bloqueo));
        setBloqueoPago(flags.some(esBloqueo));
        setEstado(flags.some((f) => !esBloqueo(f)) ? 'rojo' : 'verde');
      })
      .catch(() => activo && setEstado('verde'));
    return () => {
      activo = false;
    };
  }, [pacienteId]);

  if (estado === 'cargando') {
    return <Loader size="sm" />;
  }
  return (
    <>
      {estado === 'rojo' ? (
        <Alert color="red" icon={<IconShieldX size={20} />} title="Atención: contraindicación activa" variant="filled">
          Consultar con el equipo médico antes de continuar.
        </Alert>
      ) : (
        <Alert color="bio" icon={<IconShieldCheck size={20} />} title="Sin contraindicaciones" variant="filled">
          Paciente apto para atención.
        </Alert>
      )}
      {bloqueoPago && (
        <Alert color="orange" icon={<IconInfoCircle size={20} />} title="Pagos pendientes de regularizar (R-11)" variant="filled">
          El último cobro de la membresía fue rechazado. No puede hacer nuevas reservas hasta regularizar el pago.
        </Alert>
      )}
    </>
  );
}

/** Reserva de turno o combo: el front arma la propuesta y el bot valida + crea. */
function PanelReserva({
  paciente,
  planes,
  onReservado,
}: {
  paciente: Patient;
  planes: PlanPaciente[];
  onReservado: () => Promise<void>;
}): JSX.Element {
  const hoy = new Date().toISOString().slice(0, 10);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const [recursoCodigo, setRecursoCodigo] = useState<string | null>(null);
  const [fecha, setFecha] = useState(hoy);
  const [hora, setHora] = useState<string | null>(null);
  const [prescripcion, setPrescripcion] = useState(false);
  const [usarPlan, setUsarPlan] = useState(true);
  const [resultado, setResultado] = useState<ResultadoReserva | null>(null);
  const [resultadoCombo, setResultadoCombo] = useState<ResultadoCombo | null>(null);
  const [reservando, setReservando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const esCombo = seleccion ? COMBOS.some((c) => c.codigo === seleccion) : false;
  const servicio = !esCombo && seleccion ? SERVICIOS.find((s) => s.codigo === seleccion) : undefined;
  const salas = servicio ? recursosParaCategoria(servicio.categoria) : [];

  // ¿Hay un plan utilizable para lo seleccionado? (membresía↔combo, paquete↔servicio)
  const plan = seleccion
    ? planUsable(planes, { tipo: esCombo ? 'combo' : 'servicio', codigo: seleccion })
    : undefined;

  const opciones = [
    { group: 'Combos (secuencia automática)', items: COMBOS.map((c) => ({ value: c.codigo, label: c.nombre })) },
    { group: 'Servicios', items: SERVICIOS.map((s) => ({ value: s.codigo, label: s.nombre })) },
  ];

  const horas = useMemo(() => {
    const desde = new Date(`${fecha}T00:00:00-03:00`);
    const dummy = [{ codigo: '_', nombre: '_', tipo: 'SALA' as const, capacidad: 1 }];
    return generarSlots(dummy, HORARIO_SEMANAL, { desde, dias: 1 }).map((s) => s.inicio.slice(11, 16));
  }, [fecha]);

  function limpiar(): void {
    setResultado(null);
    setResultadoCombo(null);
    setError(null);
  }

  async function reservar(): Promise<void> {
    if (!seleccion || !hora || (!esCombo && !recursoCodigo)) {
      return;
    }
    setReservando(true);
    limpiar();
    const inicio = `${fecha}T${hora}:00-03:00`;
    const pacienteRef = `Patient/${paciente.id}`;
    const coverageId = usarPlan && plan ? plan.coverageId : undefined;
    try {
      let creado = false;
      if (esCombo) {
        const r = await reservarCombo({ pacienteRef, comboCodigo: seleccion, inicio, coverageId, confirmar: true });
        setResultadoCombo(r);
        creado = r.creado;
      } else {
        const r = await reservarTurno({
          pacienteRef,
          servicioCodigo: seleccion,
          recursoCodigo: recursoCodigo as string,
          inicio,
          prescripcionActiva: prescripcion,
          coverageId,
          confirmar: true,
        });
        setResultado(r);
        creado = r.creado;
      }
      // Si se consumió una sesión del plan, refrescar el saldo mostrado.
      if (creado && coverageId) {
        await onReservado();
      }
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setReservando(false);
    }
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Group gap="xs" mb="sm">
        <IconCalendarPlus size={18} />
        <Text fw={600}>Reservar turno</Text>
      </Group>

      <Stack gap="sm">
        <Group grow align="flex-end">
          <Select
            label="Servicio o combo"
            placeholder="Elegí qué reservar"
            data={opciones}
            value={seleccion}
            onChange={(v) => {
              setSeleccion(v);
              setRecursoCodigo(null);
              limpiar();
            }}
            searchable
          />
          {!esCombo && (
            <Select
              label="Sala / equipo"
              placeholder={servicio ? 'Elegí la sala' : 'Primero el servicio'}
              data={salas.map((r) => ({ value: r.codigo, label: r.nombre }))}
              value={recursoCodigo}
              onChange={setRecursoCodigo}
              disabled={!servicio}
              searchable
            />
          )}
        </Group>

        <Group grow align="flex-end">
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
          <Select
            label={esCombo ? 'Hora de inicio' : 'Hora'}
            placeholder={horas.length ? 'Elegí la hora' : 'Cerrado ese día'}
            data={horas}
            value={hora}
            onChange={setHora}
            disabled={!horas.length}
            searchable
          />
        </Group>

        {esCombo && (
          <Text size="xs" c="dimmed">
            El sistema agenda los componentes en orden (HBOT primero) y elige una sala libre para cada uno.
          </Text>
        )}

        {servicio?.requierePrescripcion && (
          <Switch
            label="Prescripción médica activa (requerida para IV / Terapias Biológicas)"
            checked={prescripcion}
            onChange={(e) => setPrescripcion(e.currentTarget.checked)}
          />
        )}

        {plan && (
          <Switch
            label={`Usar ${plan.nombre} (quedan ${plan.saldo.restantes} sesiones) — confirma sin seña`}
            checked={usarPlan}
            onChange={(e) => setUsarPlan(e.currentTarget.checked)}
          />
        )}

        <Group>
          <Button
            onClick={() => void reservar()}
            loading={reservando}
            disabled={!seleccion || !hora || (!esCombo && !recursoCodigo)}
          >
            {esCombo ? 'Reservar combo' : 'Reservar turno'}
          </Button>
        </Group>

        {error && (
          <Alert color="orange" icon={<IconInfoCircle size={16} />}>
            {error}
          </Alert>
        )}

        {resultado?.creado && (
          <Alert color="bio" title="Turno reservado ✓">
            {resultado.planRestantes !== undefined
              ? `Confirmado con el plan. Quedan ${resultado.planRestantes} sesiones. La sala queda ocupada en la agenda.`
              : 'La sala queda ocupada en la agenda. Tentativo hasta cobrar la seña del 50%.'}
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

        {resultadoCombo?.creado && (
          <Alert color="bio" title="Combo reservado ✓">
            {resultadoCombo.planRestantes !== undefined && (
              <Text size="sm" mb="xs">
                Confirmado con la membresía. Quedan {resultadoCombo.planRestantes} sesiones este mes.
              </Text>
            )}
            <List size="sm">
              {resultadoCombo.plan.map((p, i) => (
                <List.Item key={i}>
                  {p.desde}–{p.hasta} · {p.servicio} · {p.recurso}
                </List.Item>
              ))}
            </List>
          </Alert>
        )}
        {resultadoCombo && !resultadoCombo.creado && (
          <Alert color="red" title="No se pudo reservar el combo" icon={<IconShieldX size={16} />}>
            <List size="sm">
              {resultadoCombo.bloqueos.map((b, i) => (
                <List.Item key={i}>
                  [{b.regla}] {b.mensaje}
                </List.Item>
              ))}
            </List>
          </Alert>
        )}
      </Stack>
    </Card>
  );
}

/**
 * Cobro presencial: el sistema calcula el monto según el tipo de cliente
 * (FM / miembro a la carte) y registra ChargeItems + un Invoice `balanced` por
 * medio de pago (mixto = 2 Invoices). La recepción solo elige el medio.
 */
function PanelCobro({ paciente }: { paciente: Patient }): JSX.Element {
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const [cotizacion, setCotizacion] = useState<ResultadoRegistrarCobro | null>(null);
  const [registro, setRegistro] = useState<ResultadoRegistrarCobro | null>(null);
  const [medio, setMedio] = useState<string>('efectivo');
  const [mixto, setMixto] = useState(false);
  const [medio2, setMedio2] = useState<string>('tarjeta-debito');
  const [monto1, setMonto1] = useState<number>(0);
  const [trabajando, setTrabajando] = useState<'calcular' | 'cobrar' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const opciones = [
    { group: 'Combos', items: COMBOS.map((c) => ({ value: c.codigo, label: c.nombre })) },
    { group: 'Servicios', items: SERVICIOS.map((s) => ({ value: s.codigo, label: s.nombre })) },
  ];

  const items = (): { tipo: 'combo' | 'servicio'; codigo: string }[] =>
    seleccion ? [{ tipo: COMBOS.some((c) => c.codigo === seleccion) ? 'combo' : 'servicio', codigo: seleccion }] : [];

  async function calcular(): Promise<void> {
    if (!seleccion) {
      return;
    }
    setTrabajando('calcular');
    setError(null);
    setRegistro(null);
    setCotizacion(null);
    try {
      const r = await registrarCobro({ pacienteRef: `Patient/${paciente.id}`, items: items(), medios: [], soloCalcular: true });
      if (!r.ok) {
        setError(r.mensaje ?? 'No se pudo calcular.');
        return;
      }
      setCotizacion(r);
      setMonto1(Math.floor((r.totalARS ?? 0) / 2)); // precarga 50/50 para el mixto
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setTrabajando(null);
    }
  }

  async function cobrar(): Promise<void> {
    if (!seleccion || !cotizacion?.totalARS) {
      return;
    }
    const total = cotizacion.totalARS;
    const medios = mixto
      ? [
          { medio, montoARS: monto1 },
          { medio: medio2, montoARS: total - monto1 },
        ]
      : [{ medio }];
    setTrabajando('cobrar');
    setError(null);
    try {
      const r = await registrarCobro({
        pacienteRef: `Patient/${paciente.id}`,
        items: items(),
        medios,
        clave: `${paciente.id}-${seleccion}-${Date.now()}`,
      });
      if (!r.ok) {
        setError(r.mensaje ?? 'No se pudo registrar el cobro.');
        return;
      }
      setRegistro(r);
      setCotizacion(null);
      setSeleccion(null);
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setTrabajando(null);
    }
  }

  const total = cotizacion?.totalARS ?? 0;

  return (
    <Card withBorder radius="md" padding="lg">
      <Group gap="xs" mb="sm">
        <IconCash size={18} />
        <Text fw={600}>Cobro</Text>
      </Group>
      <Group align="flex-end">
        <Select
          label="Servicio o combo"
          placeholder="Elegí qué cobrar"
          data={opciones}
          value={seleccion}
          onChange={(v) => {
            setSeleccion(v);
            setCotizacion(null);
            setRegistro(null);
            setError(null);
          }}
          searchable
          w={360}
        />
        <Button onClick={() => void calcular()} loading={trabajando === 'calcular'} disabled={!seleccion}>
          Calcular
        </Button>
      </Group>

      {error && (
        <Alert color="orange" mt="md" icon={<IconInfoCircle size={16} />}>
          {error}
        </Alert>
      )}

      {cotizacion && (
        <Stack mt="md" gap="sm">
          <Alert color="bio" title="Total a cobrar">
            <Text size="xl" fw={700}>
              <NumberFormatter prefix="$ " value={total} thousandSeparator="." decimalSeparator="," />
            </Text>
            {cotizacion.lineas?.map((l, i) => (
              <Text key={i} size="sm" c="dimmed">
                {l.descripcion}: ${l.montoARS.toLocaleString('es-AR')}
                {l.descuentoPct
                  ? ` (con ${Math.round(l.descuentoPct * 100)}% OFF ${l.descuentoOrigen === 'fm' ? 'Founding Member' : 'miembro a la carte'})`
                  : ''}
              </Text>
            ))}
          </Alert>

          <Group align="flex-end">
            <Select label={mixto ? 'Medio 1' : 'Medio de pago'} data={MEDIOS_SELECT} value={medio} onChange={(v) => setMedio(v ?? 'efectivo')} w={190} />
            <Switch label="Pago mixto (2 medios)" checked={mixto} onChange={(e) => setMixto(e.currentTarget.checked)} mb={8} />
          </Group>

          {mixto && (
            <Group align="flex-end">
              <TextInput
                label={`Monto medio 1 (${medio})`}
                type="number"
                value={String(monto1)}
                onChange={(e) => setMonto1(Number(e.currentTarget.value) || 0)}
                w={190}
              />
              <Select label="Medio 2" data={MEDIOS_SELECT.filter((m) => m.value !== medio)} value={medio2} onChange={(v) => setMedio2(v ?? 'tarjeta-debito')} w={190} />
              <Text size="sm" c="dimmed" mb={10}>
                Medio 2 paga: ${Math.max(total - monto1, 0).toLocaleString('es-AR')} (suma exacta al total)
              </Text>
            </Group>
          )}

          <Group>
            <Button color="bio" onClick={() => void cobrar()} loading={trabajando === 'cobrar'}>
              Registrar cobro
            </Button>
          </Group>
        </Stack>
      )}

      {registro?.ok && (
        <Alert color="bio" mt="md" title="Cobro registrado ✓">
          {registro.invoices?.map((inv, i) => (
            <Text key={i} size="sm">
              {MEDIOS_SELECT.find((m) => m.value === inv.medio)?.label ?? inv.medio}: ${inv.montoARS.toLocaleString('es-AR')}
            </Text>
          ))}
          <Text size="xs" c="dimmed" mt={4}>
            Quedó registrado para el cierre de caja y los reportes de Administración.
          </Text>
        </Alert>
      )}
    </Card>
  );
}
