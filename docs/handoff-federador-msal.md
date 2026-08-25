# Federador de Pacientes (MSAL) — autocompletar el alta por DNI

> Estado: **la mitad que no depende del bus está hecha y testeada**
> (`src/lib/federador.ts`). Falta el token, y para eso falta un documento.
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

## Lo que falta: el token

Todos los endpoints piden `Authorization: Bearer <token generado por Bus Auth v2>`
y remiten a un documento **"Auth FHIR"** que no tenemos. Los dos sitios que lo
publican están **bloqueados por el proxy de egress** del entorno de desarrollo
(`guias.hl7.org.ar` y `simplifier.net` devuelven 403 en el CONNECT), así que no
se pudo leer desde acá.

**Lo que sí se puede deducir de nuestra propia pantalla de credenciales**, y
conviene confirmar antes de codificar:

- La pantalla muestra un **"Token secret word"** (con selector de longitud y
  botón *Regenerar*) y un **Issuer** que es nuestra URL. Eso sugiere un JWT
  firmado con **secreto compartido (HS256)** y `iss = https://api.medplum.com.ar`
  — no el esquema de clave pública RSA registrada.
- El `scope` va **en el body** del pedido de token, uno por servicio.

> ⚠️ Una exploración con un asistente de IA describió el flujo como OAuth2 + JWT
> con claims `iss` / `sub` / `aud` / `iat` / `exp`, firma RS256 **o** HS256, y
> tokens de vida corta (~15 min). Es **coherente** con lo anterior y sirve como
> hipótesis de trabajo, pero **no es fuente primaria**: no está verificado contra
> la documentación oficial y no se implementó nada en base a eso.

### Cómo destrabarlo (lo más rápido)

La misma pantalla de `dominios.msal.gob.ar` tiene, por servicio, los links
**"GET TOKEN FHIR"** y **Postman (QA / PROD)**. Esa colección de Postman trae el
endpoint exacto, el body y —si el JWT se arma del lado del cliente— el
*pre-request script* que lo construye. **Exportarla y leerla resuelve la duda sin
depender de ninguna doc bloqueada.**

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

1. **El token** (arriba). Es lo único bloqueante.
2. **Bot `bw-federador`**, solo lectura: token por scope + `GET Patient?identifier=…dni|…`
   + `leerPacienteFederado`. La *secret word* va como **Project Secret de
   Medplum**, nunca en `app/.env` (que se embebe en el bundle del navegador).
3. **UI**: en el alta, al tipear el DNI, ofrecer los campos y que la recepcionista
   confirme. Nunca escribir sin que alguien lo vea.
4. **Probar contra QA primero.** Es el único entorno de prueba real que tenemos:
   el repo no tiene staging propio.

## Dos preguntas que no son técnicas

- **¿A quién cubre el Federador?** Si solo tiene a quien ya pasó por el sistema
  público, el autocompletado sirve en una fracción de las altas. Define el valor
  real de todo esto y se responde con diez consultas contra QA.
- **Legal.** Consultar el Federador con el DNI de una persona es tratamiento de
  datos personales (Ley 25.326). Si entra en el consentimiento general que ya se
  firma o necesita mención propia lo define **Andrés con el asesor legal**.
