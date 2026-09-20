# Teleconsulta — visión e integración (propuesta)

> **Estado: APROBADA (Andrés, 2026-09-16) · Fase 0 instalada · Fase 1 en curso.**
> Piloto con **Cardiología, Nutrición y Endocrinología** sobre **Jitsi Meet** en
> una EC2 propia de AWS. La Fase 0 tiene su runbook en
> [`teleconsulta-fase0.md`](teleconsulta-fase0.md). De la Fase 1 están en `main`
> la lógica pura, las policies, los cuatro bots, el catálogo y **la reserva y el
> cobro del turno virtual** (PRs #225 a #229). Lo que queda para la primera
> teleconsulta real es deploy, no código: los handoffs lo enumeran. Las
> decisiones cerradas y las abiertas están en §10. Los dos handoffs ya salieron:
> [`handoff-portal-teleconsulta.md`](handoff-portal-teleconsulta.md) y
> [`handoff-dashboard-teleconsulta.md`](handoff-dashboard-teleconsulta.md).
>
> Interlocutores: este repo (`recepcion.biowellness.ar`, dueño del catálogo, las
> policies y los bots), el portal del paciente (`app.biowellness.ar`) y el
> dashboard clínico (Panel Bio).

---

## En una frase

**La teleconsulta es una modalidad más de consulta médica, no un sistema
aparte.** Mismo `Appointment`, mismos bots de reserva y cobro, mismos
recordatorios y campanita. Lo nuevo es una **sala de Jitsi por turno**, con
acceso por **token firmado desde un bot**, y tres puntos de contacto: el portal
para el paciente, el Dashboard para el profesional y la app de Recepción para el
seguimiento. **Lo clínico —PDFs incluidos— nunca pasa por Recepción** (principio 3).

## 1. Lo que ya existe y se reutiliza

Nada de esto se reescribe; se extiende. Es la razón por la que el alcance es chico:

| Pieza | Dónde está | Qué aporta a la teleconsulta |
|---|---|---|
| Consultas por médico, precio en ARS, `practitionerCodigo` | `src/config/medicos.ts`, `src/config/catalogo.ts` | El molde del servicio: un código por profesional, categoría `CONSULTA` |
| Agenda publicada del médico (`Schedule SCH_<código>` + `Slot` libres) | seed (`src/seed/index.ts`) | La disponibilidad real. Ya se valida contra ella, no contra R-13 (`chequearHorarioDisponible`) |
| Reserva con médico como `participant` y su slot a `busy` | `bw-reservar-turno` | Sin doble reserva entre presencial y virtual del mismo profesional |
| Modelo de solicitud del portal + `bw-disponibilidad` | `bw-solicitar-turno`, vista Solicitudes | El pedido entra por la misma puerta que hoy |
| Seña por link de MP, webhook, `confirmarReserva` | `bw-link-mercadopago`, `bw-webhook-mercadopago` | El cobro anticipado; solo cambia el concepto (total en vez de seña) |
| WhatsApp con plantillas de Meta, email por SES, campanita, web push | `enviarWhatsApp`, `enviarEmail`, `notificarPortal`, `bw-web-push` | Todos los avisos al paciente y al profesional |
| Recordatorios 48 h / 2 h idempotentes | `bw-recordatorios` | El de 2 h lleva el link de acceso |
| Check-in con `Encounter` | `bw-estado-turno` | "Paciente en línea" es un check-in con clase virtual |
| Avisos a Recepción (`Task aviso-recepcion` con `tipo`) | `crearAlertaRecepcion`, vista Avisos | Paciente en línea, profesional ausente, agendar control |
| Webhooks públicos con auth inyectada por nginx | `deploy/nginx-api-proxy.conf` | La receta para el webhook de Jitsi (fase 2) |
| JWT HS256 firmado en un bot con `node:crypto` | `bw-federador`, `src/lib/bus-msal.ts` | El precedente para firmar el token de Jitsi: en un bot, nunca en el front |
| Señales binarias con identidad de proyecto | `bw-estado-consentimiento`, `bw-estado-seguridad` | El molde de `bw-estado-teleconsulta`: Recepción ve "hay 2 adjuntos", no los adjuntos |
| PDFs de laboratorio del portal con `Consent` `procesamiento-datos-salud` | portal, `handoff-portal-consentimiento.md` | La subida de información previa ya existe; falta asociarla al turno |
| Policies de Nutrición y Kinesiología | `src/fhir/access-policies.ts` | El molde para Cardiología y Endocrinología |
| Split y tipo de contrato por profesional | `Practitioner.extension` `split-porcentaje`, `tipo-contrato` | El honorario de los especialistas externos ya tiene dónde vivir |

## 2. Infraestructura: Jitsi en su propia EC2

**Separada del servidor Medplum.** El video consume CPU y ancho de banda de
forma distinta a la API, y una llamada nunca puede tirar la agenda.

> **Estado real (2026-09-17):** se cumple donde importa. La **API de Medplum
> tiene su propia EC2** (`api.medplum.com.ar`), así que una llamada no puede
> tirar la agenda: la agenda no está en la máquina del video. Lo que sí comparte
> instancia con Jitsi es el **front estático** de `recepcion.biowellness.ar`
> —nginx sirviendo archivos, sin proceso detrás—, y **está decidido separarlos
> cuando la CPU lo pida** (Andrés). Con eso, lo peor que puede pasar mientras
> tanto es que tarde en abrir la app, no que deje de funcionar. Lo que hay que
> mirar, y lo que hay que tocar el día de la mudanza (que no es el DNS), está
> en el runbook §2.1.

| Tema | Propuesta |
|---|---|
| Instalación | **Paquetes Debian** (`apt install jitsi-meet`), que traen web, Prosody, Jicofo, JVB **y coturn** configurados. Docker queda como alternativa; comparación y paso a paso en [`teleconsulta-fase0.md`](teleconsulta-fase0.md) §1 |
| Dominio y TLS | `meet.biowellness.ar` con IP elástica y Let's Encrypt (la imagen lo resuelve sola) |
| Puertos | 443 TCP (web), 10000 UDP (media), 4443 TCP (respaldo). Coturn: 3478 UDP/TCP y 5349 TCP |
| Tamaño inicial | Una instancia mediana. Con tres especialidades hay pocas llamadas simultáneas, y una llamada de **dos personas va punto a punto**: el servidor casi no interviene |
| Acceso | **Solo con token JWT** (paquete `jitsi-meet-tokens`; en Docker, `ENABLE_AUTH=1` y `AUTH_TYPE=jwt`). Nadie crea salas a mano ni entra sin token |
| Roles | El **profesional entra como moderador** según el claim del token y el paciente no, verificado en producción (2026-09-16). Son **tres** piezas y las tres hacen falta: `enable-auto-owner = false` en Jicofo, el módulo `token_affiliation`, y `wait_for_host_disable_auto_owners = true` — sin esta última, Jitsi promueve a moderador a **todo** el que traiga token. Receta y por qué: runbook §4.2 |
| Nombre de la sala | Un UUID por turno (`tc-<uuid>`). **Nunca el nombre del paciente ni el id del turno**: el nombre de la sala viaja en URLs y logs |
| Grabación y terceros | Apagados: sin grabación, sin streaming, sin avatares externos ni analytics (`disableThirdPartyRequests`) |
| Embebido | Los dos fronts lo abren con el **IFrame API** (`external_api.js` del propio dominio). El nginx de Jitsi permite `frame-ancestors` solo para `app.biowellness.ar` (portal) y `dashboard.biowellness.ar` (Dashboard); el iframe necesita `allow="camera; microphone; display-capture; autoplay"` |
| Logs | Sin PHI: la sala es un UUID, el nombre visible es el del token y no se persiste |

**El token.** Lo firma un bot con la clave del Project Secret (`JITSI_JWT_SECRET`),
con vida corta y atado a la sala:

```jsonc
{
  "iss": "<JITSI_APP_ID>",
  "aud": "jitsi",
  "sub": "meet.biowellness.ar",
  "room": "tc-3f2a…",               // una sala, no "*"
  "nbf": <inicio del turno − 15 min>,
  "exp": <fin del turno + 60 min>,
  "context": { "user": { "name": "Ana", "affiliation": "owner" /* solo el profesional; el paciente: "member" */ } }
}
```

Sin DNI, sin email, sin id de paciente en el token. El nombre visible es el
**nombre elegido** de la ficha (`name[0]`, ya es el criterio de todo el repo).

**Dos riesgos técnicos para la semana cero**, antes de tocar el repo:

1. Cámara y micrófono **dentro del portal instalado como PWA en iPhone**. Si no
   funciona embebido, el botón abre Jitsi en una pestaña nueva con el token.
2. Calidad de llamada en **4G sin coturn**. Si un paciente detrás de una red
   restrictiva no conecta, coturn no es opcional.

## 3. Modelo de datos FHIR

| Recurso | Hoy | Para teleconsulta |
|---|---|---|
| `ActivityDefinition` | Un servicio por médico (`CONSULTA_MED_*`), categoría `CONSULTA`, `precio-ars` | Un servicio por **profesional y modalidad** (`TELECONSULTA_<código>`), **misma categoría `CONSULTA`**: el Panel Bio sigue contando consultas sin cambios. Extensión `modalidad-atencion = virtual` |
| `Practitioner` | Tres médicos, con `split-porcentaje` y `tipo-contrato` | Cardiólogo, nutricionista y endocrinólogo nuevos, del mismo molde. El tipo `Medico` de `src/config/medicos.ts` pasa a llamarse por lo que es (profesional): una nutricionista no es médica |
| `PractitionerRole` | Se asigna a mano desde el admin (`docs/usuarios.md`) | `specialty` con un CodeSystem propio `especialidad` (`cardiologia` · `nutricion` · `endocrinologia`). El mapeo a SNOMED CT se agrega cuando el Federador o una obra social lo pidan |
| `Schedule` + `Slot` | Agenda publicada por médico, generada por el seed | Igual. **Un turno presencial y uno virtual del mismo profesional ocupan el mismo slot**, así no hay doble reserva. Si un profesional atiende solo virtual, publica solo esa agenda |
| `Location` | Salas físicas; el consultorio con capacidad 1 | Un recurso **virtual** `R_TELECONSULTA` (tipo `VIRTUAL`, capacidad alta). Nunca bloquea: el cuello real es la agenda del profesional. El mapeo categoría→tipo de recurso (`CONSULTA → CONSULTORIO`) pasa a depender de la modalidad |
| `Appointment` | Servicio, categoría, participantes, extensiones de cobro | `appointmentType` = `modalidad-atencion|virtual`; extensión `teleconsulta-sala` con el UUID. Los PDFs que el paciente asocia al turno apuntan **desde el documento** (`DocumentReference.context.related` → el turno): el paciente no puede escribir el `Appointment`, así que `supportingInformation` no se usa. **El token no se guarda nunca**: se emite a pedido |
| `Encounter` | Clase `AMB`, se abre al llegar | Clase **`VR`** (virtual). Se abre cuando el paciente entra a la sala; `period.start` es el dato de "cuánto esperó". `participant` con el profesional cuando entra |
| `DocumentReference` | Consentimientos firmados; PDFs de laboratorio del portal | Laboratorio, informe de imágenes e informe previo, con `category` de un CodeSystem propio `documento-paciente` (`laboratorio` · `imagenes` · `informe-previo` · `informe-consulta`), `type` LOINC, `context.related` → el turno. El **informe del profesional** después de la consulta también va acá, con `author` = profesional |
| `Consent` | `atencion`, `procesamiento-datos-salud`, `uso-secundario` | Código nuevo **`teleconsulta`** en `CodeSystem/consentimiento`: el paciente acepta la modalidad y sus límites. Se firma una vez en el portal, misma evidencia (`DocumentReference` enlazado por `sourceReference`) |
| `Questionnaire` | Cuestionario de ingreso (`INTAKE_QUESTIONNAIRE_URL`) | Un **cuestionario previo por especialidad**, publicado por el seed (este repo es el dueño de los `Questionnaire`). El paciente lo completa antes del turno |
| `ServiceRequest` / `MedicationRequest` | El portal ya los lee ("Mis estudios", medicación) | Las órdenes y recetas que deja el profesional. Nada nuevo del lado de Recepción |
| `Task` | Solicitudes, avisos con `tipo` | Tres tipos nuevos de aviso (`TIPO_AVISO`): `paciente-en-linea` · `profesional-ausente` · `agendar-control` |
| `Communication` | Campanita con `CodeSystem/notificacion` | Dos tipos nuevos: `teleconsulta-lista` (el link ya está, 2 h antes) y `documento-nuevo` (hay novedades de tu consulta). `bw-web-push` necesita sus títulos y su destino |

Forma del turno virtual (armada del código que lo escribiría, no un dump):

```jsonc
{
  "resourceType": "Appointment",
  "status": "booked",
  "appointmentType": { "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/modalidad-atencion", "code": "virtual" }] },
  "serviceType":     [{ "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/servicio", "code": "TELECONSULTA_MED_CARDIO" }] }],
  "serviceCategory": [{ "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/categoria-servicio", "code": "CONSULTA" }] }],
  "participant": [
    { "actor": { "reference": "Patient/…" }, "status": "accepted" },
    { "actor": { "reference": "Practitioner/…" }, "status": "accepted" }
  ],
  "extension": [
    { "url": "https://biowellness.ar/fhir/StructureDefinition/teleconsulta-sala", "valueString": "tc-3f2a…" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/recurso-fisico", "valueString": "R_TELECONSULTA" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/item-tipo", "valueCode": "servicio" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/item-codigo", "valueString": "TELECONSULTA_MED_CARDIO" }
  ]
}
```

Recepción lee este recurso entero. Los adjuntos los cuenta
`bw-estado-teleconsulta` con `DocumentReference?related=Appointment/<id>`;
su policy no lista `DocumentReference`, así que ve que hay adjuntos, no qué dicen.

## 4. Bots

Todos finos, con la lógica pura en `src/lib/teleconsulta.ts` y tests: ventana
de acceso a la sala, claims del token (sin la firma), qué recordatorio toca en
modalidad virtual, cuándo un turno virtual es no-show. **Los nombres son
propuesta.**

| Bot | Qué hace | Quién lo ejecuta |
|---|---|---|
| `bw-teleconsulta-token` | Verifica que el turno sea de quien pide (misma defensa que `bw-cancelar-turno`), que esté `booked` y dentro de la ventana. Devuelve `{ dominio, sala, jwt }` de vida corta. Con `rol: 'profesional'` verifica que sea el `participant` y emite moderador | Portal (rol paciente) · Dashboard (rol profesional) |
| `bw-teleconsulta-presencia` | Registra entrada y salida de cada parte: abre el `Encounter` VR, mueve el turno a `arrived` (paciente en línea) o `checked-in` (en consulta), crea el aviso a Recepción y avisa al profesional. Idempotente por (turno, evento) | Portal y Dashboard al conectarse (IFrame API `videoConferenceJoined` / `Left`). En fase 2, el webhook de Jitsi |
| `bw-teleconsulta-vigilante` | **Cron cada 10 min** (el tope de `tests/cron.test.ts`; el aviso instantáneo lo da el bot de presencia): paciente esperando sin profesional hace más de N minutos, o turno empezado sin paciente. Deja avisos idempotentes en Avisos (`clave` por turno y tipo) | Cron |
| `bw-estado-teleconsulta` | **Solo lectura, identidad de proyecto:** `{ adjuntos: 2, cuestionarioPrevio: 'completo', pacienteEnLinea: true, profesionalEnLinea: false, esperaMin: 4 }`. Nunca el contenido. Falla cerrado | App de Recepción |

Los que ya existen cambian poco:

| Bot | Cambio |
|---|---|
| `bw-reservar-turno` | ✅ Entiende la modalidad: **fuerza** el recurso virtual (no lo elige el mostrador), escribe `appointmentType` y genera el UUID de la sala. R-20 queda como está (§6.4) |
| `bw-disponibilidad` / `chequearHorarioDisponible` | Sin cambios de fondo: las consultas ya se validan contra la agenda del profesional |
| `bw-link-mercadopago` / `confirmarReserva` | ✅ Cobro total anticipado: la fracción sale de `modalidadDeTurno(appt)`, `es-sena = false`, sin Invoice de saldo, y los textos no dicen "seña" |
| `bw-recordatorios` | ✅ Para turnos virtuales el de 2 h lleva el link **al portal** (nunca a Jitsi: la sala solo abre con token) y notifica `teleconsulta-lista` |
| `bw-estado-turno` | Incorpora `noshow`, que FHIR tiene y hoy no usamos |
| `bw-web-push` | ✅ Títulos y destino (`/teleconsulta/<id>`) de los dos tipos nuevos |
| `bw-whatsapp-entrante` | Un adjunto entrante recibe la auto-respuesta "subilo en tu portal" (§8) |
| `bw-proponer-reserva` | Fuera de alcance: las consultas siguen mandando a Atender |

Secrets nuevos (Project Secrets de Medplum, nunca en el `.env` de los bots):
`JITSI_BASE_URL`, `JITSI_APP_ID`, `JITSI_JWT_SECRET` y, en fase 2,
`JITSI_WEBHOOK_SECRET`.

## 5. Permisos (AccessPolicies)

Las policies son de este repo y **el seed reemplaza la policy entera**: lo que
no esté acá se pierde en la próxima corrida.

| Policy | Cambio |
|---|---|
| **Cardiología** y **Endocrinología** (nuevas) | Copian el molde de Nutrición **más** `DocumentReference`, `ServiceRequest`, `MedicationRequest`, `Encounter`, `DiagnosticReport` y `Consent` de lectura. El `PractitionerRole` se asigna a mano, como los demás |
| **Nutrición** | Hoy no tiene `DocumentReference`, `ServiceRequest` ni `Encounter`: sin eso no ve los PDFs ni puede pedir estudios. Se amplía igual que las nuevas |
| **Paciente — Portal** | `Bot?name=` suma `bw-teleconsulta-token` y `bw-teleconsulta-presencia`. `QuestionnaireResponse` y `DocumentReference` ya son escribibles. ⚠️ **Avisar al portal para actualizar su espejo** (`portal/docs/medplum/access-policy-paciente-portal.json`): ya se rompió tres veces por olvidarlo |
| **Recepción — Operativo** | **Sin cambios de alcance.** Lee `Appointment` y `Encounter` (operativos), ejecuta `bw-estado-teleconsulta`. Sigue sin `DocumentReference` |
| Bots nuevos | `bw-teleconsulta-presencia` escribe `Encounter` y `Task`; `bw-estado-teleconsulta` lee con identidad de proyecto. Ninguno necesita admin |

Los profesionales del Dashboard necesitan ejecutar los dos bots de token y
presencia: entra en el handoff al Dashboard, no acá.

## 6. El circuito de punta a punta

### 6.1 Datos del paciente

1. **Alta** con dedup por DNI, email y teléfono (`bw-alta-paciente`). El
   Federador completa nombre y documento con el RENAPER (`bw-federador`).
2. **Invitación al portal** (`bw-invitar-paciente`, WhatsApp / email / QR). Es
   el paso obligatorio: **la teleconsulta se hace desde el portal**, así que el
   paciente tiene que tener login. La teleconsulta es, de paso, el mejor
   incentivo para que se lo haga.
3. En el portal: consentimiento general de atención, consentimiento de
   **teleconsulta**, cuestionario previo de la especialidad, PDFs. Opcional:
   obra social/prepaga (`Coverage` HIP), que ya existe y no se usa para cobrar
   en el piloto.
4. Verificar **teléfono y email** en la ficha: son los dos canales por los que
   le llega el link.

### 6.2 Pedido

Las tres puertas de `docs/canales-acceso.md`, sin puertas nuevas:

- **Portal:** elige "Cardiología por videollamada" y un horario de la agenda
  publicada del profesional. Cae en **Solicitudes** con el WhatsApp a Recepción.
- **WhatsApp / teléfono:** Recepción reserva desde **Atender**, eligiendo el
  servicio virtual como cualquier otro.
- **Derivación interna:** un médico de la casa indica la interconsulta desde el
  Dashboard (`ServiceRequest` o `Task`) y cae en Solicitudes.

### 6.3 Reserva y cobro

Recepción confirma con `bw-reservar-turno`. El turno nace tentativo con
vencimiento R-19 y el WhatsApp con el link de pago. **Propuesta: la
teleconsulta se cobra completa por adelantado**, en vez de seña + saldo: no hay
mostrador donde cobrar el resto, y perseguir un saldo a distancia es trabajo de
Recepción que el sistema puede evitar. Al acreditarse el pago, el webhook
confirma el turno como hoy (`turno-confirmado` + campanita `reserva-confirmada`).

El texto del WhatsApp de confirmación dice que es por videollamada y que el link
llega 2 h antes desde el portal. El **`ChargeItem` no cambia** (código
`CONSULTA`, `linea-comercial: consultas`); ver §9.

### 6.4 Requisitos antes de reservar (R-20 en modalidad virtual)

R-20 pide consentimiento general **y** cuestionario de ingreso para cualquier
terapia. Para una teleconsulta, el cuestionario de contraindicaciones de HBOT /
IHHT no aplica. **Propuesta (regla nueva, numerada al aprobarse):** en modalidad
virtual la aptitud exige el consentimiento general **más** el de teleconsulta, y
reemplaza el cuestionario de ingreso por el **cuestionario previo de la
especialidad**. Mismo criterio de R-20 en lo demás: se lee en el servidor, falla
cerrado, sin override.

### 6.5 Información previa (PDF desde la app)

- El paciente sube PDFs desde **"Mis estudios"** del portal, que ya existe, pero
  **asociándolos al turno** (`context.related` → `Appointment`; el vínculo
  vive en el documento, no en el turno). Cada subida lleva el `Consent`
  `procesamiento-datos-salud` que el portal ya crea.
- Categorías: laboratorio, informe de imágenes, informe previo (una derivación,
  un resumen de otro médico), receta vigente.
- **Imágenes en esta fase: el informe en PDF o una foto.** El estudio DICOM
  completo queda para más adelante: Medplum no lo modela y el nginx del API
  limita los uploads a 20 MB.
- El profesional los ve en el Dashboard antes de la consulta. **Recepción ve
  "adjuntó 2 documentos"** y nada más (`bw-estado-teleconsulta`).

### 6.6 Recordatorios

Los de 48 h y 2 h salen solos. Para turnos virtuales el de **2 h cambia de
texto**: trae el link al portal y la sugerencia de probar cámara y micrófono.
Sale por WhatsApp, campanita (`teleconsulta-lista`) y web push, que ya llega con
la app cerrada. Es una plantilla nueva de Meta, que tarda días en aprobarse:
arranca por la **genérica**, como todo lo que no tiene plantilla propia.

### 6.7 El día del turno: "paciente en línea"

```
Portal                          Medplum (bots)                       Recepción / Dashboard
──────                          ──────────────                       ─────────────────────
[Entrar a la videollamada]
  (activo desde T−15 min)
        │ bw-teleconsulta-token ──► verifica turno + ventana
        │                       ◄── { dominio, sala, jwt }
  iframe Jitsi (prejoin)
  videoConferenceJoined ──────► bw-teleconsulta-presencia
                                  ├─ Appointment → arrived
                                  ├─ Encounter VR (period.start)
                                  ├─ Task aviso paciente-en-linea ──► Avisos (badge en tiempo real)
                                  └─ WhatsApp + señal al profesional ─► Dashboard: [Iniciar consulta]
                                                                              │ bw-teleconsulta-token (moderador)
                                Appointment → checked-in ◄── presencia ◄──── entra a la sala
  (la pantalla de espera
   se abre: empieza la consulta)
```

- **Ventana de acceso:** desde 15 minutos antes hasta 60 después del fin.
  Fuera de eso el botón no aparece y el bot no emite token.
- **La espera la muestra el portal, no Jitsi** (decisión de la Fase 0,
  2026-09-16). El módulo de Jitsi que retiene invitados considera anfitrión a
  cualquiera que traiga token, y en nuestro diseño el paciente también tiene el
  suyo, así que nunca lo retendría. El portal muestra su propio mensaje
  alrededor del video mientras el profesional no se conecta. El riesgo es nulo:
  a esa sala **solo el paciente y su profesional tienen token**. Detalle en el
  runbook §4.4.
- **Escalado:** si a los **5 minutos** el profesional no entró, el vigilante
  deja el aviso `profesional-ausente` y Recepción lo llama. Si el paciente no
  apareció **10 minutos** después de la hora, aviso para que Recepción lo
  contacte, y después la decisión de no-show (§6.9).
- **Recepción no entra nunca a la sala.** El soporte técnico es por WhatsApp o
  teléfono, desde afuera.

### 6.8 Después de la consulta

1. El profesional cierra desde el Dashboard: turno `fulfilled`, `Encounter`
   `finished` (`cerrarEncounterDeTurno`, la misma función de hoy).
2. Escribe su evolución en el Dashboard. Deja órdenes de laboratorio como
   `ServiceRequest` con `intent = order` y recetas como `MedicationRequest`:
   **el portal ya lee las dos cosas**.
3. Si hay informe en PDF, va como `DocumentReference` del paciente
   (`informe-consulta`) y la campanita avisa `documento-nuevo`: "tenés novedades
   de tu consulta". **Nunca contenido clínico por WhatsApp.**
4. Si hay que agendar un control, el profesional deja el aviso
   `agendar-control` y Recepción lo ve en Avisos con el botón de reservar.
5. Cuando el paciente sube el resultado del estudio pedido, el PDF referencia
   la orden (`context.related` → `ServiceRequest`) y el Dashboard lo enruta a
   su bandeja. Eso es dominio del Dashboard.

### 6.9 Incidencias

| Situación | Qué pasa |
|---|---|
| El paciente no se conectó | Aviso a los 10 min. A los **15 min** Recepción marca `noshow` desde el modal; el pago no se devuelve (§10). R-14 no aplica: no hay sesión de plan |
| El profesional no se conectó | Aviso `profesional-ausente` a los 5 min. Recepción reprograma con `bw-mover-turno` (mismo bot que el portal) y el paciente recibe el WhatsApp. La devolución es plata y se decide a mano, como la seña en R-14 |
| Se cayó la llamada | Los dos vuelven a entrar con el mismo botón: el token se emite de nuevo mientras dure la ventana. El `Encounter` no se cierra hasta que el profesional cierra |
| Fallo técnico irrecuperable | Recepción llama por teléfono y reprograma. Queda registrado en `cancelationReason` |

### 6.10 Avisos al profesional

Hasta el 2026-09-20 el sistema le confirmaba todo al paciente y el profesional
se enteraba de sus consultas mirando el Dashboard. Andrés pidió que le llegue
por WhatsApp o mail. Son tres avisos, y los tres salen de **este repo** —el
Dashboard es lo que el profesional *ve*; lo que le *llega* lo mandan nuestros
bots—:

| Aviso | Cuándo | Bot | Clave (idempotencia) |
|---|---|---|---|
| **Te reservaron una consulta** (paciente, fecha, servicio, link al Dashboard) | Al confirmarse el pago, después del WhatsApp al paciente | `confirmarReserva` (webhook de MP / seña en mostrador) | `prof-reserva-<turno>` |
| **Recordatorio de 2 h** con el acceso al Dashboard | Junto con el de 2 h del paciente. El de 48 h no va: es para que el paciente se organice | `bw-recordatorios` | `recordatorio-2h-prof-<turno>` |
| **Tu paciente está en la sala** | Cuando el paciente entra y el profesional todavía no. Hasta hoy iba solo a `RECEPCION_WHATSAPP_TO`; sigue yendo, y ahora también al profesional | `bw-teleconsulta-presencia` | `tc-en-linea-prof-<turno>` |

Los textos son funciones puras en `src/lib/teleconsulta.ts`
(`avisoProfesional*`, con tests) y el envío es `avisarProfesional` en
`src/bots/_shared.ts`. Aplica a **toda consulta con profesional**, presencial o
virtual: es el mismo médico, y el texto dice "teleconsulta" o "consulta
presencial" según el turno.

**Dónde vive el contacto.** En Project Secrets, uno por profesional:
`PROFESIONAL_WHATSAPP_<código>` y `PROFESIONAL_EMAIL_<código>` (el código es el
de `src/config/medicos.ts`). No en `Practitioner.telecom`: la policy del portal
deja leer `Practitioner` a los pacientes, y el celular personal del médico
quedaría a un pedido de API. Sin secret, ese profesional no recibe avisos y no
es error. `DASHBOARD_BASE_URL` (default `https://dashboard.biowellness.ar`) es
el link; va a la raíz porque el Dashboard no tiene una ruta confirmada para
"este turno".

**Canales.** El email sale por SES como siempre. El WhatsApp a un profesional
está siempre fuera de la ventana de 24 h de Meta (él no nos escribió), así que
va por la plantilla genérica aprobada con el cuerpo entero en `{{1}}` —el mismo
camino de `RECEPCION_WHATSAPP_TO`—. Ninguno de los tres avisos tiene secret de
plantilla propio y no hace falta (`docs/whatsapp-plantillas.md`).

**Lo que lleva y lo que no.** El nombre del paciente sí: el profesional lo va a
atender. Nada clínico: los estudios, el cuestionario previo y las notas se ven
en el Dashboard con login. El asunto del email no nombra al paciente —se lee en
la pantalla bloqueada de un teléfono apoyado en un escritorio—; el cuerpo sí.

**Best-effort, siempre.** Los tres van después de lo que importa (el cobro
registrado, la presencia anotada) y nada de esto lanza: un aviso que no sale
queda como `Communication` en `preparation` / `entered-in-error`, igual que los
del paciente, y no deshace nada.

## 7. Qué cambia en cada app

### App de Recepción (este repo)

- **Agenda del día:** un carril **"Videollamadas"** (el recurso virtual) en el
  timeline, con el badge de modalidad en cada bloque.
- **Atender → Reservar:** el servicio virtual aparece como uno más; el modal de
  reserva no cambia.
- **Modal del turno:** para virtuales, los estados son *En línea* / *En
  consulta* / *Completó* / *No se presentó* / *Cancelar*, más "Paciente conectado
  hace 4 min" y "Profesional: sin conectar", que salen de
  `bw-estado-teleconsulta`. Botones **Reenviar link** (WhatsApp con el deep link
  al portal) y **Llamar**.
- **Avisos:** los tres tipos nuevos, cada uno con su acción (llamar al
  profesional, escribir al paciente, reservar el control).
- **Solicitudes:** una teleconsulta se ve como cualquier consulta. *Proponer*
  sigue mandando a Atender.
- **Reportes:** teleconsultas por especialidad, tasa de no-show, minutos de
  espera del paciente (del `Encounter.period.start` contra el `start` del turno).

### Portal — [`handoff-portal-teleconsulta.md`](handoff-portal-teleconsulta.md)

- Página `/teleconsulta/:id` con el iframe de Jitsi, el botón activo en la
  ventana, y la llamada a los dos bots.
- **La sala de espera**: mientras el profesional no entró, el mensaje propio
  alrededor del video (ver §6.7 y runbook §4.4). Es del portal, no de Jitsi.
- "Mis estudios" con la opción de asociar el PDF a un turno próximo.
- Cuestionario previo de la especialidad en el flujo del turno.
- Consentimiento de teleconsulta (mismo mecanismo que el general).
- Dos tipos nuevos de campanita y su destino.

### Dashboard / Panel Bio — [`handoff-dashboard-teleconsulta.md`](handoff-dashboard-teleconsulta.md)

- Botón **Iniciar consulta** con el token de profesional; embebido igual que el portal.
- Ficha previa: documentos asociados al turno, cuestionario previo, vitales y
  medicación que el paciente carga en el portal.
- Evolución, órdenes, recetas, informe en PDF, aviso de control a Recepción.
- Su bandeja de tareas para "resultados por revisar". Nada de esto lo ve Recepción.

## 8. Privacidad: quién ve qué

| Actor | Ve | No ve |
|---|---|---|
| Recepción | Turno, modalidad, profesional, estado de pago, conectado o no, minutos de espera, **cantidad** de adjuntos | Los PDFs, el cuestionario previo, la evolución, las órdenes, las recetas |
| Profesional | Todo lo clínico de **sus** pacientes, en el Dashboard | Caja y cobros ajenos |
| Paciente | Lo suyo en el portal: turno, documentos, órdenes, recetas, informe | Nada de otros pacientes |
| Jitsi | El nombre visible y la sala mientras dura la llamada | DNI, historia, documentos. **No graba** |

**Un agujero que conviene cerrar de entrada.** Hoy un PDF que el paciente manda
por WhatsApp queda como `Binary` en el hilo de Mensajes, y **Recepción lo ve**
(la policy lo permite a propósito, para comprobantes y consultas). Con
laboratorios en juego eso choca con el principio 3. Dos medidas:

1. La **auto-respuesta** (`docs/whatsapp-auto-respuestas.md`) detecta un adjunto
   PDF o imagen y contesta: "si es un estudio, subilo en tu portal, en Mis
   estudios; así lo ve tu médico y queda en tu historia".
2. Un botón **"Pasar a la historia clínica"** en la burbuja: un bot con identidad
   de proyecto crea el `DocumentReference` con ese `Binary` y lo saca del hilo.
   Recepción decide que es clínico sin abrirlo.

## 9. Contrato con Administración y reportes

El `ChargeItem` sigue con `code = CONSULTA` y `linea-comercial = consultas`,
así que el tablero de Administración **no se rompe**. Para que separen
presencial de virtual en su P&L conviene sumar la extensión `modalidad-atencion`
al `ChargeItem` (ampliar la lista es compatible; renombrar no, misma regla que
`origen-lead`). El honorario del especialista sale del `split-porcentaje` de su
`Practitioner`; hoy las consultas se cobran enteras (`BW_100`) y ese pendiente
(`docs/decisiones-pendientes.md` § Clínico) se vuelve urgente con especialistas
externos.

## 10. Decisiones

### Cerradas por Andrés (2026-09-16)

| Tema | Decisión |
|---|---|
| **Dominio** | `meet.biowellness.ar` |
| **Precio por especialidad** | Teleconsulta de cardiología **ARS 150.000** · endocrinología **ARS 150.000** · nutrición **ARS 120.000**. Presencial: nutrición **ARS 180.000** (incluye las medidas) y **Antropometría suelta ARS 60.000**. Los números cierran: la presencial es la virtual más las medidas, que **no se pueden tomar por videollamada** |
| **Dos productos del mismo médico** | La teleconsulta de cardiología del Dr. D'Alessandro (150.000) **no reemplaza** su evaluación presencial (120.000): son dos productos con código propio. Los 150.000 pagan además el uso de la plataforma y del tablero cardiovascular del Dashboard |
| **Profesionales** | Cardiología: Dr. Alejandro D'Alessandro (ya estaba en el sistema). Endocrinología y diabetes: Dra. Malena Albarellos, **solo virtual** por ahora. Medicina hiperbárica: Dr. Nicolás Carrieri, **sin precio definido**, así que su `Practitioner` existe pero no se publica servicio suyo |
| **Grilla** | **Slots virtuales de 60 minutos.** R-22 **no se toca**: las consultas ya arrancan en punto, así que la grilla virtual encaja sin excepción |
| **Cobro** | **Total y anticipado**, por ser virtual. Sin seña ni saldo: no hay mostrador donde cobrar el resto |
| **Todo por la App** | El paciente gestiona desde el portal y completa **los pasos que ya existen** antes de poder reservar. Confirma el "no" al acceso sin portal: la invitación al portal es parte del onboarding |
| **Recepción y la sala** | Recepción no entra nunca a la videollamada. Soporte por WhatsApp o teléfono |
| **Especialidades** | Lista **abierta** y creciente: cardiología, endocrinología y diabetes, nutrición, medicina hiperbárica, traumatología y medicina del deporte, medicina general (`ESPECIALIDADES` en `src/fhir/identifiers.ts`). Sumar una es un renglón, no un cambio de modelo |

### Abiertas

| Tema | Propuesta | Por qué importa |
|---|---|---|
| **Aptitud en modalidad virtual (R-20)** | ⚠️ **Supuesto en uso, sin confirmar:** R-20 queda **como está**, sin excepción para lo virtual. "Completar todos los pasos tal cual están" se lee así, y funciona: las contraindicaciones se evalúan por categoría y ninguna aplica a `CONSULTA`, así que una contraindicación de cámara no bloquea una teleconsulta | Si el supuesto es correcto, esta fila se cierra sin escribir código. Si no, hay que escribir la regla antes de la primera reserva |
| **Honorarios de los especialistas** | Usar el `split-porcentaje` por profesional que ya existe. Mientras tanto sale como hoy, `BW_100` | Con especialistas externos el split deja de ser un pendiente teórico |
| **No-show** | A los 15 min sin paciente, Recepción **puede** marcar no-show; el sistema habilita, no ejecuta. Qué pasa con el pago (total y anticipado) es la decisión | `habilitaNoShow` ya está implementado y testeado; falta la consecuencia comercial |
| **Precio de la consulta hiperbárica** | El Dr. Carrieri ya está cargado; **falta su precio**, y sin precio no se publica el servicio | Es la puerta de entrada a la cámara, el servicio central de la casa |
| **Nutricionista** | Los tres precios están definidos; **falta el nombre de la profesional** | Sin ella no se pueden crear los tres servicios de nutrición |
| **Franjas de los nuevos** | Albarellos y Carrieri no tienen agenda publicada, así que el portal todavía no los ofrece (el Dr. D'Alessandro sí: teleconsulta lunes y viernes 18-20, agenda de video aparte de la presencial, 2026-09-17) | La nutrición presencial y la consulta hiperbárica usan el **único** consultorio, donde ya se reparten tres médicos. Las franjas las define Andrés; `agenda:check` detecta los cruces |

## 11. Fases y verificación

Cada fase se entrega verde antes de seguir (slices verticales, como el resto del repo).

| Fase | Contenido | Depende de | Cómo se verifica |
|---|---|---|---|
| **0 · Infra** | EC2 con Jitsi, dominio, TLS, JWT, coturn, endurecimiento. **Sin tocar el código.** Runbook: [`teleconsulta-fase0.md`](teleconsulta-fase0.md) | AWS y DNS | Nueve pruebas (runbook §7). **Instalado y verificado el 2026-09-16** hasta la prueba 4 (permisos reales); faltan 4G, tres personas, iPhone, token vencido y sala equivocada |
| **1 · Piloto** | Catálogo y profesionales, policies, los cuatro bots, reserva y cobro total, recordatorio con link, Avisos nuevos, carril en la Agenda, modal del turno. Portal: página, PDFs al turno, cuestionario previo, consentimiento. Dashboard: botón y ficha previa. **Lo de este repo está hecho** (2026-09-17) salvo el carril y el modal; el portal entregó su Hito 1 | Las decisiones de §10 | Tests de `src/lib/teleconsulta.ts`; `npm run verify`; `policy:check`; una teleconsulta real de punta a punta con un paciente de prueba |
| **2 · Endurecer** | Presencia desde el servidor de Jitsi por webhook (`/webhooks/jitsi`, misma receta de nginx; módulo de eventos de Prosody), no-show automático, informe post-consulta, "pasar a la historia clínica" desde Mensajes, imágenes DICOM, receta electrónica, obras sociales, *Proponer* para consultas | Lo aprendido del piloto | Ídem + prueba de reconexión y de webhook con firma |

**Por qué la presencia arranca desde el front y no desde Jitsi.** El evento del
IFrame API funciona con lo que ya tenemos y no requiere módulos extra en
Prosody. Le falta un caso: alguien que entre por fuera del portal. Como en el
piloto no hay acceso sin portal, ese caso no existe todavía; el webhook de
Jitsi lo cubre en fase 2 y de paso da el "salió de la llamada" real.

## 12. Preguntas abiertas

- ¿Los tres especialistas son **externos** (honorario por consulta) o de planta?
  Cambia el split, el `tipo-contrato` y si publican agenda propia.
- ¿La teleconsulta **entra en algún plan** (membresía, PB100D)? En el piloto se
  vende suelta. Si entra, el `Coverage` la tiene que contar.
- ¿Nutrición atiende también **presencial**? Hoy no hay consultorio asignado ni
  servicio presencial de nutrición en el catálogo.
- ¿Hace falta **receta electrónica** con firma digital desde el día uno, o
  alcanza con la `MedicationRequest` que el paciente ve en el portal? Es una
  pregunta para el Director Médico, no técnica.
- **Zona horaria del cron**, pendiente desde `puesta-en-produccion.md`: el
  vigilante corre cada 10 min y no le importa, pero el día que se agregue un
  recordatorio "a las 9 de la mañana" sí.
