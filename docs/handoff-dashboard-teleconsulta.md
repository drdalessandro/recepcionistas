# Handoff: Teleconsulta en el Dashboard (Panel Bio) — Iniciar consulta, la ficha previa y el cierre

> **Qué es este documento.** Lo que el Dashboard clínico tiene que construir
> para que un profesional atienda por videollamada: el botón que lo mete en la
> sala como moderador, qué tiene que tener a la vista antes de entrar, y cómo
> cierra la consulta dejando órdenes, recetas e informe donde el portal ya los
> lee. Visión completa en [`teleconsulta.md`](teleconsulta.md); infraestructura
> en [`teleconsulta-fase0.md`](teleconsulta-fase0.md).
>
> **Estado (2026-09-17, segunda revisión).** Ya se generan turnos virtuales con
> sala, y las dos entradas que faltaban en las policies de especialidad
> (`Practitioner` y `bw-estado-turno`) están puestas: **el cierre del §5.1 es el
> camino bueno desde el día uno**. Además hay un seed que les deja un turno de
> prueba listo (§7). Lo que queda es deploy nuestro y textos de terceros.
>
> Interlocutor: repo del dashboard clínico (`dashboard.biowellness.ar`, Panel
> Bio). Este repo: `recepcion.biowellness.ar`.

---

## Resumen

1. **El profesional entra a la sala con `bw-teleconsulta-token` y
   `rol: 'profesional'`**: el token sale con `affiliation: owner` y el servidor
   lo hace moderador. El paciente entra como `member` y no puede silenciarlo ni
   expulsarlo. Verificado en producción el 2026-09-16.
2. **Quién es "el profesional" lo decide el `Appointment.participant`**, no el
   input. El `Practitioner` del perfil logueado tiene que ser **el mismo
   recurso** que el seed creó con `identifier = CodeSystem/medico | MED_X`. Es
   la trampa número uno de este handoff (§1).
3. **La ficha previa sale de búsquedas que ya pueden hacer:** documentos del
   turno por `DocumentReference?related=Appointment/<id>`, cuestionario previo
   por `QuestionnaireResponse`, consentimiento por `Consent`. Nada de esto lo ve
   Recepción.
4. **Cerrar es un solo bot** (`bw-estado-turno` con `fulfilled`): cierra el
   turno y el `Encounter` juntos. Falta listarlo en su policy (§7). Órdenes,
   recetas e informe van en recursos nativos que el portal ya muestra.
5. **El aviso "agendar control" a Recepción es un `Task`** con una forma fija
   (§5.5); lo escriben ustedes, lo resuelve Recepción desde Avisos con el
   botón de reservar.

---

## 0. Estado de cada pieza

| Pieza | Estado |
| --- | --- |
| `bw-teleconsulta-token` (rol `profesional` → moderador) | ✅ en `main`, testeado (`member` vs `owner`, sala acotada, firma) |
| `bw-teleconsulta-presencia` (rol `profesional` → `checked-in`) | ✅ en `main` |
| Policies "Cardiología — Clínico limitado", "Endocrinología — Clínico limitado", "Nutrición — Clínico limitado" con `Encounter`, `DocumentReference`, `ServiceRequest`, `MedicationRequest`, `DiagnosticReport`, `Consent` (lectura), `Binary` y los dos bots | ✅ en `main` — se aplican con `npm run seed` |
| `Practitioner` de la Dra. Albarellos (endocrinología) y el Dr. Carrieri (hiperbárica) | ✅ en `main` — el `PractitionerRole` con la especialidad se asigna a mano (`docs/usuarios.md`) |
| `frame-ancestors` con `dashboard.biowellness.ar` en el nginx de Jitsi | ⏳ falta aplicar |
| Turno virtual de prueba (`npm run seed:prueba-teleconsulta`) | ✅ listo para correr (§7) |
| `bw-reservar-turno` genera la sala | ✅ **implementado** (2026-09-17) |
| `Practitioner` de lectura y `bw-estado-turno` en las policies de especialidad | ✅ implementado — se aplican con `npm run seed` |
| `Subscription` (websocket) en las policies de especialidad | ⏳ si lo piden (§2) |
| Emisor de la campanita `documento-nuevo` al paciente | ⏳ nuestro, por `Subscription` sobre lo que ustedes escriben |
| `Questionnaire` previo por especialidad | ⏳ seed, esperando textos |

