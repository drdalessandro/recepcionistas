# Puesta en producción — deploy, cron y cómo probar que anduvo

Qué correr, en qué orden y **cómo verificar cada paso**. Los tres bloques son
independientes: se puede deployar bots sin tocar el front, y viceversa.

> **Antes de todo**: `.env` en la raíz (copiar de `.env.example`) con
> `MEDPLUM_BASE_URL`, `MEDPLUM_CLIENT_ID` y `MEDPLUM_CLIENT_SECRET`. La
> ClientApplication tiene que ser **admin del proyecto** para poder crear bots
> nuevos. El `.env` NUNCA se commitea.
>
> **No hay entorno de staging separado**: todos los scripts apuntan al
> `MEDPLUM_BASE_URL` del `.env`. Para probar sin tocar producción, el único
> aislamiento real es apuntar el `.env` a otro proyecto Medplum.

## 0. Sin servidor: qué se puede verificar antes de tocar nada

```bash
npm run verify             # typecheck (src y app) + tests + build del app
npm run seed -- --dry-run  # arma el catálogo en memoria, sin conectarse
npm run bots:bundle        # bundlea los 26 bots con esbuild, sin conectarse
```

Los tres corren sin credenciales y sin red. Si alguno falla, no tiene sentido
seguir: lo que se deployaría está roto.

## 1. Bots

### Deploy

```bash
npm run deploy:bots
```

Por cada bot de `src/seed/bots-def.ts`: lo busca por nombre → lo crea si falta →
lo **bundlea con esbuild en memoria** → `POST Bot/{id}/$deploy` → escribe los ids
en `medplum.config.json`. Es idempotente: re-correrlo redeploya el código.

**Es todo o nada**: no hay flag para deployar un solo bot (`deploy-bots.ts` solo
parsea `--dry-run`). Deployar de más es inocuo — el código es el mismo del repo.

> ⚠️ **Nunca deployar desde el editor web de Medplum ni con `medplum bot deploy`.**
> No bundlean los imports relativos (`./_shared.js`) y el bot revienta en runtime
> con `Cannot find module '/var/....js'`. En el editor web: mirar sí, Save/Deploy
> jamás. Si un bot ya quedó "envenenado", hay que **borrar el recurso Bot** y
> re-correr el deploy, que lo recrea limpio (ojo: eso le borra el cron y le
> cambia el id — ver §2 y los webhooks de nginx).

### Verificar

```bash
npm run bots:check
```

Reporta por bot `✓ OK` / `⚠ SIN CÓDIGO` (existe pero nunca se deployó) /
`✗ FALTA`, lista huérfanos del servidor y sale con código 1 si algo falta.

**`bots:check` no mira el cron**: un bot puede salir `✓ OK` y no estar programado.

### Qué se deploya de lo último

La lista de espera vive en `src/bots/_shared.ts` (`avisarListaDeEspera`), que se
bundlea **dentro de cada bot**. Sin redeploy, `bw-estado-turno` y
`bw-vencer-tentativas` siguen corriendo la versión vieja y el aviso nunca sale.

## 2. Cron de los bots

**El repo no configura el cron.** `deploy-bots.ts` crea y deploya, pero nunca
escribe el horario: hay que ponerlo a mano, **una vez por bot**, en el recurso
`Bot` del servidor.

> ⚠️ **El campo es `cronString`, no `cronTimer`.** Los docs decían `cronTimer`
> hasta el 2026-08-14 y ese campo **no existe** en Medplum: escribirlo no programa
> nada y no da error. Los campos reales del recurso `Bot` son `cronString` (cron
> de 5 campos) y `cronTiming` (un `Timing` FHIR).

| Bot | `cronString` | Por qué |
|---|---|---|
| `bw-vencer-tentativas` | `*/10 * * * *` | R-19: la seña vence a las 2 h; cada 10 min el lugar se libera con poco retraso. |
| `bw-recordatorios` | `*/30 * * * *` | Recordatorios de 48 h y 2 h: cuanto más seguido, más cerca de la hora exacta. Es idempotente por `Communication`, correrlo de más no duplica. |
| `bw-cobro-membresias` | `0 9 * * *` | Solo actúa los días 1-5 y por ciclo no facturado; correrlo a diario es seguro. |
| `bw-limpiar-demo` | `0 * * * *` | Borra los datos demo de más de 48 h. |

