# Bots de Medplum

Los Bots concentran la inteligencia: el front solo orquesta. Son funciones
TypeScript que se bundlean a un único módulo CJS (`exports.handler`) y se
deployan al runtime **`awslambda`** de Medplum (configurable con la env
`BOT_RUNTIME_VERSION`).

## Los bots

| Bot | Qué hace | Cómo se invoca |
|---|---|---|
| `bw-calcular-cobro` | Calcula el cobro (USD→ARS al TC, splits) y emite `Invoice`. | `executeBot` desde el front (pantalla Atender). |
| `bw-registrar-cobro` | **Registra** un cobro presencial: descuentos por tipo de cliente + ChargeItems + un Invoice `balanced` por medio (pago mixto = N Invoices). | `executeBot` (Atender → Cobro). |
| `bw-cobrar-pendiente` | Cobra en recepción un Invoice pendiente `issued`/`cancelled` — cuota de plan (`plan-…`) o **saldo de turno** (`saldo-…`, el 50% restante tras la seña): `balanced` + ChargeItem + levanta el bloqueo R-11. | `executeBot` (Atender → Pagos pendientes · modal del turno → Cobrar saldo). |
| `bw-validar-turno` | Valida un turno (orden HBOT, contraindicaciones, prescripción, capacidad/desfasaje, ventana, saldo). | `executeBot` al reservar/confirmar. |
| `bw-reservar-turno` | Valida y, si está OK, **crea** el turno (`Appointment` + `Slot` ocupado). | `executeBot` desde el front (Reservar turno). |
| `bw-reservar-combo` | Agenda un **combo** en secuencia (HBOT primero), auto-asignando sala por componente. | `executeBot` desde el front (Reservar combo). |
| `bw-estado-turno` | Check-in/out: cambia el estado del turno, gestiona el `Encounter` y libera la sala al completar/cancelar. | `executeBot` desde el front (clic en el turno). |
| `bw-pagar-sena` | Registra la seña (50%), confirma el turno (pending→booked), **emite el Invoice pendiente del saldo restante** (`saldo-{turno}`, `issued`) y envía WhatsApp de confirmación (informa el saldo). | `executeBot` (clic en turno tentativo). |
| `bw-link-mercadopago` | Genera un link de MercadoPago por la seña (`concepto:'sena'`, default) o por el **saldo restante** (`concepto:'saldo'`, lee el Invoice pendiente). | `executeBot` (turno tentativo → seña · turno confirmado → saldo). |
| `bw-webhook-mercadopago` | Webhook de MP: verifica el pago contra la API de MP y confirma el turno automáticamente al acreditarse. | URL pública que llama MercadoPago. |
| `bw-asignar-plan` | Asigna una membresía/paquete: crea el `Coverage`, emite el cobro inicial y envía WhatsApp de bienvenida. | `executeBot` desde el front (Atender → Planes). |
| `bw-cobro-membresias` | **Cron días 1-5:** renueva cada membresía activa (reset de sesiones + cobro mensual + WhatsApp). | `cronTimer` del Bot (a diario). |
| `bw-recordatorios` | **Cron:** recuerda los turnos confirmados a 48 h y 2 h por WhatsApp. | `cronTimer` del Bot (cada ~30 min). |
| `bw-alta-paciente` | Alta de cliente: crea/actualiza el `Patient` (dedupe por DNI/email/teléfono). | `executeBot` (Atender → Nuevo paciente). |
| `bw-invitar-paciente` | Invita al paciente al **portal** (invite de Medplum) y entrega el link por WhatsApp/email/QR. **Requiere admin.** | `executeBot` (Atender → Invitar al portal). |
| `bw-limpiar-demo` | **Cron:** borra los datos demo (tag `demo`) con más de 48 h. | `cronTimer` del Bot (cada ~1 h). |
| `bw-enviar-whatsapp` | Envía WhatsApp (Twilio) y registra `Communication`. | `executeBot` por evento o manual. |
| `bw-solicitar-turno` | **Portal:** crea una solicitud de turno (`Task` `code=solicitud-turno`) del paciente y avisa a Recepción por WhatsApp (`RECEPCION_WHATSAPP_TO`). No reserva: Recepción confirma. | `executeBot` desde el **portal** del paciente (único bot que puede ejecutar). |
| `bw-dedup-paciente` | Subscription sobre `Patient` (create/update): detecta fichas duplicadas por email/DNI (variantes con/sin puntos)/teléfono y abre una Task `posible-duplicado`. El descarte es durable (candidatos ya revisados no se reabren). Nunca fusiona solo. | Subscription rest-hook (ver abajo). |
| `bw-fusionar-paciente` | Fusiona un duplicado en la canónica: valida estados (no invierte fusiones viejas), inactiva+enlaza el duplicado PRIMERO (evita tareas espurias del propio dedup), completa datos sin pisar, reapunta el login, reasigna lo del interín paginando (incl. `recipient` de Communication y solicitudes de turno) y cierra la Task + cancela las espejo. **Requiere membership admin.** | `executeBot` (vista Duplicados). |
| `bw-recordatorios` | **Cron horario:** recordatorios de turno (24h/1h) y de saldo en riesgo, por WhatsApp **y** email. | `cronTimer` del Bot (cada hora). |

