# Handoff · Recepción empieza a cargar leads del mostrador

> **Para**: la sesión que trabaje sobre `github.com/biowellness/administracion`.
> **De**: `recepcionistas` (donde nace el dato).
> Fecha: 2026-08-14. Sale del recorrido del walk-in, caso 1 ("el curioso").
>
> ## ✅ CERRADO — Administración respondió el 14/08/2026
>
> - **Toman los leads con la métrica honesta por defecto**: `walk-in` cuenta las
>   consultas sin compra, con un interruptor *"Incluir consultas sin compra"*
>   encendido por defecto y una columna **Leads** por canal. Apagarlo aplica el
>   filtro `ciclo-vida-cliente != lead` y devuelve la serie anterior. **No hay
>   nada que cambiar de nuestro lado.**
> - **Las fichas sin nombre no rompen nada** (usan `getDisplayString`, que las
>   tolera) y coinciden con no inventar nombres.
> - **El `Provenance` era opcional** y nos pasaron la forma exacta: ya está
>   implementado (ver §3). Detectan el ciclo de vida por la extensión y, si no
>   está, por el `meta.tag` — escribimos las dos; ante diferencia manda la
>   extensión.
> - **No piden nada.**

## Qué cambió

Recepción ahora puede registrar, de un clic, a la persona que **entra al local,
pregunta y se va** — con o sin datos. Hasta hoy eso no dejaba rastro y el local,
que es el canal más caro, era el único que no se podía medir.

**No inventamos un modelo de leads: usamos el de ustedes.** Leímos
`administracion/src/fhir/systems.ts` y seguimos su contrato tal cual.

## Qué escribe Recepción

Al registrar una consulta del mostrador se crea:

**1. `Patient`** — con el ciclo de vida de ustedes:

```jsonc
{
  "resourceType": "Patient",
  "active": true,
  "meta": { "tag": [{ "system": "https://bio.medplum.com.ar/fhir/CodeSystem/ciclo-vida-cliente", "code": "lead" }] },
  "extension": [
    { "url": "https://bio.medplum.com.ar/fhir/StructureDefinition/ciclo-vida-cliente", "valueCode": "lead" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/origen-lead", "valueString": "walk-in" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/fecha-alta", "valueDate": "2026-08-14" }
  ]
}
```

**2. `Task`** — la tarjeta en su kanban, en etapa `nuevo`:

```jsonc
{
  "resourceType": "Task",
  "status": "requested",
  "intent": "order",
  "businessStatus": { "coding": [{ "system": "https://bio.medplum.com.ar/fhir/CodeSystem/etapa-pipeline", "code": "nuevo" }] },
  "code": { "text": "Lead" },
  "description": "Consulta presencial en el local. Preguntó por: Cámara hiperbárica. Sin datos de contacto: no se le puede escribir.",
  "for": { "reference": "Patient/…" }
}
```

## Tres cosas que necesitan saber

**1. Hay leads sin nombre.** El curioso muchas veces no lo deja, y pedírselo es
la fricción que hace que no se registre nada. Esos `Patient` llevan un nombre
descriptivo — `"Consulta en el mostrador · 14/08 15:30"` — para que la tarjeta
sea legible en el kanban. **Nunca inventamos un nombre**: quedaría en la ficha
como si fuera el suyo. La `description` de la Task avisa explícitamente cuándo
no hay forma de contactarlo, para que nadie lo trabaje como lead accionable.

**2. Van a aparecer en "Clientes por canal".** El universo de ese panel es
`Patients con active !== false y sin link`, y estos cumplen. Van a sumar al
canal `walk-in` con conversión 0 hasta que compren.

> Eso **infla el denominador** del canal `walk-in` respecto de cómo se venía
> midiendo (antes solo entraban fichas reales). Es información nueva y más
> honesta —ahora sabemos cuánta gente entra y no compra—, pero **cambia la
> serie histórica**. Si prefieren la métrica anterior, filtren por
> `ciclo-vida-cliente != lead`; nosotros no tocamos su panel.

**3. El `Provenance` de atribución** (`bio/lead-origen`) — *resuelto*. Nos
pasaron la forma exacta y **ya lo escribimos**: un `Provenance` por lead, con
`target` al Patient, `recorded`, `agent.who` = el Practitioner que lo registró y
la sub-extensión `fuente` como **texto para mostrar** (el chip de la tarjeta).

Ese texto sale de `ORIGENES_LEAD_LABELS` —el mismo mapa que ya usábamos— así que
`walk-in` da exactamente `"Mostrador (walk-in)"` y agregar un canal nuevo no
requiere tocar nada. El canal canónico para métricas sigue siendo
`bw/origen-lead`, como acordamos.

> `agent.who` es obligatorio en FHIR y solo acepta ciertos tipos. Si la app no
> puede resolver un `Practitioner` válido, **no escribimos el Provenance**: un
> recurso inválido sería peor que la tarjeta sin chip.

## Lo que muestra la tarjeta (revisado contra su código)

