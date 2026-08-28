# App de Recepción (frontend)

SPA en **React + Vite + Mantine v7** (TypeScript) que consume el backend Medplum.
Vive en `app/`. Toda la lógica de negocio está en los Bots / `src/lib`: el front
**solo orquesta** (busca, muestra, llama bots por nombre vía `app/src/lib/bots.ts`).

## Correr en local

```bash
npm run dev        # levanta Vite en http://localhost:5173 (alias del workspace app)
npm run build:app  # build de producción
npm run app:typecheck
```

Config por env (prefijos expuestos al browser: `MEDPLUM_`, `GOOGLE_`,
`RECAPTCHA_`; ver `app/vite.config.ts`). La principal es `MEDPLUM_BASE_URL`
(default `https://api.medplum.com.ar/`). La sesión se persiste en `localStorage`,
así que el login sobrevive al refresh. **Sin login** se muestra el formulario de
ingreso; el resto del UI requiere sesión.

## Producción: nginx sirviendo el build estático (recomendado)

En producción NO usar `vite dev`/`preview`: buildear y servir `app/dist/` como
estáticos con nginx. Así desaparecen el chequeo de `allowedHosts` y el websocket
de HMR, y el front queda cacheado y comprimido.

Config lista para copiar: [`deploy/nginx-recepcion.conf`](../deploy/nginx-recepcion.conf)
(instrucciones de instalación en el encabezado del archivo). Para la **API**
(proceso Node con pm2, puerto 8103) el patrón es reverse proxy, no estáticos:
ver [`deploy/nginx-api-proxy.conf`](../deploy/nginx-api-proxy.conf). Flujo de update:

```bash
git pull && npm run build:app     # nginx no se toca: sirve el dist nuevo al instante
```

> `GOOGLE_CLIENT_ID` (y cualquier env del front) debe estar en `app/.env`
> **al momento del build** — con estáticos no hay proceso que lo lea después.

## Estructura

- `app/src/pages/` — una por vista (Agenda, Planes y sesiones, Atender, Reportes).
- `app/src/components/` — `Shell` (layout + nav + tema), `Timeline`,
  `ProximosTurnos`, `ReservaModal`, `PreAgendaModal`, etc.
- `app/src/lib/` — orquestación: `bots.ts` (llamadas a los Bots por nombre),
  `planes.ts`, `panelPlanes.ts`, `timeline.ts`, `estados.ts`.
- `app/src/theme.ts` — tema Mantine (primario `teal`, tipografía grande).

## Vistas (pestañas del header)

| Vista | Componente | Qué hace |
|---|---|---|
| **Agenda** | `AgendaDelDia` | Línea de tiempo del día por sala (7/14 franjas), franjas libres clickeables para reservar, próximos turnos y **quiénes están esperando lugar** (lista de espera, por orden de llegada). |
| **Planes y sesiones** | `PlanesSesiones` | Dashboard de saldo de planes (ver abajo). |
| **Atender paciente** | `Atender` | Busca al paciente y abre su ficha: banner de seguridad, **badge de consentimiento firmado en el portal** (firmado con fecha / sin firmar / no verificable — señal binaria vía `bw-estado-consentimiento`, nunca el documento), planes (asignar / **preferencia semanal**, R-21), reserva de turno/combo y cobro. Al elegir una Terapia Biológica, el switch de R-03 viene **precargado** si el paciente ya firmó en el portal, y el turno guarda si el consentimiento fue verificado o declarado por Recepción. |
| **Avisos** | `Avisos` | Avisos automáticos del sistema (`Task code=aviso-recepcion`): **WhatsApp de número desconocido** (con botones *Responder por WhatsApp* y *Crear ficha* prellenada), pago duplicado a devolver, pago acreditado sin registro, seña de reserva vencida, pagos rechazados, diferencia de arqueo y **turno liberado con gente esperándolo** (candidatos en orden, con botón *Ofrecer por WhatsApp* y *Reservarle*). Badge rojo + campanita. **Hasta 2026-08-12 estas alertas se creaban solo con `code.text`: como las búsquedas FHIR por token no miran el texto, ninguna pantalla las listaba y el aviso moría en la base.** |
| **Reportes** | `Reportes` | Indicadores de gestión + **"Nos piden y no tenemos"** (ver abajo). |
| **Caja** | `Caja` | Caja chica: registrar gastos (lista cerrada de categorías + tope con autorización), reposiciones y ajustes, y **cerrar caja** (arqueo). El saldo esperado se DERIVA (contado del último arqueo + Invoices en efectivo − egresos): los ingresos nunca se re-registran. Diferencia de arqueo ≠ 0 → alerta urgente a Administración (Task). Movimientos = `Basic` (code `CodeSystem/caja`), arqueos = `PaymentReconciliation`; parámetros confirmados por Andrés (2026-08-10) en `src/config/caja.ts`. Contrato para Administración: [`handoff-caja-administracion.md`](handoff-caja-administracion.md). |