## 1. Quién es el profesional (leer antes que nada)

`bw-teleconsulta-token` no confía en el `practitionerRef` que le mandan:
verifica que esa referencia sea un `participant.actor` del turno. Y el turno lo
arma `bw-reservar-turno` con **el `Practitioner` que el seed creó** para ese
médico, identificado así:

```
Practitioner?identifier=https://biowellness.ar/fhir/CodeSystem/medico|MED_DALESSANDRO
Practitioner?identifier=https://biowellness.ar/fhir/CodeSystem/medico|MED_ALBARELLOS
Practitioner?identifier=https://biowellness.ar/fhir/CodeSystem/medico|MED_CARRIERI
```

**El perfil del usuario del Dashboard (`medplum.getProfile()`) tiene que ser
ese recurso, con ese id.** Si el usuario se creó con un `Practitioner` propio
(pasa cuando se invita desde el admin sin elegir el existente), el bot va a
contestar *"No encontramos esa videollamada en tu cuenta"* para todos los
turnos del médico, y no hay nada que el Dashboard pueda hacer para
arreglarlo desde el front. Ya nos pasó con duplicados: existe
`consolidar-medicos` por eso.

Cómo verificarlo, por profesional, antes de la primera prueba:

```ts
const yo = medplum.getProfile();                 // Practitioner
const canonico = await medplum.searchOne('Practitioner',
  'identifier=https://biowellness.ar/fhir/CodeSystem/medico|MED_ALBARELLOS');
console.assert(yo?.id === canonico?.id);        // si falla, se arregla en el admin, no en código
```

**Policies.** Cada profesional entra con la de su especialidad (nombres
exactos: `Cardiología — Clínico limitado`, `Endocrinología — Clínico limitado`,
`Nutrición — Clínico limitado`). El Director Médico entra con la suya, que es
todo. La asignación es manual desde el admin, y **el seed reemplaza la policy
entera** en cada corrida: un permiso agregado a mano se pierde. Si necesitan
algo que no está, se pide acá y se agrega al código.

## 2. La agenda del profesional: reconocer un turno virtual

```
Appointment?actor=Practitioner/<id>
  &appointment-type=https://biowellness.ar/fhir/CodeSystem/modalidad-atencion|virtual
  &date=ge2026-09-20&date=le2026-09-21
  &status=booked,arrived,checked-in
```

| Señal | Dónde |
| --- | --- |
| `appointmentType.coding[system=modalidad-atencion].code === 'virtual'` | campo nativo, **la que manda** |
| `extension[url=…/StructureDefinition/teleconsulta-sala].valueString === 'tc-<uuid>'` | existe si y solo si hay sala; no hace falta usarla |
| `serviceType` = `TELECONSULTA_<MED>`, `serviceCategory` = `CONSULTA` | el nombre para el texto; la categoría no cambia, así que **el conteo de consultas del Panel sigue igual** |

Los estados del turno, que son los mismos del presencial (`arrived` = llegó,
`checked-in` = en el box):

| `status` | Qué significa en una videollamada | Quién lo pone |
| --- | --- | --- |
| `booked` | Confirmado y pagado (cobro total anticipado). Nadie entró | el webhook de MercadoPago |
| `arrived` | **El paciente está en la sala esperando** | `bw-teleconsulta-presencia`, cuando el portal dispara `videoConferenceJoined` |
| `checked-in` | El profesional entró: la consulta está en curso | `bw-teleconsulta-presencia`, con `rol: 'profesional'` |
| `fulfilled` | Cerrada | ustedes, con `bw-estado-turno` (§5.1) |
| `noshow` | El paciente no apareció | Recepción, a los 15 min, desde su modal — nunca el Dashboard |

**"Paciente en línea" en tiempo real.** La señal es el paso a `arrived`. Si
la quieren por websocket (`Subscription` con `criteria =
Appointment?actor=Practitioner/<id>`), avisen: las policies de especialidad
**no tienen `Subscription`** hoy y es un renglón nuestro. Con un refresco de
la agenda cada 30 s alcanza para el piloto, porque además el profesional
recibe el WhatsApp ("Tu paciente entró a la videollamada…") en el instante.

