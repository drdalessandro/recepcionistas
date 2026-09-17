# Handoff: Teleconsulta en el portal — la videollamada, la sala de espera y lo previo al turno

> **Qué es este documento.** Lo que el portal tiene que construir para que un
> paciente haga su consulta por videollamada, y el contrato exacto con este
> repo: cómo se reconoce un turno virtual, cómo se pide el token, qué evento
> dispara la presencia, cómo se asocian los PDFs al turno y qué notificaciones
> nuevas llegan. Visión completa en [`teleconsulta.md`](teleconsulta.md);
> infraestructura y por qué de cada decisión en
> [`teleconsulta-fase0.md`](teleconsulta-fase0.md).
>
> **Estado (2026-09-17, segunda revisión).** El portal contestó con el Hito 1
> construido y cuatro preguntas: **están las cuatro contestadas en §12**, y lo
> que dependía de nosotros ya está implementado. De los ocho pendientes de §9
> quedan tres, todos de deploy o de textos de terceros. La tabla de §0 está al
> día.
>
> Interlocutor: repo del portal del paciente (`app.biowellness.ar`). Este repo:
> `recepcion.biowellness.ar`.

---

## Resumen

1. **Un turno virtual es un `Appointment` normal con tres señales**:
   `appointmentType = virtual`, la extensión `teleconsulta-sala` (`tc-<uuid>`) y
   un servicio `TELECONSULTA_*`. Se reserva, se paga, se cancela y se mueve con
   los mismos bots de hoy. **No hay flujo de reserva nuevo.**
2. **La página `/teleconsulta/:id`** llama a dos bots: `bw-teleconsulta-token`
   (la puerta: devuelve el JWT para UNA sala y UNA persona, solo dentro de la
   ventana del turno) y `bw-teleconsulta-presencia` (al entrar a la sala: avisa
   a Recepción que el paciente está en línea). Los dos ya están en su policy.
3. **La sala de espera la muestra el portal, no Jitsi.** Es una decisión de la
   Fase 0 (§3.5): el módulo de espera de Jitsi retiene a quien NO trae token, y
   en nuestro diseño el paciente también lo trae. El riesgo de que entre alguien
   más es nulo: a esa sala solo tienen token el paciente y su profesional.
4. **Los PDFs se asocian al turno desde el documento** (`context.related` →
   `Appointment`), no escribiendo el turno: su policy tiene `Appointment` de
   solo lectura y así tiene que seguir. Su subida actual cambia en dos campos.
5. **Lo que falta de nuestro lado** (§9): que `bw-reservar-turno` genere la
   sala, que el catálogo publique la modalidad, el recordatorio de 2 h con el
   link, y los dos tipos nuevos de campanita. Hasta que esté el primero, no
   existe ningún turno con sala; para que puedan arrancar igual, **les creamos
   a mano un turno virtual de prueba en staging** (§9).

---

## 0. Estado de cada pieza

| Pieza | Dónde | Estado |
| --- | --- | --- |
| `bw-teleconsulta-token` | `src/bots/teleconsulta-token.ts` | ✅ en `main`, 8 tests de rechazo + firma |
| `bw-teleconsulta-presencia` | `src/bots/teleconsulta-presencia.ts` | ✅ en `main` |
| Los dos bots en la policy "Paciente — Portal" | `src/fhir/access-policies.ts` | ✅ en `main` — ⚠️ **actualizar su espejo** `portal/docs/medplum/access-policy-paciente-portal.json` |
| Reglas (ventana, claims, avisos) | `src/lib/teleconsulta.ts` | ✅ 21 tests |
| Servicios `TELECONSULTA_MED_DALESSANDRO` (150.000) y `TELECONSULTA_MED_ALBARELLOS` (150.000) | `src/config/medicos.ts`, `catalogo.ts` | ✅ en `main` |
| Servidor `meet.biowellness.ar` con token y moderador por token | EC2 | ✅ verificado (runbook §7, pruebas 1–4) |
| `frame-ancestors` con `app.biowellness.ar` | nginx de Jitsi | ⏳ falta aplicar en el servidor |
| Deploy de los bots + Project Secrets `JITSI_*` | `npm run deploy:bots` | ⏳ |
| `bw-reservar-turno` genera la sala y marca la modalidad | `src/bots/reservar-turno.ts` | ✅ **implementado** (2026-09-17) |
| Extensión `modalidad-atencion` en la `ActivityDefinition` (`valueCode`) | `src/seed/builders.ts` | ✅ implementado — falta correr el seed |
| Recordatorio de 2 h con link + campanita `teleconsulta-lista` | `src/bots/recordatorios.ts` | ✅ implementado |
| Tipos `teleconsulta-lista` y `documento-nuevo` + títulos y destino del web push | `src/bots/_shared.ts`, `web-push.ts` | ✅ implementado |
| Cuestionario previo por especialidad (`Questionnaire`) | seed | ⏳ (este repo es el dueño de los `Questionnaire`) |
| Código `teleconsulta` en `CodeSystem/consentimiento` | `src/fhir/identifiers.ts` | ⏳ |
| Nutrición (tres servicios) | catálogo | ⏳ bloqueado: falta el nombre de la profesional |

