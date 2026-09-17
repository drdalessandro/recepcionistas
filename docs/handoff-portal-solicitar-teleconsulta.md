# Handoff: solicitar una teleconsulta desde el Portal

**De:** Recepción (`recepcionistas`) · **Para:** Portal (App del paciente)
**Fecha:** 2026-09-17 · **Estado:** listo de nuestro lado para
`TELECONSULTA_MED_DALESSANDRO`

> Este documento cubre **pedir el turno**. Lo que pasa el día de la consulta
> —entrar a la videollamada, la sala de espera, los PDFs previos— está en
> [`handoff-portal-teleconsulta.md`](handoff-portal-teleconsulta.md) y no se
> repite acá.

## Resumen

Pedir una teleconsulta **usa el mismo camino que ya tienen** para una consulta
presencial: `bw-disponibilidad` para los horarios, `bw-solicitar-turno` para el
pedido. Lo único que cambia es el `servicioCodigo`.

Tres cosas nuevas que sí les tocan:

1. El catálogo ahora trae servicios **virtuales**, que se reconocen por la
   extensión `modalidad-atencion` (§2).
2. `bw-disponibilidad` **cambió hoy** para contestar bien a las consultas: antes
   les devolvía la grilla del consultorio físico. Ahora devuelve la agenda
   publicada del profesional y dice de dónde salió (§3).
3. El cobro es del **100 % por adelantado**, no la seña del 50 %: en ningún
   texto de un turno virtual puede decir "seña" (§5).

Y un límite que no es técnico: **hoy solo el Dr. D'Alessandro se puede ofrecer**.
La Dra. Albarellos ya está en el catálogo pero todavía no tiene franjas
publicadas (§7).

## 1. El modelo sigue siendo de SOLICITUD

El paciente **pide**, Recepción **confirma**. No cambia con la teleconsulta y
conviene que el copy lo refleje: al terminar el flujo el turno **no está
reservado todavía**.

```
Portal                        Nosotros                     Paciente
──────────────────────────────────────────────────────────────────────
bw-solicitar-turno  ──────▶  Task (solicitud)
                             + WhatsApp a Recepción
                                    │
                             Recepción confirma
                             (bw-reservar-turno)
                                    │
                             Appointment `pending`  ─────▶ WhatsApp con
                             + sala de video creada        link de pago (100 %)
                                    │
                             Paga  ──▶ `booked`     ─────▶ campanita
                                                           `reserva-confirmada`
```

El `Task` de la solicitud lo pueden leer (la policy ya lo permite:
`Task?patient=%patient`), así que pueden mostrar "pedido, esperando
confirmación" sin preguntarnos nada.

**R-19 sigue viva**: desde que Recepción confirma, el turno tiene vencimiento.
Si el pago no entra a tiempo, `bw-vencer-tentativas` libera el lugar.

## 2. Encontrar las teleconsultas en el catálogo

Se publican como `ActivityDefinition`, igual que todo el resto, y se reconocen
por la extensión:

```ts
const MODALIDAD_EXT = 'https://biowellness.ar/fhir/StructureDefinition/modalidad-atencion';
const esVirtual = ad.extension?.find((e) => e.url === MODALIDAD_EXT)?.valueCode === 'virtual';
```

`valueCode`, valores `presencial` | `virtual`. **Solo se escribe en los
virtuales**: la ausencia es presencial (no la busquen en los 40 servicios del
catálogo v9).

| | Presencial | Teleconsulta |
|---|---|---|
| Código | `CONSULTA_MED_DALESSANDRO` | `TELECONSULTA_MED_DALESSANDRO` |
| Nombre en la góndola | **Evaluación Biowellness** (sin médico) | **Teleconsulta de Cardiología — Dr. Alejandro Sergio D'Alessandro** |
| Precio | $120.000 | $150.000 |
| Duración | según el servicio | 60 min |
| `modalidad-atencion` | ausente | `virtual` |

Los dos son **productos distintos con códigos distintos** (Administración
factura y cuenta por separado), no una variante del mismo. El nombre empieza con
"Teleconsulta" a propósito: es la palabra con la que la busca todo el mundo.

**Ojo con la asimetría de los nombres**, que les va a pegar en el render: la
consulta presencial se publica como *"Evaluación Biowellness"* **sin el médico**
—son intercambiables y el paciente elige profesional al reservar (Addendum 2.1)—
mientras que la teleconsulta **sí** lleva especialidad y apellido, porque no son
intercambiables: se pide cardiología con D'Alessandro, no "una teleconsulta".
Por eso no es un simple toggle sobre la misma tarjeta; ver §3.2.

Hoy publicados: `TELECONSULTA_MED_DALESSANDRO` (cardiología) y
`TELECONSULTA_MED_ALBARELLOS` (endocrinología y diabetes).

## 3. Los horarios: `bw-disponibilidad` cambió (léanlo)

Hasta hoy este bot calculaba **siempre** la grilla de salas: horario del centro,
capacidad, ventana R-13. Para una consulta médica eso estaba mal, y para una
teleconsulta estaba mal dos veces:

- le ofrecía los horarios del **consultorio físico**, en el que un turno virtual
  no va a estar;
- y los recortaba con la **ventana R-13** (48 h para el público), que a una
  consulta no se le aplica: el médico publica su agenda con semanas de
  anticipación, y la consulta es justamente la puerta de entrada del paciente
  nuevo, el de ventana más corta.

Mientras tanto `bw-solicitar-turno` **sí** validaba contra la agenda del médico.
O sea: los dos bots miraban fuentes distintas y el portal podía ofrecer horarios
que el servidor después rechazaba.

Ya está arreglado. El bot ahora bifurca y **dice de dónde sacó los horarios**:

```ts
// Resuelvan el bot como ya lo hacen hoy (por id, o buscando Bot?name=…):
// lo único que cambia es el servicioCodigo.
const r = await medplum.executeBot(botDisponibilidadId, {
  pacienteRef: `Patient/${profile.id}`,
  servicioCodigo: 'TELECONSULTA_MED_DALESSANDRO',
});
// r.fuente === 'agenda-medico'
// r.dias  === [{ fecha: '2026-09-22', horarios: [{ inicio, fin }] }, …]
```

| `fuente` | Cuándo | Qué campos vienen |
|---|---|---|
| `'agenda-medico'` | el servicio tiene profesional (consulta **y** teleconsulta) | `dias`, `mensaje?` |
| `'salas'` | terapias (HBOT, IHHT, …) | `dias`, `perfil`, `ventanaHoras`, `grupal`, `mensaje?` |

`fuente` es un campo **agregado**: lo que ya tienen andando para terapias no lo
mira y sigue igual. Para las consultas **no viene `ventanaHoras`**, porque R-13
no las gobierna — si hoy muestran "podés reservar hasta dentro de N horas", esa
línea no va en una consulta.

Las reglas de render de siempre siguen valiendo: los horarios elegibles son
**únicamente** `r.dias[].horarios[]`, y ante `ok: false` o excepción **no se
ofrece nada** (nunca una grilla completa de fallback).

### 3.1 · Dos mensajes distintos cuando no hay horarios

No es lo mismo "no hay lugar" que "todavía no abrimos la agenda", y el paciente
merece saber cuál de las dos le tocó:

- **sin agenda publicada** → *"… todavía no tiene horarios publicados. Escribinos
  y te avisamos apenas se abran."* Es un hueco **nuestro**, no del calendario. Es
  literalmente el caso de la Dra. Albarellos hoy.
- **con agenda y todo tomado** → *"Por ahora no quedan horarios libres de …"*.

En los dos casos `ok: true` y `dias: []`. Muestren `r.mensaje` tal cual: ya viene
redactado según la causa.

### 3.2 · Presencial y virtual comparten la agenda

Hoy hay **un solo `Schedule` por médico** (`SCH_<codigo>`). Consecuencia directa:

> Si el Dr. D'Alessandro tiene una presencial a las 16:00, las 16:00 **tampoco
> están** para una teleconsulta.

Es a propósito: el cuello de botella es el profesional, no la sala. Y tiene un
lado cómodo para ustedes: **para un mismo médico la grilla es idéntica en las dos
modalidades**, así que alternar entre ellas puede cambiar solo el `servicioCodigo`
**sin volver a pedir los horarios**. Lo que sí cambia es el precio y la duración,
que vienen en la `ActivityDefinition` de cada uno.

Con el matiz del §2: como la presencial no elige médico en la góndola y la
virtual sí, el toggle recién es equivalente **una vez que el paciente ya eligió
profesional**. Antes de eso son dos recorridos distintos.

(Si en algún momento se decide que un profesional publique horarios de video
distintos de los presenciales, es un cambio nuestro y se los avisamos. Ver §7.)

## 4. El pedido: `bw-solicitar-turno`

Sin novedad respecto de lo que ya hacen. El `terapiaCodigo` es lo único que
cambia:

```ts
await medplum.executeBot(botSolicitarTurnoId, {
  pacienteRef: `Patient/${profile.id}`,
  terapia: "Teleconsulta de Cardiología — Dr. Alejandro Sergio D'Alessandro", // lo que vio el paciente
  terapiaCodigo: 'TELECONSULTA_MED_DALESSANDRO',
  preferenciaInicio: '2026-09-22T16:00:00-03:00', // el chip elegido, tal cual vino
  nota: 'texto libre del paciente (opcional)',
});
```

Respuesta: `{ ok: true, taskId }`, o el rechazo con alternativas frescas que ya
manejan:

```ts
{ ok: false, motivo: 'horario-ocupado', mensaje: '…', alternativas: DiaDisponible[] }
```

`alternativas` viene en el mismo formato que `dias`, así que se repintan los
chips sin pedir nada más. **Manden `preferenciaInicio` con el valor exacto del
chip**: es lo que permite el chequeo contra la agenda del médico (la comparación
es por instante, no por texto, así que el offset no importa — pero un horario
inventado a mano sí).

