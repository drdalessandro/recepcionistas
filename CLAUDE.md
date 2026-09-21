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
npm run policy:check       # ¿las AccessPolicies del servidor coinciden con el código?
npm run auditoria:check    # ¿la auditoría está activa y guarda la IP del cliente?
npm run bots:cron          # horario de los bots de cron (--apply para escribirlo)
npm run migrar:dni-renaper # suma el DNI con el system canónico (RENAPER) a fichas viejas
npm run limpiar:solicitudes # borra solicitudes de turno ya cerradas (dry-run; --apply borra)
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

## Plan Bienestar 100 Días (PB100D)

El programa vive en `portal` (lo que ve la paciente) y `dashboard` (el dominio, los bots y
la ficha del equipo). **De este repo son los handoffs**, y las decisiones arquitectónicas
están en el **ADR-038** (`biowellness-fhir/docs/architecture-decisions.md`).

Lo que es nuestro:

- **Las AccessPolicy de todo el mundo** (`src/fhir/access-policies.ts`), incluidas las de
  Nutrición y Kinesiología, que no existían en ningún repo hasta el Hito 7. El seed es
  dueño de estas policies y **reemplaza la policy entera**: un cambio a mano en el admin se
  pierde en la próxima corrida.
- **El catálogo del producto premium**: `PB100D_PREMIUM_MENSUAL` y `PB100D_PREMIUM_100D` en
  `src/config/programas.ts`, publicados como `PlanDefinition` con `type.text = 'programa'`.
  **No confundirlos** con las cuatro `PlanDefinition` `pb100d-nivel-N` de `biowellness-fhir`,
  que son las plantillas clínicas: éstas son el producto que se vende.
- **El cobro recurrente**: `bw-cobro-programas` y el manejo de suscripciones del webhook de
  MercadoPago.
- **Web Push**: `bw-web-push`.

Tres cosas que se prestan a error:

1. **Un programa no es una membresía.** Vende tiempo, no sesiones: su `Coverage` no lleva
   contador. `bw-cobro-membresias` los saltea a propósito y tiene un test que lo fija; si
   cayeran ahí, `getMembresia` lanzaría y cortaría la corrida del mes **para todos**.
2. **La cadencia es cada 30 días desde el alta**, no el mes calendario (brief §6.10). Quien
   compra un 28 pagaría el segundo mes a los tres días.
3. **Los débitos de una suscripción de MercadoPago no llegan como `payment`**: llegan como
   `subscription_authorized_payment`, y los cambios de la suscripción como
   `subscription_preapproval`. Antes del Hito 7 el webhook los ignoraba, así que la plata
   entraba y el sistema no se enteraba. La atribución va por `preapproval_id` contra la
   extensión `mp-suscripcion` del `Coverage`, que **carga Recepción a mano** cuando arma la
   suscripción en el panel de MP (D16: sin checkout propio).

**Lo que la paciente puede escribir** es una sola cosa: la `Task` de tipo
`pb100d-tarea|accion` (marcar un día como hecho). El filtro estuvo puesto sobre el sistema
de *conceptos* del programa y no alcanzaba —las señales al equipo llevan un coding de ese
mismo sistema y quedaban escribibles—: si tocás ese criterio, acotá por **tipo** de tarea.

**La bandeja de los `Task` clínicos del equipo está en el dashboard, no acá**, y es por el
principio 3: son señales clínicas —síntoma con el esfuerzo, intolerancia digestiva— y
Recepción no ve la historia clínica. De este repo salen los permisos que la habilitan.

## Pendientes

Ver [`docs/decisiones-pendientes.md`](docs/decisiones-pendientes.md). Horario y
salas ya están definidos (agenda operativa) y el **bloque de gestión de sesiones
está cerrado**: dashboard de saldo (con filtro "en riesgo"), agenda semanal de
membresías (R-21: preferencia de días + hora y asignación automática
`bw-agenda-semanal`; reemplazó a la pre-agenda mensual el 2026-09-01) y
recordatorios de turno **48 h / 2 h por WhatsApp**
(`bw-recordatorios`) implementados, testeados y deployados
(ver [`docs/app-recepcion.md`](docs/app-recepcion.md) y [`docs/bots.md`](docs/bots.md)).
El saldo en riesgo **se ve en el dashboard; no se avisa por mensaje**: el bot no
lo manda (2026-08-14, verificado contra `src/bots/recordatorios.ts`).

Twilio y SES ya están **operativos** (Project Secrets cargados y verificados,
2026-07: los WhatsApp y emails salen de verdad). La tabla de contraindicaciones
está **validada** por el Director Médico (Dr. Conrado López Alonso, 2026-08-09).
El cron de producción está **aplicado y verificado** (2026-08-25:
`bots:cron -- --apply` en verde, 4/4, `cronTiming` residual limpiado) y la
**lista de espera está probada de punta a punta** contra producción
(2026-08-25: `seed:prueba-espera` → cancelación → aviso con candidato en
Avisos). Lo que queda hoy **no frena nada**: confirmar la zona horaria en que
Medplum evalúa el cron y el precio de consulta del Dr. Conrado. Las plantillas de WhatsApp
ya están **todas aprobadas por Meta** y en uso (verificado 2026-08-14).
