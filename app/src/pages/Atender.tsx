import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  CopyButton,
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
  IconShieldQuestion,
  IconShieldX,
  IconCash,
  IconCalendarPlus,
  IconInfoCircle,
  IconLicense,
  IconUserPlus,
} from '@tabler/icons-react';
import type { Invoice, Patient } from '@medplum/fhirtypes';
import { COD_CONSENTIMIENTO } from '@bw/fhir/identifiers';
import { textoConsentimiento } from '@bw/lib/consentimiento';
import { accionSeguridad, tituloSeguridad } from '@bw/lib/seguridad';
import { getDisplayString } from '@medplum/core';
import { medplum } from '../medplum';
import {
  cobrarPendiente,
  registrarCobro,
  reservarTurno,
  reservarCombo,
  asignarPlan,
  mensajeError,
  estadoConsentimientoPaciente,
  estadoSeguridadPaciente,
  type EstadoConsentimientoBot,
  type EstadoSeguridadBot,
  type ResultadoReserva,
  type ResultadoCombo,
  type ResultadoRegistrarCobro,
} from '../lib/bots';
import { cargarPlanesActivos, planUsable, type PlanPaciente } from '../lib/planes';
import { MEDIOS_SELECT } from '../lib/medios';
import { SYSTEM } from '@bw/fhir/identifiers';
import { busquedasPara } from '@bw/lib/busqueda-paciente';
import { PreAgendaModal } from '../components/PreAgendaModal';
import { InvitarPortal } from '../components/InvitarPortal';
import { KioscoIngreso } from '../components/KioscoIngreso';
import { NuevoPacienteModal } from '../components/NuevoPacienteModal';
import { FoundingMember } from '../components/FoundingMember';
import { esFm } from '@bw/fhir/founding';
import { SERVICIOS, nombreServicioRecepcion } from '@bw/config/catalogo';
import { COMBOS } from '@bw/config/combos';
import { MEMBRESIAS } from '@bw/config/membresias';
import { PAQUETES } from '@bw/config/paquetes';
import { recursosParaCategoria } from '@bw/config/recursos';
import { generarSlots } from '@bw/lib/slots';
import { HORARIO_SEMANAL } from '@bw/config/horario';

/**
 * Lo que el paciente pidió desde el portal (Task solicitud-turno): llega desde
 * Solicitudes → Atender para PRELLENAR la reserva. Sin esto, Recepción
 * re-tipeaba de memoria y podía confirmar otro servicio u otro horario.
 */
export interface ReservaPrefill {
  /** Código del servicio pedido (terapia-codigo). */
  servicioCodigo?: string;
  /** Horario exacto elegido de los chips (preferencia-inicio, ISO). */
  inicio?: string;
}

export function Atender({
  pacienteInicialId,
  onPacienteInicialCargado,
  reservaInicial,
  onReservaInicialAplicada,
}: {
  /** Si viene, se abre directo la ficha de ese paciente (p. ej. desde Planes y sesiones). */
  pacienteInicialId?: string | null;
  onPacienteInicialCargado?: () => void;
  /** Si viene, la reserva arranca prellenada con lo que pidió el paciente. */
  reservaInicial?: ReservaPrefill | null;
  onReservaInicialAplicada?: () => void;
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
      // Se lanzan TODAS las búsquedas que apliquen (nombre, DNI, teléfono) y se
      // juntan sin repetir. Antes decidía una sola regla —dígitos = DNI, si no
      // nombre— y con eso era imposible encontrar a alguien por su teléfono:
      // justo lo único que tiene la ficha creada desde un aviso de WhatsApp.
      // Esa búsqueda vacía es la que terminaba en una ficha duplicada.
      const porId = new Map<string, Patient>();
      for (const b of busquedasPara(query)) {
        for (const valor of b.valores) {
          const campo = b.tipo === 'nombre' ? 'name' : b.tipo === 'dni' ? 'identifier' : 'telecom';
          const encontrados = await medplum.searchResources('Patient', { [campo]: valor, _count: 10 });
          for (const p of encontrados) {
            if (p.id) {
              porId.set(p.id, p);
            }
          }
        }
      }
      setResultados([...porId.values()]);
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
          label="Buscar por nombre, DNI o teléfono"
          placeholder="Ej.: Pérez · 30123456 · 11 6931-5830"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && void buscar()}
          w={420}
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

      {seleccionado && (
        <FichaPaciente
          paciente={seleccionado}
          onVolver={() => setSeleccionado(null)}
          reservaInicial={reservaInicial}
          onReservaInicialAplicada={onReservaInicialAplicada}
        />
      )}
    </Stack>
  );
}

