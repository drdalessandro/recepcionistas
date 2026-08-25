# Federador de Pacientes (MSAL) — autocompletar el alta por DNI

> Estado: **implementado y probado contra QA**. Todo lo que depende de nosotros
> funciona; el bus contesta `412 Missing organization authentication`, que es un
> requisito que falta **del lado del Ministerio**. Ver la sección homónima.
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

### Cómo se prueba: `npm run federador:check`

```bash
npm run federador:check                    # QA. Las dos capas.
npm run federador:check -- --dni 12497884  # con un documento concreto
npm run federador:check -- --solo-local    # sin tocar Medplum
npm run federador:check -- --prod          # producción, a propósito
```

**El ambiente lo decide el flag, nunca el `.env`.** Sin `--prod` es imposible que
este script le pegue a producción, que es lo que corresponde dado que el
environment de QA de Postman trae la URL productiva.

Prueba **dos capas separadas**, porque las credenciales viven en dos lados y
fallan igual:

| Capa | Con qué | Qué responde |
|---|---|---|
| 1 · local | `BUS_MSAL_*` del `.env` | ¿la *token secret word* sirve? |
| 2 · bot | Project Secrets de Medplum | ¿el servidor la tiene bien cargada, y el bot deployado? |

Sin esa separación, "no anda" son tres arreglos distintos con el mismo síntoma:
secret word equivocada, secret sin cargar, o bot sin deployar. El cruce de las
dos capas sale impreso al final.

Tres cosas que el script hace a propósito:

- **Nunca imprime el secreto.** Muestra una huella (`largo · sha256:…`) que
  alcanza para comparar el `.env` contra el servidor sin exponer nada.
- **Frena antes de ejecutar el bot** si el Project Secret `BUS_MSAL_URL` apunta a
  producción y no se pidió `--prod`. Enterarse por la respuesta del bot ya sería
  tarde: la consulta al padrón real ya habría ocurrido.
- **Distingue "no se pudo probar" de "falló".** Un proxy o una allowlist de
  egreso que corta el pedido devuelve texto plano, no JSON; reportar eso como
  "el bus rechazó la credencial" mandaría a cambiar una secret word que está
  bien. Es la misma disciplina que hizo falta en el bot.

> ⚠️ **`sin-resultados` contra QA no es una falla.** El Ministerio **no publica
> documentos de prueba**: la colección de QA usa el literal `dniPaciente` como
> placeholder. Que la búsqueda vuelva vacía significa que el circuito completo
> —firma → token → búsqueda → Bundle válido— funcionó.

> ⚠️ **Que tu máquina llegue al bus no garantiza que Medplum llegue.** Los bots
> salen desde AWS Lambda, con otra ruta de red. La Capa 2 es la única que prueba
> *esa* salida; la Capa 1 prueba la credencial.

## Lo que falta para terminarlo

1. ~~Cargar los tres Project Secrets y probar contra QA.~~ **Hecho** (2026-08-25).
   Los tres están cargados y el circuito llega al bus desde los dos lados. Falta
   destrabar el `412` — ver § "Missing organization authentication".
2. **UI**: en el alta, al tipear el DNI, ofrecer los campos y que la recepcionista
   confirme. **Nunca escribir sin que alguien lo vea**: el bot sugiere, la persona
   decide.
3. **Escribir el apellido paterno** en la ficha. El dato ya llega separado; falta
   verificar contra el servidor que Medplum persista `_family.extension` (los
   tipos no la modelan) antes de escribirla.

## "Missing organization authentication" — dónde estamos parados

**Primera corrida real contra QA, 2026-08-25.** El bus contestó:

```
POST https://bus-test.msal.gob.ar/bus-auth/v2/auth   →  HTTP 412
{"httpStatus":"PRECONDITION_FAILED","name":"IllegalState",
 "message":"Missing organization authentication","status":412}
```

### Lo que esto SÍ demuestra (y es casi todo lo que faltaba probar)

Es un resultado mucho mejor de lo que parece. Un 412 con cuerpo JSON estructurado
es **el bus hablando**, no un timeout ni un proxy ni un DNS que no resuelve:

- ✅ **Hay salida de red hasta el bus**, y desde los dos lados: desde la máquina
  de desarrollo y desde el Lambda de Medplum (el bot falló igual, no distinto).
- ✅ **El endpoint es el correcto** (`/bus-auth/v2/auth`) y acepta nuestro body.
- ✅ **Los tres Project Secrets están cargados** y coinciden con el `.env`
  (misma huella `sha256`), así que no hay nada desalineado.
- ✅ **El bot está deployado y llega**. `bw-federador` ejecuta, resuelve
  ambiente `qa`, y devuelve el error del bus.