El `Encounter` de la visita (clase `VR`, no `AMB`) lo abre el bot de presencia
y ustedes lo pueden leer: `Encounter?appointment=Appointment/<id>`.
`period.start` es cuándo entró el paciente; `participant` con
`Practitioner/…` aparece cuando entra el profesional. **Reportes que separen
presencial de virtual: por `Encounter.class`**, no por extensiones nuestras.

## 3. Iniciar consulta

### 3.1 · El botón

Activo en la misma ventana que el paciente: **de 15 minutos antes del inicio a
60 después del fin**, con el turno en `booked`, `arrived` o `checked-in`. El
bot es la fuente de verdad; el front solo evita mostrar un botón que va a
fallar.

Si el turno está `arrived`, el botón dice **"El paciente ya está esperando —
Iniciar consulta"**: es la única diferencia de texto que importa.

### 3.2 · El token de moderador

```ts
type EntradaToken = {
  appointmentId: string;
  rol: 'profesional';
  practitionerRef: `Practitioner/${string}`;   // medplum.getProfile().id — ver §1
};

type ResultadoToken = {
  ok: boolean;
  dominio?: string;   // "meet.biowellness.ar"
  sala?: string;      // "tc-<uuid>"
  jwt?: string;       // con affiliation: owner
  venceISO?: string;
  mensaje?: string;   // en castellano; se muestra tal cual
};
```

Los rechazos posibles y qué hacer:

| `mensaje` | Causa | Qué hacer |
| --- | --- | --- |
| `No encontramos esa videollamada en tu cuenta.` | El perfil no es el `participant` del turno (§1), o el turno no existe | Revisar el perfil en el admin; no es un error de código |
| `Ese turno no es una videollamada.` | Sin extensión de sala | No mostrar el botón para turnos sin `appointmentType = virtual` |
| `Esta videollamada no está confirmada. Escribinos y la resolvemos.` | Turno tentativo o cancelado | Recepción lo resuelve |
| `Todavía no es la hora…` / `Esta videollamada ya terminó…` | Fuera de ventana | Deshabilitar el botón con la hora |
| `La videollamada no está configurada. Avisá a Recepción.` | Faltan secrets del lado nuestro | Avisarnos |

El JWT **no se guarda** (ni `localStorage` ni URL del Dashboard); se pide de
nuevo cada vez que se entra. Vence con la ventana del turno.

### 3.3 · La sala

Igual que el portal, con el IFrame API **del dominio que devuelve el bot**:

```html
<script src="https://meet.biowellness.ar/external_api.js"></script>
```

```ts
const api = new JitsiMeetExternalAPI(r.dominio, {
  roomName: r.sala,
  jwt: r.jwt,
  parentNode: contenedor,
  lang: 'es',
  configOverwrite: { prejoinConfig: { enabled: true }, disableDeepLinking: true },
  interfaceConfigOverwrite: { MOBILE_APP_PROMO: false },
});

api.addListener('videoConferenceJoined', () => {
  medplum.executeBot(botTeleconsultaPresencia, {
    appointmentId, rol: 'profesional', practitionerRef: `Practitioner/${yo.id}`,
  }).catch(() => undefined);   // best-effort: nunca saca al profesional de la sala
});

api.addListener('readyToClose', () => { api.dispose(); /* volver a la ficha */ });
```

- **No pasar `userInfo.displayName`**: el nombre visible viene del token (el
  `name[0]` del `Practitioner`). El servidor tiene `disableProfile`.
- El profesional entra como **moderador**: ve el panel de participantes con
  "silenciar" y "expulsar" para el paciente; el paciente no los ve para él. No
  hay que configurar nada más: lo decide el claim `affiliation: owner` del
  token y tres piezas del servidor (runbook §4.2).
- Si el paciente todavía no entró, la sala está vacía. Muestren su propio
  "El paciente todavía no se conectó" con `getNumberOfParticipants() <= 1` y
  `participantJoined`, igual que el portal muestra su sala de espera. **No hay
  sala de espera en Jitsi** (runbook §4.4): el módulo retiene a quien no trae
  token, y acá los dos lo traen.