function FichaPaciente({
  paciente,
  onVolver,
  reservaInicial,
  onReservaInicialAplicada,
}: {
  paciente: Patient;
  onVolver: () => void;
  reservaInicial?: ReservaPrefill | null;
  onReservaInicialAplicada?: () => void;
}): JSX.Element {
  const [planes, setPlanes] = useState<PlanPaciente[]>([]);
  const [versionPagos, setVersionPagos] = useState(0);
  // Se incrementa al volver del kiosco, para que el banner relea la señal.
  const [versionSeguridad, setVersionSeguridad] = useState(0);
  const [kiosco, setKiosco] = useState(false);
  // Copia viva del Patient: marcar/quitar Founding lo actualiza sin re-buscar.
  const [pacienteActual, setPacienteActual] = useState(paciente);

  useEffect(() => {
    setPacienteActual(paciente);
  }, [paciente]);

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
        <Group gap="sm">
          <Title order={3}>{getDisplayString(pacienteActual)}</Title>
          <FoundingMember paciente={pacienteActual} onCambio={setPacienteActual} />
          <SenalConsentimiento pacienteId={paciente.id!} />
        </Group>
        <Button variant="subtle" onClick={onVolver}>
          ← Volver a la búsqueda
        </Button>
      </Group>
      <BannerSeguridad pacienteId={paciente.id!} version={versionSeguridad} />
      {/* Kiosco: se le presta la tablet al paciente para que firme y conteste.
          Al volver se refresca el banner, que es donde se ve el resultado. */}
      <Group>
        <Button
          variant="light"
          leftSection={<IconShieldCheck size={16} />}
          onClick={() => setKiosco(true)}
        >
          Consentimiento y cuestionario (darle la tablet al paciente)
        </Button>
      </Group>
      <KioscoIngreso
        paciente={paciente}
        abierto={kiosco}
        onCerrar={() => setKiosco(false)}
        onListo={() => setVersionSeguridad((v) => v + 1)}
      />
      <PagosPendientes paciente={paciente} version={versionPagos} onCobrado={() => setVersionPagos((v) => v + 1)} />
      <InvitarPortal paciente={paciente} />
      <PanelPlanes paciente={paciente} planes={planes} onCambio={recargarPlanes} esFm={esFm(pacienteActual)} />
      <PanelReserva
        paciente={paciente}
        planes={planes}
        onReservado={recargarPlanes}
        prefill={reservaInicial ?? undefined}
        onPrefillAplicado={onReservaInicialAplicada}
      />
      <PanelCobro paciente={paciente} />
    </Stack>
  );
}

