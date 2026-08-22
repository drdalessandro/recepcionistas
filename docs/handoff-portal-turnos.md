# Cancelar y mover un turno desde el Portal — respuesta de recepcionistas

> **Estado: LISTO del lado de recepcionistas (2026-08-21).** Los dos bots, la
> entrada en la AccessPolicy y la extensión de movimientos están implementados y
> testeados. **Falta el deploy** (`npm run deploy:bots` + `npm run seed`), sin el
> cual los botones del portal siguen respondiendo *"Todavía no podés hacerlo
> desde la app"*.
>
> Este documento responde al handoff del portal y **cierra la pregunta abierta**
> sobre la ventana de anticipación.

## Qué quedó hecho

| Pedido | Estado |
| --- | --- |
| `bw-cancelar-turno` | ✅ |
| `bw-mover-turno` | ✅ |
| AccessPolicy "Paciente — Portal" con los dos bots | ✅ |
| Extensión `movimientos` en `Appointment` | ✅ |

Se eligieron **dos bots**, como propuso el handoff: es la convención del repo
(un verbo por bot) y además cada uno tiene su propia forma de resultado.

El contrato es el que pidieron, la misma forma que `bw-solicitar-turno`:

```ts
{ ok: boolean, mensaje?: string, motivo?: 'horario-ocupado', alternativas?: DiaDisponible[] }
```

`bw-mover-turno` agrega un campo: **`movimientosRestantes`**, para que el portal
pinte el contador sin recalcular nada.

## La pregunta abierta, cerrada: **mover SÍ revalida la ventana (R-13)**

Se revalida. Dos razones:

1. **El agujero es real.** Sin revalidar, alguien reserva a 48 h con perfil
   público y va corriendo el turno hacia adelante hasta un lugar que su perfil
   no habilitaba. El tope de 3 lo acota, no lo cierra.
2. **La asimetría del error manda.** Si revalidar molesta, el paciente no puede
   mover a un horario que igual no habría podido reservar de cero: molesto pero
   coherente. Si no revalidamos, se cuela en la ventana de otro — y eso sí es
   injusto con quien pagó por tener prioridad.

Sale gratis: el bot usa **la misma `disponibilidadDePaciente` que pinta la
grilla del portal**, que ya calcula con el perfil del paciente (R-13), la
capacidad (R-07), el horario del centro y las solicitudes pendientes de otros.
Un horario que la grilla no ofrece, no se acepta.

**Para el portal esto no cambia nada**: como pide la disponibilidad con el mismo
bot, lo que muestra ya está filtrado. Si aun así el horario se ocupó entre que
se pintó y se apretó, llega `motivo: 'horario-ocupado'` con `alternativas`.

> Si a Andrés le parece demasiado estricto, se afloja en un solo lugar
> (`mover-turno.ts`, el chequeo `horarioOfrecido`). No está escondido.

## Detalles que conviene conocer

### Los dos bots verifican que el turno sea del paciente

La AccessPolicy acota lo que el paciente **lee**, no lo que le pasa a un bot: el
portal manda el `appointmentId` que quiera. Los dos bots verifican
`participant` contra el `pacienteRef` antes de tocar nada, y responden
**el mismo mensaje** para "no existe" y "no es tuyo" — contestar distinto
confirmaría si un id existe.

También revalidan estado y futuro (`proposed`/`pending`/`booked`/`waitlist` y
`start` posterior a ahora), aunque el portal ya oculte los botones.

### Cancelar: una sola implementación de R-14

La cancelación entra por dos puertas —el mostrador (`bw-estado-turno`) y el
portal— y ahora las dos llaman a la misma función (`cancelarTurnoYLiberar`). Con
dos implementaciones, R-14 se aplicaría distinto según dónde se apretó el botón,
y la que se desactualizara iba a ser siempre en contra de alguien.

Cancelar hace, en un paso: estado `cancelled`, Encounter cerrado, **saldo
pendiente anulado**, sesión devuelta al plan si corresponde, **lista de espera
avisada** y sala liberada. Es idempotente: cancelar dos veces no devuelve dos
sesiones.

El `motivo` de texto libre va al campo **nativo** `Appointment.cancelationReason`.

### La urgencia médica declarada por el paciente

Se le cree —el sitio lo publica así— y **la sesión vuelve al plan** aunque
cancele sobre la hora. Queda registrada con `cancelacion-fuerza-mayor` +
`cancelacion-declarada-por` (el propio paciente) **y genera un aviso a
Recepción**.

> ⚠️ **Decisión para Andrés.** Tal como está, un paciente puede tildar la casilla
> siempre y R-14 no lo alcanza nunca. El aviso lo hace visible pero no lo impide.
> Si aparece abuso, la alternativa es que la urgencia genere una solicitud a
> Recepción en vez de devolver la sesión sola — pero eso **contradice lo que el
> sitio ya publica**, así que no se hizo por cuenta propia.

### Mover es una sola operación, y el orden importa

1. **Toma** el lugar nuevo (Slot `busy`).
2. **Mueve** el turno (start/end/slot) y sube el contador en el mismo update.
3. **Suelta** el lugar viejo.

En ese orden: si falla el paso 1, el turno viejo sigue en pie; si falla el 3,
queda un Slot ocupado de más — molesto y recuperable, pero **nunca un paciente
sin turno**. El contador no parpadea.

Mover **no cambia qué se hace**: el servicio sale del turno (`item-codigo`), no
del input.

### El contador de movimientos

```
https://biowellness.ar/fhir/StructureDefinition/movimientos   valueInteger
```

Sin la extensión el turno cuenta como **0** (hay test). El tope vive en
`src/config/reglas.ts` → `MOVIMIENTOS.max = 3`.

## Sobre las dos afirmaciones del sitio

**"Reservar exige consentimiento firmado y cuestionario de ingreso"** — del lado
de recepcionistas **la regla es dura y se cumple**: `validarAptitudPaciente`
(R-20) bloquea la reserva sin cualquiera de los dos, sin override (decisión de
Andrés, 2026-08-14). Lo que describe el handoff es que el **portal no lo
pre-bloquea en su UI**: el paciente puede avanzar y el corte llega después. O
sea, el sitio no miente sobre el resultado; lo que falta es avisar antes. **Eso
se arregla en el portal**, no acá.

**"En Mensajes se pueden adjuntar archivos"** — es del portal, no tenemos
visibilidad. Del lado de Recepción los adjuntos sí funcionan (se suben como
`Binary` y viajan por WhatsApp).

## Para probarlo, después del deploy

1. `npm run deploy:bots` (crear antes los dos bots en Medplum: son nuevos).
2. `npm run seed` — **imprescindible**: la AccessPolicy es la que habilita los
   botones. Sin esto, el portal sigue recibiendo 403.
3. Cancelar un turno a más de 24 h → la sesión vuelve al plan.
4. Cancelar uno a menos de 24 h → se consume, y el mensaje lo explica.
5. Mover tres veces → al cuarto intento el bot lo frena con su motivo.
6. Mover a un horario fuera de la ventana del perfil → `horario-ocupado` con
   alternativas.
