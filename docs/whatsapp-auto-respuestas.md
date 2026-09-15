# Respuestas automáticas de WhatsApp

Qué contesta el sistema solo cuando un paciente escribe al WhatsApp de
Biowellness, por qué contesta *eso*, y dónde se cambia.

> **Estado:** Nivel 1 (acuse de recibo) y Nivel 2 (4 intenciones) + indicador de
> la ventana de 24 h — implementados 2026-08-21.

## La regla que ordena todo: la ventana de 24 h

Meta permite **texto libre** solo durante 24 h desde el último mensaje del
cliente. Fuera de esa ventana únicamente salen **plantillas aprobadas**.

Esto juega a favor: toda respuesta automática contesta un mensaje que el
paciente **acaba de mandar**, así que por definición cae dentro de la ventana.
**No hizo falta aprobar ninguna plantilla nueva** — se manda texto libre
(`enviarWhatsApp({ sinPlantilla: true })`).

Del otro lado del mostrador, la bandeja de **Mensajes** muestra la ventana de
cada conversación (`Ventana WhatsApp · 3 h 20 m` / `Ventana cerrada`). Antes, la
recepcionista escribía una respuesta pasadas las 24 h y se enteraba —si se
enteraba— por una notificación de error.

### Texto libre vs plantilla: por qué importa para el formato

`enviarWhatsApp` **consulta la ventana antes de mandar** y elige:

| Ventana | Qué manda | Por qué |
| --- | --- | --- |
| Abierta | **Texto libre** | Sale tal cual se escribió: con saltos de línea y sin prefijos. |
| Cerrada | Plantilla aprobada | Es lo único que Meta acepta. |

No es un detalle cosmético. Una **variable de plantilla no admite saltos de
línea** —Meta los borra— y la genérica aprobada además prefija `Hola: `. Cuando
una respuesta de tres párrafos salía por plantilla estando la ventana abierta,
al paciente le llegaba **un bloque compacto con el saludo duplicado** («Hola:
¡Hola María Adela!…»), aunque en Recepción se viera perfecta.

Dos detalles del mecanismo:

- La ventana se cuenta desde el último mensaje que el paciente mandó **por
  WhatsApp**. Un mensaje escrito desde el portal también deja una
  `Communication` suya, pero **no** abre la ventana de Meta — por eso se filtra
  por canal.
- **Autocuración en las dos direcciones**: si el texto libre resulta rechazado
  (la ventana estaba cerrada de verdad), se reintenta con plantilla; si la
  plantilla es rechazada, se reintenta como texto libre.

### Cómo escribir para un celular

En la pantalla de Recepción un párrafo largo se lee bien; en un teléfono se
convierte en un muro, y varios links seguidos en un mismo renglón se parten y no
se distingue dónde termina cada uno. Por eso el prompt del Nivel 3 pide **un
link por línea** y un renglón en blanco entre ideas — y le muestra la lista de
precios **ya formateada así**, porque el modelo copia el formato que ve.

## Los dos límites que NO se cruzan

1. **Nada clínico.** "¿Puedo hacer cámara si tengo un stent?" no lo contesta un
   bot: lo contesta el Director Médico. El sistema deriva a una persona, que es
   la respuesta correcta y no una falla.
2. **Ningún precio cotizado a mano.** La intención `precios` responde con el
   **link a la lista publicada**, que es la que se mantiene. Un número tipeado
   en el código se desactualiza y nadie se entera.

## Qué contesta

Todo vive en `src/lib/auto-respuesta.ts` (lógica pura, testeada) y
`src/config/auto-respuesta.ts` (los datos y las perillas). El bot
`bw-whatsapp-entrante` solo orquesta.

