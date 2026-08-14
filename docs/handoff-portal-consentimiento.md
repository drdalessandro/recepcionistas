# Consentimiento informado: contrato Portal ↔ Recepción

> **Estado: ACORDADO con Alejandro (MedTech) el 2026-08-14.** El recurso legal
> es **`Consent` (FHIR R4)** para los dos flujos; el `DocumentReference` sigue
> siendo la evidencia firmada. Este documento fija la forma exacta, el cambio
> mínimo del lado del portal y lo que ya está hecho del lado de Recepción.
>
> Repos: portal del paciente (`app.biowellness.ar`) ↔ `recepcion.biowellness.ar`.

---

## 1. La decisión: `Consent` **y** `DocumentReference`, no uno u otro

No compiten, cumplen roles distintos y por eso conviene tener los dos:

| Recurso | Qué es | Para qué sirve |
| --- | --- | --- |
| **`Consent`** | El **hecho jurídico**: quién consintió, a qué, cuándo, y si sigue vigente. | Es *consultable* y *revocable*. Permite preguntar "¿este paciente tiene consentimiento vigente?" sin abrir un documento, y revocar con `status: 'inactive'`. |
| **`DocumentReference`** | La **evidencia**: el texto exacto que la persona leyó y firmó, con nombre, DNI y timestamp. | Es lo que se presenta ante un reclamo. Inmutable, versionado por el propio texto. |

Se enlazan con **`Consent.sourceReference` → `DocumentReference`**. Así el hecho
legal siempre puede recuperar la prueba, y la prueba nunca queda huérfana.

Sin el `Consent`, "¿está vigente?" obliga a leer documentos (y a Recepción a
tener permiso sobre toda la historia documental). Sin el `DocumentReference`, el
`Consent` no prueba **qué** texto se firmó. Por eso van juntos.

## 2. Lo que ya existe (verificado contra el servidor)

**Flujo A — autorización al subir un PDF de laboratorio.** Ya crea `Consent`, y
está bien:

```jsonc
{
  "resourceType": "Consent",
  "status": "active",
  "scope":    { "coding": [{ "system": "…/consentscope", "code": "patient-privacy" }] },
  "category": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
                              "code": "IDSCL" }] }],
  "patient":  { "reference": "Patient/…" },
  "dateTime": "2026-07-25T11:34:22.665Z",
  "policyRule": { "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/consentimiento",
                               "code": "procesamiento-datos-salud" }] },
  "provision": { "type": "permit", "data": [{ "meaning": "instance",
                 "reference": { "reference": "DocumentReference/…" } }] }
}
```

**Flujo B — consentimiento general (onboarding / `/health-record/consent`).**
Hoy `firmarConsentimiento()` crea **solo** el `DocumentReference` (LOINC
`59284-0`, texto completo en el adjunto). Falta el `Consent`.

## 3. El cambio mínimo en el portal

En `firmarConsentimiento()`, después del `createResource<DocumentReference>`,
agregar el `Consent` que lo referencia. **No se toca nada de lo que ya existe**:

```ts
await medplum.createResource<Consent>({
  resourceType: 'Consent',
  status: 'active',
  // 'treatment': es un consentimiento de ATENCIÓN. (El de laboratorio usa
  // 'patient-privacy' porque autoriza tratamiento de datos: son cosas distintas
  // y conviene que el scope lo diga.)
  scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'treatment' }] },
  // Misma codificación que el DocumentReference.type: LOINC Patient Consent.
  category: [{ coding: [{ system: CONSENT_TYPE_SYSTEM, code: CONSENT_TYPE_CODE, display: 'Patient Consent' }] }],
  patient: createReference(patient),
  dateTime: timestamp,
  performer: [createReference(patient)],
  // ← el enlace al documento firmado: el hecho legal apunta a su evidencia.
  sourceReference: createReference(doc),
  policyRule: {
    coding: [{ system: 'https://biowellness.ar/fhir/CodeSystem/consentimiento', code: 'atencion' }],
    text: `Consentimiento Informado BIOWELLNESS (texto ${USO_DATOS_VERSION})`,
  },
  provision: { type: 'permit' },
});
```

Tres detalles que valen la pena:

