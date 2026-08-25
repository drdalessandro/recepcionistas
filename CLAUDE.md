# CLAUDE.md — Guía del repositorio

Contexto y convenciones para desarrollar en este repo (Biowellness · Recepción ·
Bloque 0). Backend **Medplum (FHIR R4)**, todo en **TypeScript**.

## Principios

1. **La recepción no calcula ni decide nada que el sistema pueda calcular o
   decidir.** Toda la lógica vive en el backend (`src/lib`, `src/bots`).
2. **Fuente de verdad del catálogo/precios: Manual de Protocolos v9.** Si un
   precio o regla difiere entre el código y el Manual, gana el Manual.
3. **Privacidad por diseño.** La recepción nunca ve la historia clínica completa;
   solo la señal binaria del banner de seguridad.
4. **Gobernanza.** Todo cambio de fondo en la arquitectura o en una regla de
   negocio *core* se consulta con Andrés antes de implementarlo.

## Arquitectura

- `src/domain` — tipos de dominio, agnósticos de FHIR.
- `src/config` — datos del Manual v9 (catálogo, combos, membresías, paquetes,
  recursos, horario, contraindicaciones, TC, constantes de reglas).
- `src/lib` — **lógica pura** (sin FHIR ni red): `money`, `pricing`,
  `reglas-turno`. Es lo que se testea exhaustivamente.
- `src/fhir` — identificadores/URLs, extensiones (`StructureDefinition`),
  AccessPolicies.
- `src/bots` — Medplum Bots: envoltura fina sobre `src/lib` + integraciones.
- `src/seed` — builders FHIR + runner idempotente del seed.
- `src/motor-agenda` — **motor de agenda** (lógica pura, autocontenido): decide si
  una reserva es posible, qué recursos bloquea y en qué orden. Los tiempos son
  atributos del recurso y los offsets de un combo se derivan, no se declaran.
  Todavía **no lo usa ningún bot**: convive con `src/lib/reglas-turno.ts` porque
  revisa reglas que el repo ya implementa de otra manera. Ver
  [`docs/motor-agenda.md`](docs/motor-agenda.md).
- `tests` — casos AC del Anexo A + integridad del catálogo.

> Regla práctica: **la lógica de negocio nueva va en `src/lib` como función pura
> y se testea**; el bot solo orquesta (lee/escribe FHIR, llama integraciones).

## Convenciones

- **Idioma:** código, identificadores de negocio y docs en español.
- **Imports** relativos con extensión `.js` (ESM; `moduleResolution: Bundler`).
- **Extensiones FHIR:** kebab-case bajo `https://biowellness.ar/fhir/...`,
  centralizadas en `src/fhir/identifiers.ts`.
- **Reglas:** cada regla referencia su código `R-xx` y, si tiene, su caso `AC-xx`.
- **Dinero:** precios de lista en USD; conversión a ARS solo al cobrar
  (`usdAArs`), nunca hardcodear el TC (usar `resolverTC` / config FHIR).

## Flujo de trabajo

- Ramas: `main` y `staging` con deploy automático (CI: `.github/workflows/ci.yml`).
- Gate de CI (y antes de pushear): `npm run verify` y `npm run seed -- --dry-run`.
  `verify` cubre **las dos apps**: typecheck de `src`+`tests`, typecheck de
  `app/` (tiene su propio tsconfig y quedaba afuera), los tests, y el **build
  del app** — que no es redundante: `vite build` es lo único que detecta
  problemas de empaquetado, como un import que arrastre `node:crypto` al bundle
  del navegador.
- Construcción por **slices verticales**: cada pieza se entrega "verde" (sus casos
  AC pasan) antes de seguir.

## Comandos

```bash
npm run verify             # gate completo: typecheck (src y app) + tests + build del app
npm run seed -- --dry-run  # construye el catálogo sin servidor
npm run seed               # carga el catálogo en Medplum (credenciales en .env)
npm run bots:bundle        # bundlea los bots sin conectarse (dry-run)
npm run deploy:bots        # crea + bundlea (esbuild) + deploya los bots — NO usa el CLI de Medplum
npm run bots:check         # ¿están todos creados y con código deployado?
npm run bots:cron          # horario de los bots de cron (--apply para escribirlo)
npm run migrar:dni-renaper # suma el DNI con el system canónico (RENAPER) a fichas viejas
npm run federador:check    # ¿anda el Federador del Ministerio? (QA por defecto; --prod es explícito)
```

> Puesta en producción (deploy, cron, build del app, prueba end-to-end):
> [`docs/puesta-en-produccion.md`](docs/puesta-en-produccion.md).

## Secretos

Nunca commitear `.env` ni credenciales. Las integraciones (Twilio, AWS SES,
MercadoPago, Medplum) se configuran por variables de entorno (`.env.example`).
El email se envía con `medplum.sendEmail()` (proveedor AWS SES configurado en el
servidor Medplum). MercadoPago tokeniza tarjetas: **nunca** almacenar números de
tarjeta.

## Pendientes

Ver [`docs/decisiones-pendientes.md`](docs/decisiones-pendientes.md). Horario y
salas ya están definidos (agenda operativa) y el **bloque de gestión de sesiones
está cerrado**: dashboard de saldo (con filtro "en riesgo"), pre-agenda de
membresías y recordatorios de turno **48 h / 2 h por WhatsApp**
(`bw-recordatorios`) implementados, testeados y deployados
(ver [`docs/app-recepcion.md`](docs/app-recepcion.md) y [`docs/bots.md`](docs/bots.md)).
El saldo en riesgo **se ve en el dashboard; no se avisa por mensaje**: el bot no
lo manda (2026-08-14, verificado contra `src/bots/recordatorios.ts`).

Twilio y SES ya están **operativos** (Project Secrets cargados y verificados,
2026-07: los WhatsApp y emails salen de verdad). La tabla de contraindicaciones
está **validada** por el Director Médico (Dr. Conrado López Alonso, 2026-08-09).
Lo que queda hoy **no frena el desarrollo**: correr `npm run bots:cron -- --apply`
una vez contra producción (el horario ya está declarado en `src/seed/bots-def.ts`
y el comando lo escribe y lo verifica), y confirmar el precio de consulta del
Dr. Conrado. Las plantillas de WhatsApp
ya están **todas aprobadas por Meta** y en uso (verificado 2026-08-14).
