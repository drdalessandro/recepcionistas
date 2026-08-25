# Modelo de datos FHIR R4

Recursos FHIR estándar con extensiones custom donde el estándar no cubre el caso
(Documento de Requerimientos v4, §4). Las extensiones viven bajo el namespace
`https://biowellness.ar/fhir/StructureDefinition/...` (ver `src/fhir/identifiers.ts`).
Naming: **kebab-case**.

## Recursos y extensiones

| Recurso FHIR | Uso | Extensiones custom |
|---|---|---|
| **Patient** | Ficha del paciente | `tipo-cliente`, `tag-fm`, `tc-bloqueo-fm`, `perfil-clinico`, `origen-lead`, `fecha-alta` |
| **Practitioner** | Médicos, terapeutas, enfermeras | `split-porcentaje`, `tipo-contrato` |
| **Schedule / Slot** | Disponibilidad de recursos físicos | `recurso-fisico`, `comparte-tumbona` |
| **Appointment** | Turno reservado · **espera de lugar** (`status: waitlist`) | `orden-protocolo`, `requiere-hbot-previo`, `ocupantes`, `espera-dias`, `espera-franjas` |
| **Encounter** | Visita ejecutada (check-in/out) | `recursos-usados`, `duracion-real` *(slices posteriores)* |
| **CarePlan** | Protocolo de tratamiento | `ciclo-semanas`, `perfil-clinico` |
| **ActivityDefinition** | Catálogo de servicios | `precio-usd`, `regla-pricing-recurso`, `split-bw`, `requiere-prescripcion` |
| **PlanDefinition** | Combos / membresías / paquetes | `secuencia-ordenada`, `descuento-combo`, `tier`, `sesiones-mes`, `precio-usd`, `precio-usd-lista`, `duracion-min`, `sesiones`, `vigencia-dias`, `descuento-fm`, `descuento-a-la-carte`, `es-pareja` |
| **Coverage / Contract** | Membresía activa (por paciente) | `tier`, `version`, `sesiones-mes`, `sesiones-usadas`, `precio-bloqueado-fm` |
| **Invoice / ChargeItem** | Cobros y splits | `monto-split-bw`, `monto-split-profesional`, `tc-aplicado` |
| **Communication** | WhatsApp y emails | `canal`, `template-usado` |
| **Location** | Recurso físico (sala/equipo) | (identificado por `SYSTEM.recursoCodigo`) |
| **CodeSystem** | Tabla de contraindicaciones | propiedades `severidad`, `aplicaA`, `borrador` |
| **Basic** | Configuración (TC vigente) · caja chica · **demanda no cubierta** | `tc-aplicado`, `caja-monto-ars`, `demanda-clave` |
| **AuditEvent** | Log regulatorio (nativo Medplum) | — |

## Decisiones de modelado del Bloque 0

- **Catálogo:** los servicios se modelan como `ActivityDefinition` (con el precio en
  la extensión `precio-usd`); combos, membresías y paquetes como `PlanDefinition`
  diferenciados por `type.text` (`combo` / `membership` / `package`).
- **Recursos físicos:** `Location` + `Schedule` (uno por recurso). La extensión
  `comparte-tumbona` marca los gabinetes Recovery Pro que comparten las 2 tumbonas
  Red Light (cuello de botella de agenda, R-07).
- **Tipo de cambio:** recurso `Basic` con identifier `config-tipo-cambio` y la
  extensión `tc-aplicado`; el bot de cobro lo lee como TC vigente (configurable
  por el admin).
- **Demanda no cubierta** (lo que piden en el mostrador y no ofrecemos):
  `Basic` con code `CodeSystem/demanda|no-disponible`, el pedido textual en
  `code.text`, la clave de agregación en `demanda-clave` y `subject` = quien lo
  pidió (para poder avisarle si algún día lo sumamos). Recurso propio y no un
  campo del lead a propósito: el lead solo se crea si la persona es nueva, y así
  se cuenta con una búsqueda estándar (`Basic?code=…|no-disponible`) en vez de
  leer las tarjetas del CRM una por una.
- **Lista de espera** (no hay lugar y quiere venir): `Appointment` con
  `status: waitlist` —el estado que FHIR R4 tiene para exactamente esto— y la
  ventana en `requestedPeriod`. No hay recurso nuevo: quien espera es alguien que
  quiere un turno, y cuando se concreta es el mismo tipo de recurso. Efecto
  práctico: **no aparece en la agenda**, porque todas las pantallas y bots buscan
  turnos por `date=ge…` (que en R4 es `Appointment.start`) y una espera no tiene
  `start`. Lo único que el estándar no modela es la preferencia dentro de la
  ventana ("martes o jueves, a la tarde"), y sin eso el aviso se vuelve ruido:
  por eso van `espera-dias` (CSV con la convención de `Date.getDay()`) y
  `espera-franjas` (`manana|tarde|noche`). Vacías = cualquiera.