| Intención | Cuándo | Qué hace |
| --- | --- | --- |
| `comprobante-pago` | "ya pagué", "mando comprobante", o una pista de pago **con adjunto** | Acusa recibo **y deja un aviso en Avisos** para verificarlo contra MercadoPago o caja. |
| `turno-pedido` | Habla de turno **y** pide ("quiero", "necesito", "sacar"…) | Confirma que se anotó **y crea la solicitud en la bandeja de Solicitudes**, que es donde Recepción ya resuelve los pedidos. |
| `turno-consulta` | Habla de turno sin pedir ("¿a qué hora era mi turno?") | Le dice **su próximo turno real** si lo tiene. |
| `precios` | "cuánto sale", "precio", "tarifa" | Links a la lista publicada, **en escalera comercial**: Sesiones → Paquetes → Combos → Membresías → Todo el catálogo. |
| `hbot` | "cámara hiperbárica", "HBOT", "hiperbárica" — **sin** señal clínica | Las tres páginas publicadas: HBOT, Cómo funciona y la Guía HBOT. |
| `ihht` | "IHHT", "hipoxia", "hiperoxia", "hipóxico", "entrenamiento en altura" — **sin** señal clínica | Las tres páginas publicadas: IHHT, Cómo funciona y la Guía IHHT. "Intermitente" sola no alcanza. |
| `red-light` | "red light", "fotobiomodulación", "luz roja", "terapia de luz" — **sin** señal clínica | Las tres páginas publicadas: Red Light, Cómo funciona y la Guía Red Light. "Infrarrojo" a secas no alcanza: también es el sauna de Recovery. |
| `informacion` | "información", "catálogo", "cómo funciona" — **sin** señal clínica | El índice de info y Cómo funciona. |
| `horario-ubicacion` | "horarios", "dónde están", "cómo llego" | Dirección + mapa + **el horario real de `horario.ts`**: si Andrés cambia el horario, el mensaje cambia solo. |
| `generico` | Todo lo demás | Acuse de recibo: saluda, dice **cuándo** le responde una persona (según esté abierto o cerrado) y menciona su próximo turno si lo tiene. |

Lo que no cae en ninguna es `generico`. **No adivinar es una decisión de diseño.**

### El orden de los links de precios no es cosmético

`LINKS_PRECIOS` va de precio de lista a más conveniente, y eso está verificado
contra el catálogo (2026-09-14), no supuesto:

| | Descuento |
| --- | --- |
| Sesiones sueltas | 0 % (lista) |
| Paquetes | 5 % · 10 % · 15 % por volumen |
| Combos | 20 % – 22 % sobre lista |
| Membresías | 20 % – 30 % **además** del combo (`descuentoContinuidad` se acumula) |

Dos motivos para respetarlo si se toca la lista:

1. La paciente lo lee como una escalera de "lo más caro a lo más conveniente".
2. **WhatsApp arma la tarjeta de vista previa con el PRIMER link del mensaje.**
   Con Sesiones primero, la tarjeta es la puerta de entrada del catálogo; antes
   era Combos, que es el tercer escalón.

Matiz honesto: paquete y combo no son el mismo eje (paquete = N sesiones del
mismo servicio; combo = servicios distintos en una visita), así que no es
estrictamente un ranking de lo mismo. Como narrativa comercial funciona.

### Título arriba, link abajo

`listaDeLinks()` pone el título en un renglón y la URL en el siguiente. Antes
iba `· Título: https://…` en una sola línea y **en el teléfono la URL larga se
parte sola**: el renglón queda cortado al medio y la lista se lee compactada y
desordenada (Andrés, 2026-09-14, con la captura). No es preferencia estética:
es legibilidad en el dispositivo donde se lee de verdad.

### El cierre: la App en (casi) todas las respuestas

Toda respuesta automática termina con la invitación a autogestionarse desde la
App (`CTA_APP`), separada por un renglón en blanco, con el título en un renglón
y el link solo en el siguiente:

```
📱 *Autogestión en la App*
Pedí turnos, seguí tu plan y tus pagos, y escribinos. Todo en un solo lugar:
https://app.biowellness.ar
```

El título va en **negrita de WhatsApp** (`*…*`): se renderiza en texto libre,
que es lo único que manda el bot. Es lo que lo pone a la par de Web e Info en
la bienvenida (Andrés, 2026-09-14).

Tres decisiones detrás de ese bloque:

1. **Va al final, no al principio.** WhatsApp arma la tarjeta de vista previa
   con el primer link, y ese lugar es de Sesiones (precios) o de la página de
   HBOT. En las respuestas que no traen ningún link (acuse, turno, comprobante)
   la App pasa a ser el único link y **se lleva la tarjeta**, que es justo lo
   que queremos vender.