> **Zona horaria**: no está definida en el repo en qué TZ evalúa Medplum el cron.
> Si es UTC, `0 9 * * *` son las 06:00 de Argentina. **Confirmar antes de asumir**
> el horario del cobro de membresías — es el único cuyo horario importa.

### Ponerlo

Desde la UI: Bot → editar el recurso → campo **`cronString`** → guardar. (Eso es
editar el *recurso*, no el código: no rompe el bundling.)

O de una, para los cuatro:

```bash
npx tsx -e "import 'dotenv/config'; import { MedplumClient } from '@medplum/core';
const CRON = { 'bw-vencer-tentativas': '*/10 * * * *', 'bw-recordatorios': '*/30 * * * *',
               'bw-cobro-membresias': '0 9 * * *', 'bw-limpiar-demo': '0 * * * *' };
void (async () => {
  const m = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL, fetch });
  await m.startClientLogin(process.env.MEDPLUM_CLIENT_ID, process.env.MEDPLUM_CLIENT_SECRET);
  for (const [nombre, cron] of Object.entries(CRON)) {
    const bot = await m.searchOne('Bot', 'name=' + encodeURIComponent(nombre));
    if (!bot?.id) { console.log('✗ falta', nombre); continue; }
    const out = await m.updateResource({ ...bot, cronString: cron });
    console.log('✓', nombre, 'Bot/' + out.id, '→', out.cronString);
  }
})();"
```

### Verificar

Que el campo quedó escrito:

```bash
npx tsx -e "import 'dotenv/config'; import { MedplumClient } from '@medplum/core';
void (async () => {
  const m = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL, fetch });
  await m.startClientLogin(process.env.MEDPLUM_CLIENT_ID, process.env.MEDPLUM_CLIENT_SECRET);
  for (const b of await m.searchResources('Bot', { _count: 200 }))
    console.log((b.name ?? '?').padEnd(26), b.cronString ?? '-');
})();"
```

Que **el tick corre de verdad** (que es otra cosa): crear el fixture, esperar un
tick y buscar el efecto, sin ejecutar el bot a mano.

```bash
npm run seed:prueba-recordatorios   # paciente con turno a ~20 h (dispara el de 48 h)
# …esperar un tick del cron…
npx tsx -e "import 'dotenv/config'; import { MedplumClient } from '@medplum/core';
void (async () => {
  const m = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL, fetch });
  await m.startClientLogin(process.env.MEDPLUM_CLIENT_ID, process.env.MEDPLUM_CLIENT_SECRET);
  for (const c of await m.searchResources('Communication', '_sort=-_lastUpdated&_count=20'))
    console.log(c.meta?.lastUpdated, c.status, c.identifier?.map(i => i.value).join(','));
})();"
```

Si aparece un `recordatorio-48h-…` que **nadie disparó a mano**, el cron está
vivo. `status: preparation` significa que el cron corrió pero faltó un secret o
el teléfono.

Para separar "el bot está roto" de "el cron no dispara", ejecutarlo a mano:

```bash
npx medplum post 'Bot/<id>/$execute' '{}'
```

> El comando `medplum bot execute <nombre>` que sugieren algunos comentarios del
> repo **no existe** en el CLI instalado (`medplum bot` solo tiene save/deploy/create).

### Orden y cosas que lo rompen

1. **Primero deploy, después cron.** Programar un bot sin `executableCode` hace
   que el tick falle en silencio.
2. `npm run deploy:bots` **no pisa** un `cronString` ya configurado (solo hace
   `$deploy` del código). Lo que sí lo pierde es **borrar y recrear** el Bot.
3. **Bots duplicados por nombre**: si hay dos, el cron puede quedar en el viejo.
   Borrar duplicados antes de programar.
4. `bw-cobro-membresias` **cobra plata**. Es idempotente por ciclo y solo actúa
   los días 1-5; fuera de esa ventana `$execute` devuelve `fueraDeVentana: true`.