Miramos `PipelinePage.tsx` con las primeras tarjetas ya en producción: la
tarjeta renderiza **nombre + chip de `fuente` + `próxima-acción` + responsable**,
y **no muestra `Task.description`** — que era donde habíamos puesto "preguntó
por X". O sea que las primeras tarjetas mostraban un nombre suelto y nada más:
justo el dato que hace vendible al lead quedaba invisible.

Corregido de nuestro lado: ahora escribimos también `Task.input` con
`próxima-acción`, que es el campo que sí se ve.

| Situación | Texto en la tarjeta |
| --- | --- |
| Dejó teléfono | `Contactar — preguntó por Cámara hiperbárica` |
| No dejó nada | `Preguntó por Cámara hiperbárica — no dejó datos de contacto` |

Cuando no hay forma de contactarlo **no decimos "Contactar"**: prometer una
acción imposible es peor que no decir nada. `Task.description` sigue teniendo el
detalle completo por si algún día lo quieren mostrar.

**`Task.owner` lo dejamos vacío a propósito**: el responsable del lead lo asignan
ustedes al trabajarlo, no Recepción. Por eso las tarjetas salen sin responsable.

## Canal nuevo: `acompanante` (2026-08-14, segunda tanda)

Sumamos un código al contrato de canales: **`acompanante`**, para el que viene
acompañando a un paciente y pregunta mientras espera. No es `walk-in` —no vino
por su cuenta, vino traído— y muy probablemente **convierte distinto**: ya vio
el lugar por dentro y tuvo cuarenta minutos de exposición. Medirlo aparte es
justamente el punto.

Verificamos en su `canales.ts` que un canal nuevo no rompe nada:
`canalLabel` cae al código crudo y `ordenContrato` lo manda al final. Así que
**va a aparecer como `acompanante`** en el panel hasta que le agreguen la
etiqueta. La nuestra es *"Acompañante de un paciente"*, por si quieren la misma.

En la tarjeta del kanban el vínculo va primero, porque es lo que abre la
conversación:

| Situación | Texto en la tarjeta |
| --- | --- |
| Acompañante con teléfono | `Contactar — acompañó a Julio D'Alessandro y preguntó por IHHT` |
| Acompañante sin datos | `Acompañó a Julio D'Alessandro y preguntó por IHHT — no dejó datos de contacto` |

> El vínculo va **solo en el texto**, no en un recurso ni extensión nueva: nada
> del lado de ustedes lo leería, y no quisimos inventar contrato para un dato
> que es color de conversación, no métrica. Para medir alcanza con el canal.

## El que pide algo que no tenemos (2026-08-14, tercera tanda)

Caso 11 del walk-in. Cuando alguien pregunta por algo **que no está en el
catálogo**, Recepción ahora anota *qué* pidió (antes caía en "Otra cosa" y el
texto se perdía). Eso les cambia dos cosas en la tarjeta y **no requiere que
toquen nada**:

| Situación | Texto en la tarjeta (`próxima-acción`) |
| --- | --- |
| Con teléfono | `Avisarle si sumamos nutricionista — hoy no lo ofrecemos` |
| Sin datos | `Pidió nutricionista, que hoy no ofrecemos — no dejó datos de contacto` |

`Task.description` dice además **"Pidió: nutricionista — NO está en el catálogo
hoy"**. La acción deliberadamente **no** es "Contactar": no hay qué venderle
hoy, y llamarlo para repetirle que no lo tenemos quema el lead. Lo que sí se
puede prometer es avisarle si lo sumamos — por eso el lead queda vivo.

El agregado que **sí** es dato nuevo, por si lo quieren en su panel: cada pedido
deja un `Basic` propio, listable con una búsqueda estándar:

```
GET /fhir/R4/Basic?code=https://biowellness.ar/fhir/CodeSystem/demanda|no-disponible
```

```jsonc
{
  "resourceType": "Basic",
  "code": {
    "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/demanda", "code": "no-disponible" }],
    "text": "nutricionista"                       // tal como lo dijo
  },
  "subject": { "reference": "Patient/…" },          // a quién avisarle si lo sumamos
  "author":  { "reference": "Practitioner/…" },     // quién lo registró
  "created": "2026-08-14",
  "extension": [
    { "url": "https://biowellness.ar/fhir/StructureDefinition/demanda-clave",
      "valueString": "nutricionista" }              // clave de agregación (sin tildes/mayúsculas)
  ]
}
```

Se escribe **también para pacientes que ya existen** (ahí no hay tarjeta de lead,
y el pedido vale igual). Nosotros lo mostramos agrupado en Reportes; si les
sirve para el panel comercial, el dato ya está y no hay contrato nuevo que
acordar.

## Deduplicación (esto les sirve)

El lead entra por el **mismo** `bw-alta-paciente` que un alta normal, así que
hereda su deduplicación por DNI / email / teléfono. Consecuencia útil: si el
curioso deja el teléfono y vuelve en un mes, o escribe por WhatsApp, **se lo
encuentra y se completa la misma ficha** en vez de duplicarla. El paso de `lead`
a `activo` es de ustedes (`promover-lead`); nosotros nunca lo pisamos.

## Qué NO hicimos

- No tocamos ningún recurso ni pantalla del repo `administracion`.
- No escribimos `Provenance` (ver punto 3).
- No inventamos etapas: solo usamos `nuevo`.