2. **Promete lo que la App hace hoy** — pedir turno, seguir el plan y los pagos,
   escribirnos — con el mismo alcance que la invitación de `lib/onboarding.ts`.
   No dice "pagás desde la App": la seña sale por link de MercadoPago, y una
   promesa que la App no cumple vuelve como reclamo en Mensajes.
3. **Se pega una sola vez, después de decidir la respuesta** (`armarAutoRespuesta`
   llama a `decidirRespuesta` y le agrega el cierre), no caso por caso: una
   intención nueva no puede olvidárselo.

Y **dos excepciones**, en `llevaCtaApp()`, que no son gusto:

- **`HUMANO`**: la persona pidió que la dejemos de contestar. Cerrar ese
  mensaje vendiéndole la App es lo contrario de lo que pidió.
- **`generico` a un número desconocido**: `CTA_APP` ya es el **segundo globo**
  de la bienvenida (ver "Números desconocidos"). El mismo bloque dos veces en
  diez segundos se lee como un error. Ojo: un *pedido de turno* de un número
  desconocido **sí** lleva el cierre, porque ahí no hay bienvenida.

Todo esto tiene test: presente y último en las demás intenciones, ausente en
las dos excepciones, y la URL es la misma `PORTAL_URL` del onboarding.

### HBOT, IHHT e información ceden ante lo clínico y ante el turno

Las tres intenciones de "folleto" van **después** de `turno-*` y de `precios`
en `detectarIntencion`, por el mismo motivo por el que `turno-pedido` le gana a
`precios`: "quiero un turno de cámara hiperbárica" es un pedido de turno, y
"cuánto sale la hipoxia" es precio. Mandar el folleto perdería la intención.

Y las tres ceden ante `RE_CLINICO`. "Cámara hiperbárica" aparece igual en
"contame de la cámara" que en **"¿puedo hacer cámara si tengo un stent?"**: la
primera se responde con el link a nuestra página, la segunda va a una persona.
Lo mismo con "¿puedo hacer IHHT con marcapasos?". El bot **enlaza material
publicado, no contesta** — es el límite 1 de acá arriba, y está cubierto por
tests.

IHHT y Red Light (2026-09-15) copian el circuito de HBOT: `LINKS_IHHT` y
`LINKS_RED_LIGHT` con la página, Cómo funciona y la guía del paciente.
`RE_IHHT` reconoce "ihht", "hipoxia", "hiperoxia", "hipóxico" y "entrenamiento
en altura"; `RE_RED_LIGHT`, "red light", "fotobiomodulación", "luz roja" y
"terapia de luz" — **no** "infrarrojo" a secas, que también es el sauna del
circuito Recovery. Si un mensaje nombra más de una terapia gana la primera de
este orden: HBOT → IHHT → Red Light (HBOT es la que más preguntan; una persona
completa después). Las URLs las pasó Andrés y **no se pudieron verificar desde
el entorno de desarrollo** (el proxy bloquea `info.biowellness.ar`): si una
diera 404, se cambia en config sin tocar lógica.

### "Estamos cerrados" dentro de una frase

Las respuestas de folleto y de precios terminan con "Si tenés dudas sobre tu
caso en particular, …" seguido de la frase de cuándo responde una persona. Una
captura de producción (2026-09-15) mostró dos cosas: a una paciente saludada
por su nombre se le pedía *"dejanos tu nombre y apellido"*, y el "Por favor"
que va después de un punto salía en minúscula porque la frase entera pasaba
por `toLowerCase()`. Ahora el pedido de nombre y apellido va **solo al número
desconocido**, y en la frase se baja **solo la primera letra**. Hay test.

### Horario: en hora de Argentina, no en UTC

El bot corre en UTC. Un viernes a las 22:30 de Argentina son las 01:30 del
sábado en UTC — una implementación ingenua diría "estamos abiertos" cuando el
centro ya cerró. `partesArgentina()` corre la fecha 3 h (offset fijo, sin DST
desde 2009), igual que el resto del repo. Hay tests para eso.

## Las tres protecciones

