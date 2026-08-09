# Modelo de datos FHIR R4

Recursos FHIR estándar con extensiones custom donde el estándar no cubre el caso
(Documento de Requerimientos v4, §4). Las extensiones viven bajo el namespace
`https://biowellness.ar/fhir/StructureDefinition/...` (ver `src/fhir/identifiers.ts`).
Naming: **kebab-case**.

## Recursos y extensiones

| Recurso FHIR | Uso | Extensiones custom |
|---|---|---|
| **Patient** | Ficha del paciente | `tipo-cliente`, `tag-fm`, `tc-bloqueo-fm`, `perfil-clinico`, `origen-lead` |
| **Practitioner** | Médicos, terapeutas, enfermeras | `split-porcentaje`, `tipo-contrato` |
| **Schedule / Slot** | Disponibilidad de recursos físicos | `recurso-fisico`, `comparte-tumbona` |
| **Appointment** | Turno reservado | `orden-protocolo`, `requiere-hbot-previo`, `ocupantes` |
| **Encounter** | Visita ejecutada (check-in/out) | `recursos-usados`, `duracion-real` *(slices posteriores)* |
| **CarePlan** | Protocolo de tratamiento | `ciclo-semanas`, `perfil-clinico` |
| **ActivityDefinition** | Catálogo de servicios | `precio-usd`, `regla-pricing-recurso`, `split-bw`, `requiere-prescripcion` |
| **PlanDefinition** | Combos / membresías / paquetes | `secuencia-ordenada`, `descuento-combo`, `tier`, `sesiones-mes`, `precio-usd` |
| **Coverage / Contract** | Membresía activa (por paciente) | `tier`, `version`, `sesiones-mes`, `sesiones-usadas`, `precio-bloqueado-fm` |
| **Invoice / ChargeItem** | Cobros y splits | `monto-split-bw`, `monto-split-profesional`, `tc-aplicado` |
| **Communication** | WhatsApp y emails | `canal`, `template-usado` |
| **Location** | Recurso físico (sala/equipo) | (identificado por `SYSTEM.recursoCodigo`) |
| **CodeSystem** | Tabla de contraindicaciones | propiedades `severidad`, `aplicaA`, `borrador` |
| **Basic** | Configuración (TC vigente) | `tc-aplicado` |
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