- `api.dispose()` al desmontar. Sin eso el micrófono queda abierto.
- **La página tiene que estar en `dashboard.biowellness.ar`**: el nginx de
  Jitsi va a permitir embeber solo desde ahí y desde el portal
  (`frame-ancestors`). Un entorno de desarrollo en `localhost` **no va a poder
  embeber** el servidor de producción; para desarrollar, o se prueba en un
  entorno del Dashboard con ese dominio, o pedimos agregar uno de staging a la
  lista — es una línea de nginx.

### 3.4 · Si se cae

El profesional vuelve a apretar **Iniciar consulta**: token nuevo, misma sala,
mismo `Encounter`. El turno ya está `checked-in` y ahí queda. Nada que guardar.

## 4. La ficha previa (antes de entrar)

Todo con búsquedas que su policy ya permite. Nada de esto lo ve Recepción: su
policy no lista `DocumentReference` ni `QuestionnaireResponse` clínicas, y
solo recibe "adjuntó 2 documentos" de un bot que cuenta.

### 4.1 · Documentos que el paciente asoció al turno

```
DocumentReference?related=Appointment/<id>&_sort=-date
```

y los de su historia en general, por tipo:

```
DocumentReference?subject=Patient/<id>&category=https://biowellness.ar/fhir/CodeSystem/documento-paciente|laboratorio
```

| `category.code` | Qué es |
| --- | --- |
| `laboratorio` | Análisis |
| `imagenes` | **El informe** de la imagen (PDF o foto). El DICOM no, en esta fase |
| `informe-previo` | Derivación, resumen de otro médico, receta vigente |
| `informe-consulta` | Lo que ustedes dejan (§5.4). Filtrar por `author` para separar lo propio |

El PDF está en `content[0].attachment.url` (`Binary/…`); tienen `Binary` en la
policy. **El vínculo con el turno vive en el documento** (`context.related`),
no en `Appointment.supportingInformation`: el paciente no puede escribir el
turno, así que no lo busquen ahí.

### 4.2 · Cuestionario previo de la especialidad

```
QuestionnaireResponse?subject=Patient/<id>
  &questionnaire=https://biowellness.ar/Questionnaire/previo-<especialidad>
  &status=completed&_sort=-authored&_count=1
```

con `<especialidad>` ∈ `cardiologia` · `endocrinologia` · `nutricion`. Es
**uno por paciente y especialidad**, no por turno; la última respuesta es la
que vale. **Los `Questionnaire` todavía no existen** (los publica el seed de
este repo, con los textos que defina cada profesional): hasta que estén, la
sección muestra "sin cuestionario previo". Pidan la lista de preguntas a cada
especialista y nos la pasan; nosotros la publicamos.

El cuestionario de **ingreso** general (`https://biowellness.ar/Questionnaire/intake-clinico`,
con el screening de contraindicaciones) también está y también lo pueden leer,
igual que hoy.

### 4.3 · Consentimiento de teleconsulta

```
Consent?patient=Patient/<id>&status=active
```

y filtrar en cliente por `policyRule.coding[system=…/CodeSystem/consentimiento].code === 'teleconsulta'`
(no hay search param para `policyRule`; es lo mismo que hace nuestro
`bw-estado-consentimiento`). El código `teleconsulta` **se agrega de nuestro
lado cuando el Director Médico entregue el texto**; hasta entonces no hay
consentimientos de este tipo y la sección muestra "pendiente".

### 4.4 · Lo que el paciente carga solo

Vitales y medicación que el paciente carga en el portal ya son `Observation` y
lo que hoy leen; sin cambios.

## 5. Cerrar la consulta

### 5.1 · El turno y la visita, en una llamada

```ts
await medplum.executeBot(botEstadoTurno, { appointmentId, estado: 'fulfilled' });
```

`bw-estado-turno` es el mismo bot con el que el mostrador cierra un turno
presencial: pone el `Appointment` en `fulfilled`, cierra el `Encounter`
(`finished`, `period.end`) y libera el `Slot`. **Ya está en las policies de
especialidad** (2026-09-17), así que este es el camino desde el día uno: no
hace falta el rodeo de cerrar solo el `Encounter` y que Recepción cierre el
turno. Llega al servidor con la próxima corrida del seed.