## Deploy

Requiere el `.env` de la raíz (mismas credenciales que el seed):
`MEDPLUM_BASE_URL`, `MEDPLUM_CLIENT_ID`, `MEDPLUM_CLIENT_SECRET`. La
`ClientApplication` debe ser **admin del proyecto** (para poder crear bots).

```bash
npm run bots:bundle   # opcional: bundlea y muestra tamaños, sin conectarse
npm run deploy:bots   # crea (si faltan) + bundlea + deploya + guarda ids
```

`deploy:bots` hace, por cada bot:
1. lo busca por `name`; si no existe, lo crea (`POST admin/projects/{id}/bot`, runtime `awslambda`);
2. bundlea el source con esbuild (CJS, sin dependencias externas);
3. lo deploya (`POST Bot/{id}/$deploy`);
4. guarda los ids en `medplum.config.json`.

Es idempotente: reejecutar redeploya el código sobre los bots existentes.

## Comunicaciones: secretos y comportamiento

En Medplum los bots leen secretos de `event.secrets`, **no** de `process.env`
(el `.env` de la raíz es solo para el seed/deploy, que corren en tu máquina). Los
secretos se cargan como **Project Secrets** en el panel de Medplum
(Project → Secrets).

**Campanita del portal:** además del WhatsApp/email, los bots crean la
`Communication`-notificación que enciende la campanita del paciente en el portal
(`notificarPortal` en `src/bots/_shared.ts`; contrato en
`portal/docs/mensajeria-y-notificaciones.md`). Hoy la disparan: la confirmación
de reserva (`confirmarReserva`: seña manual y webhook de MP → `reserva-confirmada`
+ `pago-recibido`) y los recordatorios (`bw-recordatorios` → `recordatorio`).
Es best-effort e idempotente: nunca interrumpe el flujo que la dispara.

**Regla de oro:** los helpers (`enviarWhatsApp` / `enviarEmail` en
`src/bots/_shared.ts`) **siempre** registran la `Communication`, pero **solo
envían** si está la configuración completa. Así se puede probar la lógica sin
spamear a nadie. Estados resultantes:

| Situación | Estado de la `Communication` | ¿Se envió? |
|---|---|---|
| Config completa + destinatario válido | `completed` | sí |
| Falta secreto / falta teléfono o email del paciente | `preparation` | no |
| El proveedor (Twilio/SES) devuelve error | `entered-in-error` | no |

