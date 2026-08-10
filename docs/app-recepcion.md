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
| **Agenda** | `AgendaDelDia` | Línea de tiempo del día por sala (7/14 franjas), franjas libres clickeables para reservar y próximos turnos. |
| **Planes y sesiones** | `PlanesSesiones` | Dashboard de saldo de planes (ver abajo). |
| **Atender paciente** | `Atender` | Busca al paciente y abre su ficha: banner de seguridad, planes (asignar / **pre-agendar**), reserva de turno/combo y cobro. |
| **Reportes** | `Reportes` | Indicadores de gestión. |
| **Caja** | `Caja` | Caja chica: registrar gastos (lista cerrada de categorías + tope con autorización), reposiciones y ajustes, y **cerrar caja** (arqueo). El saldo esperado se DERIVA (contado del último arqueo + Invoices en efectivo − egresos): los ingresos nunca se re-registran. Diferencia de arqueo ≠ 0 → alerta urgente a Administración (Task). Movimientos = `Basic` (code `CodeSystem/caja`), arqueos = `PaymentReconciliation`; parámetros provisorios en `src/config/caja.ts`. |

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

### Pre-agenda de membresías

En `Atender → Planes`, cada membresía con saldo muestra **"Pre-agendar mes"**:
propone y reserva de una vez las sesiones del mes según la frecuencia (2x/3x por
semana).

- Elegís días de la semana (sugeridos según la frecuencia), hora y fecha de inicio;
  previsualiza la serie antes de reservar.
- Reserva una por una con el bot de combo (asigna sala, valida R-01/R-02/R-07 y
  consume sesión de la membresía), mostrando ✓/✗ por turno; manda **un** WhatsApp
  de resumen (no uno por sesión).
- Cálculo de fechas puro y testeado: `src/lib/serie-turnos.ts`
  (`generarSerieFechas`, `diasSugeridos`). UI: `app/src/components/PreAgendaModal.tsx`.

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