Todo lo que dependía de nosotros funciona. Lo que falta está del otro lado.

### Lo que NO es

**No es la *token secret word*.** Un 412 *Precondition Failed* no discute la
firma: dice que falta un requisito previo. Una credencial mal firmada da 401/403
con un mensaje de tipo `invalid_client` o `invalid signature`. Cambiar la secret
word por este error es perder horas tocando algo que está bien.

> El diagnóstico **daba ese consejo equivocado** en su primera versión: concluía
> "lo más probable es que la token secret word no sea la correcta". Ya está
> arreglado (`clasificarErrorAuth` en `src/lib/bus-msal.ts`): ahora cita
> textualmente lo que dijo el bus y, ante una precondición, dice explícitamente
> que no se toque la credencial.

### Qué falta averiguar

Las dos guías técnicas que tenemos (Patient/FEDERADOR, 31 pp. y
Organization/REFES, 6 pp.) fueron leídas **enteras**: ninguna menciona el 412,
"organization authentication", ni ningún segundo paso de autenticación. Las dos
delegan el tema, con la misma frase literal repetida en cada endpoint:

> `Authorization: Bearer token generado por Bus Auth v2 (ver documento Auth FHIR).`

**Ese "documento Auth FHIR" es lo que nos falta, y tiene nombre propio.** Pedirlo
es el paso concreto: por diseño, ninguna guía de recurso va a explicar este
error.

### La causa más probable: **hay una SEGUNDA autenticación y no la estamos haciendo**

Esto sale de la **implementación de referencia del propio Ministerio** (el SGH,
Sistema de Gestión Hospitalaria), que documenta **dos validaciones distintas**:

```shell
# 1. Login de la APLICACIÓN — el que nos falta
curl -X POST '{bus}/masterfile-federacion-service/api/usuarios/aplicacion/login' \
  -d '{"nombre":"NOMBRE", "clave":"CLAVE", "codDominio":"..."}' \
  -H "Content-Type: application/json"
# → devuelve `token`

# 2. Token del DOMINIO — el que sí hacemos
curl -X POST '{bus}/bus-auth/auth' \
  -d '{"grantType":"client_credentials", "scope":"…", "clientAssertion":"<JWT>"}'
# → devuelve `accessToken`
```

Y su interceptor manda el primero como **header propio**, no como `Bearer`:

```java
headers.add("token", token.get());
headers.add("codDominio", renaperWSConfig.getDominio());
```

**`nombre`/`clave` → `token` es exactamente el mapeo de
`appName`/`appPassword` → `appAccessToken`** de los environments de Postman —
las tres variables que ninguna colección del Federador usa y que estaban ahí sin
explicación. Eso encaja con la palabra "organization" del error.

Confianza: **alta pero no confirmada.** Los hechos son duros (el SGH es del
Ministerio y el mapeo de nombres es exacto); lo que es inferencia nuestra es que
el flujo **v2** exija ese paso — la referencia del SGH usa `bus-auth/auth` (v1).
Ninguna fuente pública dice qué dispara ese mensaje: la cadena
`"Missing organization authentication"` tiene **cero resultados** en todo GitHub
y en la web indexada.

Dato de forma que lo respalda: el cuerpo del error (`httpStatus` + `name` +
`message` + `status`, sin ser un `OperationOutcome`) es el mapeo genérico de
Spring `@ExceptionHandler(IllegalStateException.class)` +
`@ResponseStatus(PRECONDITION_FAILED)`. O sea: el servidor **buscó** un registro
de autenticación de organización asociado a la credencial y **no lo encontró**.
No es "te falta un campo en el request".

### Lo que hay que conseguir

**Las credenciales de aplicación (`nombre` / `clave`).** La pantalla de
`dominios.msal.gob.ar` nos dio la *token secret word* del **dominio**; falta el
juego de la **aplicación**, que en los tres environments de Postman viene vacío.
Sin eso no se puede ni probar la hipótesis.

### Para consultarle al Ministerio

Cuatro preguntas, en orden de utilidad:

1. ¿Nos pueden dar las **credenciales de aplicación** (`appName` / `appPassword`,
   o `nombre` / `clave`) para el dominio 4002, y el `codDominio` que corresponde?
2. ¿El flujo de **Bus Auth v2** requiere el login de aplicación
   (`/api/usuarios/aplicacion/login`) **además** del `client_credentials` del
   dominio? ¿Ese token va como header `token` + `codDominio`, como en el SGH?
3. ¿Nos pueden pasar el **documento "Auth FHIR"** al que remiten todas las guías?
4. ¿El dominio 4002 está habilitado en **QA** (`bus-test.msal.gob.ar`) o solo en
   producción? ¿La *secret word* es la misma en los dos ambientes?