### WhatsApp (Twilio)

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM` (formato `whatsapp:+549...`)
- `RECEPCION_WHATSAPP_TO` (número de Recepción, para el aviso de **solicitudes** del portal)

El destinatario sale de `Patient.telecom` (teléfono/SMS). El WhatsApp se dispara
automático **al reservar** (turno tentativo), **al pagar la seña** (confirmado),
**al renovar la membresía** y en los **recordatorios** (ver abajo).

> **Diagnóstico de WhatsApp:** `npm run whatsapp:test -- +5491122334455` ejecuta el
> bot `bw-enviar-whatsapp` en el server (lee los Project Secrets reales) y reporta
> el `status` de la `Communication`: `completed` (Twilio aceptó), `preparation`
> (falta algún secret) o `entered-in-error` (Twilio rechazó: sandbox/FROM/número).

### Email (AWS SES)

El email se envía con `medplum.sendEmail()`, que usa el proveedor **AWS SES
configurado en el servidor Medplum** — **no** hacen falta credenciales de SES en
el código ni en los Project Secrets. Solo hay que tener:

- un **remitente verificado** en SES (referencia local: `SES_FROM_EMAIL` en
  `.env.example`), y
- el `Patient.telecom` con un email (de ahí sale el destinatario).

Sin email en el paciente (o si SES falla), la `Communication` igual queda
registrada (`preparation` / `entered-in-error`).

Para el link de MercadoPago (seña), además: `MERCADOPAGO_ACCESS_TOKEN`. Si no
está, el flujo manual de seña sigue funcionando y el bot de link avisa que MP no
está configurado.

## Permisos del bot

El bot se crea con su propia `ProjectMembership`. Para mínimo privilegio se le
puede asignar una `AccessPolicy` acotada (p. ej. solo `Invoice`/`Communication`/
lectura de catálogo). Pendiente de afinar.

## Webhook de MercadoPago (confirmación automática)

Cuando el paciente paga la seña por el link, MercadoPago avisa a un **webhook** y el
turno se confirma solo (pending → booked) + WhatsApp.

1. Crear el bot `bw-webhook-mercadopago` (UI) y `npm run deploy:bots`.
2. Cargar el secret `MERCADOPAGO_ACCESS_TOKEN` (el mismo del link).
3. En MercadoPago (Tus integraciones → tu app → **Webhooks**, evento **Pagos**),
   configurar la **URL** del `$execute` del bot:
   `https://api.medplum.com.ar/fhir/R4/Bot/<id-de-bw-webhook-mercadopago>/$execute`
   - Como MP no envía headers de auth, se usa una **ClientApplication dedicada** y
     se embeben las credenciales en la URL:
     `https://<clientId>:<clientSecret>@api.medplum.com.ar/fhir/R4/Bot/<id>/$execute`
   - (Esta parte la validamos juntos: confirmamos que MP acepte la URL con
     credenciales. El bot, además, **verifica el pago contra la API de MP**, así
     que no confía en el payload.)
4. (Opcional) Setear el secret `MP_WEBHOOK_URL` con esa URL: el link de pago la
   manda como `notification_url` por preferencia. Si no, alcanza con la config
   global del paso 3.

El bot toma el id del pago, hace `GET /v1/payments/{id}` con el token, y si está
`approved` confirma el turno por su `external_reference` (= appointmentId). Es
idempotente (los reintentos de MP no duplican la seña).

## Membresías y paquetes (planes)

Un plan del paciente se modela como un **`Coverage`** (`status: active`,
`beneficiary` = el paciente) con extensiones: `tipo-cobertura`
(`membresia`/`paquete`), `plan-codigo`, `sesiones-mes` (membresía) o
`sesiones-total` (paquete), `sesiones-usadas` y, en membresías, `ciclo-mes`
(`YYYY-MM` ya facturado). Los paquetes llevan `period.end` (vencimiento por
vigencia en días); las membresías no vencen (se renuevan por ciclo).

- **Asignar** (`bw-asignar-plan`): crea el `Coverage`, emite el `Invoice` inicial
  (membresía: mes en curso; paquete: total, con FM si aplica) y avisa por WhatsApp.
- **Consumir** (al reservar): si se pasa `coverageId`, `bw-reservar-turno` /
  `bw-reservar-combo` validan el saldo (**R-10**) y que la base del plan coincida
  con lo reservado (paquete↔servicio, membresía↔combo). Si todo OK, incrementan
  `sesiones-usadas` y el turno queda **confirmado sin seña** (`booked`).
- **Bloqueo al agotarse** (**R-10**): sin saldo / vencido / inactivo, la reserva
  con plan se rechaza (la lógica pura está en `src/lib/planes.ts`, testeada).
- **Cobro recurrente** (`bw-cobro-membresias`): pensado como **cron diario**. En
  los días 1-5 (R-11) resetea las sesiones del mes y emite el cobro mensual
  (idempotente por ciclo: no duplica si corre varias veces).

### Cron de `bw-cobro-membresias`

El reset/cobro mensual lo dispara el `cronTimer` del Bot en Medplum. Configurarlo
**una vez** (Bot → propiedad `cronTimer`, p. ej. `0 9 * * *` = 09:00 a diario).
El propio bot decide si actúa (días 1-5 y ciclo no facturado), así que correrlo
todos los días es seguro e idempotente.

## Recordatorios automáticos (48 h / 2 h)

`bw-recordatorios` avisa por WhatsApp antes de cada turno **confirmado**
(`booked`): una vez ~48 h antes y otra ~2 h antes. La lógica de "qué recordatorio
toca" es pura (`src/lib/recordatorios.ts`, testeada): usa ventanas hacia abajo
(falta ≤ 2 h → recordatorio de 2 h; falta ≤ 48 h y > 2 h → el de 48 h), así que si
una corrida del cron se saltea, el siguiente tick lo manda igual.