/** Planes (membresías/paquetes) del paciente: muestra saldo y permite asignar uno. */
function PanelPlanes({
  paciente,
  planes,
  onCambio,
  esFm,
}: {
  paciente: Patient;
  planes: PlanPaciente[];
  onCambio: () => Promise<void>;
  /** Marca Founding de la ficha: precarga el 20% en paquetes (R-09). */
  esFm: boolean;
}): JSX.Element {
  const [tipo, setTipo] = useState<'membresia' | 'paquete'>('membresia');
  const [planCodigo, setPlanCodigo] = useState<string | null>(null);
  const [fm, setFm] = useState(esFm);

  // El descuento sale de la FICHA, no de la memoria de la recepcionista: si la
  // marca cambia (o se abre otro paciente), el switch se realinea solo.
  useEffect(() => {
    setFm(esFm);
  }, [esFm, paciente.id]);
  const [medioPago, setMedioPago] = useState<string>('efectivo');
  const [asignando, setAsignando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pendienteMP, setPendienteMP] = useState<{ monto: number; url?: string; nota?: string } | null>(null);
  const [preAgenda, setPreAgenda] = useState<PlanPaciente | null>(null);

  const opciones =
    tipo === 'membresia'
      ? MEMBRESIAS.map((m) => ({ value: m.codigo, label: `${m.tier} ${m.intensidad} ${m.variante}` }))
      : PAQUETES.map((p) => ({ value: p.codigo, label: `${p.nombre} (${p.tamano} sesiones)` }));

  async function asignar(): Promise<void> {
    if (!planCodigo) {
      return;
    }
    setAsignando(true);
    setError(null);
    setOk(null);
    setPendienteMP(null);
    try {
      const r = await asignarPlan({
        pacienteRef: `Patient/${paciente.id}`,
        tipo,
        planCodigo,
        fm: tipo === 'paquete' ? fm : undefined,
        medioPago,
      });
      if (r.ok && r.pendiente) {
        // MercadoPago: el plan queda PENDIENTE hasta que el pago se acredite
        // (webhook). Nada de "activado" ni sesiones disponibles todavía.
        setPendienteMP({ monto: r.totalARS ?? 0, url: r.url, nota: r.mensaje });
        setPlanCodigo(null);
        await onCambio();
      } else if (r.ok) {
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
              <Text size="sm" fw={500} c={p.pendientePago ? 'dimmed' : undefined}>
                {p.nombre}
              </Text>
              <Group gap="xs">
                {p.pendientePago ? (
                  // Asignado con MercadoPago, esperando la acreditación: las
                  // sesiones NO están disponibles hasta que el pago entre.
                  <>
                    <Badge color="gray" variant="light">
                      {p.estado.total} sesiones
                    </Badge>
                    <Badge color="yellow" variant="filled">
                      ⏳ pendiente de pago
                    </Badge>
                  </>
                ) : (
                  <>
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
                  </>
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
        <Switch
          mt="sm"
          label="Founding Member (20% OFF)"
          description={
            esFm
              ? 'Precargado de la ficha: el paciente es Founding.'
              : 'El paciente NO está marcado Founding en la ficha. Si corresponde, marcalo arriba en vez de prender esto a mano.'
          }
          checked={fm}
          onChange={(e) => setFm(e.currentTarget.checked)}
        />
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
      {pendienteMP && (
        <Alert color="yellow" mt="md" title="Plan PENDIENTE de pago (MercadoPago)">
          <Stack gap={6}>
            <Text size="sm">
              Se reservó el plan y le enviamos al paciente el link de pago por{' '}
              <NumberFormatter prefix="$" value={pendienteMP.monto} thousandSeparator="." decimalSeparator="," />. Las
              sesiones se habilitan solas cuando el pago se acredite (también se puede cobrar en mostrador desde
              “Pagos pendientes”).
            </Text>
            {pendienteMP.url ? (
              <Group gap="xs">
                <Anchor href={pendienteMP.url} target="_blank" rel="noreferrer" size="sm" style={{ wordBreak: 'break-all' }}>
                  {pendienteMP.url}
                </Anchor>
                <CopyButton value={pendienteMP.url}>
                  {({ copied, copy }) => (
                    <Button size="compact-xs" variant="light" onClick={copy}>
                      {copied ? 'Copiado ✓' : 'Copiar link'}
                    </Button>
                  )}
                </CopyButton>
              </Group>
            ) : (
              <Text size="sm" c="dimmed">
                No se pudo generar el link de MercadoPago{pendienteMP.nota ? ` (${pendienteMP.nota})` : ''}: cobrarlo en
                mostrador desde “Pagos pendientes”.
              </Text>
            )}
            {pendienteMP.url && pendienteMP.nota && (
              <Text size="xs" c="dimmed">
                {pendienteMP.nota}
              </Text>
            )}
          </Stack>
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
/**
 * Señal de consentimiento firmado en el portal, al lado del nombre.
 *
 * Es una señal BINARIA: firmado / sin firmar / no verificable, con la fecha.
 * Nunca el documento ni el detalle clínico — eso vive del lado médico y el bot
 * `bw-estado-consentimiento` no lo devuelve (CLAUDE.md, principio 3).
 *
 * Ojo con el default ante error: acá NO se copia el `.catch(() => 'verde')` del
 * banner de seguridad. Si no se pudo verificar, se dice; dar por firmado lo que
 * no se pudo leer habilitaría una Terapia Biológica sin respaldo (R-03).
 */
function SenalConsentimiento({ pacienteId }: { pacienteId: string }): JSX.Element | null {
  const [resultado, setResultado] = useState<EstadoConsentimientoBot | null>(null);

  useEffect(() => {
    let activo = true;
    setResultado(null);
    // Se pregunta por el consentimiento GENERAL de atención, no por
    // "cualquiera": si no se filtrara, la autorización que el paciente firma al
    // subir un PDF de laboratorio haría decir "Consentimiento firmado" aunque
    // nunca haya firmado el general. Serían dos cosas distintas con el mismo cartel.
    estadoConsentimientoPaciente(`Patient/${pacienteId}`, COD_CONSENTIMIENTO.atencion)
      .then((r) => activo && setResultado(r))
      .catch(() => activo && setResultado({ ok: false, estado: 'no-verificable' }));
    return () => {
      activo = false;
    };
  }, [pacienteId]);

  if (!resultado) {
    return <Loader size="xs" />;
  }
  const texto = textoConsentimiento({ estado: resultado.estado, fechaISO: resultado.fechaISO });
  const color = resultado.estado === 'firmado' ? 'bio' : resultado.estado === 'no-registrado' ? 'gray' : 'yellow';
  return (
    <Badge
      variant="light"
      color={color}
      title={texto}
      leftSection={resultado.estado === 'firmado' ? <IconShieldCheck size={12} /> : <IconInfoCircle size={12} />}
    >
      {resultado.estado === 'firmado' ? 'Consentimiento firmado' : texto}
    </Badge>
  );
}

/**
 * Banner de seguridad. Tiene CUATRO estados, no dos.
 *
 * Hasta 2026-08-14 derivaba el color solo de los `Flag` activos: sin Flags
 * pintaba verde y afirmaba "Paciente apto para atención". Para un paciente
 * recién creado en el mostrador —que nunca contestó una pregunta de screening—
 * eso era afirmar algo que nadie verificó; y el `.catch(() => 'verde')` hacía
 * que un error de lectura se viera exactamente igual. Ahora la señal la calcula
 * `bw-estado-seguridad` y **falla cerrado**: sin screening o sin poder consultar,
 * el banner lo dice en vez de dar el OK.
 */
function BannerSeguridad({ pacienteId, version = 0 }: { pacienteId: string; version?: number }): JSX.Element {
  const [seguridad, setSeguridad] = useState<EstadoSeguridadBot | null>(null);
  const [bloqueoPago, setBloqueoPago] = useState(false);

  useEffect(() => {
    let activo = true;
    setSeguridad(null);
    estadoSeguridadPaciente(`Patient/${pacienteId}`)
      .then((r) => activo && setSeguridad(r))
      .catch(() => activo && setSeguridad({ ok: false, estado: 'no-verificable', color: 'gris', puedeAvanzar: false }));
    // El bloqueo administrativo por pago (R-11) es su propio aviso y se sigue
    // leyendo directo: es dato administrativo, no clínico.
    medplum
      .searchResources('Flag', { subject: `Patient/${pacienteId}`, status: 'active', _count: 20 })
      .then((flags) => {
        if (activo) {
          setBloqueoPago(flags.some((f) => f.code?.coding?.some((c) => c.system === SYSTEM.bloqueo)));
        }
      })
      .catch(() => activo && setBloqueoPago(false));
    return () => {
      activo = false;
    };
  }, [pacienteId, version]);

  if (!seguridad) {
    return <Loader size="sm" />;
  }
  const colorAlerta = seguridad.color === 'rojo' ? 'red' : seguridad.color === 'verde' ? 'bio' : 'yellow';
  const Icono = seguridad.estado === 'apto' ? IconShieldCheck : seguridad.estado === 'contraindicado' ? IconShieldX : IconShieldQuestion;
  return (
    <>
      <Alert color={colorAlerta} icon={<Icono size={20} />} title={tituloSeguridad(seguridad.estado)} variant="filled">
        {accionSeguridad(seguridad.estado)}
      </Alert>
      {bloqueoPago && (
        <Alert color="orange" icon={<IconInfoCircle size={20} />} title="Pagos pendientes de regularizar (R-11)" variant="filled">
          El último cobro de la membresía fue rechazado. No puede hacer nuevas reservas hasta regularizar el pago.
        </Alert>
      )}
    </>
  );
}

/**
 * Cuotas de plan pendientes (`issued`) o rechazadas (`cancelled`, R-11): recepción
 * las cobra acá eligiendo el medio; el bot las pasa a `balanced`, crea el
 * ChargeItem y levanta el bloqueo de reservas.
 */
function PagosPendientes({
  paciente,
  version,
  onCobrado,
}: {
  paciente: Patient;
  version: number;
  onCobrado: () => void;
}): JSX.Element | null {
  const [pendientes, setPendientes] = useState<Invoice[]>([]);
  const [medios, setMedios] = useState<Record<string, string>>({});
  const [cobrando, setCobrando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let activo = true;
    void (async () => {
      try {
        const [issued, cancelled] = await Promise.all([
          medplum.searchResources('Invoice', { subject: `Patient/${paciente.id}`, status: 'issued', _count: 20 }),
          medplum.searchResources('Invoice', { subject: `Patient/${paciente.id}`, status: 'cancelled', _count: 20 }),
        ]);
        if (activo) {
          const esCobrable = (i: Invoice): boolean =>
            Boolean(i.identifier?.some((x) => x.value?.startsWith('plan-') || x.value?.startsWith('saldo-')));
          setPendientes([...issued, ...cancelled].filter(esCobrable));
        }
      } catch {
        // sin permisos o sin datos: no mostrar el panel
      }
    })();
    return () => {
      activo = false;
    };
  }, [paciente.id, version]);

  if (pendientes.length === 0) {
    return null;
  }

  async function cobrar(inv: Invoice): Promise<void> {
    if (!inv.id) {
      return;
    }
    setCobrando(inv.id);
    setError(null);
    try {
      const r = await cobrarPendiente(inv.id, medios[inv.id] ?? 'efectivo');
      if (!r.ok) {
        setError(r.mensaje ?? 'No se pudo cobrar.');
        return;
      }
      onCobrado();
    } catch (e) {
      setError(mensajeError(e));
    } finally {
      setCobrando(null);
    }
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Group gap="xs" mb="sm">
        <IconCash size={18} />
        <Text fw={600}>Pagos pendientes (planes y saldos de turno)</Text>
      </Group>
      <Stack gap="xs">
        {pendientes.map((inv) => (
          <Group key={inv.id} justify="space-between" wrap="wrap">
            <div>
              <Text size="sm" fw={500}>
                {inv.lineItem?.[0]?.chargeItemCodeableConcept?.text ??
                  inv.lineItem?.[0]?.chargeItemReference?.display ??
                  'Cuota de plan'}
              </Text>
              <Group gap={6}>
                <Badge color={inv.status === 'cancelled' ? 'red' : 'yellow'} variant="light">
                  {inv.status === 'cancelled' ? 'Rechazado (R-11)' : 'Pendiente'}
                </Badge>
                <Text size="sm" c="dimmed">
                  ${(inv.totalGross?.value ?? 0).toLocaleString('es-AR')}
                </Text>
              </Group>
            </div>
            <Group gap="xs">
              <Select
                data={MEDIOS_SELECT}
                value={medios[inv.id!] ?? 'efectivo'}
                onChange={(v) => setMedios((m) => ({ ...m, [inv.id!]: v ?? 'efectivo' }))}
                w={170}
                size="xs"
              />
              <Button size="xs" color="bio" loading={cobrando === inv.id} onClick={() => void cobrar(inv)}>
                Cobrar
              </Button>
            </Group>
          </Group>
        ))}
        {error && (
          <Alert color="orange" icon={<IconInfoCircle size={16} />}>
            {error}
          </Alert>
        )}
      </Stack>
    </Card>
  );
}

const TZ_AR = 'America/Argentina/Buenos_Aires';

/** Reserva de turno o combo: el front arma la propuesta y el bot valida + crea. */
function PanelReserva({
  paciente,
  planes,
  onReservado,
  prefill,
  onPrefillAplicado,
}: {
  paciente: Patient;
  planes: PlanPaciente[];
  onReservado: () => Promise<void>;
  /** Lo que pidió el paciente desde el portal: arranca cargado, editable. */
  prefill?: ReservaPrefill;
  onPrefillAplicado?: () => void;
}): JSX.Element {
  const hoy = new Date().toISOString().slice(0, 10);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const [recursoCodigo, setRecursoCodigo] = useState<string | null>(null);
  const [fecha, setFecha] = useState(hoy);
  const [hora, setHora] = useState<string | null>(null);

  // Prefill de la solicitud del portal (una sola vez): el servicio y el horario
  // que el paciente ELIGIÓ llegan ya puestos — confirmar es un clic, y el error
  // de re-tipear otro servicio (pasó en producción) desaparece. Editable igual.
  useEffect(() => {
    if (!prefill) {
      return;
    }
    if (
      prefill.servicioCodigo &&
      (SERVICIOS.some((s) => s.codigo === prefill.servicioCodigo) || COMBOS.some((c) => c.codigo === prefill.servicioCodigo))
    ) {
      setSeleccion(prefill.servicioCodigo);
    }
    if (prefill.inicio) {
      const d = new Date(prefill.inicio);
      if (!Number.isNaN(d.getTime())) {
        setFecha(d.toLocaleDateString('en-CA', { timeZone: TZ_AR }));
        setHora(d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ_AR }));
      }
    }
    onPrefillAplicado?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);
  const [prescripcion, setPrescripcion] = useState(false);
  const [consentimiento, setConsentimiento] = useState(false);
  /** Consentimiento de TB firmado en el portal (R-03): lo verifica el sistema. */
  const [consentTB, setConsentTB] = useState<EstadoConsentimientoBot | null>(null);
  const [usarPlan, setUsarPlan] = useState(true);
  const [resultado, setResultado] = useState<ResultadoReserva | null>(null);
  const [resultadoCombo, setResultadoCombo] = useState<ResultadoCombo | null>(null);
  const [reservando, setReservando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const esCombo = seleccion ? COMBOS.some((c) => c.codigo === seleccion) : false;
  const servicio = !esCombo && seleccion ? SERVICIOS.find((s) => s.codigo === seleccion) : undefined;
  const salas = servicio ? recursosParaCategoria(servicio.categoria) : [];

  // R-03: al elegir una Terapia Biológica, el sistema pregunta si el paciente
  // ya firmó en el portal, en vez de confiar en la memoria de la recepcionista
  // (principio 1). El switch queda editable igual: la firma en papel en el
  // mostrador sigue siendo un caso real.
  const esTB = servicio?.categoria === 'TERAPIA_BIOLOGICA';
  useEffect(() => {
    if (!esTB || !paciente.id) {
      setConsentTB(null);
      return;
    }
    let activo = true;
    setConsentTB(null);
    estadoConsentimientoPaciente(`Patient/${paciente.id}`, COD_CONSENTIMIENTO.terapiaBiologica)
      .then((r) => {
        if (!activo) {
          return;
        }
        setConsentTB(r);
        // Solo 'firmado' precarga el switch. 'no-verificable' NO: ante la duda
        // lo declara la recepcionista, y así queda claro quién lo afirmó.
        if (r.estado === 'firmado') {
          setConsentimiento(true);
        }
      })
      .catch(() => activo && setConsentTB({ ok: false, estado: 'no-verificable' }));
    return () => {
      activo = false;
    };
  }, [esTB, paciente.id]);

  // ¿Hay un plan utilizable para lo seleccionado? (membresía↔combo, paquete↔servicio)
  const plan = seleccion
    ? planUsable(planes, { tipo: esCombo ? 'combo' : 'servicio', codigo: seleccion })
    : undefined;

  const opciones = [
    { group: 'Combos (secuencia automática)', items: COMBOS.map((c) => ({ value: c.codigo, label: c.nombre })) },
    { group: 'Servicios', items: SERVICIOS.map((s) => ({ value: s.codigo, label: nombreServicioRecepcion(s) })) },
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
          consentimientoFirmado: consentimiento,
          // De dónde salió la afirmación: verificada contra el portal o
          // declarada por Recepción. Sin esto no hay forma de reconstruir
          // quién dijo que había consentimiento ante un reclamo.
          origenConsentimiento: consentTB?.estado === 'firmado' ? 'portal' : 'declarado-recepcion',
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

        {servicio?.categoria === 'TERAPIA_BIOLOGICA' && (
          <>
            <Group gap="xs" align="center">
              <Switch
                label="Consentimiento informado FIRMADO (requerido para Terapias Biológicas)"
                description={
                  consentTB
                    ? `${textoConsentimiento({ estado: consentTB.estado, fechaISO: consentTB.fechaISO })}. Responsable principal: el médico que indica; luego el Director Médico.`
                    : 'Verificando contra el portal… Responsable principal: el médico que indica; luego el Director Médico.'
                }
                checked={consentimiento}
                onChange={(e) => setConsentimiento(e.currentTarget.checked)}
              />
              {consentTB?.estado === 'firmado' && (
                <Badge variant="light" color="bio" leftSection={<IconShieldCheck size={12} />}>
                  Verificado en el portal
                </Badge>
              )}
              {consentTB?.estado === 'no-verificable' && (
                <Badge variant="light" color="yellow" leftSection={<IconInfoCircle size={12} />}>
                  Sin verificar
                </Badge>
              )}
            </Group>
            {consentTB?.estado === 'no-registrado' && !consentimiento && (
              <Text size="xs" c="dimmed">
                El paciente puede firmarlo desde el portal. Si firmó en papel en el mostrador, tildalo acá: queda
                registrado que lo declaró Recepción.
              </Text>
            )}
            <Text size="xs" c="dimmed">
              Estas terapias siempre requieren evaluación e indicación médica previas. Info para el paciente:{' '}
              <Anchor href="https://info.biowellness.ar/terapias-biologicas.html" target="_blank" size="xs">
                info.biowellness.ar/terapias-biologicas
              </Anchor>
            </Text>
          </>
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
  // Clave idempotente del cobro: se genera UNA vez al cotizar; si la recepcionista
  // hace doble click en "Registrar cobro" (o se reintenta), el bot deduplica.
  const [claveCobro, setClaveCobro] = useState<string>('');

  const opciones = [
    { group: 'Combos', items: COMBOS.map((c) => ({ value: c.codigo, label: c.nombre })) },
    { group: 'Servicios', items: SERVICIOS.map((s) => ({ value: s.codigo, label: nombreServicioRecepcion(s) })) },
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
      setClaveCobro(`${paciente.id}-${seleccion}-${Date.now()}`);
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
        clave: claveCobro || `${paciente.id}-${seleccion}-${Date.now()}`,
      });
      if (!r.ok) {
        setError(r.mensaje ?? 'No se pudo registrar el cobro.');
        return;
      }
      setRegistro(r);
      setCotizacion(null);
      setSeleccion(null);
      setClaveCobro('');
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