## 1. Cómo reconocer un turno virtual

Tres señales, en este orden de confianza. **La primera es la que manda.**

```ts
const MODALIDAD = 'https://biowellness.ar/fhir/CodeSystem/modalidad-atencion';
const SALA = 'https://biowellness.ar/fhir/StructureDefinition/teleconsulta-sala';

const esVirtual = appt.appointmentType?.coding?.some(
  (c) => c.system === MODALIDAD && c.code === 'virtual',
);
const sala = appt.extension?.find((e) => e.url === SALA)?.valueString; // "tc-3f2a1b4c-…"
```

| Señal | Dónde | Para qué |
| --- | --- | --- |
| `appointmentType` = `modalidad-atencion \| virtual` | campo nativo | Pintar el badge "por videollamada" y el botón de entrar. Es el campo por el que también se busca: `Appointment?appointment-type=<system>\|virtual` |
| `extension[teleconsulta-sala]` = `tc-<uuid>` | extensión | Existe si y solo si el turno tiene sala. No hace falta usarla: el bot la lee solo. Si falta, el bot contesta "Ese turno no es una videollamada" |
| `serviceType` = `TELECONSULTA_<MED>` | campo nativo | El nombre del servicio para el texto ("Cardiología por videollamada — Dr. D'Alessandro") |

**No deducir la modalidad del nombre del servicio ni del código.** El prefijo
`TELECONSULTA_` es una convención nuestra de hoy, no un contrato.

**En la góndola**, el servicio virtual es una `ActivityDefinition` más:
`topic` es la especialidad ("Cardiología", "Endocrinología y Diabetes"), el
precio va en `precio-ars` como en toda consulta, y la duración es 60. La
extensión `modalidad-atencion` en la `ActivityDefinition` ya está definida y es
**`valueCode`** (§12, pregunta 3): se publica **solo en los servicios virtuales**
—la ausencia es `presencial`— y es la forma de mostrar el ícono de cámara en la
tarjeta. Llega al servidor con la próxima corrida del seed.

## 2. Reservar: no hay nada nuevo

El pedido entra por `bw-disponibilidad` + `bw-solicitar-turno`, igual que
cualquier consulta. Los chips salen de la agenda publicada del profesional
(`Schedule` + `Slot`), no de R-13, exactamente como ya pasa con las consultas
presenciales desde el 22-ago (`handoff-portal-turnos.md`). Un turno presencial
y uno virtual del mismo médico compiten por el mismo horario: eso lo resuelve
el `Slot`, no ustedes.

Lo que cambia es de nuestro lado y ustedes solo lo reflejan en el texto:

- **Cobro total y anticipado** (Andrés, 2026-09-16). El link de MercadoPago
  que llega por WhatsApp es por el 100 %, no la seña del 50 %. Cuando el
  webhook acredita, el turno pasa a `booked` y llega la campanita
  `reserva-confirmada` como hoy. Si en algún texto del portal dicen "seña",
  para un turno virtual va "pago de la consulta".
- **Requisitos antes de reservar.** La regla es "todo por la App": el paciente
  completa los pasos que ya existen (consentimiento general, cuestionario de
  ingreso). Hoy R-20 se aplica igual a una teleconsulta —está confirmado que
  no bloquea de más: las contraindicaciones son por categoría y ninguna toca
  `CONSULTA`— y **el consentimiento de teleconsulta** se suma como paso
  (§6). Andrés todavía no cerró si el cuestionario de ingreso se reemplaza
  por el previo de la especialidad en modalidad virtual (`teleconsulta.md`
  §10); mientras tanto, se piden los dos.

