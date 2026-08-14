# Handoff · Recepción empieza a cargar leads del mostrador

> **Para**: la sesión que trabaje sobre `github.com/biowellness/administracion`.
> **De**: `recepcionistas` (donde nace el dato).
> Fecha: 2026-08-14. Sale del recorrido del walk-in, caso 1 ("el curioso").

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

**3. No usamos su `Provenance` de atribución** (`bio/lead-origen`). El canal
viaja en nuestro `bw/origen-lead = walk-in`, que es el contrato que ya existía
entre nosotros (`docs/handoff-crm-canales.md`). Si quieren el Provenance
también, decínos la forma exacta de las sub-extensiones y lo agregamos — no lo
inferimos para no escribir algo que después les rompa el pipeline.

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