5. `bw-limpiar-demo` **borra** (solo lo etiquetado `demo`) y necesita permiso de
   delete; sin permiso falla en silencio.

## 3. App de Recepción

```bash
# en el servidor, en el path que matchea el `root` de nginx
git pull && npm run build:app
```

nginx **no se toca**: sirve `app/dist/` y toma el build nuevo al instante. La
conf está en [`deploy/nginx-recepcion.conf`](../deploy/nginx-recepcion.conf) (se
instala una sola vez; `root` = `/home/recepcionistas/app/dist`).

> ⚠️ **Las variables del front son de BUILD, no de runtime**, y se leen **solo**
> de `app/.env` (el `.env` de la raíz es del seed/bots y no entra al bundle).
> Cambiar `app/.env` sin re-buildear no cambia nada. `app/.env` está
> gitignoreado: existe solo en la máquina que buildea.
>
> Nunca poner secretos ahí: con el prefijo `MEDPLUM_` quedan **embebidos en el
> JS** que descarga el navegador.

### Verificar

```bash
grep -o 'assets/index-[^"]*' app/dist/index.html          # hash recién buildeado
curl -s https://<dominio>/ | grep -o 'assets/index-[^"]*'  # hash que sirve prod
```

Si coinciden, se está sirviendo la versión nueva. Si el `index.html` viniera
cacheado, el bloque `location = /index.html` de la conf manda `no-store` — se
comprueba con `curl -sI https://<dominio>/index.html`.

Si falta `GOOGLE_CLIENT_ID`, el build **igual sale con código 0** y solo imprime
un aviso: el botón "Acceder con Google" desaparece y te enterás por el usuario.

## 4. Prueba end-to-end de la lista de espera

Necesita el deploy de bots (§1) y el build del front (§3). **No** necesita el
cron: la cancelación es el disparador.

1. **Anotar la espera.** *Atender* → buscar al paciente → botón **"No hay lugar:
   anotar en la lista de espera"** (al lado de *Reservar turno*). Elegir servicio;
   días y franja son opcionales. Guardar con **"Anotar en la lista"**.
2. **Ver que quedó.** En la ficha aparece *"Está esperando lugar"*; en **Agenda**,
   debajo de la grilla, la tarjeta **"Esperando lugar"**. Por API:
   `GET Appointment?status=waitlist&_count=200` (o `&actor=Patient/<id>`).
3. **Cancelar un turno que le sirva.** *Agenda* → clic en el turno → **Cancelar**.
   El turno tiene que ser de la **misma terapia**, en el **futuro**, y de **otro
   paciente**.
4. **Ver el aviso.** Solapa **Avisos** (badge rojo): *"Se liberó un turno y hay
   alguien esperándolo"*, con los candidatos y **"Ofrecer por WhatsApp"** /
   **"Reservarle"**. Por API:
   `GET Task?identifier=https://biowellness.ar/fhir/Identifier/task|hueco-<appointmentId>`.

### Si el aviso no aparece

Todo el paso es *best-effort* (`try/catch` que devuelve 0): **no hay error en
pantalla ni recurso de error**. Descartar por orden — el aviso NO se crea si:

- el turno cancelado **ya estaba** cancelado / noshow / entered-in-error;
- el turno **no tiene `start`** o su inicio **ya pasó** (se compara contra *ahora*);
- la terapia no coincide (el match es por **categoría**, no por código de servicio);
- el que espera es **el mismo paciente** que canceló;
- la espera **venció** (`hasta` < ahora), o el día/franja no coinciden;
- **ya hubo un aviso para ese turno**: el `Task` es idempotente por
  `hueco-{appointmentId}` y la búsqueda **no filtra por status**. Un turno da
  aviso **una sola vez, para siempre** — aunque lo hayas resuelto. Para repetir la
  prueba: **usar otro turno** o borrar el `Task` primero.

Entran **3 candidatos**, por orden de llegada (`Appointment.created`).

### El WhatsApp

"Ofrecer por WhatsApp" crea una `Communication`:

| status | Qué pasó |
|---|---|
| `completed` | Twilio lo aceptó. La entrega real se mira con `npm run whatsapp:entregas`. |
| `preparation` | **No se envió nada**: faltan Project Secrets de Twilio o la ficha no tiene teléfono. No es un error, es el rastro. |
| `entered-in-error` | Twilio lo rechazó (número, sandbox, plantilla). |