Cancelar y mover: `bw-cancelar-turno` y `bw-mover-turno`, sin cambios. Los
mismos topes (R-14, 3 movimientos).

## 3. La página `/teleconsulta/:id`

Una página por turno, a la que se llega desde Mis turnos (botón "Entrar a la
videollamada"), desde la campanita `teleconsulta-lista` y desde el deep link
del WhatsApp de 2 h. **Confirmen la ruta** (§11): el WhatsApp y el web push
la llevan escrita.

### 3.1 · El botón y la ventana

El acceso se habilita **15 minutos antes del inicio** y se corta **60 minutos
después del fin** (`TELECONSULTA.accesoAntesMin` / `accesoDespuesMin`). El
front puede calcular lo mismo para deshabilitar el botón y mostrar "Vas a poder
entrar a las 09:45", pero **la fuente de verdad es el bot**: si el reloj del
teléfono está mal, el bot igual contesta con el mensaje correcto.

Estados que habilitan el botón: `booked`, `arrived`, `checked-in`. Un turno
`proposed`/`pending` (tentativo, sin pagar) no entra y el bot lo dice.

### 3.2 · Pedir el token

```ts
type EntradaToken = {
  appointmentId: string;
  rol: 'paciente';
  pacienteRef: `Patient/${string}`;   // el perfil logueado, SIEMPRE
};

type ResultadoToken = {
  ok: boolean;
  dominio?: string;   // "meet.biowellness.ar" — armar TODO con esto, no hardcodearlo
  sala?: string;      // "tc-<uuid>"
  jwt?: string;       // HS256, vida = la ventana del turno
  venceISO?: string;  // cuándo deja de servir
  mensaje?: string;   // en castellano, para mostrar tal cual
};

const r = await medplum.executeBot(botTeleconsultaToken, {
  appointmentId, rol: 'paciente', pacienteRef: `Patient/${profile.id}`,
}) as ResultadoToken;
```

Se resuelve el bot como los otros cinco que ya llaman (`bw-cancelar-turno`,
etc.). Lo que verifica el bot, en orden: que el turno exista **y sea del
paciente** (misma respuesta para los dos casos, como `bw-cancelar-turno`), que
tenga sala, que esté confirmado, que esté en ventana. Cualquier `ok: false`
trae `mensaje`; **no hay que traducir códigos**.

| `mensaje` | Qué hacer en el portal |
| --- | --- |
| `Todavía no es la hora. Vas a poder entrar desde 15 minutos antes de tu turno.` | Botón deshabilitado con la hora |
| `Esta videollamada ya terminó. Si necesitás retomar, escribinos y coordinamos.` | Botón "Escribir a Recepción" (el chat que ya tienen) |
| `Esta videollamada no está confirmada. Escribinos y la resolvemos.` | Mostrar el link de pago si el turno sigue tentativo; si no, el chat |
| `No encontramos esa videollamada en tu cuenta.` | Volver a Mis turnos |
| `Ese turno no es una videollamada.` | No debería pasar si el botón solo aparece con `appointmentType = virtual` |
| `La videollamada no está configurada. Avisá a Recepción.` | Falta un secret del lado nuestro; el chat |

**Reglas sobre el JWT:** vive en memoria de la página, nunca en `localStorage`
ni en la URL del portal; no se muestra; **al reconectarse se pide de nuevo**
(el bot lo emite las veces que haga falta mientras dure la ventana). No hace
falta renovarlo durante la llamada: `exp` es el fin de la ventana.

### 3.3 · Montar la sala

Con el IFrame API del propio servidor. El script se carga **del dominio que
devolvió el bot**, no de `meet.jit.si`:

```html
<!-- una vez, cuando la página se monta; no en el bundle -->
<script src="https://meet.biowellness.ar/external_api.js"></script>
```

```ts
const api = new JitsiMeetExternalAPI(r.dominio, {
  roomName: r.sala,
  jwt: r.jwt,
  parentNode: contenedor,          // un div con altura fija; la sala llena el 100 %
  lang: 'es',
  configOverwrite: {
    prejoinConfig: { enabled: true },   // probar cámara y micrófono antes de entrar
    disableDeepLinking: true,           // que iOS no ofrezca la app nativa
    startWithAudioMuted: false,
    startWithVideoMuted: false,
  },
  interfaceConfigOverwrite: {
    MOBILE_APP_PROMO: false,
  },
});
```

- **No pasar `userInfo.displayName`**: el nombre lo fija el token (el nombre
  elegido de la ficha) y el servidor tiene `disableProfile`. Si lo pasan, se
  ignora igual.
- El iframe que crea la API necesita los permisos del navegador. La API los
  pone sola en el `allow` del iframe; si lo envuelven en otro iframe (no lo
  hagan), ese también tiene que llevar
  `allow="camera; microphone; display-capture; autoplay; clipboard-write"`.
- La barra de botones, el idioma, la ausencia de "grabar" y de "invitar" vienen
  del `config.js` del servidor: no hay que replicarlos.

### 3.4 · Presencia: el evento que le avisa a Recepción

```ts
api.addListener('videoConferenceJoined', async () => {
  await medplum.executeBot(botTeleconsultaPresencia, {
    appointmentId, rol: 'paciente', pacienteRef: `Patient/${profile.id}`,
  }).catch(() => undefined);   // que falle el aviso NUNCA saca al paciente de la sala
});
```

`bw-teleconsulta-presencia` mueve el turno a `arrived`, abre el `Encounter` de
la visita y, **si el profesional todavía no entró**, deja el aviso en la vista
Avisos de Recepción (con badge en tiempo real) y le manda un WhatsApp al
profesional. Es idempotente: reconectarse tres veces no genera tres avisos.

Devuelve `{ ok, estado, avisada }`. No hay que hacer nada con la respuesta.

**Solo la entrada.** No hay evento de salida en esta fase: cerrar el navegador
de golpe no dispara nada, y `videoConferenceLeft` no es confiable. La salida
real llega en la Fase 2 desde el servidor de Jitsi. Mientras tanto "en línea"
significa "entró y el turno sigue abierto", y para los avisos alcanza.

### 3.5 · La sala de espera es del portal

**Por qué.** `mod_muc_wait_for_host`, el módulo de espera de Jitsi, define
anfitrión como "cualquier sesión con token JWT". Está hecho para instalaciones
donde el médico tiene token y los invitados entran sin nada. Acá los dos tienen
token, así que el paciente cuenta como anfitrión y nunca queda retenido. No es
un bug de configuración: el módulo distingue *con token* de *sin token*, y lo
que necesitamos distinguir es *dueño* de *miembro* (runbook §4.4).

**Qué hace el portal.** Mientras el profesional no entró, un panel propio
**sobre** el video (el video sigue montado debajo: así el paciente ya pasó por
la pantalla previa y tiene cámara y micrófono probados):

> **Ya estás en la sala.**
> El Dr. D'Alessandro se va a conectar en un momento. Dejá esta pantalla
> abierta; cuando entre, la vas a ver acá mismo.
> *Si pasan más de 10 minutos, Recepción ya está avisada y te escribe.*

**Cómo saber que entró.** Solo dos personas tienen token para esa sala, así que
"hay otro participante" **es** "entró el profesional":

```ts
let solo = api.getNumberOfParticipants() <= 1;      // incluye al local

api.addListener('participantJoined', () => { solo = false; ocultarPanel(); });
api.addListener('participantLeft', () => {
  if (api.getNumberOfParticipants() <= 1) { solo = true; mostrarPanel('El profesional se desconectó. Esperá un momento: si se cayó su conexión, vuelve a entrar.'); }
});
```

Evaluar `getNumberOfParticipants()` también **justo después** de
`videoConferenceJoined`: si el profesional entró primero, no va a haber
`participantJoined` para él.

**No temporizar nada del lado del portal.** Recepción se entera del paciente
solo a los 0 minutos (por el evento de presencia) y de la ausencia del
profesional a los 5 (`bw-teleconsulta-vigilante`); los llamados salen de ahí.
El "más de 10 minutos" del texto es informativo.

### 3.6 · Salir y volver

```ts
api.addListener('readyToClose', () => { api.dispose(); volverAMisTurnos(); });
```

Si la llamada se cae, el paciente vuelve a Mis turnos y **el mismo botón lo
vuelve a meter**: token nuevo, misma sala, mismo `Encounter`. No hay que
guardar nada entre una entrada y otra.

Al desmontar la página: `api.dispose()`. Sin eso, el micrófono queda abierto.

### 3.7 · iPhone dentro de la PWA

Es la prueba 7 de la Fase 0 y **todavía no está hecha** (runbook §7). Lo que
sabemos: `getUserMedia` dentro de un iframe en Safari funciona si el iframe
lleva el `allow` y el gesto viene del usuario (por eso la pantalla previa con
su botón "Unirse" es lo que destraba el permiso, no el montado automático).

**Fallback, si la prueba falla:** el botón abre una pestaña nueva con
`https://${r.dominio}/${r.sala}?jwt=${r.jwt}#config.prejoinConfig.enabled=true`.
Es la misma sala con el mismo token; se pierde el panel de espera y el evento
de presencia se dispara **antes** de abrir la pestaña (llamando al bot al
click). Lo dejamos como plan B, no como diseño.

## 4. Información previa: PDFs asociados al turno

"Mis estudios" ya sube PDFs como `DocumentReference` con su `Consent`
`procesamiento-datos-salud`. **Cambian dos campos y se agrega una opción.**

```jsonc
{
  "resourceType": "DocumentReference",
  "status": "current",
  "subject": { "reference": "Patient/…" },
  "date": "2026-09-20T14:02:00Z",
  "category": [{ "coding": [{
    "system": "https://biowellness.ar/fhir/CodeSystem/documento-paciente",
    "code": "laboratorio"                       // NUEVO · qué es
  }] }],
  "context": { "related": [{ "reference": "Appointment/<id>" }] },   // NUEVO · para qué turno
  "content": [{ "attachment": { "contentType": "application/pdf", "url": "Binary/…", "title": "Laboratorio 18-09" } }]
}
```

| `category.code` | Qué es | Quién lo escribe |
| --- | --- | --- |
| `laboratorio` | Análisis de sangre, orina, etc. | Paciente |
| `imagenes` | **El informe** de la ecografía, la RMN, la placa (PDF o foto). El estudio DICOM completo no, en esta fase: Medplum no lo modela y el API limita los uploads a **20 MB** | Paciente |
| `informe-previo` | Una derivación, el resumen de otro médico, una receta vigente | Paciente |
| `informe-consulta` | El informe que deja el profesional después | Dashboard — el portal solo lo **muestra** |

- **La opción en la UI:** al subir, "¿Es para un turno?" con los turnos
  próximos por videollamada (los `booked` con `appointmentType = virtual`).
  Se puede subir sin turno (queda en la historia, sin `related`) y se puede
  subir después del turno (el Dashboard lo enruta igual). Lo ideal es antes.
- **`type` (LOINC) es opcional** y no lo lee nadie del lado nuestro: lo que
  enruta es `category`. Si ya ponen un LOINC, déjenlo.
- **La doble `category` que propusieron va bien** (§12, pregunta 3): dejen la
  suya (`CodeSystem/documento`, que rutea al agente de archivos) y sumen la
  nuestra. Nada de nuestro lado busca por `category`: el conteo y el ruteo van
  por `related`. Lo único que mira la categoría es la exclusión del informe del
  profesional, que ustedes no escriben.
- **No escriban `Appointment.supportingInformation`.** No pueden (su policy
  tiene `Appointment` de solo lectura) y no hace falta: el vínculo vive en el
  documento. Recepción cuenta los adjuntos del turno con `bw-estado-teleconsulta`
  buscando `DocumentReference?related=Appointment/<id>` (**ya implementado**), y
  el Dashboard los lee con la misma búsqueda. Recepción ve **cuántos** hay,
  nunca cuáles.
- El `Consent` `procesamiento-datos-salud` sigue igual, uno por documento.

**Un estudio mandado por WhatsApp** hoy queda en el hilo de Mensajes y
Recepción lo ve. La auto-respuesta va a contestar "subilo en tu portal, en Mis
estudios". No requiere nada del portal, pero explica por qué la opción de
asociar al turno tiene que ser fácil de encontrar.

## 5. Cuestionario previo por especialidad

Un `Questionnaire` por especialidad, publicado por el seed de este repo
(**todavía no existe**, §9). Se completa **una vez por paciente y especialidad**,
no por turno; la última respuesta es la que vale para el profesional.

| | |
| --- | --- |
| Cómo encontrarlo | `Questionnaire?url=https://biowellness.ar/Questionnaire/previo-<especialidad>` con `<especialidad>` ∈ `cardiologia` · `endocrinologia` · `nutricion` (los códigos de `CodeSystem/especialidad`) |
| Qué especialidad pide el turno | Del `Practitioner` del turno: `PractitionerRole?practitioner=<id>` → `specialty.coding[system=CodeSystem/especialidad].code`. Hasta que el `PractitionerRole` esté cargado para los nuevos, el texto del `topic` del servicio coincide con `ESPECIALIDADES` |
| Cómo se responde | `QuestionnaireResponse` con `questionnaire` = esa URL, `subject` = paciente, `status = completed`. Mismo mecanismo que el cuestionario de ingreso; ya pueden escribirlas |
| Cuándo pedirlo | Después de pagar y antes del turno: en la confirmación, y de nuevo en el recordatorio de 48 h si sigue sin responder |
| "Ya lo completó" | `QuestionnaireResponse?subject=Patient/<id>&questionnaire=<url>&status=completed&_sort=-authored&_count=1` |

Si más adelante hace falta atar una respuesta a **un** turno (una revisión
previa distinta por consulta), definimos una extensión de nuestro lado antes de
que la escriban; no la inventen.

## 6. Consentimiento de teleconsulta

Mismo mecanismo que el consentimiento general
([`handoff-portal-consentimiento.md`](handoff-portal-consentimiento.md)):
`DocumentReference` con el texto firmado + `Consent` que lo referencia por
`sourceReference`, con la diferencia en un solo campo:

```jsonc
"policyRule": { "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/consentimiento", "code": "teleconsulta" }] }
```

- **Una vez**, no por turno. Vigente mientras esté `active`.
- **Cuándo:** como paso previo a la primera solicitud de un turno virtual (el
  botón "Reservar" de un servicio virtual lleva primero al consentimiento si
  no hay uno `active`). Del lado del servidor no se valida todavía (§9); el
  portal es la barrera en el piloto.
- **El texto** lo escribe el Director Médico; no está. Cuando esté, el código
  `teleconsulta` entra en `COD_CONSENTIMIENTO` de nuestro lado el mismo día.

## 7. Notificaciones nuevas

Dos códigos más en `https://biowellness.ar/fhir/CodeSystem/notificacion`, con
la misma `Communication` de siempre (`status = in-progress` hasta que la abren):

| `category.code` | Cuándo | `about` | A dónde lleva el tap |
| --- | --- | --- | --- |
| `teleconsulta-lista` | 2 h antes del turno virtual, junto con el WhatsApp | `Appointment/<id>` | `/teleconsulta/<id>` |
| `documento-nuevo` | El profesional dejó un informe, una orden o una receta | `DocumentReference/<id>` · `ServiceRequest/<id>` · `MedicationRequest/<id>` | La pantalla donde muestran cada uno hoy |

Del lado del portal: sumar los dos códigos al tipo que tienen, el título y el
destino. `bw-web-push` (nuestro) va a mandar el push con el mismo destino,
así que **la ruta tiene que ser la misma** en los dos repos (§11).

**Los dos emisores son nuestros y faltan** (§9). Ninguna de las dos
notificaciones lleva contenido clínico: "Tenés novedades de tu consulta", nunca
"Tu laboratorio dio…".

## 8. Lo que el paciente ve y lo que no

Nada nuevo respecto de hoy: ve lo suyo. Lo que sí cambia es lo que **Recepción**
deja de ver: los PDFs y el cuestionario previo no están en su policy, y la
señal que le llega es "adjuntó 2 documentos". Si un paciente pregunta por chat
"¿vieron mi laboratorio?", Recepción puede contestar "lo tiene el médico" sin
haberlo abierto. Eso es a propósito (principio 3 de `CLAUDE.md`).

## 9. Lo que falta de nuestro lado

Los cinco primeros de la lista original están **implementados** (2026-09-17) y
esperan deploy. Lo que queda:

| # | Qué | Quién destraba |
| --- | --- | --- |
| 1 | `npm run deploy:bots` + Project Secrets `JITSI_BASE_URL` (el **host pelado**: `meet.biowellness.ar`), `JITSI_APP_ID` y `JITSI_JWT_SECRET` | Nosotros |
| 2 | `frame-ancestors 'self' https://app.biowellness.ar https://dashboard.biowellness.ar` en el nginx de `meet.biowellness.ar` | Nosotros |
| 3 | `Questionnaire` previo por especialidad · código `teleconsulta` en `COD_CONSENTIMIENTO` | Esperan textos del Director Médico y de cada especialista |
| 4 | Emisor de `documento-nuevo` (bot por `Subscription` sobre lo que escribe el Dashboard) | Nosotros, después del primer cierre real |

**El turno de prueba ya no hay que pedirlo**: hay un seed que lo crea.

```bash
npm run seed:prueba-teleconsulta
```

Deja un turno **`booked`** (pagado y confirmado) del paciente de prueba con el
Dr. D'Alessandro, con `appointmentType`, sala `tc-<uuid>` y los dos
`participant`, e imprime el `appointmentId`, el `pacienteRef` y la URL de la
página. **El turno empieza 10 minutos después de correrlo**, a propósito: con
la ventana de acceso cerrada el botón no se habilita y parece roto. Volver a
correrlo borra el anterior y crea uno nuevo con otra sala.

Si tienen un paciente de prueba **con login al portal** (el nuestro no tiene
usuario, así que no sirve para probar la página), pásennos su id y lo usamos:
`PRUEBA_TELECONSULTA_PATIENT_ID=<id> npm run seed:prueba-teleconsulta`.

## 10. Checklist de aceptación (de su lado)

- [ ] Un turno con `appointmentType = virtual` muestra el badge y el botón; uno presencial no.
- [ ] Antes de T−15 el botón está deshabilitado con la hora; a T−15 pide token y entra.
- [ ] Al entrar, el turno pasa a `arrived` (lo ven en Mis turnos) y Recepción recibe el aviso.
- [ ] Panel de espera visible con la sala vacía; desaparece al entrar el profesional; vuelve si se desconecta.
- [ ] Cerrar la pestaña y volver a entrar: mismo turno, sin aviso duplicado.
- [ ] T+61 desde el fin: el bot rechaza con "ya terminó" y el botón lleva al chat.
- [ ] Turno de otro paciente por URL: "No encontramos esa videollamada en tu cuenta".
- [ ] `api.dispose()` al salir de la página: el micrófono se apaga.
- [ ] Subir un PDF con `category` y `related`; el Dashboard lo ve en el turno; Recepción ve "1 adjunto".
- [ ] El espejo de la policy en `portal/docs/medplum/` está actualizado con los dos bots.

## 11. Preguntas para el portal

**Contestadas las cuatro** (respuesta del portal, 2026-09-17): la ruta es
`/teleconsulta/:id` y ya está fijada en el código (`rutaTeleconsulta`); la
prueba de iPhone se hace con el turno del seed; "Mis estudios" ya escribe
`category` con un sistema propio (ver §12); y el turno de prueba ahora lo crea
un seed (§9).

Queda **una sola pregunta abierta**, chica pero concreta:

- **¿Cuál es la ruta de "Estudios"?** El web push de `documento-nuevo` necesita
  a dónde mandar el tap. Hoy `urlDestino` lo manda a la raíz (`/`) porque
  adivinar una ruta que no existe sería peor: un push que abre un 404 es peor
  que uno que abre el inicio. Con la ruta, es un renglón.

## 12. Respuestas a las preguntas del portal (2026-09-17)

### 1 · La góndola: la teleconsulta va en Servicios (decidido por Andrés)

De nuestro lado ya está: el servicio virtual se publica con `topic` = la
**especialidad** ("Cardiología", "Endocrinología y Diabetes"), `orden: 15`
—después del Chequeo y las consultas presenciales— y su propia `description` en
voz de paciente. El filtro `/consulta/i` y el CTA son de ustedes.

Una advertencia sobre ese filtro: el problema no es solo que `TELECONSULTA_MED_*`
contenga la palabra `CONSULTA`. **Filtrar por el texto del código es el bug**, y
va a volver a morder con el próximo código que agreguemos. Los códigos son
identificadores opacos: lo que distingue a una consulta con médico es que el
servicio tiene `practitionerCodigo`, y eso viaja al portal. Si prefieren no
depender de eso, la extensión `modalidad-atencion` sirve para el ícono pero no
para esta decisión.

### 2 · Elegir la modalidad al reservar: **sí, el código es la única diferencia**

Confirmado leyendo el camino completo, no de memoria. `bw-solicitar-turno`
recibe la misma `SolicitudTurno` de siempre y lo único que hace con el código es
`getServicio(terapiaCodigo)` y pasárselo a `chequearHorarioDisponible`, que
**bifurca por `servicio.practitionerCodigo`** — no por la modalidad ni por la
categoría. Como `CONSULTA_MED_X` y `TELECONSULTA_MED_X` tienen el **mismo**
`practitionerCodigo`, los dos se validan contra la misma agenda publicada
(`Schedule SCH_MED_X` + sus `Slot` libres).

Eso tiene una consecuencia que conviene que conozcan, porque es la que hace que
el selector funcione: **la grilla de horarios es la misma para las dos
modalidades**. Un médico publica UNA agenda; si a las 10:00 ya tiene una consulta
presencial, ese horario tampoco está para una virtual. Es a propósito —el médico
es el cuello de botella, no la sala— y es lo que evita que se duplique.

Así que el selector "Presencial / Por videollamada" puede cambiar solo el
`terapiaCodigo` **sin volver a pedir la grilla**. Lo que sí cambia es el precio
(150.000 vs 120.000 en cardiología) y la duración (60 min la virtual), que ya
vienen en la `ActivityDefinition` de cada uno.

### 3 · La extensión `modalidad-atencion`: **`valueCode`**

`https://biowellness.ar/fhir/StructureDefinition/modalidad-atencion`,
**`valueCode`**, valores `presencial` | `virtual` (lista cerrada). Es el mismo
criterio que `regla-pricing`, `split` y `tipo-contrato`: lista acotada → `code`.

```ts
const MODALIDAD_EXT = 'https://biowellness.ar/fhir/StructureDefinition/modalidad-atencion';
const esVirtual = ad.extension?.find((e) => e.url === MODALIDAD_EXT)?.valueCode === 'virtual';
```

**Solo se publica en los servicios virtuales.** La ausencia es `presencial`:
escribirla en los 40 servicios del catálogo no agregaría información y obligaría
a un `seed` completo para nada.

Sobre la doble `category` de "Mis estudios": **adelante**. No tocamos
`CodeSystem/documento` ni sus códigos, y nada nuestro busca por `category` —
`bw-estado-teleconsulta` y el Dashboard van por `related`. Lo único que mira la
categoría es que el conteo de Recepción **excluye `informe-consulta`** (el
informe que deja el profesional no es "el paciente adjuntó algo").

### 4 · `informe-consulta` sin pantalla

De acuerdo con dejarlo para el Hito 2 y que mientras tanto `documento-nuevo`
lleve a Estudios. Nuestro emisor todavía no existe (§9), así que no van a
recibir notificaciones de este tipo hasta que el Dashboard empiece a escribir
informes: no hay apuro.

### 5 · El copy de "seña"

Tenían razón en que no hay nada que cambiar del lado del portal, y **lo de
nuestro lado ya está hecho**: para un turno virtual, el WhatsApp de reserva dice
*"aboná la consulta ($150.000)"* y el de confirmación *"Recibimos el pago de
$150.000"*, sin la palabra "seña" y sin mencionar saldo. El Invoice se emite con
`es-sena = false` y **no se crea el Invoice de saldo**, así que el turno tampoco
aparece en "Pagos pendientes". Si en algún momento muestran el link de pago
dentro de la app, el concepto que van a ver es *"Consulta por videollamada · …"*.



1. **La ruta.** ¿`/teleconsulta/:id` les sirve, o la página vive dentro de la
   del turno? El WhatsApp de 2 h y el web push la llevan escrita.
2. **La prueba en iPhone PWA** (§3.7) la hacemos juntos: necesitamos su build
   con el iframe montado para probar el permiso de cámara.
3. **"Mis estudios"**: ¿la subida actual ya escribe `category`? Si sí, con qué
   sistema, para no pisarlo.
4. **Cuándo** les creamos el turno de prueba en staging (§9).