1. **Anti-repetición.** La *misma* intención no se contesta dos veces dentro de
   `MINUTOS_ENTRE_AUTO_RESPUESTAS` (3 h). Cinco mensajes seguidos = un acuse.
   Una intención **distinta** sí pasa: un comprobante no puede quedar mudo
   porque hace diez minutos hubo un "hola".
2. **Palabra de escape.** Si el paciente escribe **`HUMANO`** (sola), el sistema
   confirma, avisa a Recepción y **no manda nada automático por 12 h**. Que el
   paciente pueda apagar el bot es innegociable: el peor WhatsApp es el que te
   contesta solo y no te suelta.
3. **Marca de origen.** Toda respuesta automática queda en el hilo con
   `EXT.autoRespuesta` y se muestra como **🤖 Automática**. Nadie tiene que
   preguntarse si eso lo escribió una compañera, y los reportes no confunden
   bot con atención humana.

Además, la auto-respuesta **nunca rompe el flujo**: si falla, el mensaje del
paciente ya quedó guardado. Que Twilio reintente y duplique el mensaje sería
peor que no contestar.

## Números desconocidos

También reciben respuesta —**tres globos**, con `SEGUNDOS_ENTRE_MENSAJES` (3 s)
entre medio— y el aviso en **Avisos** sigue funcionando igual. Como no tienen
hilo donde dejar la marca, la anti-repetición mira los avisos previos del mismo
teléfono.

1. **Saludo** (`BIENVENIDA_SALUDO`): bajada de marca; **Web e Info destacadas**
   (emoji + título en negrita + link solo en su renglón); mapa e Instagram en
   una línea plana cada uno. El email salió: quien escribe por WhatsApp ya nos
   tiene, y era el texto que sobraba.
2. **La App** (`CTA_APP`): el mismo bloque que cierra el resto de las
   respuestas, a la par de Web e Info. Por eso `llevaCtaApp()` **no** lo vuelve
   a pegar en este caso.
3. **El pedido de datos** (`pedidoDeDatos()`): Nombre y Apellido, Email y DNI
   (opcional). Fuera de horario suma cuándo se responde y el horario real.

Cada globo arma su propia tarjeta de vista previa con su primer link: la Web en
el 1, la App en el 2.

### Por qué la pregunta va última (y por qué la pausa NO se sube)

Hasta el 2026-09-14 la pregunta iba en el **primer** globo: quien contestaba
rápido veía sus datos seguidos de dos mensajes nuestros que parecían
ignorarlos. Se evaluó subir la pausa de 3 s a 10-12 s y se descartó:

- **No entra.** La pausa corre adentro del webhook de Twilio, que corta a los
  15 s, y el bot corre en Lambda con el timeout por defecto de Medplum (10 s).
  Con 10 s por pausa el tercer globo no saldría, y tampoco correría lo que
  viene después: **el aviso a Recepción del número desconocido**. Se perdería
  justo el lead.
- **No alcanza.** Escribir nombre, apellido y email lleva 20-40 s. Ninguna
  pausa elimina el cruce; solo lo hace menos frecuente.

Con la pregunta en el **último** globo, la respuesta no puede llegar antes que
ella, a cualquier velocidad. Y si igual contestan en el medio, no pasa nada
grave: entra como mensaje nuevo, la anti-repetición lo calla (misma intención
dentro de las 3 h) y el aviso llega igual. Hay test de que la pregunta está
solo en el último globo.

## Qué tocar para cambiar algo

Todo en `src/config/auto-respuesta.ts`, sin tocar lógica:

| Perilla | Qué cambia |
| --- | --- |
| `LINKS_PRECIOS` | Los links de la lista de precios, **en orden**: el orden ES el mensaje comercial (ver abajo). |
| `LINKS_HBOT` · `LINKS_IHHT` · `LINKS_RED_LIGHT` · `LINKS_INFO` | Los links de las intenciones `hbot`, `ihht`, `red-light` e `informacion`. |
| `listaDeLinks()` | El formato: título arriba, link en su propio renglón. |
| `CTA_APP` · `APP_URL` | El cierre con la App que llevan (casi) todas las respuestas, y el segundo globo de la bienvenida. Las dos excepciones están en `llevaCtaApp()` (lógica, no perilla). |
| `BIENVENIDA_SALUDO` · `PEDIDO_DATOS` | El primer globo de la bienvenida al desconocido y los campos que se le piden en el último. |
| `SEGUNDOS_ENTRE_MENSAJES` | La pausa entre globos. **No subirla** (ver "Números desconocidos"). |
| `MINUTOS_ENTRE_AUTO_RESPUESTAS` | Cada cuánto puede repetirse la misma respuesta. |
| `MINUTOS_SILENCIO_HUMANO` | Cuánto dura el silencio que pide `HUMANO`. |
| `CENTRO_DIRECCION` | Dirección y mapa (el link se arma solo). |

Los **textos** están en `armarAutoRespuesta()`. El **horario** NO se toca acá:
sale de `src/config/horario.ts`, que es la única fuente de verdad.

## Nivel 3 — el borrador para la recepcionista

> Implementado 2026-08-21. Bot `bw-borrador-respuesta` + botón **Sugerir** en
> Mensajes.

En la bandeja, el botón **Sugerir** escribe en el campo de respuesta el borrador
de la próxima contestación. La recepcionista lo lee, lo corrige si hace falta y
lo envía. **Nada sale sin que una persona toque Enviar** — el bot es de solo
lectura: no escribe en FHIR ni manda ningún mensaje.

### Qué ve el asistente

Lo mismo que Recepción ya tiene en pantalla, reunido: nombre, próximo turno,
plan y sesiones restantes, saldo pendiente, bloqueo R-11, y la conversación
(los últimos 12 mensajes, marcando cuáles fueron automáticos).

**No ve nada clínico**: ni screening, ni contraindicaciones, ni documentos. Del
consentimiento viaja solo la señal binaria — lo mismo que muestra el banner de
Atender (CLAUDE.md, principio 3).

### Los límites, en el prompt y verificados por tests

Los mismos dos del Nivel 2, y por el mismo motivo: **nada clínico** y **ningún
precio inventado**. Que haya una persona revisando no los relaja — un borrador
plausible pero incorrecto se lee rápido y se manda.

Cuando el mensaje necesita a una persona sí o sí (consulta clínica, reclamo,
tema delicado, o no se entiende qué piden), el asistente responde
`SIN_BORRADOR: <motivo>` y la bandeja avisa **«Mejor contestalo vos»** en vez de
sugerir cualquier cosa. Ese comportamiento está en `systemBorrador()` y los
tests verifican que las prohibiciones sigan en el prompt.

También se corta un borrador desmedido (900 caracteres): en WhatsApp, un texto
larguísimo se manda sin leer.

### La métrica que decide el paso siguiente

Cada mensaje enviado desde un borrador queda marcado con `EXT.borradorUsado`:
`sin-editar` o `editado`. Con eso, dentro de unos meses se puede responder con
datos —no con intuición— qué intenciones podrían llegar a contestarse solas.

**Mientras ese número no exista, no se automatiza nada más.**

### Configuración

Un solo secret en Medplum: `ANTHROPIC_API_KEY`. Sin él, el botón avisa que está
desactivado y Recepción escribe a mano, como siempre. Modelo: `claude-opus-5`
con `effort: low` — un borrador corto de atención al cliente no necesita más.

## Lo que sigue (no implementado)

- **Quinta intención: cancelaciones** (política R-14, 24 h).
- **Respuestas rápidas de un click** en la bandeja, con los datos del paciente
  ya rellenados: útil como red si la API no responde.
- **Nivel 4 — el agente propone la acción**, no solo el texto. **Primera
  rebanada implementada (2026-09-02)**, por decisión del PO y en paralelo al
  número del Nivel 3: en la cola de **Solicitudes**, el botón *Proponer* arma la
  reserva concreta y Recepción la confirma con *Reservar* (bot
  `bw-proponer-reserva`, ver [`agente-solicitudes.md`](agente-solicitudes.md)).
  Lo que sigue dentro del Nivel 4: mover y cancelar por lenguaje natural («quiere
  mover el turno del jueves» → *[Reagendar al viernes 15:00]*), con los mismos
  límites: propone, botón, bot.
