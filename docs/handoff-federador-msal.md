# Federador de Pacientes (MSAL) — autocompletar el alta por DNI

> Estado: **implementado de punta a punta** (`bw-federador`). Falta configurar
> los Project Secrets y probarlo contra QA.
> Fecha: 2026-08-25.

## Para qué

Hoy la recepcionista tipea nombre, apellido, fecha de nacimiento y género. Cada
uno de esos campos es una fuente de duplicados y de nombres mal escritos — el
**caso 2 del walk-in** fue exactamente eso: dos fichas de la misma persona sin un
solo campo en común. El Federador contesta todo eso a partir del **DNI**, que es
el dato que la persona ya trae.

Es el principio 1 del repo aplicado a la identidad: *la recepción no tipea lo que
el sistema puede resolver*.

## Lo que ya está verificado

| Cosa | Fuente | Estado |
|---|---|---|
| Biowellness está dado de alta como dominio | `dominios.msal.gob.ar/systems/4002/credentials/2741` | ✅ |
| **Issuer: `https://api.medplum.com.ar`** (nuestro propio Medplum) | idem | ✅ |
| Scopes: `Patient/*.read`, `Patient/*.write`, `Practitioner/*.read`, `Organization/*.read`, `Location/*.read`, `Immunization/*.read` | idem | ✅ |
| Hay **ambiente QA** además de producción | idem (Postman por ambiente) | ✅ |
| **Un token por servicio**, con su scope específico en el body — no todos juntos | recuadro "IMPORTANTE" de esa pantalla | ✅ |
| Endpoints y respuestas del Federador | guía técnica Patient/FEDERADOR OCT2025 | ✅ |
| `identifier` de RENAPER: `http://www.renaper.gob.ar/dni` | idem + perfil `Patient-ar-core` | ✅ |

Búsquedas disponibles: por id del federador, por identifier del federador, **por
DNI**, por apellido paterno, apellido+género, fecha de nacimiento+género,
teléfono+género, y `POST /Patient/$match` (matching probabilístico con nombre +
apellido paterno + fecha de nacimiento + género + un identifier, con `count`).

## Autenticación (Bus Auth v2) — verificado

Sale de la **colección de Postman oficial** del Federador (PacientesPROD,
OCT 2025), no de una deducción:

```
POST {busUrl}/bus-auth/v2/auth          (sin Authorization)
Content-Type: application/json

{
  "grantType": "client_credentials",
  "scope": "Patient/*.read",
  "clientAssertionType": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  "clientAssertion": "<JWT firmado>"
}
→ { "accessToken": "…" }
```

El `clientAssertion` es un **JWT HS256** firmado con la *token secret word* del
dominio:

| Claim | Valor |
|---|---|
| `iss` | la URL del dominio — para nosotros `https://api.medplum.com.ar` |
| `iat` / `exp` | segundos. **Nosotros usamos 5 minutos** (ver abajo) |
| `aud`, `sub`, `name`, `ident`, `role` | los **literales** `'aud'`, `'sub'`, … |

Después, cada llamada FHIR va con `Authorization: Bearer <accessToken>`.

**Tres cosas que conviene tener presentes:**

1. **Un token por servicio.** El `scope` va en el body y la pantalla de
   credenciales es explícita: si el dominio tiene varios habilitados, se manda
   **únicamente** el del servicio que se va a usar.
2. **Los claims de relleno se replican tal cual.** `aud: 'aud'`, `sub: 'sub'`…
   son literales en la colección oficial: el bus no los valida. "Mejorarlos" con
   valores que parezcan sensatos sería inventar un contrato que nadie especificó.
3. **El `exp` del ejemplo son ~69 días** (`iat + 6000000`) para una aserción de
   un solo uso. Usamos **5 minutos** (`ASSERTION_TTL_S`): un `exp` más corto
   nunca es más permisivo. Si el auth fallara, es la primera perilla a mover.

### El path del Federador no es el de la documentación

La guía muestra los ejemplos con `/fhir/Patient`, pero **todas las búsquedas de
la colección** usan `/masterfile-federacion-service/fhir/Patient`. Ese es el que
se usa.

### Secrets (en Medplum, nunca en el repo ni en `app/.env`)

| Secret | Valor |
|---|---|
| `BUS_MSAL_URL` | **QA: `https://bus-test.msal.gob.ar`** · producción: `https://bus.msal.gob.ar` |
| `BUS_MSAL_ISSUER` | `https://api.medplum.com.ar` |
| `BUS_MSAL_SECRET` | la *token secret word* de la pantalla de credenciales |

