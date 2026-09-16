# Recepcionistas — Biowellness San Isidro

Herramienta de Recepción de Biowellness San Isidro. **Bloque 0 (Cimientos)**: la
base sobre la que se apoya la pantalla de la recepción. Backend **Medplum (FHIR R4)**.

> Principio rector: *"Las Recepcionistas nunca calculan ni deciden nada que el
> sistema pueda calcular o decidir por ellas."* Toda la inteligencia vive en el
> backend (catálogo, motor de precios, reglas de agenda y bots).

## Estado actual (Bloque 0)

| Pieza | Estado |
|---|---|
| Andamiaje TypeScript + tooling | ✅ |
| Catálogo v9 (servicios, combos, membresías, paquetes) | ✅ |
| Motor de precios (USD→ARS, splits, cascada TB) | ✅ con tests |
| Motor de reglas de agenda (R-01..R-14) | ✅ con tests |
| Extensiones FHIR + AccessPolicies (recepción) | ✅ |
| Bots: calcular-cobro · validar-turno · enviar-whatsapp | ✅ + deploy (`npm run deploy:bots`) |
| Seed del catálogo (idempotente) | ✅ (`--dry-run` sin servidor) |
| Motor de agenda: Slots + semáforo de salas | ✅ con tests (config provisoria) |
| Front de recepción (React + Vite) | ✅ login, agenda + semáforo, atención, reserva de turnos |
| Reserva de turnos (valida + crea Appointment/Slot) | ✅ bot `bw-reservar-turno` |
| Reserva de combos en secuencia (HBOT primero, auto-sala) | ✅ bot `bw-reservar-combo` |
| Check-in / check-out + estados en el timeline | ✅ bot `bw-estado-turno` |
| Reserva con seña 50% (confirma turno) + WhatsApp | ✅ bots `bw-pagar-sena` / `bw-link-mercadopago` |
| Webhook de MercadoPago (confirma turno al pagar) | ✅ bot `bw-webhook-mercadopago` |
| Reportes / tablero (turnos, ingresos, ocupación) | ✅ pantalla Reportes |
| Consultas médicas (3 médicos, 1 consultorio, precio ARS) | ✅ catálogo + `Practitioner` |
| Harness de tests (casos AC del Anexo A) | ✅ 70 tests |
| CI (GitHub Actions) | ✅ |
| Horario + lista definitiva de salas | ✅ confirmado (L-V 08-22, Sáb 08-20; 13 salas) |
| Contraindicaciones | ⚠️ borrador, pendiente validación médica |

Ver [`docs/decisiones-pendientes.md`](docs/decisiones-pendientes.md) para lo que falta definir.

## Requisitos

- Node.js ≥ 20 (probado en 22)
- Una cuenta de Medplum (arrancamos en **Medplum Cloud**; portable a self-hosted)

## Puesta en marcha

```bash
npm install
cp .env.example .env       # completar credenciales
npm run verify             # typecheck + tests
npm run seed -- --dry-run  # construye el catálogo sin conectarse a Medplum
npm run seed               # carga el catálogo en Medplum (requiere credenciales)
```

## Scripts

| Script | Qué hace |
|---|---|
| `npm run typecheck` | Chequeo de tipos (tsc) |
| `npm run test` | Tests (vitest) |
| `npm run verify` | typecheck + test (gate de CI) |
| `npm run seed` | Carga el catálogo en Medplum (idempotente) |
| `npm run seed -- --dry-run` | Construye todos los recursos sin servidor |
| `npm run seed -- --with-slots [--dias=N]` | (Opcional) materializa `Slot` libres en Medplum. El front NO lo necesita. |
| `npm run limpiar` | Lista Schedules ajenos/duplicados (dry-run); `-- --apply` los borra |
| `npm run dev` | **Levanta el front de recepción en http://localhost:5173** |
| `npm run build:app` | Build de producción del front |
| `npm run bots:bundle` | Bundlea los Bots y muestra tamaños (sin conectarse) |
| `npm run deploy:bots` | Crea + bundlea + deploya los Bots a Medplum (ver `docs/bots.md`) |

