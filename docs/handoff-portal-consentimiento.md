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
{ "resourceType": "Consent", "criteria": "Consent?patient=%patient" }
```

- **Lee** todos sus consentimientos (también los que cargue el equipo médico).
- **Firma** los suyos; el criteria por paciente es la protección real.

> ⚠️ La primera versión de esta entrada acotaba la escritura por `category` con
> el system de Biowellness. **Estaba mal y habría roto la firma con 403**: el
> portal usa la categoría estándar de HL7 (`v3-ActCode|IDSCL`) y pone el código
> de BW en `policyRule`. Corregido el 2026-08-14 contra el recurso real.

**Acción para ustedes:** actualizar el espejo
`portal/docs/medplum/access-policy-paciente-portal.json` con estas dos entradas
y **mandarnos ese JSON** para diffearlo contra el código. Ya van tres entradas
que vivieron solo en el servidor (Coverage HIP, ServiceRequest y esta): mientras
el espejo no se compare, cada seed es una ruleta.

## 2. Lo que el portal escribe HOY (verificado 2026-08-14)

Contra un recurso real del servidor: la subida de un PDF de laboratorio crea un
`Consent` con esta forma —

```jsonc
{
  "resourceType": "Consent",
  "status": "active",
  "scope":    { "coding": [{ "system": "…/consentscope", "code": "patient-privacy" }] },
  "category": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
                              "code": "IDSCL" }] }],          // ← categoría ESTÁNDAR
  "patient":  { "reference": "Patient/…" },
  "dateTime": "2026-07-25T11:34:22.665Z",
  "policyRule": { "coding": [{                                 // ← el código de BW vive ACÁ
    "system": "https://biowellness.ar/fhir/CodeSystem/consentimiento",
    "code": "procesamiento-datos-salud"
  }] },
  "provision": { "type": "permit", "data": [{ "meaning": "instance",
    "reference": { "reference": "DocumentReference/…" } }] }   // ← el estudio autorizado
}
```

**El dato que nos faltaba: el código de Biowellness va en `policyRule`, no en
`category`.** Nuestro lado ya está adaptado: la policy no filtra por category
(lo hacía y habría dado 403, ver §1) y el bot busca por paciente y filtra por
`policyRule`.

### Lo que falta confirmar: el consentimiento GENERAL

El otro flujo —el onboarding paso a paso que termina en "Firmar y aceptar" en
`/health-record/consent`— parece registrar la firma como **`DocumentReference`**
(el Network muestra un `POST DocumentReference` 201 en el momento exacto en que
aparece "Consentimiento firmado"), no como `Consent`. Si es así, necesitamos:

1. Confirmarlo, y
2. **Con qué `type`/`category` se marca ese DocumentReference**, para que el bot
   pueda reconocerlo sin leer el resto de la historia documental.

Alternativa más limpia, si les resulta barato: que ese flujo **además** cree un
`Consent` con `policyRule` = `atencion` (mismo patrón que ya usan para el PDF).
Con eso Recepción lo ve sin tocar `DocumentReference` y el modelo queda uniforme.

## 3. Códigos de Biowellness (`policyRule`)

| Código | Cuándo | Estado |
| --- | --- | --- |
| `procesamiento-datos-salud` | El paciente sube un PDF de laboratorio y autoriza procesarlo (Ley 25.326). | ✅ CONFIRMADO |
| `atencion` | Consentimiento general de atención (onboarding). | ⏳ A confirmar (¿hoy es DocumentReference?) |
| `terapia-biologica` | El que exige **R-03** para TB (péptidos, PRP, exosomas…). | ⏳ A definir |

Están en `src/fhir/identifiers.ts` (`COD_CONSENTIMIENTO`): si usan otros, se
cambian ahí y nada más.

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
2. **Confirmar el consentimiento general** (§2): ¿es un `DocumentReference`? ¿con
   qué `type`/`category`? ¿o pueden crear además un `Consent` con
   `policyRule` = `atencion`?
3. **Definir si existe el de Terapias Biológicas** (R-03) y con qué código.
4. Si el consentimiento se puede **revocar** desde el portal, que el `Consent`
   pase a `status: 'inactive'` — nuestra lógica ya lo contempla y deja de
   contarlo como firmado.