No marcar `cancelled` ni `noshow` desde el Dashboard: **ambos tienen efecto
sobre plata cobrada** y son de Recepción, que puede haber hablado con el
paciente dos minutos antes.

### 5.2 · La evolución

Es de ustedes (dominio del Panel Bio). Recepción no la ve ni la va a ver.

### 5.3 · Órdenes y recetas

Recursos nativos que **el portal ya muestra** en "Mis estudios" y medicación:

- Orden de laboratorio o imagen: `ServiceRequest` con `intent = order`,
  `status = active`, `subject` = paciente, `requester` = `Practitioner/<yo>`,
  `encounter` = el `Encounter` de la visita.
- Receta: `MedicationRequest` con `intent = order`, `status = active`, ídem.

Cuando el paciente suba el resultado, su `DocumentReference` va a referenciar la
orden (`context.related` → `ServiceRequest/<id>`): así lo enrutan a su bandeja
de "resultados por revisar". Es su dominio; lo mencionamos para que la forma
coincida.

### 5.4 · El informe en PDF

```jsonc
{
  "resourceType": "DocumentReference",
  "status": "current",
  "subject": { "reference": "Patient/<id>" },
  "author": [{ "reference": "Practitioner/<yo>" }],
  "date": "2026-09-20T15:05:00Z",
  "category": [{ "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/documento-paciente", "code": "informe-consulta" }] }],
  "context": { "related": [{ "reference": "Appointment/<id>" }], "encounter": [{ "reference": "Encounter/<id>" }] },
  "content": [{ "attachment": { "contentType": "application/pdf", "url": "Binary/…", "title": "Informe de consulta 20-09" } }]
}
```

El aviso al paciente ("Tenés novedades de tu consulta", campanita
`documento-nuevo` + web push) **lo mandamos nosotros** con un bot suscripto a
estos `DocumentReference`, `ServiceRequest` y `MedicationRequest`: ustedes no
escriben `Communication` (su policy no lo tiene y no hace falta). Nunca sale
contenido clínico por WhatsApp: el paciente lo lee en el portal.

### 5.5 · "Agendar control" a Recepción

Un `Task` con esta forma exacta, que aparece en la vista **Avisos** de Recepción
con el botón de reservar. Tienen `Task` en la policy.

```jsonc
{
  "resourceType": "Task",
  "status": "requested",
  "intent": "order",
  "priority": "urgent",
  "code": { "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/task-tipo", "code": "aviso-recepcion" }],
            "text": "Agendar control de cardiología" },
  "description": "Control en 30 días, por videollamada. Paciente avisado en la consulta.",
  "authoredOn": "2026-09-20T15:10:00Z",
  "identifier": [{ "system": "https://biowellness.ar/fhir/Identifier/task", "value": "agendar-control-<appointmentId>" }],
  "for":   { "reference": "Patient/<id>" },
  "focus": { "reference": "Appointment/<id>" },
  "input": [
    { "type": { "text": "tipo" },          "valueString": "agendar-control" },
    { "type": { "text": "appointmentId" }, "valueString": "<appointmentId>" },
    { "type": { "text": "servicioCodigo" },"valueString": "TELECONSULTA_MED_DALESSANDRO" },
    { "type": { "text": "plazo" },         "valueString": "30 días" }
  ]
}
```

- `code.text` es el título que ve Recepción; `description`, el detalle. **Sin
  contenido clínico en ninguno de los dos**: "control en 30 días", no "por la
  arritmia".
- `identifier` con `agendar-control-<appointmentId>` lo hace idempotente:
  apretar dos veces no crea dos avisos (es la misma clave que usaríamos
  nosotros). Busquen antes de crear, como hace `crearAlertaRecepcion`.
- `input.servicioCodigo` es opcional y ahorra un paso: con él, el botón de
  Avisos abre Reservar con el servicio elegido.

## 6. Incidencias, desde su lado