El botón pasa a decir *"Ofrecido"*, pero eso es estado en memoria: se pierde al
recargar. **El registro real es la `Communication`.**

## 5. Datos de prueba

```bash
npm run seed                        # catálogo + Schedule por sala (OBLIGATORIO antes de datos-demo)
npm run seed -- --with-slots --dias=14   # además, franjas libres (ojo: --dias=N con "=", con espacio se ignora)
npm run datos-demo                  # 6 pacientes, 7 turnos, 2 planes, 3 cobros — todos con tag demo
npm run datos-demo -- --limpiar     # borra TODO lo etiquetado demo
npm run agenda:check                # ¿existe el Schedule de cada sala? ¿cuántos slots libres?
```

- `datos-demo` **no tiene dry-run** y **borra los demo existentes antes de generar**:
  si dos personas prueban contra el mismo proyecto, una se lleva puesta a la otra.
- El tag demo es `https://biowellness.ar/fhir/demo` (con `/fhir/`).
- La limpieza demo cubre 7 tipos (Communication, Invoice, Coverage, Flag,
  Appointment, Slot, Patient). Lo que generen los bots a partir de datos demo
  (Encounter, Task, Consent, Basic…) **no lleva el tag y no se borra**.
- `npm run limpiar -- --apply` **no** es la limpieza demo: borra Schedules ajenos
  y todos sus Slots, sin mirar el tag. Correr siempre el dry-run primero.

## 6. Diagnósticos

| Comando | Para qué |
|---|---|
| `npm run bots:check` | ¿están todos los bots creados y con código? |
| `npm run agenda:check` | Schedules y slots libres por recurso; agendas de médicos. |
| `npm run whatsapp:test -- +549…` | Prueba la cadena Medplum→Twilio (usa Project Secrets). |
| `npm run whatsapp:entregas` | Qué pasó **después** de que Twilio aceptó (error_code traducido). |
| `npm run whatsapp:plantilla` | Estado de aprobación de las plantillas de Meta. |
| `npm run email:test -- alguien@dominio` | Aísla Medplum→SES mostrando el error crudo. |
| `npm run mp:test` | Webhook de MercadoPago + preferencia de prueba de ARS 100. |
| `npm run portal:check -- alguien@dominio` | Por qué un paciente no recibe el link de activación del portal. |

### Cuando la invitación al portal dice «no pude generar el link»

Casi siempre es un paciente **que ya tenía cuenta**. El `invite` de Medplum crea
el link de activación **solo para usuarios nuevos**, y el pedido de respaldo
(`auth/resetpassword`) responde **200 aunque no encuentre al usuario**
(anti-enumeración de cuentas): "OK" ahí no significa "lo hice". Por eso el bot
verifica que aparezca una solicitud NUEVA en vez de confiar en la respuesta.

`npm run portal:check -- <email>` distingue los tres casos:

1. **Hay una solicitud vigente** → el link se puede generar; reinvitá.
2. **Todas las solicitudes están usadas** → el paciente **ya activó** su cuenta:
   no necesita activación sino *recuperar la contraseña* desde el portal
   («¿Olvidaste tu contraseña?»). **Reinvitar no sirve para esto**: desde que el
   servidor tiene reCAPTCHA configurado, `auth/resetpassword` exige un token que
   solo puede producir un navegador, y el bot llama de servidor a servidor.
   Ver [`handoff-portal-reset-password.md`](handoff-portal-reset-password.md) §5.
3. **No hay ninguna solicitud** → el `User` quedó fuera del proyecto
   (*server-scoped*, típico de altas viejas): `auth/resetpassword` no lo
   encuentra nunca. Se resuelve borrando ese User en Medplum y reinvitando.

El diagnóstico también avisa si la ficha tiene **más de un email**: puede haber
una cuenta de login por cada uno, y el bot usa el primero si no se le indica
cuál. Conviene dejar en la ficha solo el email con el que el paciente entra.

> `npm run whatsapp:crear-plantillas` **no es diagnóstico**: crea plantillas
> reales en Twilio y las manda a aprobación de Meta. No usarlo para explorar.

