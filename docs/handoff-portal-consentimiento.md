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

## 8. Traza de la firma — respuesta al handoff del 2026-09-21

Los tres pedidos del portal, verificados contra el código. **Los dos primeros
están hechos**; el tercero es una decisión de Andrés.

### 8.1 Al leer el estado, gana el `Consent` ✅ (hecho)

`leerRegistrosConsentimiento` (`src/bots/_shared.ts`) ya no suma la fila del
`DocumentReference` cuando el paciente tiene un `Consent` de atención. El
diagnóstico del portal era correcto: `estadoConsentimiento` se queda con la
fecha MAYOR, así que un celular adelantado le ganaba al instante del servidor y
el arreglo se perdía en el badge de Atender.

⚠️ **El snippet propuesto (`if (registros.length === 0)`) no se puede usar tal
cual**: descarta los documentos apenas existe *cualquier* `Consent`, y hay tres
códigos (§6). Un paciente con `Consent` de terapia biológica y su firma de
atención vieja solo como documento pasaba a "no registrado", y R-20 le bloqueaba
las reservas. La condición quedó por **código**:

```ts
const tieneConsentDeAtencion = registros.some((r) => r.codigo === COD_CONSENTIMIENTO.atencion);
if (!tieneConsentDeAtencion) { /* … las filas del DocumentReference … */ }
```

De regalo arregla algo que no estaba en el pedido: la revocación toca el
`Consent` y **no** el `DocumentReference` (`ingreso-presencial` solo actualiza
Consent), así que un consentimiento dado de baja seguía leyéndose como firmado
por la fila del documento. Hay test de los cuatro casos, y de los dos mutantes.

**Sobre la vigencia**: tenían razón en que convenía resolverlo antes. Con una
sola fila por paciente, el día que se active `vigenciaMeses` no hay dos fechas
compitiendo. Sigue sin vencimiento hasta que Andrés defina otra cosa.

### 8.2 El kiosco deja la misma evidencia ✅ (hecho)

`bw-ingreso-presencial` tenía razón el reproche: su encabezado promete "la misma
evidencia que el portal" y no la daba.

- **`size` y `hash`** (SHA-1 en base64, lo que define FHIR R4) sobre los mismos
  bytes que van en `data`. Antes una firma del mostrador no se podía comprobar.
- **`Consent.dateTime`** sale ahora del `meta.lastUpdated` de la versión 1 del
  `DocumentReference`, igual que ustedes. El riesgo acá era chico —el reloj es
  el del runtime del bot, un servidor— pero sin esto las dos firmas no eran
  comparables campo a campo, que era el punto.
- **`DocumentReference.date` y `attachment.creation` siguen con el reloj del
  bot**, a propósito y por el mismo motivo que ustedes: es la hora que quedó
  **impresa dentro del texto** que el paciente leyó y firmó. Hay un test que
  verifica que coinciden con el texto.

Tomamos la aclaración de que el hash prueba integridad y no autoría, y quedó
escrita en el código: la comprobación que vale es contra la **versión 1**
(`/_history`), no contra la actual.

### 8.3 `AuditEvent` y `Provenance` — decisión de Andrés ⚠️

Gracias por esto: es el hallazgo más valioso del handoff y nos corrige algo que
dábamos por imposible. No lo activamos por nuestra cuenta porque las tres partes
son decisiones y no implementación:

1. **`saveAuditEvents` en `api.medplum.com.ar`**: audita CADA lectura. El
   volumen y el costo de almacenamiento son reales, y activarlo sin definir la
   purga es la clase de cosa que se descubre en la factura. Va con retención
   definida o no va.
2. **La IP detrás de nginx**: es nuestro y lo vamos a verificar. Si la confianza
   en el proxy no está configurada, todos los `AuditEvent` registran la IP del
   proxy y la evidencia no sirve para lo que se la quiere.
3. **`Provenance` con `Signature`**: coincidimos con ustedes en la **opción 2**
   (lo escribe un bot). Es consistente con "la app pide, el bot escribe" y no
   amplía la superficie de escritura del paciente — el mismo criterio por el que
   `bw-ingreso-presencial` existe en vez de dejar que Recepción escriba `Consent`.

Queda anotado en [`decisiones-pendientes.md`](decisiones-pendientes.md).
**Antes de decidir hay que confirmar la versión de Medplum en producción**: todo
el punto 3 sale de leer `packages/server` 5.1.39 y el repo acá fija `@medplum/core`
en **5.1.24**, que es la del cliente, no la del servidor.

## 7. Resumen para su backlog

1. **Flujo B**: agregar el `Consent` de §3 (≈15 líneas, no toca lo existente).
2. **Actualizar el espejo** de la AccessPolicy y mandárnoslo para diffear — van
   tres entradas que vivieron solo en el servidor (Coverage HIP, ServiceRequest
   y Consent).
3. Evaluar §4 (uso secundario como `Consent`).
4. Definir si existe un consentimiento específico de **Terapias Biológicas**
   (R-03) y con qué código.