- **Idempotente:** cada recordatorio queda como `Communication` con identifier
  `recordatorio-{tipo}-{grupo}`. Antes de enviar, el bot busca ese identifier; si
  existe, no reenvía. Por eso es seguro correrlo cada pocos minutos.
- **Combos:** se manda **un** recordatorio por combo (el componente que arranca
  primero), no uno por sesión (se agrupan por el identifier de combo).

### Cron de `bw-recordatorios`

Configurar el `cronTimer` del Bot **una vez** (p. ej. `*/30 * * * *` = cada 30
min). Cuanto más seguido corra, más cerca de las 48 h / 2 h exactas sale el aviso;
la idempotencia evita duplicados. Necesita los mismos secretos de Twilio que
`bw-enviar-whatsapp`.

## Alta e invitación de pacientes (onboarding)

Dos pasos **separados** (la recepción puede dar de alta sin invitar, e invitar
después):

1. **Alta** (`bw-alta-paciente`): crea el `Patient` (nombre, DNI, teléfono, email).
   Deduplica por DNI → email → teléfono (no crea duplicados). No da login.
   No requiere admin (la recepción ya escribe `Patient`).
2. **Invitación al portal** (`bw-invitar-paciente`): le da acceso de login para ver
   **lo suyo** (turnos/plan/pagos). Usa el **invite de Medplum** con
   `sendEmail:false` + `upsert:true` (reusa el `Patient` existente por email, no
   duplica) y la AccessPolicy **"Paciente — Portal"**. Recupera el link mágico
   (`/setpassword/{id}/{secret}`) y lo entrega por el canal elegido:
   - **whatsapp** → Twilio;
   - **email** → mail BioWellness (SES, `medplum.sendEmail`);
   - **qr** → devuelve el link y el front lo dibuja como **QR** (client-side, el
     link nunca sale a un tercero).

   El link apunta al **portal del paciente** (FooMedical, `bio.medplum.com.ar`),
   no a la app de recepción. Se configura con el secret **`PORTAL_BASE_URL`**
   (default `https://bio.medplum.com.ar`).

### Requisitos para invitar

- `bw-invitar-paciente` debe tener **admin del proyecto**. Lo necesita por **dos**
  motivos: (1) el *invite* es endpoint de administración; (2) **enviar email** vía
  `medplum.sendEmail()` también exige membership admin. El server Medplum gatea el
  endpoint de email con `project.features incluye "email"` **Y**
  `ctx.membership.admin === true` (verificado en el código de Medplum). Por eso el
  mismo bot admin cubre invite + email. Asignar admin a su `ProjectMembership` en
  Medplum (igual que se crean los bots). Sin admin, devuelve un aviso claro.
- Que el proyecto tenga la **feature `email`** habilitada (super admin).
- Que exista la AccessPolicy **"Paciente — Portal"** (corré `npm run seed`).
- Para alinear con el **auto-registro** del portal ("Crear cuenta"), conviene que
  el **default patient access policy** del proyecto Medplum sea también
  "Paciente — Portal" (así el paciente que se registra solo y el invitado quedan
  con el mismo alcance).

> **Diagnóstico de email:** `npm run email:test -- correo@dominio` prueba la cadena
> Medplum→SES. Si da `Forbidden`, la membership usada **no es admin** (requisito de
> Medplum para email). SES en sí se prueba aparte con la CLI de AWS
> (`aws sesv2 send-email …`).

## Datos de demostración (autodestrucción a las 48 h)

Para ver la app con datos (pacientes, turnos en varios estados, planes, un Flag de
contraindicación, cobros y comunicaciones):

```bash
npm run datos-demo                       # limpia demo previa y genera datos nuevos
npm run datos-demo -- --limpiar          # borra TODOS los datos demo
npm run datos-demo -- --limpiar-vencidos # borra solo los demo de > 48 h
```

Todo lo creado lleva `meta.tag = demo` (system `https://biowellness.ar/demo`). La
limpieza borra **solo** lo etiquetado demo (por `_tag` + `_lastUpdated`); **nunca**
toca datos reales.

