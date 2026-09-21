# WhatsApp en producción — plantillas de Meta (Twilio Content API)

Número productivo: **+54 9 11 7250-9550** (desde 2026-08-12; antes 6247-0002 —
al cambiar de sender hay que re-verificar: Project Secret `TWILIO_WHATSAPP_FROM`,
webhook de entrada del número nuevo apuntando a `bw-whatsapp-entrante`, y estado
de aprobación de las plantillas sobre el sender nuevo con `npm run whatsapp:plantilla`).
Fuera de la ventana de 24 h (desde el
último mensaje del cliente), WhatsApp solo permite mensajes iniciados por el
negocio si usan una **plantilla aprobada por Meta**. En Twilio, cada plantilla
aprobada tiene un **Content SID** (`HX...`).

## Cómo decide el sistema qué mandar

`enviarWhatsApp` (todos los bots) resuelve en este orden:

1. **Plantilla específica**: si existe el Project Secret `TWILIO_CONTENT_SID_<PLANTILLA>`
   → manda `ContentSid` + variables estructuradas.
2. **Plantilla genérica**: si existe `TWILIO_CONTENT_SID_GENERICO`
   → manda esa plantilla con `{{1}}` = el texto completo del mensaje.
3. **Texto libre**: sin plantillas cargadas (sandbox, o dentro de la ventana de 24 h).

Esto permite salir a producción con **una sola plantilla aprobada** (la genérica)
y después ir migrando a las específicas sin tocar código: cada `HX...` que se
carga como secret se activa solo.

## Setup (una vez)

1. Registrar el número como WhatsApp sender: Twilio → Messaging → Senders →
   WhatsApp senders (requiere verificación del negocio en Meta).
2. Actualizar el Project Secret `TWILIO_WHATSAPP_FROM` → `+5491172509550`.
3. Crear las plantillas en Twilio → Messaging → Content Template Builder
   (tipo *Text*), enviarlas a aprobación de WhatsApp, y cargar cada `HX...`
   como Project Secret con el nombre indicado abajo.

## Catálogo de plantillas

## Estado verificado — 2026-08-14 ✅

`npm run whatsapp:plantilla` devuelve **10 plantillas, todas `approved`** por Meta
en `es_AR`, con los placeholders numéricos validados. O sea: el pendiente de
"aprobar las plantillas para producción" **está cerrado**.

| Nuestro `template` | Plantilla aprobada en Twilio |
|---|---|
| `recordatorio-48h` | `biowellness_recordatorio_48h_v4` |
| `recordatorio-2h` | `biowellness_recordatorio_2h_v4` |
| `turno-confirmado` | `biowellness_turno_confirmado_v4` (⚠️ existe también `_v3`, duplicada) |
| `reserva-plan` | `biowellness_reserva_plan_v4` |
| `tentativa-vencida` | `biowellness_tentativa_vencida_v3` |
| `plan-link-pago` | `biowellness_plan_link_pago_v3` |
| `sena-recordatorio` | `biowellness_sena_recordatorio_v3` |
| `mensaje-recepcion` | `biowellness_mensaje_recepcion_v4` |
| *(genérica)* | `biowellness_generico_v4` |

Los demás `template` del código (`reserva-tentativa`, `lista-espera-hueco`,
`invitacion-portal`, `plan-asignado`, `membresia-*`, `solicitud-turno`) **no
tienen plantilla propia y no la necesitan**: viajan por la genérica, que también
está aprobada. Los dos primeros por decisión explícita (ver la tabla de abajo).

> **El `Hola:` de la genérica se queda** (José y Andrés, 2026-09-21). Andrés
> pidió sacarlo el 20-09 —en pantalla queda "Hola: Reservamos tu turno de…", que
> es raro— y **no se puede**: Meta no acepta un cuerpo que EMPIECE con una
> variable (`2388299`), así que algo tiene que ir delante del `{{1}}`. No es que
> Meta pida la palabra "Hola": pide texto fijo, y el texto fijo que hay es ese.
> Cambiarlo cuesta una v5 a aprobación, con el nombre **quemado aunque la
> rechacen**, y arriesga la genérica, que es la que habilita todo lo que sale
> fuera de la ventana de 24 h. Si alguna vez se retoma: hay que sacar también el
> "Biowellness:" que escriben los cuerpos de los bots, o aparecería dos veces.