1. **`policyRule.text` con la versión del texto.** Ya manejan versión (`Texto v1`
   en la página): dejarla ahí permite responder "¿qué versión firmó?" sin abrir
   el adjunto. Si el texto cambia, la firma vieja sigue siendo válida para su
   versión y se puede pedir refirma solo a quien corresponda.
2. **Revocación.** Hoy la página dice "escribí a info@biowellness.ar". Con
   `Consent`, revocar es `status: 'inactive'` (o un `Consent` nuevo que
   reemplace al anterior). Nuestro lado ya lo respeta: un consentimiento
   `inactive` deja de contar como firmado.
3. **Refirma.** Al firmar una versión nueva, conviene pasar el `Consent` anterior
   a `inactive` y el `DocumentReference` viejo a `superseded`.

## 4. Sugerencia: el uso secundario también como `Consent`

`guardarUsoDatos()` guarda la decisión de uso secundario (Ley 25.326) como un
campo en la ficha del paciente. Funciona, pero como es una autorización
**opcional y revocable**, gana bastante siendo su propio `Consent`:

```jsonc
{
  "scope":      { "coding": [{ "system": "…/consentscope", "code": "patient-privacy" }] },
  "policyRule": { "coding": [{ "system": "…/CodeSystem/consentimiento", "code": "uso-secundario" }] },
  "provision":  { "type": "permit" }   // o "deny" si no acepta
}
```

Ventaja concreta: queda el **historial** de decisiones (aceptó, revocó, volvió a
aceptar) con fecha, que es justo lo que se necesita si alguien reclama. El campo
de la ficha puede quedar como caché de lectura rápida. **No es bloqueante** — el
Flujo B es lo que destraba la pantalla de Recepción.

## 5. Lo que ya está hecho de este lado

- **AccessPolicy del paciente**: `Consent` con lectura y escritura acotadas por
  paciente. ⚠️ **Sin filtrar por `category`** — la primera versión filtraba por
  el system de BW y habría rechazado con 403 el Consent del Flujo A, porque el
  código de Biowellness va en `policyRule`, no en `category`. La entrada además
  faltaba en el seed: cada `npm run seed` la borraba (hay que **actualizar el
  espejo** `portal/docs/medplum/access-policy-paciente-portal.json`).
- **Bot `bw-estado-consentimiento`** (solo lectura): busca por paciente y
  devuelve **solo** `{ estado: 'firmado' | 'no-registrado' | 'no-verificable',
  fechaISO }`. Nunca el documento ni el contenido. Recepción ve la señal sin que
  su policy toque recursos clínicos.
- **Compatibilidad hacia atrás**: el bot también reconoce el `DocumentReference`
  LOINC `59284-0` como firma del consentimiento general. Así, **las firmas que ya
  existen cuentan desde hoy** y nadie tiene que volver a firmar. Cuando el portal
  cree el `Consent`, ese manda.
- **Pantalla "Atender"**: badge junto al nombre (firmado con fecha / sin firmar /
  no verificable) y, al elegir una Terapia Biológica, el switch de R-03
  precargado si el paciente ya firmó.

## 6. Códigos de Biowellness (`policyRule`)

| Código | Cuándo | Estado |
| --- | --- | --- |
| `procesamiento-datos-salud` | Sube un PDF de laboratorio y autoriza procesarlo (Ley 25.326). | ✅ En producción |
| `atencion` | Consentimiento general de atención (onboarding). | ⏳ Falta el `Consent` (§3) |
| `uso-secundario` | Uso secundario de datos, opcional y revocable. | 💡 Sugerido (§4) |
| `terapia-biologica` | El que exige **R-03** para TB (péptidos, PRP, exosomas…). | ⏳ A definir si existe |

Viven en `src/fhir/identifiers.ts` (`COD_CONSENTIMIENTO`).

## 7. Resumen para su backlog

1. **Flujo B**: agregar el `Consent` de §3 (≈15 líneas, no toca lo existente).
2. **Actualizar el espejo** de la AccessPolicy y mandárnoslo para diffear — van
   tres entradas que vivieron solo en el servidor (Coverage HIP, ServiceRequest
   y Consent).
3. Evaluar §4 (uso secundario como `Consent`).
4. Definir si existe un consentimiento específico de **Terapias Biológicas**
   (R-03) y con qué código.