## 5. Después del pedido: el dinero y los textos

Cuando Recepción confirma, sale un WhatsApp con el link de MercadoPago. Para un
turno virtual ese link es por el **100 %**, no por la seña del 50 %
(Andrés, 2026-09-16).

**Lo de nuestro lado ya está hecho**: el WhatsApp dice *"aboná la consulta
($150.000)"* y el de confirmación *"Recibimos el pago de $150.000"*, sin la
palabra "seña" y sin mencionar saldo. El `Invoice` se emite con
`es-sena = false` y **no se crea el Invoice de saldo**, así que el turno tampoco
aparece en "Pagos pendientes".

Lo que les toca: **revisar sus textos**. Si alguna pantalla o mail del portal
dice "seña" o "resto a abonar en el centro", para un turno virtual no aplica.
El concepto que van a ver si muestran el link es *"Consulta por videollamada · …"*.

## 6. Lo que hay que pedirle al paciente ANTES

`bw-solicitar-turno` **no** valida R-20: lo valida `bw-reservar-turno` cuando
Recepción confirma. O sea, un pedido de alguien que no cumple los requisitos
**entra igual y muere en el mostrador**. Para que eso no pase, el portal
corta antes:

| Requisito | Regla | Cómo lo ven ustedes |
|---|---|---|
| Consentimiento general firmado | R-20 | `Consent?patient=%patient` (lo leen y lo firman ya) |
| Cuestionario de ingreso completo | R-20 | `QuestionnaireResponse?subject=%patient` |
| Consentimiento de teleconsulta | — | §6 del handoff de teleconsulta |

R-20 no bloquea de más en este caso: las contraindicaciones son por categoría y
ninguna toca `CONSULTA`.

Sigue abierto si en modalidad virtual el cuestionario de ingreso se reemplaza
por el previo de la especialidad (`teleconsulta.md` §10, decide Andrés).
**Mientras tanto se piden los dos.**

## 7. Lo que falta, y de quién depende

| Qué | Estado | De quién |
|---|---|---|
| **Franjas de la Dra. Albarellos** | sin agenda publicada → el portal no la puede ofrecer | **Andrés**. Es un renglón en `src/config/medicos.ts` + `npm run seed` |
| **Dr. Carrieri (hiperbárica)** | `Practitioner` creado, **sin servicio publicado** | **Andrés**: falta el precio de la consulta |
| **Nutrición** | tres servicios sin publicar | **Andrés**: falta el nombre de la nutricionista |
| **Agenda de video separada de la presencial** | el campo `agendaTeleconsulta` existe en la config pero **no lo usa nadie**: hoy hay una sola agenda por médico (§3.2) | decisión de Andrés; si se activa, es cambio nuestro y se los avisamos |

Nada de esto los bloquea para arrancar con cardiología.

## 8. Lo que NO cambia

- **Cancelar y mover**: `bw-cancelar-turno` y `bw-mover-turno`, sin
  modificaciones, con los mismos topes (R-14, 3 movimientos).
- **La campanita**: `reserva-confirmada` llega igual que hoy.
- **La AccessPolicy**: no hace falta tocar nada. `bw-disponibilidad` y
  `bw-solicitar-turno` ya están en la lista de bots que el paciente puede
  ejecutar, y `Schedule`/`Slot` ya son legibles.

## 9. Checklist de aceptación

- [ ] La góndola muestra "Teleconsulta de Cardiología — Dr. Alejandro Sergio
      D'Alessandro" a $150.000, separada de la evaluación presencial.
- [ ] Al elegirla, los chips salen de `bw-disponibilidad` con
      `fuente === 'agenda-medico'` y coinciden con los horarios publicados del
      médico (martes 16-20, miércoles 8-12, jueves 16-20).
- [ ] Un horario a más de 48 h **se ofrece** (antes lo comía R-13).
- [ ] Reservar la presencial de las 16:00 hace desaparecer las 16:00 también de
      la lista virtual.
- [ ] Elegir la endocrinóloga muestra el mensaje de "todavía no tiene horarios
      publicados" y **no** una grilla inventada.
- [ ] El pedido crea el `Task` y el portal muestra "esperando confirmación".
- [ ] Ningún texto del flujo virtual dice "seña" ni promete un saldo a pagar en
      el centro.
- [ ] Sin consentimiento general o sin cuestionario, el portal no deja llegar al
      pedido.

## 10. Preguntas para ustedes

1. ¿El selector de modalidad va **dentro** de la ficha del profesional, o son dos
   tarjetas separadas en la góndola? Nos cambia solo el copy, pero queremos que
   el nombre del servicio les quede bien en las dos.
2. ¿Muestran hoy `ventanaHoras` en algún lado? Si sí, ahí hay que contemplar que
   para consultas no viene.
3. ¿Les sirve `fuente`, o preferían dos bots distintos? Estamos a tiempo de
   cambiarlo sin romper a nadie.
