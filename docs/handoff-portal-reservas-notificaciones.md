# Handoff: Reservas con horarios reales + campanita de mensajes

> **Qué es este documento.** Respuesta al feedback del equipo de recepción
> (2026-08-12) que detectó dos problemas visibles en el portal: (1) la pantalla
> de Reservas ofrece horarios que ya están ocupados, y (2) los mensajes del
> chat no notifican al paciente. El (1) tiene un pedido concreto para ustedes y
> un refuerzo nuevo de nuestro lado que necesitan manejar; el (2) es enteramente
> de su lado y acá está todo lo necesario para implementarlo.
>
> Interlocutor: repo del portal del paciente (`app.biowellness.ar`). Este repo:
> `recepcion.biowellness.ar`.

---

## Resumen

1. **Reservas debe pintar EXCLUSIVAMENTE los chips de `bw-disponibilidad`.**
   El caso reportado (monoplaza reservada miércoles 9:00; otra usuaria vio
   8:30 y 9:00 como disponibles y pudo pedirlos) no puede pasar si la grilla
   sale del bot. Si hoy hay una grilla fija de horarios, ese es el bug.
2. **Nuevo desde 2026-08-12: `bw-solicitar-turno` rechaza horarios tomados.**
   Aunque la grilla esté desactualizada, el server ahora devuelve
   `ok:false, motivo:'horario-ocupado'` con chips frescos en `alternativas`.
   El portal tiene que manejar esa respuesta (¡hoy quizás la muestre como
   error genérico o la ignore!).
3. **La campanita de mensajes no requiere nada de nuestro lado**: la
   AccessPolicy del paciente YA permite `Subscription?type=websocket` y los
   mensajes del chat YA llevan `subject` = paciente. Falta solo que el portal
   se suscriba y notifique.

---

## 1. Reservas: los chips salen del bot, nunca de una grilla fija

```ts
const r = await medplum.executeBot(
  { system: 'https://biowellness.ar/fhir/identifiers/bot', value: 'bw-disponibilidad' }, // o por id
  { pacienteRef: `Patient/${profile.id}`, servicioCodigo },
);
// r = { ok, perfil, ventanaHoras, grupal, dias: [{ fecha, horarios: [{ inicio, fin, lugares?, ocupantes? }] }], mensaje? }
```

Reglas de render:

- Los horarios elegibles son **únicamente** `r.dias[].horarios[]`. Nada más.
- `r.ok === false` o excepción → mostrar "No pudimos cargar los horarios,
  probá de nuevo" y **no ofrecer nada**. Jamás caer a una grilla completa: un
  fallback optimista es exactamente el bug que reportó recepción.
- `r.mensaje` (sin opciones) → mostrarlo tal cual: ya viene redactado según la
  causa (todo pedido vs. sin horarios en su ventana).
- Multiplaza: `lugares`/`ocupantes` alimentan el "quedan N lugares · ya somos M".

**Matiz importante para no "sobre-corregir"**: un horario puede seguir
ofrecido aunque *una* sala esté ocupada — la sesión HBOT individual puede ir a
la monoplaza **o a la biplaza**, y la sala la elige Recepción al confirmar. El
chip desaparece recién cuando **todas** las salas de la categoría están
tomadas. O sea: "reservé monoplaza 9:00 y el portal sigue ofreciendo 9:00"
puede ser correcto; "pude *pedir* un horario con todo ocupado" nunca lo es
(y ahora el server también lo impide, ver §2).

## 2. Nuevo contrato de `bw-solicitar-turno`: rechazo con alternativas

Desde 2026-08-12 el bot verifica el horario pedido contra la **misma**
disponibilidad de §1 (ocupación por sala, ventana R-13, horario del centro,
solicitudes pendientes de otros pacientes) antes de crear la solicitud:

```jsonc
// Respuesta nueva posible (además de las existentes):
{
  "ok": false,
  "motivo": "horario-ocupado",
  "mensaje": "Ese horario acaba de ocuparse o ya no está disponible. Elegí otro de los horarios libres.",
  "alternativas": [ { "fecha": "2026-08-13", "horarios": [ { "inicio": "...", "fin": "..." } ] } ]
}
```

Qué hacer en el portal: mostrar `mensaje` y **re-renderizar los chips con
`alternativas`** (mismo formato que `dias` de `bw-disponibilidad` — se pueden
pintar directamente, sin re-llamar al bot). No tratarlo como error técnico.

Se aplica cuando la solicitud trae `preferenciaInicio` + `terapiaCodigo` con
código de **servicio** (ej. `HBOT_MONO`). Si mandan categoría (`HBOT`) o texto
libre, el chequeo no corre — otra razón para mandar siempre el código de
servicio que ya usan en §1.

## 3. Campanita de mensajes (chat) — todo listo de nuestro lado

Hoy el paciente ve el mensaje si entra a la conversación, pero nada le avisa.
Las confirmaciones (seña recibida, turno confirmado) "notifican" porque viajan
por WhatsApp; el chat vive en el portal y necesita su propia campanita.

Datos del contrato (verificados):

- Cada mensaje del chat es una `Communication` **hija** (con `partOf` al hilo)
  y lleva `subject` y `recipient` = el paciente. El hilo (topic) no tiene
  `partOf` y lleva el asunto en `topic.text`.
- La AccessPolicy "Paciente — Portal" **ya permite** `Subscription?type=websocket`
  y ya acota `Communication` por `subject=%patient`. No hay nada que pedirnos.

Patrón (el mismo que usa la app de recepción, componente `CampanitaNovedades`
en `app/src/components/`, disponible como referencia):

```tsx
useSubscription(
  `Communication?subject=Patient/${profile.id}&part-of:missing=false`,
  (bundle) => {
    /* mensaje nuevo → badge + toast/push local; ignorar los enviados por el
       propio paciente (sender === perfil) */
  },
);
```

Detalles que importan:

- Filtrar `part-of:missing=false` para escuchar mensajes, no hilos.
- Al abrir la conversación, setear `received` en los mensajes ajenos:
  recepción usa ese campo como tilde de "leído".
- WebSocket se cae en mobile al backgroundear: refrescar el contador al volver
  a foco (nuestra campanita hace polling de respaldo cada 60 s).

## 4. Resumen para su backlog

1. Reservas: chips **solo** de `bw-disponibilidad`; sin fallback a grilla fija
   ante error (§1).
2. Manejar `motivo:'horario-ocupado'` de `bw-solicitar-turno`: mensaje +
   re-render con `alternativas` (§2).
3. Campanita: `useSubscription` sobre `Communication?subject=Patient/<id>` +
   badge + `received` al leer (§3). Policy ya habilitada.
4. Mandar siempre `terapiaCodigo` = código de **servicio** en las solicitudes
   (habilita el rechazo server-side y mejora la auto-resolución).