El botón **"Atender"** del dashboard abre `Atender` con ese paciente ya cargado
(`pacienteInicialId`).

## Features

### Dashboard "Planes y sesiones"

Lista a **todos los clientes con plan activo** y reparte sus sesiones en tres
baldes sobre el total — **realizadas · agendadas a futuro · libres** — para
gestionar de forma proactiva lo que está por perderse (las sesiones no usadas se
pierden: membresía al cerrar el mes, paquete al vencer).

- **Urgencia**: membresía → días hasta el cierre de mes; paquete → días hasta
  vencer. Ordena por lo más en riesgo y permite filtrar **Todos / En riesgo**.
- **Acciones**: barra de baldes, badge de urgencia y botón **Atender** por fila.
- Lógica de agregación: `app/src/lib/panelPlanes.ts` (lee los `Coverage` activos,
  cuenta turnos futuros por cobertura vía la extensión `cobertura-usada` y reusa
  `saldoPlan` de `src/lib/planes.ts`).

### Preferencia semanal de membresías (R-21)

En `Atender → Planes`, cada membresía muestra **"Preferencia semanal"**
(reemplaza a "Pre-agendar mes", 2026-09-01: las sesiones se gestionan por semana
calendario, no reservando el mes entero de una).

- Elegís días de la semana con nombre (sugeridos según la frecuencia 2x/3x) y
  una hora, y prendés la **asignación automática**: no reserva nada en el acto —
  guarda la preferencia en el `Coverage` (`bw-preferencia-semanal`) y el cron
  `bw-agenda-semanal` reserva cada sesión apenas se abre la ventana R-13 del
  socio (ver [`bots.md`](bots.md) § Agenda semanal).
- Apagar el interruptor **pausa** la asignación sin perder los días/hora
  guardados.
- El tope semanal (frecuencia del plan, sin recupero) lo aplica el backend solo
  al portal y al cron: el mostrador puede seguir reservando libre (override
  humano, mismo contrato que R-13).
- UI: `app/src/components/AgendaSemanalModal.tsx`.

### "Nos piden y no tenemos" (demanda no cubierta)

Caso 11 del recorrido del walk-in. En **Registrar consulta**, elegir *"Otra cosa
(algo que no ofrecemos)"* abre un campo de texto **obligatorio**: qué pidió, con
las palabras que usó. Es la única cosa obligatoria de más en ese formulario —
todo lo demás sigue siendo opcional— porque *"Otra cosa"* sin el detalle es
exactamente el registro que había hasta ahora: sabíamos que alguien pidió algo y
nunca qué.

- **Se guarda aparte del lead**: `Basic` con code `CodeSystem/demanda` +
  `code.text` (el pedido tal como lo dijo), la clave normalizada en la extensión
  `demanda-clave` y `subject` = quien lo pidió. Lo escribe `bw-alta-paciente`
  **para pacientes nuevos y existentes**: la tarjeta de lead solo se crea si la
  persona es nueva, así que si el pedido viviera únicamente ahí se perdería
  justo el de quien ya nos conoce y viene a preguntar por otra cosa.
