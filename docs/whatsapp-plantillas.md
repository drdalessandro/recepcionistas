# WhatsApp en producción — plantillas de Meta (Twilio Content API)

Número productivo: **+54 9 11 6247-0002**. Fuera de la ventana de 24 h (desde el
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
2. Actualizar el Project Secret `TWILIO_WHATSAPP_FROM` → `+5491162470002`.
3. Crear las plantillas en Twilio → Messaging → Content Template Builder
   (tipo *Text*), enviarlas a aprobación de WhatsApp, y cargar cada `HX...`
   como Project Secret con el nombre indicado abajo.

## Catálogo de plantillas

**Primera y prioritaria — la genérica** (habilita TODO mientras se aprueban las demás):

| Secret | Cuerpo sugerido |
|---|---|
| `TWILIO_CONTENT_SID_GENERICO` | `BioWellness San Isidro: {{1}} Cualquier duda, escribinos por acá. 💚` |

**Específicas con variables estructuradas** (los bots ya mandan estas variables):

| Plantilla (bot) | Secret | Cuerpo sugerido | Variables |
|---|---|---|---|
| `reserva-tentativa` | `TWILIO_CONTENT_SID_RESERVA_TENTATIVA` | `BioWellness: reservamos tu turno de {{1}} para el {{2}} (tentativo). Aboná la seña del 50% para confirmarlo. 💚` | 1 servicio · 2 fecha/hora |
| `reserva-plan` | `TWILIO_CONTENT_SID_RESERVA_PLAN` | `BioWellness: ¡tu turno de {{1}} quedó confirmado con tu plan para el {{2}}! Te quedan {{3}} sesiones. ¡Te esperamos! 💚` | 1 servicio · 2 fecha/hora · 3 sesiones restantes |
| `turno-confirmado` | `TWILIO_CONTENT_SID_TURNO_CONFIRMADO` | `BioWellness: ¡tu turno quedó confirmado! {{1}}. Recibimos la seña de {{2}}. Saldo restante: {{3}}. ¡Te esperamos! 💚` | 1 turno · 2 seña (con $) · 3 saldo o "sin saldo pendiente" |
| `recordatorio-48h` | `TWILIO_CONTENT_SID_RECORDATORIO_48H` | `BioWellness: te recordamos tu turno de {{1}} el {{2}}. ¡Te esperamos! 💚` | 1 servicio · 2 fecha/hora |
| `recordatorio-2h` | `TWILIO_CONTENT_SID_RECORDATORIO_2H` | `BioWellness: ¡tu turno de {{1}} es hoy a las {{2}}! Te esperamos en un rato. 💚` | 1 servicio · 2 hora |

**Espejo de la bandeja de Mensajes** (respuestas de Recepción por WhatsApp):

| Plantilla (bot) | Secret | Cuerpo sugerido | Variables |
|---|---|---|---|
| `mensaje-recepcion` | `TWILIO_CONTENT_SID_MENSAJE_RECEPCION` | `BioWellness San Isidro: {{1}} Podés responder por acá. 💚` | 1 texto del mensaje |

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
