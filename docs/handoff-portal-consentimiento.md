# Handoff: consentimiento informado firmado desde el portal

> **Qué es este documento.** Dos cosas: (1) un **aviso urgente** de una entrada
> de AccessPolicy que se estaba perdiendo en cada seed y les rompía la firma con
> 403, y (2) la **propuesta de contrato** para que Recepción pueda ver si el
> paciente firmó — hoy no puede, porque nadie definió qué se escribe al firmar.
>
> Interlocutor: repo del portal del paciente (`app.biowellness.ar`). Este repo:
> `recepcion.biowellness.ar`.

---

## 1. ⚠️ Urgente: `Consent` no estaba en la policy del seed

`docs/recepcionistaschequeohandoff.md` decía que el espejo del portal tenía una
entrada `Consent` **aplicada a mano en el servidor**, y el docstring de nuestra
policy prometía que el paciente escribe "sus consentimientos"… pero la entrada
**no estaba en `src/fhir/access-policies.ts`**, que es la fuente de verdad del
seed (upsert por `name`). O sea: **cada `npm run seed` la borraba** y la firma
del portal quedaba en 403 hasta que alguien la volviera a poner a mano.

Ya está arreglado en este repo, con el mismo patrón de dos entradas que usamos
para Coverage y ServiceRequest:

```jsonc
{ "resourceType": "Consent", "readonly": true, "criteria": "Consent?patient=%patient" },
{ "resourceType": "Consent", "criteria": "Consent?patient=%patient&category=https://biowellness.ar/fhir/CodeSystem/consentimiento|" }
```

- **Lee** todos sus consentimientos (también los que cargue el equipo médico).
- **Firma** solo los de Biowellness: el `category` le impide fabricar `Consent`
  de cualquier otro tipo.

**Acción para ustedes:** actualizar el espejo
`portal/docs/medplum/access-policy-paciente-portal.json` con estas dos entradas
y **mandarnos ese JSON** para diffearlo contra el código. Ya van tres entradas
que vivieron solo en el servidor (Coverage HIP, ServiceRequest y esta): mientras
el espejo no se compare, cada seed es una ruleta.

## 2. La pregunta bloqueante: ¿qué escriben hoy al firmar?

Nuestra policy les habilita **tres caminos a la vez** —
`QuestionnaireResponse`, `DocumentReference` y `Binary` — y ninguna convención
dice cuál usar. Necesitamos saber qué crean **hoy** cuando el paciente firma:
recurso, y si lleva algún código identificatorio.

Sin esa respuesta, la pantalla de Recepción muestra "sin consentimiento
firmado" para siempre y **sin ningún error visible** — el peor tipo de bug.

## 3. Contrato propuesto: `Consent`

Proponemos `Consent` porque es el recurso canónico de FHIR para esto, ya estaba
asumido en nuestra policy, y —clave— es el único que permite dar a Recepción una
señal **acotada por categoría** sin exponer la historia documental del paciente.

```jsonc
{
  "resourceType": "Consent",
  "status": "active",                       // 'inactive' si se revoca
  "scope": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/consentscope", "code": "treatment" }] },
  "category": [{ "coding": [{
    "system": "https://biowellness.ar/fhir/CodeSystem/consentimiento",
    "code": "terapia-biologica"             // o "atencion" (ver tabla)
  }] }],
  "patient": { "reference": "Patient/<id>" },
  "dateTime": "2026-08-13T18:20:00-03:00",  // momento de la firma
  "sourceAttachment": { /* PDF firmado */ } // o sourceReference → DocumentReference/Binary
}
```

| Código | Qué consentimiento es |
| --- | --- |
| `atencion` | Consentimiento general de atención, el que firma cualquier paciente al darse de alta. |
| `terapia-biologica` | El que exige **R-03** para Terapias Biológicas (péptidos, PRP, exosomas…), con la cadena de responsabilidad médica detrás. |

Los códigos están en `src/fhir/identifiers.ts` (`COD_CONSENTIMIENTO`) y son
**provisorios**: si ustedes ya usan otros, los cambiamos acá y listo — es un
archivo.

## 4. Qué hace Recepción con eso (y qué NO ve)

Recepción **no lee el `Consent`**: su AccessPolicy no incluye `Consent`, ni
`DocumentReference`, ni `QuestionnaireResponse`, y no las va a incluir — abrirlas
daría toda la historia documental del paciente (CLAUDE.md, principio 3).

En su lugar hay un bot de solo lectura, **`bw-estado-consentimiento`**, que corre
con identidad de proyecto y devuelve **únicamente**:

```jsonc
{ "ok": true, "estado": "firmado" | "no-registrado" | "no-verificable", "fechaISO": "…" }
```

Con eso la pantalla "Atender paciente" muestra un badge junto al nombre y, al
elegir una Terapia Biológica, precarga el switch de R-03. Nunca el documento, ni
el contenido, ni quién lo indicó.

Detalle que importa: **`no-verificable` ≠ `no-registrado`**. Si la consulta
falla, lo decimos; jamás damos por firmado lo que no se pudo leer, porque eso
habilitaría una TB sin respaldo.

## 5. Resumen para su backlog

1. ⚠️ **Actualizar el espejo** de la policy con las dos entradas `Consent` del §1
   y mandarnos el JSON para diffear.
2. **Contestar el §2**: ¿qué recurso escriben hoy al firmar?
3. **Adoptar el contrato del §3** (o decirnos cuál usan, y lo adaptamos).
4. Si el consentimiento se puede **revocar** desde el portal, que el `Consent`
   pase a `status: 'inactive'` — nuestra lógica ya lo contempla y deja de
   contarlo como firmado.
