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