## Estructura

```
src/
  domain/      Tipos de dominio (agnósticos de FHIR)
  config/      Datos del Manual v9 (catálogo, combos, membresías, paquetes,
               recursos, horario, contraindicaciones, TC, constantes de reglas)
  lib/         Lógica pura: money, pricing, reglas-turno (testeable sin servidor)
  fhir/        Identificadores, extensiones (StructureDefinition), AccessPolicies
  bots/        Medplum Bots: calcular-cobro, validar-turno, enviar-whatsapp
  seed/        Builders FHIR + runner del seed
tests/         Harness de tests (casos AC del Anexo A)
app/           Front de recepción (React 18 + Vite + Mantine + @medplum/react)
docs/          Documentación técnica (Bloque 0, reglas, modelo de datos, pendientes)
```

## Front de recepción (localhost:5173)

Pantalla simple y rápida para la recepción (no para programadores). Toda la
inteligencia vive en los Bots y el backend; el front solo orquesta.

```bash
npm install                       # instala backend + front (workspaces)
cp app/.env.example app/.env      # MEDPLUM_BASE_URL=https://api.medplum.com.ar/ (sin prefijo VITE_: lo expone envPrefix)
npm run dev                       # abre http://localhost:5173
```

Pantallas del esqueleto:

- **Login** contra Medplum (SignInForm).
- **Agenda del día** — **vista timeline**: salas en filas, horas en columnas, cada
  turno como bloque en su franja (servicio + paciente), con línea de "ahora".
  **Clic en una franja libre** abre el formulario de reserva precargado con esa
  sala y hora. Autorefresco cada 60 s.
- **Atender paciente** — búsqueda por nombre/DNI, banner de seguridad verde/rojo
  (sin ver la historia clínica), **reserva de turnos** (valida + crea vía bot
  `reservar-turno`) y cobro **calculado por el bot** `calcular-cobro`.
- **Reportes** — tablero del día/mes: turnos por estado, ingresos (cobros y
  señas), ocupación por sala y WhatsApp enviados. Lee de Medplum.

> El cobro requiere los Bots desplegados (`npm run deploy:bots`). Si no están, la
> pantalla lo avisa con claridad: el front nunca calcula por su cuenta.

## Documentación

- [`docs/bloque-0.md`](docs/bloque-0.md) — alcance técnico y Definition of Done
- [`docs/bots.md`](docs/bots.md) — los Bots, deploy, secretos y recordatorios
- [`docs/app-recepcion.md`](docs/app-recepcion.md) — la app de recepción: vistas y features (dashboard, pre-agenda, modo oscuro)
- [`docs/reglas-negocio.md`](docs/reglas-negocio.md) — reglas R-01..R-18
- [`docs/modelo-datos-fhir.md`](docs/modelo-datos-fhir.md) — recursos y extensiones FHIR
- [`docs/decisiones-pendientes.md`](docs/decisiones-pendientes.md) — decisiones abiertas
- [`docs/pasarelas-de-pago.md`](docs/pasarelas-de-pago.md) — evaluación de Clover frente a MercadoPago: probabilidad de uso, matriz y camino rápido
- [`docs/teleconsulta.md`](docs/teleconsulta.md) — teleconsulta (Cardiología · Nutrición · Endocrinología) sobre Jitsi en EC2: visión, modelo FHIR, bots, circuito de punta a punta y decisiones pendientes
- [`docs/teleconsulta-fase0.md`](docs/teleconsulta-fase0.md) — runbook de la Fase 0: Jitsi en una EC2 propia (paquetes Debian vs Docker vs JaaS), JWT, moderador por token, endurecimiento, pruebas de aceptación y las trampas de la instalación real
- [`CLAUDE.md`](CLAUDE.md) — convenciones y guía para el desarrollo

---

Confidencial · Shanti OM SRL · 2026