| Situación | Qué hace el Dashboard | Quién actúa |
| --- | --- | --- |
| El paciente no entró | Nada. Recepción recibe el aviso a los 10 min y lo contacta; a los 15 puede marcar `noshow` | Recepción |
| Se cayó la llamada | El botón vuelve a meter al profesional (§3.4) | El profesional |
| El profesional no puede conectarse | Le avisa a Recepción por WhatsApp o teléfono. Recepción recibe igual el aviso `profesional-ausente` a los 5 min y reprograma con `bw-mover-turno` | Recepción |
| El paciente subió el PDF equivocado | Nada que hacer desde acá; el paciente lo reemplaza en el portal | Paciente |

**Recepción no entra nunca a la sala.** El soporte técnico es desde afuera.

## 7. Lo que falta de nuestro lado

Los tres primeros de la lista original están **implementados** (2026-09-17).
Lo que queda:

| # | Qué | Quién destraba |
| --- | --- | --- |
| 1 | `npm run deploy:bots` + Project Secrets `JITSI_*` + `npm run seed` (las policies nuevas) | Nosotros |
| 2 | `frame-ancestors` con `dashboard.biowellness.ar` —y un dominio de staging si lo piden— en el nginx de Jitsi | Nosotros + su respuesta a §9.1 |
| 3 | `Subscription` en las policies de especialidad | Solo si quieren "paciente en línea" por websocket (§2) |
| 4 | `Questionnaire` previo por especialidad; código `teleconsulta` en `COD_CONSENTIMIENTO` | Esperan las preguntas de cada especialista y el texto del Director Médico |
| 5 | Emisor de `documento-nuevo` al paciente | Nosotros, después del primer cierre real |
| 6 | `PractitionerRole` con `specialty` para Albarellos y Carrieri; usuarios del Dashboard con el perfil correcto (§1) | Manual, desde el admin: lo hacemos juntos en la primera prueba |

**El turno de prueba ya está**, y lo crea un seed:

```bash
npm run seed:prueba-teleconsulta
```

Deja un turno **`booked`** del paciente de prueba con el Dr. D'Alessandro —con
`appointmentType`, sala `tc-<uuid>` y los dos `participant`— e imprime el
`appointmentId` y el `practitionerRef` que necesitan para pedir el token de
moderador. **El turno empieza 10 minutos después de correrlo**: con la ventana
de acceso cerrada el botón no se habilita y parece roto. Volver a correrlo borra
el anterior (y su `Encounter`) y crea uno nuevo.

El `practitionerRef` que imprime es **el `Practitioner` canónico** del §1: si el
usuario del Dashboard con el que prueban apunta a otro, el bot va a rechazar el
token y ahí van a ver el problema del §1 en vivo, que es el mejor momento para
verlo.

## 8. Checklist de aceptación (de su lado)

- [ ] `getProfile().id` coincide con el `Practitioner` canónico del médico (§1), para cada profesional del piloto.
- [ ] La agenda muestra los turnos virtuales con el badge y el estado (`booked` / `arrived` / `checked-in`).
- [ ] "Iniciar consulta" deshabilitado fuera de la ventana, con la hora.
- [ ] Al entrar, el turno pasa a `checked-in` y en el panel de participantes el profesional tiene los controles de moderador sobre el paciente, y no al revés.
- [ ] Con la sala vacía se ve "El paciente todavía no se conectó"; desaparece cuando entra.
- [ ] La ficha previa lista los `DocumentReference` con `related` = el turno y abre el PDF.
- [ ] Cerrar con `bw-estado-turno` deja el turno `fulfilled` y el `Encounter` `finished`.
- [ ] Una `ServiceRequest` y una `MedicationRequest` creadas desde el cierre aparecen en el portal del paciente de prueba.
- [ ] El `Task` de control aparece en Avisos de Recepción con el botón de reservar, y apretar dos veces no lo duplica.
- [ ] `api.dispose()` al salir: el micrófono se apaga.

## 9. Preguntas para el Dashboard

1. **Dominio de desarrollo.** ¿Tienen un entorno con dominio propio para
   probar el embebido, o agregamos uno a `frame-ancestors`? Con `localhost` no
   va a cargar.
2. **Websocket o refresco** para "paciente en línea" (§2).
3. ~~**El cierre**~~: resuelto — `bw-estado-turno` ya está en sus policies, así
   que cierren con el bot directamente (§5.1).
4. **Las preguntas del cuestionario previo** de cardiología, endocrinología y
   nutrición: quién las define y cuándo, para publicarlas.