## 7. MercadoPago: pasaje de prueba a producción

Los cobros tienen **dos juegos de credenciales** (Access Token) en
[developers de MercadoPago](https://www.mercadopago.com.ar/developers): el de
**prueba** (cuenta/usuario de prueba, dinero ficticio) y el **productivo** (los
pagos son reales). El sistema no distingue entornos por código: **es el token
cargado el que decide** si un link cobra de verdad.

> ⚠️ El token vive en DOS lugares y **no se sincronizan solos**:
> el `.env` local (lo usan `mp:test` / `mp:ordenes`) y los **Project Secrets**
> de Medplum (lo usan los bots). `mp:test` compara ambos y avisa si difieren.

### Checklist del cutover

1. **Project Secrets** (Admin de Medplum → Project → Secrets):
   - `MERCADOPAGO_ACCESS_TOKEN` → el token **productivo** de la aplicación.
   - `MP_WEBHOOK_URL` → `https://api.medplum.com.ar/webhooks/mercadopago`.
     **Obligatorio**: sin él los bots se niegan a generar links (un pago sin
     webhook se acreditaría sin confirmar nada).
   - `APP_BASE_URL` → adónde vuelve el pagador al terminar el checkout
     (`back_urls`). Hoy: la app de recepción.
   - Los secrets se leen en cada ejecución: **no hace falta redeployar bots**.
2. **Panel de MP** (Tus integraciones → tu app → Webhooks → **modo
   productivo**): evento **Pagos**, URL `https://api.medplum.com.ar/webhooks/mercadopago`.
   Copiar la **clave secreta** del panel y cargarla como Project Secret
   `MERCADOPAGO_WEBHOOK_SECRET` (el bot valida la firma `x-signature`).
   > Usar **Webhooks**, no IPN: las notificaciones IPN viajan solo en la query
   > string y el `$execute` de Medplum no se la pasa al bot.
3. **`.env` local**: mismo token productivo (para que `mp:test` pruebe lo mismo
   que usan los bots) y `MERCADOPAGO_WEBHOOK_SECRET` si se quiere a mano.
4. **Prueba de humo**: `npm run mp:test`. Verifica endpoint del webhook, valida
   el token (y dice si es de prueba o productivo), y **compara el `.env` con los
   Project Secrets**. Con token productivo, el paso del link de ARS 100 frena
   solo: correr `npm run mp:test -- --cobro-real` a conciencia, pagar el link
   y **devolver el pago desde el panel** (Actividad → devolver dinero) — la
   devolución además prueba la alerta de "pago devuelto" del webhook.
5. **Prueba de negocio** (opcional pero recomendada): un turno tentativo real
   de un servicio barato, pagar la seña por el link, verificar que el turno pasa
   a confirmado y llega el WhatsApp; devolver el pago y cancelar el turno.
6. `npm run mp:ordenes` lista los últimos pagos (dice si la cuenta es de prueba
   o productiva): sirve para conciliar contra el panel de MP.

### Después del cutover

- **Cron `bw-cobro-membresias`**: con token productivo, los días 1-5 cobra
  **plata real** a los socios con tarjeta guardada y manda links reales al
  resto. Antes de habilitar su `cronString`, confirmar que el catálogo de
  membresías y los `Coverage` activos del servidor son los reales.
- **Rotación del token** (si se compromete o vence): generar uno nuevo en el
  panel de MP y actualizarlo en Project Secrets **y** en el `.env`. Nada más:
  las preferencias ya emitidas siguen funcionando (viven del lado de MP).
- **Si se recrea el bot `bw-webhook-mercadopago`** cambia su id, y el bloque
  nginx (`BOT_ID_WEBHOOK_MP` en `deploy/nginx-api-proxy.conf`) apunta al viejo:
  actualizarlo y `sudo nginx -t && sudo systemctl reload nginx`.
- Los reintentos de MP son la red de seguridad ante caídas: si el webhook
  responde error (token faltante, MP caído), MP reintenta con backoff hasta
  ~24 h. Más de eso (un pago acreditado que nunca entró) se ve en
  `npm run mp:ordenes` y se registra a mano.