> **Aprobada ≠ en uso.** Que Meta la haya aprobado no alcanza: su `HX…` tiene que
> estar cargado como Project Secret. Cómo saberlo sin entrar a Medplum: mirar el
> texto entregado en `npm run whatsapp:entregas`. La genérica **prefija `Hola: `**;
> si el mensaje entregado NO empieza con eso, salió por la plantilla específica.
> Verificado así el 2026-08-14 para `recordatorio-48h`, `turno-confirmado` y
> `tentativa-vencida` (entregados sin el prefijo → secret cargado).

> **Los cuerpos "sugeridos" de las tablas de abajo no son los aprobados.** Los
> reales no llevan el prefijo "Biowellness:" ni el 💚 — p. ej. `recordatorio-48h`
> quedó como *"Te recordamos tu turno de {{1}} el {{2}}. ¡Te esperamos!"*. La
> fuente de verdad es `npm run whatsapp:plantilla`, no esta doc.

**Primera y prioritaria — la genérica** (habilita TODO mientras se aprueban las demás):

| Secret | Cuerpo sugerido |
|---|---|
| `TWILIO_CONTENT_SID_GENERICO` | `Biowellness San Isidro: {{1}} Cualquier duda, escribinos por acá. 💚` |

**Específicas con variables estructuradas** (los bots ya mandan estas variables):

| Plantilla (bot) | Secret | Cuerpo sugerido | Variables |
|---|---|---|---|
| `reserva-tentativa` | **NINGUNO — no crear.** | Viaja por la plantilla **genérica** aprobada (`{{1}}` = cuerpo entero). Tras **10 rechazos** de Meta (familia `reserva_tentativa_*` v3→v9 + `biowellness_sena_pendiente`, "Unknown rejection reason"), se decidió (2026-08-09) no pedirle más plantilla propia: el clasificador penaliza cuerpos parecidos a rechazados previos **y** a aprobados existentes (`sena_recordatorio_v3` ya dice monto + link + deadline). ⚠️ El secret `TWILIO_CONTENT_SID_RESERVA_TENTATIVA` **no debe existir** en Medplum: un SID rechazado ahí rompe el envío. Borrar también `biowellness_sena_pendiente` del Twilio Console. | — (el bot arma el cuerpo completo) |
| `sena-recordatorio` | `TWILIO_CONTENT_SID_SENA_RECORDATORIO` | `Biowellness: ¡último aviso! Tu reserva de {{1}} ({{2}}) se libera a las {{3}} si no abonás la seña de {{4}}. Pagala acá: {{5}} y quedás confirmado. 💚` | 1 servicio · 2 fecha/hora · 3 hora límite · 4 monto · 5 link MP |
| `tentativa-vencida` | `TWILIO_CONTENT_SID_TENTATIVA_VENCIDA` | `Biowellness: tu reserva de {{1}} del {{2}} se liberó porque no llegó la seña a tiempo. Si todavía querés venir, escribinos por acá y buscamos otro horario. 💚` | 1 servicio · 2 fecha/hora |
| `lista-espera-hueco` | **NINGUNO por ahora.** | Viaja por la **genérica** (`{{1}}` = cuerpo entero): *"Biowellness: se liberó un lugar de X el martes 18/08 a las 17:00. Estabas en la lista de espera: respondé este mensaje y te lo reservamos…"*. Lo manda Recepción desde **Avisos**, y el front no tiene forma de pasar variables estructuradas (`bw-enviar-whatsapp` solo recibe `body`): un secret específico con 2 variables recibiría una sola y sería rechazado. Si algún día se quiere plantilla propia, primero hay que pasarle las variables al bot. | — (el aviso arma el cuerpo completo) |
| `saldo-link` | `TWILIO_CONTENT_SID_SALDO_LINK` (opcional) | `Te quedó pendiente el saldo de tu turno de {{1}} del {{2}}: {{3}}. Podés abonarlo acá: {{4}} o en recepción el día de la sesión.` — mientras Meta no la apruebe sale por la **genérica**: el bot manda cuerpo **y** variables, así que cargar el secret la activa sin tocar código. Modelada sobre `plan-link-pago`, que Meta sí aprobó con link adentro. | 1 servicio · 2 fecha/hora · 3 monto · 4 link MP |
| `plan-link-pago` | `TWILIO_CONTENT_SID_PLAN_LINK_PAGO` | `Biowellness: ¡reservamos tu {{1}}! Para activarla aboná {{2}} en este enlace: {{3}} — cuando se acredite el pago te confirmamos por acá. 💚` | 1 plan · 2 monto · 3 link MP (alta de plan con MP) |
| `reserva-plan` | `TWILIO_CONTENT_SID_RESERVA_PLAN` | `Biowellness: ¡tu turno de {{1}} quedó confirmado con tu plan para el {{2}}! Te quedan {{3}} sesiones. ¡Te esperamos! 💚` | 1 servicio · 2 fecha/hora · 3 sesiones restantes |
| `turno-confirmado` | `TWILIO_CONTENT_SID_TURNO_CONFIRMADO` | `Biowellness: ¡tu turno quedó confirmado! {{1}}. Recibimos la seña de {{2}}. Saldo restante: {{3}}. ¡Te esperamos! 💚` | 1 turno · 2 seña (con $) · 3 saldo o "sin saldo pendiente" |
| `recordatorio-48h` | `TWILIO_CONTENT_SID_RECORDATORIO_48H` | `Biowellness: te recordamos tu turno de {{1}} el {{2}}. ¡Te esperamos! 💚` | 1 servicio · 2 fecha/hora |
| `recordatorio-2h` | `TWILIO_CONTENT_SID_RECORDATORIO_2H` | `Biowellness: ¡tu turno de {{1}} es hoy a las {{2}}! Te esperamos en un rato. 💚` | 1 servicio · 2 hora |
| `profesional-reserva` · `profesional-recordatorio-2h` · `profesional-paciente-en-linea` | **NINGUNO por ahora.** | Avisos **al profesional** (no al paciente), 2026-09-20. Van por la **genérica** con el cuerpo entero en `{{1}}`: el profesional nunca nos escribió, así que están siempre fuera de la ventana de 24 h. Si algún día se quiere plantilla propia, tiene que ser de **una sola variable**: el bot manda `body` sin `variables`. Destino: `PROFESIONAL_WHATSAPP_<código>`. | — (el bot arma el cuerpo completo) |