- **Documento del paciente: DOS identifiers, a propósito.** La ficha lleva el DNI
  dos veces:
  - `https://biowellness.ar/fhir/Identifier/dni` — el nuestro, histórico. Guarda
    el valor **tal como se tipeó** (`"30.123.456"`). Las fichas viejas y sus
    búsquedas dependen de esa forma, así que no se re-normaliza.
  - `http://www.renaper.gob.ar/dni` — el **canónico nacional**, siempre
    normalizado a dígitos (`"30123456"`). Es el system con el que el Federador de
    Pacientes del Ministerio de Salud y el resto del ecosistema nombran a una
    persona (guía técnica Patient/FEDERADOR, OCT2025).

  Cuesta un renglón y vuelve la ficha cruzable con cualquier otro sistema sin
  tabla de equivalencias ni migración posterior — el mismo criterio que ya
  usamos con el CRM: cuando el otro ya tiene un identificador, se usa el suyo.
  El alta escribe los dos y **busca por los dos** (`busquedaPorDni`): una ficha
  que solo tuviera el canónico sería invisible y terminaría en un duplicado.
  Ojo con el `http://` — el token search de FHIR compara el string exacto.
  Construcción en `src/fhir/paciente.ts`; fichas anteriores:
  `npm run migrar:dni-renaper` (aditivo e idempotente).

  **No es una invención nuestra: es lo que exige el perfil nacional.**
  [`Patient-ar-core`](http://fhir.msal.gob.ar/core/StructureDefinition/Patient-ar-core)
  (v0.5.0, DNSIS · Ministerio de Salud / HL7 Argentina) pide `identifier` **2..\***
  con dos slices obligatorios discriminados por `use`:

  | Slice | `use` | `system` |
  |---|---|---|
  | `DocumentoUnico` (1..1) | `official` | fijo: `http://www.renaper.gob.ar/dni` |
  | `IdentificadorDominio` (1..1) | `usual` | el del dominio — el nuestro |

  Por eso los identifiers llevan `use`: es la dimensión por la que el perfil
  slicea, y sin él la ficha no conforma aunque los dos systems estén bien.

### Qué falta para conformar `Patient-ar-core`

El perfil deriva de `Patient-uv-ips` y pide, además de lo de arriba:

| Requisito | Estado |
|---|---|
| `identifier` 2..* con `use` (arriba) | ✅ |
| `active` 1..1 fijo en `true` | ✅ (el alta lo escribe) |
| `name:NombreLegal` con `use: official` | ✅ |
| `family.extension:FathersLastName` **1..1** (`humanname-fathers-family`) | ❌ **falta** |
| `family.extension:MothersLastName` 0..1 | ❌ falta |
| `name:NombreElegido` 0..1 (`use: usual`) — nombre elegido, Ley 26.743 | ✅ (2026-08-25) — campo opcional del alta; va **primero** en `name`, así `getDisplayString` y los `name[0]` de los bots muestran el elegido en todos lados sin tocar cada pantalla. El legal queda como `official` (lo buscan por `use` el Federador y lo fiscal). |

Los dos apellidos **no se escriben adivinando**: el alta recibe un nombre
completo y lo parte en dos, y de "Juan Pérez González" no se deduce si el
apellido paterno es "Pérez" o si el compuesto es "Pérez González". Inventarlo
sería poner en la ficha un dato de identidad que nadie afirmó. Además va en
`_family` (extensión de un primitivo), que los tipos de Medplum no modelan: hay
que verificar contra el servidor que lo persista antes de escribirlo. La fuente
natural es el Federador, que ya lo devuelve separado.

> Ojo con la cardinalidad: un **lead sin documento** (el curioso del mostrador)
> no puede conformar `identifier` 2..*, y está bien — el perfil es para
> intercambiar pacientes, no para el CRM interno. Se conforma cuando hay
> documento.
- **Contraindicaciones:** `CodeSystem` en estado `active` — tabla validada por el
  Director Médico (Dr. Conrado López Alonso, 2026-08-09). Una entrada nueva sin
  validar (`borradorPendienteRevision`) lo vuelve a `draft` hasta su aprobación.
  El banner que ve la recepción es una señal binaria verde/rojo; el detalle
  clínico nunca se expone a recepción.
- **Leads / prospectos:** a definir en el Bloque 0 (modelar como `Task` + perfil
  liviano que se promueve a `Patient` al convertir). Aún no implementado.

## Privacidad por diseño

La `AccessPolicy` de recepción (*Operativo*) **solo lista recursos operativos**
(agenda, cobros, comunicación, CRM, catálogo). Los recursos clínicos
(`Observation`, `Condition`, `DiagnosticReport`, `DocumentReference`, `CarePlan`,
`MedicationRequest`) **no se listan**, por lo que quedan denegados por defecto. La
historia clínica completa queda reservada al equipo médico (Ley 26.529 / 25.326).