**Autodestrucción:** el bot **`bw-limpiar-demo`** (cron, p. ej. `0 * * * *` cada
hora) borra los demo cuyo `_lastUpdated` supere las 48 h. Configurar su `cronTimer`
una vez en Medplum. Sin el cron, igual podés limpiar a mano con `--limpiar`.

> El bot que borra necesita permiso de borrado sobre esos tipos (admin de proyecto
> o una AccessPolicy con delete). La generación se hace por script, no por bot.

## Contrato de pagos con Administración (INAMOVIBLE)

El repo `administracion` (tableros de Andrés, bot `kpis-finanzas`) lee lo que
este repo escribe. Reglas:

- **Invoice**: `status` `balanced`=cobrado / `issued`=pendiente / `cancelled`=fallido;
  monto **BRUTO** en `totalNet` y `totalGross` (la comisión de MP NUNCA se descuenta:
  es un gasto del P&L de Administración, R-18); `date` = fecha del cobro; medio de
  pago en la extensión `medio-pago` como **valueString** con uno de los 5 códigos
  canónicos (`MEDIOS_PAGO` en `src/fhir/identifiers.ts`): `efectivo` ·
  `tarjeta-debito` · `tarjeta-credito` · `transferencia` · `mercadopago`.
- **ChargeItem** por ítem cobrado: monto en `priceOverride.value`, fecha en
  `occurrenceDateTime`, servicio en `code.coding[0].code` (categoría: HBOT, IHHT,
  CONSULTA…), profesional en `performer[0].actor`, y extensión `linea-comercial`
  (system de administracion, `EXT_LINEA_COMERCIAL`): `membresias` · `sueltas-combos`
  · `paquetes` · `iv-tb` · `consultas` · `otros`.
- **Pago mixto** = N Invoices (uno por medio, cada uno con su porción, suma EXACTA)
  referenciando los MISMOS ChargeItems.
- **R-11**: cobro de membresía → Invoice `issued` + cobro MP (tarjeta tokenizada si
  hay `mp-customer-id`/`mp-card-id` en el Coverage; si no, link). `approved` →
  `balanced` + ChargeItem + se levanta el bloqueo; `rejected` → `cancelled` +
  **bloqueo de reservas** (Flag system `bloqueo`) + **alerta a recepción** (Task).
- Migración de Invoices viejos (valueCode → valueString): `npm run migrar:medios`.

## Invocación desde el front

El front llama a los bots **por nombre** (`Bot?name=bw-calcular-cobro` →
`executeBot`). Por eso los nombres de los bots no deben cambiarse sin actualizar
`app/src/lib/bots.ts`.


## Deduplicación de fichas (2 capas, decide un humano)

Cuando alguien que YA tiene ficha se autoregistra en el portal, el server crea un
`Patient` nuevo → dos fichas. El circuito: `bw-dedup-paciente` (disparado por
Subscription sobre `Patient`) abre una Task `posible-duplicado`; Recepción la ve en
la vista **Duplicados** y decide fusionar (`bw-fusionar-paciente`) o descartar.
**Nunca hay fusión automática**, y la fusión no borra nada (duplicado inactivo +
`link replaced-by` = auditable). Complementa el dedupe de `bw-alta-paciente` (alta
manual desde Recepción).

Configuración (una vez, en el admin de Medplum):

1. `npm run deploy:bots` (crea/deploya los 2 bots).
2. La ProjectMembership del bot `bw-fusionar-paciente` debe tener `admin: true`
   (toca ProjectMemberships de pacientes).
3. Crear la Subscription — ⚠️ el endpoint lleva el UUID REAL del bot, **sin `<` ni `>`**:

```json
{
  "resourceType": "Subscription",
  "status": "active",
  "reason": "Detección de fichas duplicadas al registrarse/completar datos",
  "criteria": "Patient",
  "channel": { "type": "rest-hook", "endpoint": "Bot/UUID-DE-bw-dedup-paciente" }
}
```

Prueba end-to-end: (1) crear ficha "Ana Pérez" en Recepción con email y DNI;
(2) autoregistrarse en el portal con ese email → segunda ficha; (3) en segundos
aparece la Task en Duplicados (coincidencia por email); (4) completar el wizard del
portal con el DNI → el update re-dispara el bot y sigue habiendo UNA tarea
(idempotencia); (5) fusionar eligiendo la ficha de Recepción → el login de Ana ve
la historia vieja, la ficha nueva queda `active=false` con `link replaced-by`, lo
creado en el interín apunta a la canónica y la Task queda `completed`;
(6) regresión: un email inédito NO genera tarea.