- **Cambia lo que dice la tarjeta del CRM**: la próxima acción deja de ser
  "Contactar" (no hay qué venderle) y pasa a *"Avisarle si sumamos X — hoy no lo
  ofrecemos"*, y la descripción dice **"NO está en el catálogo hoy"** para que
  nadie lo llame a ofrecerle algo que no existe.
- **Se lee en Reportes**: cuadro *"Nos piden y no tenemos"* con los pedidos de
  los últimos 90 días agrupados y contados, lo más pedido arriba. Que lo vea la
  misma persona que lo carga no es decorativo: es lo que sostiene el registro.
- Lógica pura y testeada en `src/lib/demanda.ts` (`normalizarPedido`,
  `validarPedido`, `agruparDemanda`) y `src/fhir/demanda.ts` (el `Basic`).
  La agrupación junta mayúsculas, tildes, signos y espacios; **no** inventa
  sinónimos ni singular/plural, que con este volumen es una agrupación falsa.

### Lista de espera (no hay lugar y quiere venir)

El momento en que se anota es cuando falla la reserva: el botón **"No hay lugar:
anotar en la lista de espera"** vive al lado del de reservar en `Atender`, y
también aparece dentro del error *"No se pudo reservar"*.

- **Qué se pide**: el servicio y hasta cuándo espera (por defecto 14 días). Los
  días y la franja (mañana/tarde/noche) son **opcionales** pero cambian mucho el
  resultado: sin ellos se lo llama por cualquier horario de esa terapia, y el
  aviso que no sirve enseña a ignorar los avisos.
- **Dónde se ve**: en la ficha del paciente (con *Quitar*) y en **Agenda →
  "Esperando lugar"**, que es la pantalla donde está la recepcionista cuando se
  corre un turno y sobra una franja.
- **Qué pasa cuando se libera un lugar**: al cancelar un turno (o al vencer una
  seña, R-19) el bot busca a quién le sirve ESE horario, ordena por llegada y
  deja el aviso con los 3 primeros y el teléfono a mano. El WhatsApp lo manda
  Recepción de un clic — el sistema **no** lo ofrece solo: el lugar no queda
  reservado y elegir a quién ofrecérselo es una decisión comercial.
- **Vence sola**: pasada la fecha deja de recibir avisos sin que nadie limpie la
  lista. Al quitarla se cancela, no se borra: queda el rastro de que esa persona
  quiso venir y no había lugar, que es la medida de la demanda que no atendemos.
- Lógica pura y testeada en `src/lib/lista-espera.ts` (`sirveElHueco`,
  `candidatosParaHueco`, `validarEspera`, textos) y `src/fhir/lista-espera.ts`
  (el `Appointment` con `status: waitlist`). UI:
  `app/src/components/ListaEsperaModal.tsx` y `EsperandoLugar.tsx`.

### Modo oscuro / claro

Toggle **sol/luna** en el header (arriba a la derecha, junto a "Salir"). Se apoya
en el dark mode nativo de Mantine v7.

- `app/src/main.tsx`: `defaultColorScheme="light"` + `ColorSchemeScript` (evita el
  flash inicial).
- `app/src/components/Shell.tsx`: `useMantineColorScheme` / `useComputedColorScheme`.
- La preferencia **se persiste** en `localStorage` (`mantine-color-scheme-value`).
- Los colores de "chrome" (bordes, grilla del timeline, hover de filas/slots,
  input de fecha nativo) usan variables semánticas que se adaptan al tema
  (`--mantine-color-default-border`, `--mantine-color-default-hover`,
  `--mantine-color-teal-light`).

Para ver el tema **sin loguearte**, en la consola del navegador:

```js
localStorage.setItem('mantine-color-scheme-value', 'dark'); location.reload();
```

> Nota: el render claro/oscuro aún no se validó con captura en CI (el sandbox no
> tiene navegador). Se verifica a ojo corriendo `npm run dev`.