### Un segundo problema que vamos a chocar después

Independiente del 412, y conviene saberlo ahora: **nuestros claims de relleno
probablemente no sirvan.** Nosotros mandamos los literales `'aud'`, `'sub'`,
`'name'`, `'ident'`, `'role'` porque así están en la colección oficial, y así lo
documentamos. Pero las implementaciones **reales en producción** (SGH, y ANDES de
Neuquén) mandan valores con sentido:

| Claim | SGH (referencia del Ministerio) | Nosotros |
|---|---|---|
| `sub` | *"Nombre del dominio"* | `'sub'` |
| `name` | *"Apellido y Nombres del Usuario que accede"* | `'name'` |
| `role` | *"Especialidad del usuario"* | `'role'` |
| `ident` | *"Un identificador para el usuario"* | `'ident'` |
| `aud` | la URL del endpoint de auth | `'aud'` |

Y hay **deriva entre versiones de la documentación**: la guía de Simplifier dice
que `sub` es el `client_id` de la aplicación y `iss` la URL de la aplicación
(no del dominio), y agrega un claim `jti`. No se toca nada todavía —cambiarlo
ahora sería mover dos variables a la vez—, pero es la siguiente perilla si el
412 se destraba y aparece un error nuevo.

Mientras tanto **el alta funciona exactamente como hoy**: sin token, el bot
devuelve un motivo y la recepcionista tipea como siempre. Esto no bloquea nada.

## Lo que la guía técnica NO dice (leída entera, 31 páginas)

Vale la pena dejarlo escrito, porque son huecos reales del contrato y no
omisiones nuestras. Cada uno es algo que hoy resolvemos por inferencia y que la
primera corrida contra QA puede confirmar:

1. **No documenta el caso "no encontrado" de la búsqueda por DNI.** Para las
   búsquedas solo describe el 200, el 400 (system mal) y el 500 (parámetro
   nulo). Que un DNI no federado devuelva un `Bundle` con `total: 0` es el
   comportamiento FHIR estándar, **pero la guía no lo afirma**. Para el endpoint
   hermano (`GET /Patient/{id}`) sí documenta **404 + `OperationOutcome`** con
   `diagnostics: "… not found"`. Por eso el bot trata un **404 como
   `sin-resultados`** y no como caída: si fuera lo segundo, el caso más común de
   todos se vería como "el padrón no contesta". El `detalle` guarda cuál de las
   dos formas llegó.

2. **No hay documentos de prueba de QA.** La palabra "QA" no aparece en ninguna
   de las 31 páginas, y la colección de QA usa el literal `dniPaciente`. Los
   únicos documentos que existen son ejemplos de la doc, todos apuntando al host
   de **producción**: `23327755` (p. 6-7, el ejemplo de *esta* búsqueda),
   `12497884` y `21506540` (Anexo II). Ninguno tiene garantía de existir en QA.

3. **Un paciente federado puede no tener DNI.** El ejemplo completo del Anexo I
   (`ANTONIA MARIA VACCARO FALINO`, id 513298) **no tiene identifier de
   RENAPER**: tiene CI de la PFA y números de hospital. O sea que
   `sin-resultados` significa *"no hay nadie con ese documento"*, **no** "esa
   persona no está federada". Es un dato para la pregunta de cobertura de más
   abajo.

4. **No dice nada del JWT ni del `exp`.** Toda la autenticación la delega a otro
   documento; nuestros 5 minutos siguen siendo una elección nuestra sin respaldo
   ni contradicción. Por eso `federador:check` reintenta solo con el `exp` largo
   de la colección cuando el auth falla: si con ese entra, la perilla es esa.

5. **No hay rate limits ni cuotas documentadas.** Ninguna mención a 429 o
   throttling. Lo único acotable es el `count` del `$match`.

Dos rarezas del servicio que conviene tener presentes: usa **500** para
"parámetro vacío" (un error de cliente disfrazado de caída), y el **422** del
alta mezcla `severity: warning` con `severity: error` en el mismo `issue[]`.

## Dos preguntas que no son técnicas

- **¿A quién cubre el Federador?** Si solo tiene a quien ya pasó por el sistema
  público, el autocompletado sirve en una fracción de las altas. Define el valor
  real de todo esto y se responde con diez consultas contra QA. Ojo que hay
  **dos preguntas** acá, no una: cuánta gente está en el padrón, y de esa gente
  cuánta es **encontrable por DNI** — el Anexo I muestra que no son lo mismo.
- **Legal.** Consultar el Federador con el DNI de una persona es tratamiento de
  datos personales (Ley 25.326). Si entra en el consentimiento general que ya se
  firma o necesita mención propia lo define **Andrés con el asesor legal**.