> ⚠️ **El environment "VARIABLES QA" de Postman trae la URL de PRODUCCIÓN**
> (`busUrl: https://bus.msal.gob.ar`), mientras que la colección de QA usa
> `bus-test.msal.gob.ar` **hardcodeado en las 10 requests** y nunca lee esa
> variable. Copiar el valor del archivo que dice "QA" significa consultar el
> registro nacional productivo con DNIs reales creyendo que se está probando.
> Las dos URLs están con nombre en `BUS_URLS` (`src/lib/bus-msal.ts`) y el bot
> **devuelve siempre `ambiente`** para que se pueda ver contra cuál habló.
>
> Si `BUS_MSAL_URL` no es ninguno de los dos, el bot devuelve `bus-desconocido`
> y **no firma nada**: un `http://` por error de tipeo mandaría el JWT en claro.

Sin los tres secrets, el bot devuelve `sin-credenciales` y no intenta nada: el
alta sigue funcionando exactamente como hoy.

**A confirmar**: si la *secret word* es la misma para QA y para producción, o si
hay un registro de credenciales por ambiente. Los dos environments traen el campo
vacío, así que de ahí no se deduce.

## Lo que ya está construido (`src/lib/federador.ts`)

Lógica pura, testeada contra el **ejemplo real del Anexo II** de la guía:

- `leerPacienteFederado()` — de su `Patient` a nuestros campos, incluidos el
  **apellido paterno y materno**, que vienen separados en `_family.extension`
  (`humanname-fathers-family` / `-mothers-family`).
- `elegirPorDni()` — cuál de los resultados es la persona: `unico`,
  `sin-resultados` o **`ambiguo`**. Con dos personas con el mismo documento **no
  elegimos por el usuario**: autocompletar con la ficha equivocada deja un dato de
  identidad que nadie revisó, y eso es peor que no autocompletar.
- `sugerenciaParaAlta()` — qué se completa, con dos reglas deliberadas:
  1. **Solo lo que falta.** Nunca pisa lo que la recepcionista ya escribió: ella
     tiene a la persona enfrente, el Federador tiene lo que había la última vez
     que alguien lo actualizó.
  2. **El teléfono no se autocompleta**, aunque venga. Es el canal por el que le
     escribimos: un número desactualizado del registro nacional manda los
     recordatorios —y el consentimiento— a un desconocido.
  3. De una persona **fallecida** no se sugiere nada: que lo resuelva un humano
     antes de abrir una ficha.

Esto además cierra un hueco que teníamos abierto: el perfil `Patient-ar-core`
exige el apellido paterno (`1..1`) y nosotros **no sabemos deducirlo** de un
nombre suelto ("Juan Pérez González" es ambiguo). El Federador sí lo sabe, así
que es la fuente natural de ese dato.

## Dos grafías de la extensión del apellido

Las **respuestas** del Federador y el perfil `Patient-ar-core` usan la forma
estándar de HL7 (`humanname-fathers-family`), pero los **bodies de ejemplo de la
colección** usan `humanname-fathersfamily`, sin el guion del medio. Se leen las
dos: mirar una sola deja el apellido paterno en `undefined` según de dónde venga
el recurso.

## Contradicción a tener presente

En la respuesta **real** del Federador, el DNI de RENAPER viene con
`use: "usual"` y el id del propio federador con `use: "official"`:

```jsonc
{ "use": "official", "system": "https://federador.msal.gob.ar/patient-id", "value": "5025175" },
{ "use": "usual",    "system": "http://www.renaper.gob.ar/dni",            "value": "12497884" }
```

El perfil `Patient-ar-core` fija **lo contrario**: `DocumentoUnico` (RENAPER) con
`use: official` e `IdentificadorDominio` con `use: usual`. Perfil *draft* de 2021
contra sistema en producción de 2025.

**Nosotros seguimos el perfil.** El `use` no afecta ninguna búsqueda (los token
search van por `system|value`), así que la elección no tiene consecuencia
funcional — pero si algún día federamos una ficha (`POST /Patient`, que el scope
`Patient/*.write` habilita), hay que confirmar cuál espera el bus.

## Lo que falta para terminarlo

1. **Cargar los tres Project Secrets** y probar contra **QA**
   (`https://bus-test.msal.gob.ar`, ver la advertencia de arriba).
2. **UI**: en el alta, al tipear el DNI, ofrecer los campos y que la recepcionista
   confirme. **Nunca escribir sin que alguien lo vea**: el bot sugiere, la persona
   decide.
3. **Escribir el apellido paterno** en la ficha. El dato ya llega separado; falta
   verificar contra el servidor que Medplum persista `_family.extension` (los
   tipos no la modelan) antes de escribirla.

## Dos preguntas que no son técnicas

- **¿A quién cubre el Federador?** Si solo tiene a quien ya pasó por el sistema
  público, el autocompletado sirve en una fracción de las altas. Define el valor
  real de todo esto y se responde con diez consultas contra QA.
- **Legal.** Consultar el Federador con el DNI de una persona es tratamiento de
  datos personales (Ley 25.326). Si entra en el consentimiento general que ya se
  firma o necesita mención propia lo define **Andrés con el asesor legal**.
