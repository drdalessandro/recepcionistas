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
| `precios` | "cuánto sale", "precio", "tarifa" | Links a la lista publicada. |
| `horario-ubicacion` | "horarios", "dónde están", "cómo llego" | Dirección + mapa + **el horario real de `horario.ts`**: si Andrés cambia el horario, el mensaje cambia solo. |
| `generico` | Todo lo demás | Acuse de recibo: saluda, dice **cuándo** le responde una persona (según esté abierto o cerrado) y menciona su próximo turno si lo tiene. |

Lo que no cae en ninguna es `generico`. **No adivinar es una decisión de diseño.**

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

También reciben acuse (pidiéndoles nombre y apellido para darlos de alta), y el
aviso en **Avisos** sigue funcionando igual que antes. Como no tienen hilo donde
dejar la marca, la anti-repetición mira los avisos previos del mismo teléfono.

## Qué tocar para cambiar algo

Todo en `src/config/auto-respuesta.ts`, sin tocar lógica:

| Perilla | Qué cambia |
| --- | --- |
| `LINKS_PRECIOS` | Los links de la lista de precios. ⚠️ **Completar** con las URLs reales de terapias, paquetes y membresías: hoy solo está confirmada la de combos. |
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
- **Nivel 4 — el agente propone la acción**, no solo el texto: «quiere mover el
  turno del jueves» → botón *[Reagendar al viernes 15:00]*. Requiere los números
  del Nivel 3 primero.