**Espejo de la bandeja de Mensajes** (respuestas de Recepción por WhatsApp):

| Plantilla (bot) | Secret | Cuerpo sugerido | Variables |
|---|---|---|---|
| `mensaje-recepcion` | `TWILIO_CONTENT_SID_MENSAJE_RECEPCION` | `Biowellness San Isidro: {{1}} Podés responder por acá. 💚` | 1 texto del mensaje |

**El resto** (`invitacion-portal`, `plan-asignado`, `membresia-renovada`,
`membresia-cobro-link`, `membresia-pago-rechazado`, `solicitud-turno`) usa la
genérica con el texto completo. Si más adelante conviene estructurarlas, se crea
la plantilla `{{1}}`-style con su secret `TWILIO_CONTENT_SID_<NOMBRE>` (regla:
las plantillas sin variables estructuradas en el código se crean con un único
`{{1}}` que recibe el texto completo).

> Nota Meta: los cuerpos enviados a aprobación deben coincidir con estos textos
> (los mismos que hoy van por texto libre). Si Meta rechaza la genérica por ser
> "demasiado variable", priorizar la aprobación de las 5 específicas.
>
> **Reglas de Meta que ya nos rechazaron plantillas** (por eso las plantillas se
> crean con `npm run whatsapp:crear-plantillas`, que las valida antes de crear):
> cada variable necesita un valor de **ejemplo** (`2388043`), y el cuerpo **no
> puede empezar ni terminar con una variable** (`2388299`) — por eso las
> genéricas llevan un cierre de texto fijo después de `{{1}}`. El contenido en
> Twilio es inmutable y el nombre rechazado queda tomado en Meta: cada
> corrección es una versión nueva (`_v2`, `_v3`, …) con su SID nuevo, y hay que
> **actualizar el secret** para apuntar al SID de la versión aprobada.
