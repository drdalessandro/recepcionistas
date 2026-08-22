# Mapeo a FHIR R4 del motor de agenda — Biowellness

**Shanti Om SRL · San Isidro · Backend Medplum (FHIR R4, `api.medplum.com.ar`)**
Estado: propuesta de arquitectura. Los puntos marcados **[Andrés]** son cambios de regla de negocio *core* o de arquitectura y, por `CLAUDE.md` §Gobernanza, no se implementan sin consulta previa.

---

## 1. Qué mapea este documento

El motor de agenda de Biowellness ya tiene un modelo de dominio cerrado en `src/motor-agenda/` (recursos con `setup/terapia/turnaround`, combos como secuencias encadenadas, etapas internas de Recovery Pro, titularidades, pausas, Founding Member, franja clínica, ventanas de reserva). Ese modelo es deliberadamente agnóstico de FHIR: en `src/motor-agenda/dominio/tipos.ts` no entra ni un `Reference`. Este documento es la otra mitad: **cómo se proyecta ese dominio sobre FHIR R4 en Medplum, y qué NO se proyecta**.

El principio que lo guía es uno solo y se aplica en este orden: **la regla de negocio se hace cumplir en una función pura de `src/lib` o `src/motor-agenda`; FHIR guarda el hecho y lo hace consultable.** No al revés. Toda vez que una propuesta prometió "enforcement" por la vía de la forma de los datos —no sembrar Slots libres, marcar un `Slot.status`, poner un `intent`— la verificación contra el código de este repo mostró que no enforcea nada, porque la disponibilidad se computa en memoria y la reserva escribe su propio `Slot busy`. Esa asimetría está documentada explícitamente en cada sección.

El segundo criterio es **campo nativo antes que extensión, y extensión antes que `SearchParameter` custom** — no por purismo, sino porque un `SearchParameter` nuevo cuesta un reindexado manual de todos los recursos existentes, con un modo de falla silencioso que el propio repo advierte en `src/fhir/search-parameters.ts`.

El tercero es **no romper contratos vigentes**: el de pagos con el repo `administracion` (`Invoice` balanced/issued/cancelled + `ChargeItem` con `linea-comercial`), el del Panel Bio (`Appointment.serviceType`/`serviceCategory` como registro de la terapia efectiva) y el del portal del paciente (la `AccessPolicy` espejada en `portal/docs/medplum/access-policy-paciente-portal.json`, que ya se rompió tres veces por olvidar sincronizarla).

Todo lo verificado se verificó contra `node_modules/@medplum/fhirtypes@5.1.24` y contra el código del repo. **`@medplum/definitions` no está instalado** (no hay ningún `search-parameters*.json` en el árbol), así que ninguna afirmación sobre *search parameters* ni sobre *binding strength* pudo comprobarse contra un archivo: donde una decisión se apoya en un search param, está marcada como pendiente de smoke test contra el servidor. Y `@medplum/fhirtypes` no es R4 puro —trae `HealthcareService.offeredIn`, que es R5—, así que los `.d.ts` prueban qué acepta Medplum, no qué está en la spec.

---

## 2. Tabla resumen

| Concepto de dominio | Recurso(s) FHIR R4 | Campo / extensión clave |
|---|---|---|
| Tramo de combo (uno por recurso) | `Appointment` | `start`/`end`, `serviceType`, `serviceCategory`, `slot[]`, ext. `recurso-fisico`, `orden-protocolo`, `ocupantes` |
| Instancia de combo (la cabecera) | `ServiceRequest` + `Appointment.basedOn` | `requisition` (system `CodeSystem/combo`), `occurrencePeriod`, `code`, `category` |
| Índice denormalizado del combo | `Appointment.identifier` | `system = https://biowellness.ar/fhir/CodeSystem/combo` (**ya en producción, no se toca**) |
| Ejecución de la visita | `Encounter` | `appointment[]`, `class = AMB`, `location[]` con `period`, `type` (programa) |
| Unidad física reservable | `Location` hoy → `Device` (unidades con identidad de mantenimiento) | `identifier` `CodeSystem/recurso-fisico`, `Device.location`, `Location.partOf` |
| Agenda de una unidad | `Schedule` | `identifier` `SCH_{codigo}`, ext. `recurso-fisico`, `comparte-tumbona` |
| Bloqueo de una unidad en una ventana | `Slot` (`status: busy`) | ext. `recurso-fisico` + ext. `ocupantes` (**sin las dos, el motor no lo ve**) |
| Capacidad / mínimo operativo / exclusividad | `Schedule.extension` (+ espejo en `Device.property`) | `capacidad`, `minimo-operativo`, `reserva-exclusiva` |
| Sub-reserva de tumbona (Recovery Pro) | mismo `Appointment`, N+1 `Slot` | `Appointment.slot[]` (0..\*) + `participant.period` |
| Programa clínico vs bienestar | `Appointment.serviceCategory[1]`, `Slot.serviceCategory`, `Encounter.type`, `ServiceRequest.category` | `CodeSystem/programa` = `clinico` \| `bienestar` |
| Titularidad de membresía / paquete | `Coverage` | ext. `tipo-cobertura`, `plan-codigo`, `sesiones-mes`, `sesiones-usadas`, `ciclo-mes` |
| Mora (estado `en-mora`) | `Flag` | `code.coding.system = CodeSystem/bloqueo`, code `PAGO_RECHAZADO` (**ya existe**) |
| Libro mayor de saldo | `Basic` | `code = CodeSystem/movimiento-saldo`, ext. `movimiento-delta`, `movimiento-instante`, `movimiento-reserva` |
| Pausa de membresía | `Task` | `code = CodeSystem/task-tipo\|pausa-membresia`, `focus → Coverage`, `authoredOn`, `executionPeriod` |
| Autorización médica (R-03) | `ServiceRequest` + `Appointment.basedOn` | `intent = order`, `category`, `occurrencePeriod` **obligatorio**, `requester → Practitioner` |
| Perfil clínico | `Observation` + `Patient.extension` | `code = CodeSystem/observacion\|perfil-clinico`, `valueCodeableConcept`, ext. `perfil-clinico` |
| Lista de precios versionada | `ChargeItemDefinition` (uno por ítem × versión) + `Library` manifiesto | `url` (1..1) + `version` (`AAAA-MM`), `propertyGroup.priceComponent.amount` |
| `fm_price_list_version` | `Patient.identifier` | `system = https://biowellness.ar/fhir/Identifier/lista-precios-fm` |
| Cobro contra una versión | `ChargeItem` | `definitionCanonical` (`url\|version`), `priceOverride` (ARS), ext. `tc-aplicado` |

---

## 3. Decisiones

### 3.1 Agrupación de los tramos de un combo

**Decisión.** Cada tramo sigue siendo su propio `Appointment`, como hoy. Se agrega una cabecera `ServiceRequest` por instancia de combo, referenciada desde `Appointment.basedOn`, y se **conserva sin tocar** el `Appointment.identifier` con `system = https://biowellness.ar/fhir/CodeSystem/combo`. El `ServiceRequest.requisition` reusa **ese mismo system**, no uno nuevo. El `Encounter` queda como registro de ejecución, no de agrupación.

**Por qué.** `Appointment.basedOn` es `Reference<ServiceRequest>[]` y `ServiceRequest` es el único tipo que acepta: no hay elección. La cabecera resuelve tres cosas que hoy no tienen dónde vivir: la ventana completa del combo (minuto 0 al 150, que ningún `Appointment` representa porque `start`/`end` son 0..1 cada uno), la cobertura que lo paga (`insurance → Coverage`) y, para IV/TB, la autorización médica. Conservar el `identifier` no es conservadurismo: `_shared.ts`, `vencer-tentativas.ts:73` y `recordatorios.ts:77` agrupan hoy por él, y cambiarlo sería una migración sin beneficio. Dos claves para el mismo hecho es aceptable mientras sean el **mismo system** y las escriba el mismo bot; dos systems para el mismo UUID no.

Sobre el `Encounter`: hoy `estado-turno.ts` crea **uno por Appointment**, así que un BIO LONGEVITY genera tres. Consolidarlo a uno por visita es correcto, pero **no se hace sin arreglar `cerrarEncounter` en el mismo commit**: esa función busca el Encounter por `appointment=Appointment/{id}` y le pone `status='finished'`, de modo que con un Encounter compartido, terminar el tramo de HBOT cerraría la visita con el IHHT y el Recovery Pro sin ejecutar. La corrección es condicionar el cierre a que todos los hermanos del combo (por `identifier`) estén en estado terminal. Hasta entonces, sigue uno por tramo. **[Andrés]** — además hay que verificar si `administracion` cuenta `Encounter` como proxy de visitas antes de cambiar la cardinalidad.

**Alternativas descartadas.**
- **`Appointment.partOf` apuntando a un Appointment cabecera.** El campo no existe en R4 ni en R5. Verificado: no hay ninguna propiedad `partOf` en `Appointment.d.ts`.
- **`Appointment.encounter`.** Tampoco existe. La dirección del puntero en R4 es la inversa: `Encounter.appointment?: Reference<Appointment>[]` (0..\*, `Encounter.d.ts:202`). Ir del tramo al grupo cuesta una búsqueda inversa.
- **`Encounter` como agrupador creado al reservar.** Es legal (`status: 'planned'` existe) pero modela el *contacto*, no el *pedido*: el combo se agenda antes de que haya visita, un combo que nunca se ejecuta deja un Encounter huérfano en el compartimento clínico del paciente, y ampliar la escritura de recepción sobre `Encounter` tiene costo de `AccessPolicy`.
- **Un solo `Appointment` para todo el combo con varios `slot`.** `Appointment.slot` sí es 0..\* (`Appointment.d.ts:218`), pero `start` y `end` son 0..1: un `Appointment` expresa **una** ventana continua. Bloquearía conceptualmente 0→150 y perdería que el HBOT sólo ocupa 0→60. Además mezclaría los tres servicios en `serviceType`/`serviceCategory` y `clasificacionDeServicio()` dejaría de poder atribuir la exposición acumulada de HBOT al tramo correcto — que es el motivo documentado por el que esos campos existen.
- **`Appointment.previousAppointment` / `recurrenceId` (R5).** Medplum 5.1.24 es R4. `previousAppointment` es el campo correcto para una serie encadenada y `recurrenceId` es para series *recurrentes* (la membresía, no el combo), pero **no pude verificar los search params de R5**: `@medplum/definitions` sólo trae R4 y el proxy bloquea `hl7.org`. Cualquier plan de migración tiene que confirmarlo primero.

**Búsquedas que habilita.**
```http
GET /Appointment?based-on=ServiceRequest/sr-combo-9f3a&_sort=date
GET /ServiceRequest?requisition=https://biowellness.ar/fhir/CodeSystem/combo|9f3a…
GET /Appointment?identifier=https://biowellness.ar/fhir/CodeSystem/combo|9f3a…   # la que YA se usa
GET /Appointment?based-on=ServiceRequest/sr-combo-9f3a&status=cancelled           # cascada R-14
GET /Encounter?appointment=Appointment/appt-tramo-2
GET /ServiceRequest?subject=Patient/pac-123&status=active&_sort=-authored
```

---

### 3.2 Sub-reserva de la tumbona en Recovery Pro

**Decisión.** El tramo Recovery Pro es **un solo `Appointment`** con **1 + N `Slot`**, donde N = ocupantes: el `Slot` del gabinete cubre la ventana completa del tramo y cada `Slot` de tumbona cubre sólo la etapa 28→48. Cada `Slot` de tumbona lleva **obligatoriamente** `EXT.recursoFisico` y `EXT.ocupantes`. Las tumbonas van además como `participant.actor` con `participant.period` acotado a la sub-ventana.

**Por qué.** Recovery Pro es un servicio, un cobro (USD 200 indivisible) y un tramo del protocolo: un segundo `Appointment` inflaría el conteo de sesiones y aparecería como fila fantasma en la agenda. `Appointment.slot` es 0..\* y el repo **ya usa slot múltiple** (`reservar-turno.ts` mete el slot del recurso y el de la agenda del médico), así que hay precedente. Y la liberación en cascada de `estado-turno.ts`, que recorre `appt.slot` y pone todos en `free`, es *correcta* acá porque los N+1 slots pertenecen a la misma reserva.

N = ocupantes, no 1: `BIO_LONGEVITY_PAREJA` declara `['RECOVERY_PRO', 60, 2]` y el dominio es explícito — `EtapaInterna.ocupa: { pool }` es "una tumbona por ocupante" y `PedidoDeTumbonas.cantidad` dice lo mismo. Con dos tumbonas en la sala, una pareja consume el pool entero en esa ventana, y **eso no es un efecto colateral: es exactamente lo que hace cierto el desfasaje de R-07**, como documenta `pool-tumbonas.ts`.

Las extensiones en el `Slot` no son adorno: `cargarReservasEnRango` (`_shared.ts`) filtra `Slot?status=busy`, **descarta todo Slot sin `recurso-fisico`** y asume 1 ocupante si falta `ocupantes`. Un Slot de tumbona sin ellas sería invisible para la disponibilidad y produciría sobreventa silenciosa.

**Precondición bloqueante.** Las dos tumbonas de la sala **no existen hoy como recursos**. `src/config/recursos.ts` tiene 14 recursos y una sola tumbona (`R_RED_LIGHT`, la standalone); las de la sala se modelan implícitamente como la clave compartida `TUMBONAS_RECOVERY` en `comparteCon` de los dos gabinetes, más la extensión booleana `comparte-tumbona` en el `Schedule`. Darlas de alta no es "agregar dos recursos": es **reemplazar el mecanismo con el que hoy se hace cumplir R-07**, y toca los tres call sites de `compartenEquipo()`, `recursosParaCategoria('RED_LIGHT')` (pasaría de devolver 1 a 3, habilitando que un Red Light suelto caiga en la sala — que es lo que la direccionalidad quiere, pero hay que decirlo) y el seed. **[Andrés]**. Mientras eso no ocurra, el mapeo vigente sigue siendo `comparte-tumbona` y el desfasaje heurístico; los dos mecanismos **no pueden convivir**.

La direccionalidad del pool (Recovery Pro sólo toma las de la sala; los externos prefieren la standalone) **no va a FHIR**. FHIR guarda dónde está cada tumbona (`Device.location` o `Location.partOf`); el orden de preferencia es política y ya vive donde corresponde, en `src/motor-agenda/agenda/pool-tumbonas.ts`, donde la ausencia de `'standalone'` en la lista *es* la regla.

**Alternativas descartadas.**
- **Un segundo `Appointment` para la tumbona.** Duplica el hecho comercial, infla el conteo de sesiones y obliga a decidir qué `item-tipo`/`item-codigo` lleva.
- **Sólo `participant.period`, sin `Slot` propio.** El campo existe y es semánticamente perfecto (`Appointment.d.ts:331`), pero el motor no lo lee: la ocupación se calcula desde `Slot?status=busy`. Queda como capa declarativa e interoperable; el `Slot busy` es el que hace cumplir.
- **Una sola `Location` "pool de tumbonas" con capacidad 3.** Pierde la identidad de cada unidad, y la identidad es justamente lo que la direccionalidad necesita: con un contador agregado se sabe "quedan 2 libres" pero no *cuáles*.

**Búsquedas que habilita.**
```http
GET /Slot?schedule=Schedule/SCH_R_TUMBONA_SALA_1&status=busy&start=ge2026-09-03T00:00:00-03:00
GET /Appointment?location=Location/loc-tumbona-sala-1&date=ge2026-09-03   # requiere participant.actor
GET /Location?partof=Location/loc-sala-recovery
```
Las dos últimas **hoy devuelven vacío**: ningún `Appointment` lleva la `Location` como participant, y `buildLocation` no emite `partOf`. Ver §5.

---

### 3.3 Programa clínico y plantillas de Slot

**Decisión.** El programa (`clinico` | `bienestar`) se escribe como **segunda entrada** de `Appointment.serviceCategory`, con `system = https://biowellness.ar/fhir/CodeSystem/programa`, **siempre anexada, nunca antepuesta**; y en `Slot.serviceCategory`, `Schedule.serviceCategory`, `Encounter.type` y `ServiceRequest.category`. **El enforcement de la franja 12:00–17:00 L–V no vive en FHIR: vive en `src/motor-agenda/reglas/calendario.ts`**, que ya lo implementa (`verificarFranjaClinica` y `esReservaClinica`, con "toda IV y toda TB son clínicas sin excepción, se pidan como se pidan").

**Por qué.** La idea de "no sembrar Slots libres fuera de la ventana y que la ausencia de hueco haga cumplir la regla" **no funciona en este repo**, y conviene ser explícito porque es un modo de falla silencioso con apariencia de control: `src/lib/disponibilidad.ts` genera la grilla en memoria con `generarSlots()` sobre `HORARIO_SEMANAL` (08:00–22:00) y **nunca consulta `Slot?status=free`**; y `reservar-turno.ts` / `reservar-combo.ts` **crean un `Slot busy` nuevo** en lugar de consumir el libre sembrado. Los `Slot free` del seed y los `Slot busy` de la reserva son dos poblaciones paralelas que no se tocan (salvo la agenda publicada de médicos). Dejar de sembrar Slots de `R_SALA_TB` a las 09:00 no impediría absolutamente nada, y además rompería `src/seed/diagnostico-agenda.ts`, que cuenta libres por Schedule.

Por eso el `serviceCategory` del `Slot` es **dato declarativo e interoperable** —vale, y hay que escribirlo—, pero no se lo puede vender como control. El control es la función pura, que ya existe y ya está testeada.

**Precondición obligatoria.** `_shared.ts:1515` y `src/fhir/lista-espera.ts:68` leen la categoría con índice posicional: `a.serviceCategory?.[0]?.coding?.find(c => c.system === SYSTEM.categoriaServicio)`. Hoy funciona porque el array tiene un solo elemento. **Antes de escribir la segunda entrada hay que aplanar**: `a.serviceCategory?.flatMap(cc => cc.coding ?? []).find(...)`. Si no se hace, el síntoma es silencioso y caro (la lista de espera deja de matchear huecos liberados). Y el programa debe ir anexado porque `tests/clasificacion-servicio.test.ts` y `tests/lista-espera.test.ts` assertean `serviceCategory[0].coding[0]`.

**Alternativas descartadas.**
- **`Appointment.appointmentType` / `Slot.appointmentType`.** Son 0..1 —un solo valor— con binding *preferred* a `v2-0276`, cuyo eje es el estilo del turno (ROUTINE, WALKIN, CHECKUP). Gastarlos en "programa" deja sin lugar al eje que FHIR les asignó. Se dejan libres para distinguir walk-in de turno agendado, que este repo todavía no modela (verificado: `appointmentType` no aparece ni una vez en `src/`, `app/` ni `tests/`).
- **`Encounter.serviceType`.** Existe (0..1) pero es un callejón sin salida para consultar: no hay search param que lo toque en R4. Se usa `Encounter.type`, que sí lo tiene.
- **`Encounter.class`.** Es 1..1 obligatorio, tipo `Coding` (verificado, `Encounter.d.ts:140`), con binding extensible a un value set cuyo eje es ambulatorio/internación/emergencia. `AMB` describe correctamente los dos programas, así que un binding extensible no autoriza a inventar un código propio ahí. Y el `Encounter` no existe al reservar, con lo que no puede alimentar el filtro de disponibilidad.
- **Extensión propia + `SearchParameter` custom.** Cuesta un reindexado manual de todos los `Appointment` y `Slot` para conseguir lo que `serviceCategory` ya da indexado de fábrica.
- **`EpisodeOfCare` para la franja.** `Programa` es un atributo **por reserva** en el dominio (`SolicitudDeReserva.programa`), no un curso longitudinal. `EpisodeOfCare` sigue siendo el recurso correcto si algún día se modela el *curso prescrito* con alta y médico responsable, pero eso es otra cosa.

**Búsquedas que habilita.** *(pendientes de smoke test: no hay `search-parameters.json` en el árbol)*
```http
GET /Appointment?service-category=https://biowellness.ar/fhir/CodeSystem/programa|clinico&date=ge2026-09-01&date=le2026-09-30
GET /Appointment?service-category=…/categoria-servicio|HBOT&service-category=…/programa|clinico
GET /Slot?schedule=Schedule/SCH_R_SALA_TB&status=free&service-category=…/programa|clinico
GET /Encounter?type=…/programa|clinico&date=ge2026-09-01
```

---

### 3.4 Titularidades de membresía

**Decisión.** `Coverage` sigue siendo la titularidad y `EXT.sesionesUsadas` sigue siendo el saldo que leen los cinco consumidores actuales (`estadoDeCoverage`, `validarSaldoMembresia`, `validar-turno`, el dashboard, `cobro-membresias`) — **cero migración de lectores**. Cambia cómo se escribe: guarda optimista con `patchResource` + operación `test` sobre `/meta/versionId`, y un libro mayor de eventos inmutables (`Basic` con `code = CodeSystem/movimiento-saldo`) como fuente de verdad auditable. **Una sola `Coverage` por membresía de pareja.** El estado `en-mora` se mapea a `Flag` con `SYSTEM.bloqueo|PAGO_RECHAZADO`, que **ya existe** (`_shared.ts:680`).

**Por qué.** `Coverage` en R4 no tiene ningún concepto de saldo consumible: sus elementos son `identifier, status, type, policyHolder, subscriber, subscriberId, beneficiary, dependent, relationship, period, payor, class, order, network, costToBeneficiary, subrogation, contract` y nada más. `costToBeneficiary` es lo que el paciente *debe pagar*, no un derecho, y no tiene contraparte `used`. O sea: el saldo va en extensión o va en otro recurso.

El contador mutado que hay hoy tiene un *lost update* real y verificado: `consumirSesionDePlan` hace read-modify-write y `medplum.updateResource()` **no manda `If-Match`** (verificado en `@medplum/core`: la firma no tiene parámetro de versión y no hay ninguna aparición de `If-Match` en el `.d.ts`). Dos recepcionistas reservando a la vez leen `usadas=7` y ambas escriben `8`. `PatchOperation.op` sí incluye `'test'` y `patchResource` existe, así que la guarda es implementable hoy.

El libro mayor agrega lo que el `_history` de Medplum no da: por qué se movió el saldo, contra qué turno, con qué motivo, agregable y consultable. Con tres correcciones que no son opcionales:

1. **`Basic.created` es de tipo `date` (día), no `dateTime`.** Los `.d.ts` lo aplanan a `string` y TypeScript no lo ataja, pero este repo ya se comió el problema y lo documenta tres veces (`src/fhir/demanda.ts:36`, `src/fhir/caja.ts:27`, `app/src/lib/reportes.ts:124`, todas con `.slice(0, 10)`). El instante real va en una extensión `movimiento-instante` (`valueInstant`), y el orden se resuelve por `_lastUpdated`. Corolario: **la conciliación tiene que ser conmutativa** (sumar deltas), porque el orden intra-día no existe.
2. **La clave de idempotencia es la RESERVA, no el turno.** `consumirSesionDePlan` se llama *antes* de que exista ningún `Appointment` (`reservar-combo.ts` consume en la línea 214 y el `comboInstanceId = randomUUID()` recién se genera después). Y para un combo el id de turno es ambiguo por definición. La clave es `consumo:{reservaId}` / `devolucion:{reservaId}`, con el `reservaId` generado antes de consumir y reutilizado como `Appointment.identifier[system=CodeSystem/combo]`.
3. **Hay que arreglar la triple devolución en el mismo commit.** `reservar-combo.ts` escribe `EXT.coberturaUsada` en **cada tramo** y `estado-turno.ts` llama `devolverSesionDePlan` **por cada Appointment cancelado** que la tenga: cancelar los tres tramos de un BIO LONGEVITY resta 3 habiendo sumado 1. Hoy el clamp `if (usadas <= 0) return` lo enmascara. Con clave por reserva, las tres devoluciones colapsan en un `+1`. Sin ese arreglo, el libro mayor convierte un bug tapado en un bug canónico y auditado.

**Sobre la pareja.** Dos `Coverage` hermanas **no**: `cobro-membresias.ts` itera todas las Coverage activas y emite **un Invoice por cada una**, y el precio de una membresía pareja ya es el precio de los dos (HEALTHSPAN intensivo pareja USD 3898 contra 3058 individual). Serían dos cobros mensuales del precio de pareja y 16 sesiones donde hay 8. El acompañante va como **segundo `Appointment.participant`** (`participant` es 1..\* y `actor` acepta `Patient`); hoy `reservar-combo.ts` escribe un solo participante con `ocupantes: 2`, así que el acompañante es invisible en FHIR — ese es el hueco real.

**Lo que NO se hace ahora.**
- **No se backfillea `Coverage.period.end` en membresías.** Hoy no lo tienen a propósito (`asignar-plan.ts`: "las membresías no vencen: se renuevan por ciclo"). Escribirlo dejaría toda membresía **vencida para siempre**, porque `planes.ts` deriva `vencido` de ahí y `cobro-membresias.ts` **nunca toca `Coverage.period`**. La regla nueva ("vencen el último día del mes o a los 30 días, lo que ocurra primero") ya está implementada como `finDeCiclo()` en `src/motor-agenda/comercial/membresias.ts`: hay que **conectarla**, no inventarla, y en el mismo commit que hace avanzar el `period` en la renovación y que hace a `motivoNoDisponible` distinguir membresía de paquete. **[Andrés]** — además cambia el saldo efectivo de socios vigentes.
- **No se escribe `Coverage.class` todavía.** La idea es buena —`class-type` y `class-value` serían buscables sin extensión— pero sería un espejo de tres caras (`EXT.tier` ya guarda el tier) y dos de sus slots no son derivables: `formato` y `plazo` no existen en `src/config/membresias.ts`, cuyos códigos son `FOCUS_STD_IND` / `PRIME_INT_PAR`, y donde **FOCUS no tiene variante PAREJA** — mientras `src/motor-agenda/config/comercial.ts` sí cotiza FOCUS pareja (USD 1800/2520). **Los dos catálogos se contradicen y hay que reconciliarlos primero.**

**Alternativas descartadas.**
- **`ExplanationOfBenefit.benefitBalance` / `CoverageEligibilityResponse.insurance.item.benefit`.** Tienen la forma exacta (`allowedUnsignedInt` / `usedUnsignedInt`), pero sus obligatorios los vuelven un abuso: EOB exige `use ∈ claim|preauthorization|predetermination`, `insurer`, `provider`, `outcome`, `insurance` y `created` — es el resultado *adjudicado* de un reclamo a un pagador, y acá hay autopago; CER exige un `CoverageEligibilityRequest` que habría que fabricar en cada consumo. CER **sí** es correcto como *forma de respuesta* de un bot de elegibilidad construida al vuelo y nunca persistida.
- **`ChargeItem` como libro mayor.** Es del contrato inamovible con `administracion` y alimenta `kpis-finanzas`. Un consumo de sesión de membresía no es facturable: inyectarlo ahí ensucia esos tableros.
- **`Provenance`.** No tiene elemento `identifier` (verificado): sin clave de negocio no hay `createResourceIfNoneExist` ni idempotencia posible.
- **`CarePlan.activity.detail.quantity`.** `CarePlan.intent` es proposal/plan/order/option y `addresses` apunta a `Condition`: es un plan clínico. Además es escribible por el paciente desde el portal.
- **Derivar el saldo contando `Appointment`.** Da el número equivocado en tres casos del modelo ya decidido: un combo son N turnos y una sesión; una pausa resta sesiones sin ningún turno de por medio; y un ajuste manual tampoco tiene turno. `Appointment.supportingInformation → Coverage` sí se agrega, pero como **trazabilidad**, y la consulta devuelve *tramos*, no sesiones.

**Búsquedas que habilita.**
```http
GET /Basic?code=…/CodeSystem/movimiento-saldo|&subject=Coverage/cov-1&created=ge2026-08-01&_sort=_lastUpdated
GET /Flag?subject=Patient/ana&status=active            # ¿en mora? (evaluarFoundingMember lo necesita)
GET /Coverage?patient=Patient/ana&status=active
GET /Appointment?supporting-info=Coverage/cov-1&status=booked,arrived,checked-in,fulfilled   # TRAMOS
```

---

### 3.5 Pausa de membresía

**Decisión.** Un `Task` propio: `code = https://biowellness.ar/fhir/CodeSystem/task-tipo|pausa-membresia` (el system `taskTipo` **ya existe** en `identifiers.ts`), `focus → Coverage`, `for → Patient`, `authoredOn` = fecha de declaración, `executionPeriod` = la ventana pausada, parámetros en `input[]`/`output[]`. Los efectos se aplican **al aceptar la pausa**, no al completarla.

**Por qué.** `Coverage.status = 'suspended'` **es ilegal en R4**: el enum es exactamente `'active' | 'cancelled' | 'draft' | 'entered-in-error'` (verificado en `Coverage.d.ts:113`). TypeScript ni siquiera compila. Y usar `'cancelled'` sería mentir: una membresía pausada no está de baja.

`Task` es el único recurso que trae nativos los cinco datos de una pausa: `status` con ciclo de vida real (incluye `'on-hold'`, verificado), `focus` (0..1 `Reference<Resource>`), `for`, `authoredOn` y `executionPeriod`, más `input`/`output` con todo el abanico de `value[x]` — no hace falta ni una extensión para los parámetros.

**El efecto es sobre las sesiones ASIGNADAS, no sobre las usadas.** `aplicarPausa` reduce `sesionesAsignadas` (12 → 6 para 15 días), corre `finCiclo` los días pausados y devuelve estado `'pausada'`, todo atómicamente. Modelarlo como un delta negativo sobre `sesiones-usadas` tendría tres consecuencias malas: en el libro mayor —construido para auditar— una pausa quedaría indistinguible de seis consumos; el dashboard mostraría "realizadas 9 de 12" con 3 reales (`panelPlanes.ts` calcula `realizadas = max(usadas - proximas, 0)`); y diferir el corrimiento de `period.end` al final de la pausa haría que durante toda la pausa `saldoPlan` reporte `vencido` y recepción lea "El paquete está vencido".

En FHIR eso se escribe así: **no se pisa `EXT.sesionesMes`** (es el valor contratado que `estadoDeCoverage` lee como total) sino una extensión nueva `https://biowellness.ar/fhir/StructureDefinition/sesiones-mes-efectivas` que, si está presente, gana; y `Coverage.period.end` se corre al aceptar. El cobro prorrateado usa el campo nativo `ChargeItem.factorOverride` (0..1 decimal, hoy sin usar en el repo), con `overrideReason` explicando la cuenta.

**El tope anual se cuenta en código, no con una query.** `diasPausadosEnAnio` cuenta por el año de `pausa.inicio`; el search param `period` indexa `executionPeriod` como **rango**, así que una pausa del 20-dic al 5-ene matchearía los dos años. No existe search param para "`executionPeriod.start` cae en el año X". Se traen todas las pausas del paciente y se cuenta en la función pura, que además es lo que manda `CLAUDE.md`.

**Alternativas descartadas.**
- **Extensión repetible en `Coverage`.** No es buscable sin `SearchParameter` custom + reindexado, las extensiones no tienen `status` (y una pausa tiene ciclo de vida: declarada → aceptada → vigente → cumplida → cancelada), y cada acción sobre la pausa mutaría el `Coverage`, que es justo el recurso caliente del que estamos sacando escrituras.
- **`Basic`.** Tiene exactamente cuatro campos de negocio (`code` 1..1, `subject`, `created`, `author`) y **no tiene `status` ni `period`** (verificado). Sirve para un hecho puntual —una fila del libro mayor—; la pausa es un proceso.
- **`Account.status = 'on-hold'`.** `Account` no guarda ninguna cantidad de sesiones y es una agrupación financiera para facturar, del dominio de `administracion`. Queda anotado como el hogar correcto de la cuenta compartida de la pareja si Administración lo pide.

**Riesgo de `AccessPolicy`.** `POLICY_RECEPCIONISTA` da `{ resourceType: 'Task' }` **sin criteria** (para el CRM de leads), así que la pausa quedaría editable desde el mostrador. Acotar `Task` por `code` no es trivial: los Task de leads se distinguen por `businessStatus` con `SYSTEM_ETAPA_PIPELINE`, no necesariamente por `code`, y un criteria `Task?code=a|,b|` excluiría todo Task sin code matcheante. Hay que enumerar todos los codes en uso y probar el kanban antes de tocarla.

**Búsquedas que habilita.**
```http
GET /Task?code=…/task-tipo|pausa-membresia&focus=Coverage/cov-1&status=accepted,in-progress
GET /Task?code=…/task-tipo|pausa-membresia&status=in-progress          # lo que saltea el cobro
GET /Task?code=…/task-tipo|pausa-membresia&patient=Patient/ana&_count=50   # y contar en src/lib
```

---

### 3.6 Autorización médica (R-03)

**Decisión.** `ServiceRequest` con `status = 'active'`, `intent ∈ {order, original-order}`, `category = CodeSystem/categoria-autorizacion|iv-therapy|terapia-biologica`, `subject → Patient`, `requester → Practitioner`, y **`occurrencePeriod` obligatorio**. El turno se enlaza con `Appointment.basedOn`. La decisión la toma una función pura; la query nunca filtra por `code` ni por fecha.

**Por qué.** `Appointment.basedOn` es `Reference<ServiceRequest>[]`: el enlace es nativo, sin extensiones. `ServiceRequest.subject` es 1..1, `status` e `intent` son obligatorios, y `category`/`code` tienen binding *example*, así que los CodeSystems propios son conformes.

Qué significa "activa", en seis condiciones —las tres primeras son las que se olvidan:
1. `status === 'active'`. `draft` es un borrador, `on-hold` está suspendida, `revoked` revocada, `completed` es un curso terminado. Ninguna autoriza.
2. `intent ∈ {order, original-order}`. Un `proposal` o un `plan` es una sugerencia. El enum tiene nueve valores (verificado) y sólo los de orden autorizan.
3. **Cubre el momento del TURNO, no "ahora".** `occurrencePeriod.start <= Appointment.start <= occurrencePeriod.end`. Reservar hoy para dentro de cuatro meses con una autorización que vence en tres es un falso positivo. `verificarAutorizacionMedica` ya mide así.
4. **Sin `occurrencePeriod` no hay autorización: se rechaza.** No se inventa un fallback de "N días desde `authoredOn`": esa constante no existe en `src/config/reglas.ts`, y el tipo del dominio es taxativo — `AutorizacionMedica.vigenteHasta` es **obligatorio**. Una autorización sin ventana no es una autorización con ventana por defecto: es un dato inválido.
5. `requester` tiene que **resolver a `Practitioner` o `PractitionerRole`**. El campo acepta también `Patient`, `RelatedPerson`, `Organization` y `Device` (verificado), así que su mera presencia no prueba autoría médica. Va como test AC, no como comentario.
6. Tope de sesiones del curso, si hay `quantityQuantity`: contar `Appointment?based-on=…` en estados vivos.

**El comodín.** `AutorizacionMedica.servicio` admite `'*'` (autorización general). El mapeo es **`ServiceRequest.code` ausente** (es 0..1). De ahí la regla dura: **en el camino de R-03 nunca se filtra por `code`** — hacerlo pierde todas las autorizaciones generales, o sea un falso negativo que bloquea a un paciente legítimamente autorizado.

**La fecha tampoco va en el query.** La semántica de un search de tipo `date` contra un `Period` (qué significa `ge` cuando el índice es un rango, qué pasa si falta `end`) depende del servidor y no se puede verificar contra los tipos. R-03 es seguridad clínica: un falso negativo molesta, un falso positivo es un incidente. El conjunto de autorizaciones por paciente es de unidades, así que se filtra por `patient + status + intent + category` (todos exactos) y se decide en `src/lib`. El filtro por `occurrence` sí se usa para avisos comerciales de vencimiento, donde un falso positivo es inocuo.

**Alternativas descartadas.**
- **`MedicationRequest`.** Su vigencia vive en `dispenseRequest.validityPeriod`, que no tiene search param — no hay forma de preguntar "vigente hoy" —, y para Terapia Biológica no hay medicamento que nombrar sin inventar un `Medication` ficticio. **Sí** como complemento para IV: la fórmula del cóctel en un `MedicationRequest` con `basedOn → ServiceRequest` (el tipo lo acepta). El motor de agenda nunca lee la fórmula: se preserva el principio de privacidad.
- **`Consent`.** Responde otra pregunta: "¿el paciente aceptó?" contra "¿el médico autorizó?". Para Terapia Biológica hacen falta **las dos**, y conflacionarlas haría que "firmó" se lea como "autorizó" — el fallo exacto que R-03 previene. (Deuda registrada: `Consent.policyRule`, donde vive el código BW, no es buscable, y la policy del portal documenta que acotar por `category` rompió la firma con 403.)

**Riesgos de policy.** `POLICY_ENFERMERA` lista `{ resourceType: 'ServiceRequest' }` **sin `criteria` ni `readonly`**: enfermería podría crear `intent='order'` y fabricar una autorización. Es más grave que el riesgo del portal, que ya está cerrado (`ServiceRequest?subject=%patient&intent=proposal,plan`, y ese string exacto está asserteado en `tests/seed.test.ts`, así que tocarlo rompe CI). Y recepción **no tiene `ServiceRequest` en su policy en absoluto**, así que hoy no puede crear ni la cabecera comercial del combo: para §3.1 hay que *otorgar* (acotado a `intent=plan` y `category=bienestar`), no acotar. **[Andrés]**

**Búsquedas que habilita.**
```http
GET /ServiceRequest?patient=Patient/ana&status=active&intent=order&category=…/categoria-autorizacion|terapia-biologica&_sort=-authored&_count=20
GET /Appointment?based-on=ServiceRequest/sr-iv-88&status=booked,arrived,checked-in,fulfilled&_summary=count
GET /ServiceRequest?requester=Practitioner/conrado&authored=ge2026-08-01&status=active
```

---

### 3.7 Perfiles clínicos

**Decisión.** El hecho evaluado va en una `Observation` append-only (`code = CodeSystem/observacion|perfil-clinico`, `valueCodeableConcept` con `CodeSystem/perfil-clinico`, `performer → Practitioner`, `derivedFrom → QuestionnaireResponse`); el valor corriente se mantiene en `Patient.extension[perfil-clinico]`, que **ya existe** y **ya está oculta a recepción** por `hiddenFields`. Reasignar = escribir otra Observation; corregir un error = `status='entered-in-error'` en la vieja.

**Por qué.** Es la capa clínica, separada de las tres membresías comerciales, y `Observation` es el recurso con mejor segmentación nativa: `code`, `value-concept`, `status`, `category`, `patient`, `date`, `performer` y el composite `code-value-concept`. La extensión sola no alcanza: no registra quién asignó el perfil, ni cuándo, ni con qué evidencia, y reasignar pisa el valor anterior sin rastro.

**Precondición de integridad.** `POLICY_PACIENTE_PORTAL` da `{ resourceType: 'Observation', criteria: 'Observation?subject=%patient' }` — **lectura y escritura**. Con la regla "gana la de `effectiveDateTime` más reciente", el paciente podría autoasignarse el perfil desde el portal y volverlo autoritativo. La misma policy ya aprendió esta lección con `ServiceRequest`; hace falta el equivalente acá (criteria por `code`, o `readonlyFields`), más exigir que `performer` resuelva a `Practitioner`. Va en el mismo commit, y hay que actualizar el espejo `portal/docs/medplum/access-policy-paciente-portal.json`.

**Deuda que hay que resolver con `administracion`.** La segmentación del CRM ya corre sobre **otra** extensión: `src/bots/recomputar-segmentos.ts` lee `https://bio.medplum.com.ar/fhir/StructureDefinition/perfil-interes`, del namespace de Administración, no la nuestra. Escribir el perfil sólo en `bw/perfil-clinico` deja los `Group` del CRM vacíos en silencio — mismo patrón de convivencia que `origen-lead` (bw) vs `lead-origen` (bio), que `identifiers.ts` documenta como contrato. Es handoff, no decisión unilateral.

**Invariante testeable.** Un test que afirme que `CodeSystem/perfil-clinico ∩ CodeSystem/membresia = ∅`, y que ningún `Coverage`/`Contract`/`PlanDefinition` lleve un código de perfil ni ninguna Observation de perfil lleve un código de membresía. La separación conceptual sólo se sostiene si está en verde en CI.

**Alternativas descartadas.**
- **`Condition`.** Un perfil no es un diagnóstico: "Atleta" no es una enfermedad. `Condition` alimenta la lista de problemas y toda exportación tipo CCD/IPS, así que la contaminación se propaga fuera del sistema. Además `clinicalStatus` (active/remission/resolved) y `verificationStatus` (confirmed/refuted) no significan nada para un perfil.
- **`Flag`.** `Flag` es "advertencia prominente para cualquiera que abra la ficha", y el perfil no es una advertencia. Ojo con el argumento correcto: no es cierto que `Flag` esté reservado al banner de seguridad —ya es de doble uso, porque `setBloqueoPago` crea Flags con `SYSTEM.bloqueo|PAGO_RECHAZADO`—, pero sí es cierto que recepción lo tiene en su policy (`readonly`), con lo que meter perfiles ahí violaría el principio de privacidad.
- **`Group` (uno por perfil) como fuente de verdad.** Cada asignación reescribiría un recurso compartido por cientos de pacientes, y `Group.member` no registra quién asignó ni por qué. `Group` **sí** se conserva como cohorte materializada —es exactamente lo que hace `recomputar-segmentos.ts`—, alimentada desde las Observation.
- **`EpisodeOfCare`.** El mejor candidato rechazado: tiene `statusHistory[]` con `period` (auditoría nativa de cambios de estado, que ningún otro ofrece). Pero un perfil no es un episodio: "Anti-aging/Longevidad" es una orientación permanente, no un curso acotado con alta.

**Búsquedas que habilita.**
```http
GET /Observation?code-value-concept=…/observacion|perfil-clinico$…/perfil-clinico|atleta&status=final
GET /Observation?patient=Patient/ana&code=…|perfil-clinico&status=final&_sort=-date&_count=1
```

---

### 3.8 Lista de precios versionada y `fm_price_list_version`

**Decisión.** Un `ChargeItemDefinition` (CID) por **(ítem × versión)**, con la **misma `url` en todas las versiones** y la versión en `version` (`AAAA-MM`, `AAAA-MM.rN` para correcciones). Un `Library` manifiesto por versión. La vigencia se resuelve por `effectivePeriod` — no hace falta un puntero aparte. `fm_price_list_version` va como **`Patient.identifier`**, no como extensión.

**Por qué el CID.** Es el único recurso R4 que reúne a la vez identidad canónica (`url` **1..1 obligatorio**, verificado en `ChargeItemDefinition.d.ts:118`), versión de negocio (`version` 0..1), precio tipado con moneda (`propertyGroup.priceComponent.amount` es `Money`, y el enum de `currency` incluye USD y ARS) y ventana de vigencia (`effectivePeriod`). `InsurancePlan` no tiene `url` ni `version`; `List` tampoco, y su `status` no tiene `draft`; `PlanDefinition` sí los tiene pero deja el precio en una extensión `valueDecimal` con la moneda codificada en el nombre, y acopla el precio al protocolo clínico —cambiar un precio obligaría a versionar el protocolo entero.

La búsqueda que resuelve el requisito es de dos search params nativos, sin extensiones:
```http
GET /ChargeItemDefinition?url=https://biowellness.ar/fhir/ChargeItemDefinition/membresia-HEALTHSPAN-standard-individual&version=2026-08
```

**Detalles que hay que fijar, porque si no el dato es ambiguo.**
- **`ChargeItemDefinition` NO tiene search param `code` en R4.** Por eso cada CID lleva además un `identifier` con la versión (`Identifier/lista-precios|2026-08`), que es lo que permite traer la versión completa de un saque.
- **`amount` es siempre el TOTAL DE LA LÍNEA**, y la unidad se declara en `priceComponent.code` (`CodeSystem/unidad-precio|total-linea` o `|por-persona`). Sin esto, el mismo campo tendría tres semánticas en el mismo catálogo (165 total para monoplaza, 100 *por persona* para biplaza×2 cuyo total es 200, 200 indivisible para Recovery Pro). Ese es exactamente el defecto que hace inutilizable a `factor`.
- **El precio por ocupantes**: un `propertyGroup` por cantidad, con la extensión existente `ocupantes` (`valueInteger`) — hay que **agregar el contexto `ChargeItemDefinition.propertyGroup` al `StructureDefinition`** de esa extensión, no crear una segunda URL — **más un `propertyGroup` sin `applicability` ni extensión, que es el DEFAULT** y cubre el `precioPorPersonaUsd` que `cotizarServicio` ya usa como fallback (`precio.precioPorOcupantesUsd[ocupantes] ?? precio.precioPorPersonaUsd`). Sin ese grupo por defecto, cualquier N no enumerado devuelve `PRECIO_NO_DEFINIDO`.
- **El `applicability.expression` FHIRPath se omite o se escribe correcto.** `%context.quantity.value` es la cantidad de la línea (`crearChargeItems` escribe `quantity: { value: l.cantidad ?? 1 }`), **no** los ocupantes: un cobro de biplaza para 2 lleva `quantity.value = 1`. Un FHIRPath falso es peor que ninguno; queda `applicability.description` en español. El motor no evalúa FHIRPath — `$apply` existe como OperationDefinition en R4 pero **no está verificado que Medplum lo implemente**, y la resolución vive en `src/lib` como función pura.
- **El recargo del plazo mensual (+20 %) es un atributo DE LA LISTA**, no de ningún ítem (`VersionListaPrecios.recargoPlazoMensual`). Ningún CID por ítem puede alojarlo. Va como extensión `recargo-plazo-mensual` (`valueDecimal`) en el `Library` manifiesto — y por eso el manifiesto no es opcional.

**Inmutabilidad.** Una versión publicada nunca se edita: se publica otra. Están permitidas exactamente dos escrituras posteriores, las dos de metadato: sellar `effectivePeriod.end` al publicar la siguiente, y `status → 'retired'` en el único caso de publicación errónea. Se hace cumplir con `AccessPolicy.readonlyFields` sobre `ChargeItemDefinition` (`url`, `version`, `code`, `identifier`, `propertyGroup`) —campo de Medplum, no de R4, pero el repo ya usa `readonlyFields` en producción—, con un único bot publicador que escriba la versión entera en un `Bundle` de tipo `transaction`, y con `Library.content[].hash` como detección. En ese orden: la detección va tercera porque detectar no es prevenir.

**Retiro: dos casos que no hay que confundir.** Una versión **supersedida queda `status: 'active'`** con `effectivePeriod.end` — sigue siendo la lista vinculante de todos los FM congelados en ella. Ponerla en `retired` es el bug que evapora el beneficio FM en silencio. Corolario: la búsqueda que cotiza a un FM **no debe filtrar por `status=active`**. `retired` se reserva para la publicación errónea, con `ChargeItemDefinition.replaces` y un re-apuntado paciente por paciente con `AuditEvent`; y cotizar contra una versión retirada tiene que ser rechazo duro (`VERSION_LISTA_RETIRADA`, junto al `VERSION_LISTA_DESCONOCIDA` que `precios.ts` ya implementa con el razonamiento correcto).

**`fm_price_list_version` como `Patient.identifier`.** El repo ya documenta el patrón en `src/fhir/founding.ts`: los identifiers son buscables (`Patient?identifier=<system>|<valor>`) **sin `SearchParameter` custom y sin reindexado**. Con `system = https://biowellness.ar/fhir/Identifier/lista-precios-fm` el match es token exacto —resuelve de paso el problema de que `2026-08` traería a los de `2026-08.r2` con un search de tipo string— y permite listar a quién hay que re-apuntar si una versión se retira. El campo de dominio correspondiente es `Cliente.fmVersionListaPrecios`.

**La invariante del FM que cambia de producto.** Cuando el FM de agosto 2026 pasa a HEALTHSPAN en 2028 se emite un `Contract` nuevo. Su `instantiatesUri` **se copia del identifier del Patient, nunca de la lista vigente al emitirlo**. Escrito con ingenuidad, el congelamiento se evapora en silencio y hasta la consulta de auditoría deja de encontrar al socio. Es el escenario para el que existe todo este diseño: va como test AC.

**Alternativas descartadas.**
- **`meta.versionId` / `_history` como versión de lista.** Una versión es un *conjunto* de ~50 recursos y `_history` versiona cada uno por separado, sin lectura transversal; y `versionId` lo asigna el servidor, así que no puede ser un valor de negocio estable y legible.
- **Un CID por versión con 50 `propertyGroup`.** `propertyGroup` **no tiene elemento `code`** (verificado): la identidad de cada ítem quedaría sólo dentro de strings de FHIRPath, y se perdería `url|version` por ítem, que es justamente la resolución del FM.
- **Un segundo CID en ARS.** Sería una segunda fuente de verdad que se desincroniza el primer día que se mueve el TC, contra la convención del repo. La conversión va en el `ChargeItem`.
- **Un `Basic` de configuración con la versión vigente.** `versionVigente()` ya resuelve por fechas y **no necesita que se selle `vigenteHasta`** (se queda con el `vigenteDesde` más nuevo entre las candidatas), que era la única objeción real al `effectivePeriod`. Adoptar el Basic sin borrar `versionVigente()` deja dos fuentes de verdad para "cuál es la lista de hoy".
- **Unir CID y cobro por `code`.** `codingDeItem` (`_shared.ts`) escribe en `ChargeItem.code`, para servicios, la **categoría** (`CodeSystem/servicio|HBOT`), no el código (`HBOT_BIPLAZA`): es el contrato con `administracion` que alimenta `kpis-finanzas`. El CID de biplaza nunca matchearía, justo en el caso (R-04) para el que se diseñó el `propertyGroup`. El join es **`ChargeItem.definitionCanonical`** (0..\*, verificado, hoy sin usar), que es aditivo y no toca el contrato.

**Alcance pendiente. [Andrés]** `VersionListaPrecios` tiene sólo `membresias`, `servicios` y `recargoPlazoMensual`: **no tiene combos ni paquetes**. Hoy un FM que congela 2026-08 no congela el precio de BIO LONGEVITY. Los CID de combo/paquete se seedean **sin `version`** hasta que se decida ampliarlo. Y falta la regla para el FM que compra un producto que no existía en su versión congelada (R-09 le permite cambiar de tier libremente): hoy la búsqueda devolvería vacío y `cotizarMembresia` tiraría `PRECIO_NO_DEFINIDO`, o sea que el FM no podría comprar.

**Colisión con lo que ya hay. [Andrés]** Existen **tres** mecanismos de congelamiento declarados con `StructureDefinition`: `tc-bloqueo-fm` (Patient, decimal, y está en `readonlyFields` de la policy del portal: es un campo vivo y protegido), `precio-bloqueado-fm` (Coverage/Contract, decimal) y `version` (Coverage/Contract, "versión de la membresía contratada"). Congelar el **TC** y congelar la **lista en USD** son cosas distintas y pueden contradecirse — si el FM congela las dos, su precio en pesos queda fijo para siempre. Antes de agregar el identifier nuevo hay que declarar muertas las que se retiran y avisar al portal.

**Búsquedas que habilita.**
```http
GET /ChargeItemDefinition?url=…/membresia-HEALTHSPAN-standard-individual&version=2026-08
GET /ChargeItemDefinition?identifier=https://biowellness.ar/fhir/Identifier/lista-precios|2026-08&_count=200
GET /Library?url=https://biowellness.ar/fhir/Library/lista-precios&version=2026-08
GET /Patient?identifier=https://biowellness.ar/fhir/Identifier/lista-precios-fm|2026-08&_summary=count
GET /Contract?instantiates=https://biowellness.ar/fhir/Library/lista-precios|2026-08&status=executed
```
La última **es la más crítica a smoke-testear**: si `Contract?instantiates` no funciona en Medplum, el mecanismo de auditoría del FM entero se cae.

---

### 3.9 Recursos físicos, capacidad y ocupación

**Decisión.** El `Schedule` es la junta de dilatación y **no se mueve**: `identifier = SCH_{codigo}`, extensión `recurso-fisico`, y todas las búsquedas `Slot?schedule=…&status=busy` siguen igual. La unidad reservable pasa de `Location` a **`Device` sólo para las unidades con identidad de mantenimiento** (número de serie, modelo, calibración); lo que es un lugar sigue siendo `Location`. La **ocupación se calcula como hoy**: N `Slot busy` de **exactamente la misma ventana**, sumando `EXT.ocupantes` hasta la capacidad.

**Por qué Device es posible.** `Schedule.actor` es 1..\* y acepta `Device` entre sus targets; `Appointment.participant.actor` acepta exactamente los mismos. `Device.location` es 0..1 `Reference<Location>` y es el campo nativo para "esta tumbona está en esta sala" (`Location.partOf` sería el equivalente si se quedaran como Location, pero entonces la tumbona-como-lugar no tiene dónde poner serie ni modelo — hoy la identidad del JAY-20H #1 vs #2 vive en un string de `nota`). `Device.status: 'inactive'` da el "fuera de servicio" que hoy no existe: habría que borrar el `Schedule`. Y el blast radius medido es chico: `Location` aparece en 11 líneas, todas en `src/seed/*` más una en `access-policies.ts`, y **ninguna consulta del app, de los bots ni de los tests busca por `?location=` ni por `actor=Location/…`**.

**Por qué NO se migra todavía. [Andrés]** Hay **dos inventarios de recursos que se contradicen**: `src/config/recursos.ts` (el que lee el seed: 14 recursos, `R_HBOT_MONO`…`R_IV_2`, con **una sola tumbona**) y `src/motor-agenda/config/recursos.ts` (`HBOT-MULTI`, `RL-SALA-1/2`, `RL-STANDALONE`, `IV-1/2`), y `src/motor-agenda` **hoy no lo importa nadie** fuera de `tests/`. Además el "puesto IV 1" *es* `R_SALA_TB`, la sala misma, así que `partOf: sala-tb` para todos los puestos no cierra hasta separar la sala de su puesto — y por eso "ampliar de 2 a 4 puestos IV sin tocar código" **es falso hoy**: cambiar `CANTIDADES_SAN_ISIDRO.puestosIv` no crea ningún recurso FHIR. La reconciliación de los dos inventarios es precondición de todo lo demás, incluido el alta de las tumbonas de sala de §3.2.

**Capacidad: son tres cosas distintas, no un número.** La **capacidad física** (multiplaza 6, gabinete 2), el **mínimo operativo** (multiplaza 3: advertencia, no bloqueo, R-06) y **si la reserva es exclusiva**. Sin la tercera el dato es ambiguo: la biplaza y el gabinete son capacidad 2 y no comparten con desconocidos, mientras la multiplaza es capacidad 6 y sí. Las tres van como extensiones en el **`Schedule`** —que es lo que el motor ya lee, con lo que un lector no necesita saber si la unidad es Device o Location— y se espejan en `Device.property` como dato interoperable. `Device.property` no compra nada operativo: no tiene search param. La fuente de verdad sigue siendo el config; FHIR es la proyección, y el invariante `setup + terapia + turnaround <= slot` se testea en código.

**Alternativas descartadas.**
- **`Slot.overbooked` como contador de ocupación.** R4 lo define literalmente como "*this slot has already been overbooked, appointments are unlikely to be accepted for this time*": es una advertencia de sobreventa, es 0..1 **boolean** —no lleva cantidad, no puede expresar "3 de 6"— y no tiene search param.
- **Un `Appointment` por ocupante apuntando todos al mismo `Slot`.** Rompe dos bots en producción: `estado-turno.ts` y `vencer-tentativas.ts` recorren `appt.slot` y ponen `status='free'`, de modo que si **uno** de los seis del multiplaza cancela, la cámara queda libre con cinco personas adentro. Y `_summary=count` contaría Appointments, no plazas: una reserva familiar de 3 contaría 1 de 6.
- **`Slot.status` como caché "free hasta capacidad".** Saca la reserva del filtro `Slot?status=busy` de `cargarReservasEnRango` → sobreventa silenciosa.
- **`busy-tentative` para la seña pendiente (R-19).** Semánticamente atractivo, operativamente destructivo hoy: mismo filtro, mismo efecto. La tentativa se guarda como `busy` + `EXT.venceSena`. Si algún día se cambia, primero hay que ampliar el filtro a `status=busy,busy-tentative` en `_shared.ts` y en todo lo que lo consuma.
- **`Appointment?actor=…&date=ge…&end=le…` para la disponibilidad.** Innecesario —la disponibilidad se contesta con `Slot?status=busy` + `EXT.recursoFisico`, que es R4 puro— y además **incorrecto como test de solapamiento**: `date=ge{inicio}&end=le{fin}` es una consulta de *contención* y pierde el turno que empieza antes y termina después, que es el caso más frecuente. (`Appointment?end=` y `Slot?end=` son search params **propios de Medplum**, no R4; conviene no depender de ellos.)
- **`HealthcareService` como unidad reservable.** Modela "un servicio que se ofrece en un lugar": su clave natural es servicio×lugar, duplicaría el catálogo de `ActivityDefinition` y no tiene ningún campo de identidad física.
- **Migrar todo a `Device`, consultorio y sala TB incluidos.** Rompe la semántica sin ganar nada: `Location.physicalType` tiene los códigos que hacen falta (`ro` Room, `bd` Bed) y `Location.partOf` da la jerarquía sala→puesto.

**Búsquedas que habilita.**
```http
GET /Schedule?identifier=https://biowellness.ar/fhir/CodeSystem/recurso-fisico|SCH_R_HBOT_MULTIPLAZA
GET /Slot?status=busy&start=ge2026-08-25T00:00:00Z&_count=1000      # y sumar EXT.ocupantes por ventana
GET /Device?type=…/recurso-fisico|TUMBONA&location=Location/sala-recovery&status=active
GET /Device?status=inactive                                          # fuera de servicio
GET /Location?partof=Location/sala-tb&type=…/recurso-fisico|PUESTO_IV
```

---

## 4. Ejemplos

### 4.1 BIO LONGEVITY completo, jueves 2026-09-03 09:00

Combo individual: `['HBOT_MONO', 60, 1] + ['IHHT', 30, 1] + ['RECOVERY_PRO', 60, 1]`. Los offsets del ejemplo son los del plan que devuelve el motor; en producción se derivan encadenando el ancla de salida de cada recurso (`anclaSalidaMin`), no se escriben a mano.

**Cabecera — `ServiceRequest`**

```json
{
  "resourceType": "ServiceRequest",
  "id": "sr-combo-9f3a",
  "status": "active",
  "intent": "plan",
  "subject": { "reference": "Patient/pac-123" },
  "requisition": {
    "system": "https://biowellness.ar/fhir/CodeSystem/combo",
    "value": "9f3a1c02-7b44-4e51-9a10-2c8d5e6f0011"
  },
  "code": {
    "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/combo",
                 "code": "BIO_LONGEVITY", "display": "BIO LONGEVITY" }]
  },
  "category": [{
    "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/programa", "code": "bienestar" }]
  }],
  "occurrencePeriod": {
    "start": "2026-09-03T09:00:00-03:00",
    "end":   "2026-09-03T11:30:00-03:00"
  },
  "insurance": [{ "reference": "Coverage/cov-healthspan-ana" }],
  "authoredOn": "2026-09-01T16:20:00-03:00"
}
```

**Tramo 1 — HBOT, 09:00–10:00**

```json
{
  "resourceType": "Appointment",
  "id": "appt-tramo-1",
  "status": "booked",
  "description": "BIO LONGEVITY · Cámara Hiperbárica Monoplaza",
  "basedOn": [{ "reference": "ServiceRequest/sr-combo-9f3a" }],
  "identifier": [{ "system": "https://biowellness.ar/fhir/CodeSystem/combo",
                   "value": "9f3a1c02-7b44-4e51-9a10-2c8d5e6f0011" }],
  "serviceType": [{
    "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/servicio", "code": "HBOT_MONO" }]
  }],
  "serviceCategory": [
    { "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/categoria-servicio",
                   "code": "HBOT" }] },
    { "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/programa",
                   "code": "bienestar" }] }
  ],
  "start": "2026-09-03T09:00:00-03:00",
  "end":   "2026-09-03T10:00:00-03:00",
  "slot": [{ "reference": "Slot/slot-hbot-mono-0900" }],
  "supportingInformation": [{ "reference": "Coverage/cov-healthspan-ana" }],
  "participant": [
    { "actor": { "reference": "Patient/pac-123" }, "status": "accepted" },
    { "actor": { "reference": "Location/loc-hbot-mono" }, "status": "accepted",
      "required": "required",
      "type": [{ "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/rol-recurso",
                              "code": "principal" }] }] }
  ],
  "extension": [
    { "url": "https://biowellness.ar/fhir/StructureDefinition/recurso-fisico", "valueString": "R_HBOT_MONO" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/orden-protocolo", "valueInteger": 1 },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/ocupantes", "valueInteger": 1 },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/item-tipo", "valueCode": "combo" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/item-codigo", "valueString": "BIO_LONGEVITY" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/cobertura-usada",
      "valueString": "Coverage/cov-healthspan-ana" }
  ]
}
```

**Tramo 2 — IHHT, 10:00–10:30.** Idéntico en forma, con `serviceType|IHHT`, `recurso-fisico: R_IHHT_1`, `orden-protocolo: 2`, `slot: [Slot/slot-ihht-1-1000]`.

**Tramo 3 — Recovery Pro, 10:30–11:30 · un Appointment, DOS Slots**

```json
{
  "resourceType": "Appointment",
  "id": "appt-tramo-3",
  "status": "booked",
  "description": "BIO LONGEVITY · Recovery Pro — Gabinete 1",
  "basedOn": [{ "reference": "ServiceRequest/sr-combo-9f3a" }],
  "identifier": [{ "system": "https://biowellness.ar/fhir/CodeSystem/combo",
                   "value": "9f3a1c02-7b44-4e51-9a10-2c8d5e6f0011" }],
  "start": "2026-09-03T10:30:00-03:00",
  "end":   "2026-09-03T11:30:00-03:00",
  "slot": [
    { "reference": "Slot/slot-recovery-g1-1030" },
    { "reference": "Slot/slot-tumbona-sala-1-1058" }
  ],
  "participant": [
    { "actor": { "reference": "Patient/pac-123" }, "status": "accepted" },
    { "actor": { "reference": "Location/loc-recovery-g1" }, "status": "accepted",
      "type": [{ "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/rol-recurso",
                              "code": "principal" }] }],
      "period": { "start": "2026-09-03T10:30:00-03:00", "end": "2026-09-03T11:30:00-03:00" } },
    { "actor": { "reference": "Location/loc-tumbona-sala-1" }, "status": "accepted",
      "type": [{ "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/rol-recurso",
                              "code": "auxiliar" }] }],
      "period": { "start": "2026-09-03T10:58:00-03:00", "end": "2026-09-03T11:18:00-03:00" } }
  ],
  "extension": [
    { "url": "https://biowellness.ar/fhir/StructureDefinition/recurso-fisico", "valueString": "R_RECOVERY_G1" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/orden-protocolo", "valueInteger": 3 },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/ocupantes", "valueInteger": 1 }
  ]
}
```

La extensión `recurso-fisico` del **Appointment** es única y apunta al recurso **principal**: `app/src/lib/timeline.ts`, `reportes.ts` y `proximos.ts` la leen con `.find()` y una segunda ocurrencia quedaría silenciosamente ignorada. La tumbona se identifica por su `Slot` y por su `participant`. Cuidado también con `timeline.ts`, que usa `a.slot?.[0]` como fallback posicional: **la tumbona nunca debe quedar primera**.

**Los dos Slots — lo que realmente bloquea**

```json
{ "resourceType": "Slot", "id": "slot-recovery-g1-1030",
  "schedule": { "reference": "Schedule/sch-r-recovery-g1" }, "status": "busy",
  "start": "2026-09-03T10:30:00-03:00", "end": "2026-09-03T11:30:00-03:00",
  "extension": [
    { "url": "https://biowellness.ar/fhir/StructureDefinition/recurso-fisico", "valueString": "R_RECOVERY_G1" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/ocupantes", "valueInteger": 1 }
  ]}
```
```json
{ "resourceType": "Slot", "id": "slot-tumbona-sala-1-1058",
  "schedule": { "reference": "Schedule/sch-r-tumbona-sala-1" }, "status": "busy",
  "start": "2026-09-03T10:58:00-03:00", "end": "2026-09-03T11:18:00-03:00",
  "extension": [
    { "url": "https://biowellness.ar/fhir/StructureDefinition/recurso-fisico", "valueString": "R_TUMBONA_SALA_1" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/ocupantes", "valueInteger": 1 }
  ]}
```

En la variante **pareja** (`BIO_LONGEVITY_PAREJA`, `ocupantes: 2`) el tramo 3 lleva **tres** `slot` (gabinete + dos tumbonas), **dos** `participant` auxiliares con el mismo `period`, y los dos pacientes como participantes. Con `tumbonasEnSala: 2`, esa reserva consume el pool entero en la ventana 28→48: el gabinete hermano no puede correr su etapa de tumbona ahí. Eso *es* R-07.

### 4.2 Membresía con pausa

`Coverage` — una sola para la pareja, **sin `period.end`** hasta que la renovación lo avance:

```json
{
  "resourceType": "Coverage",
  "id": "cov-healthspan-ana",
  "status": "active",
  "type": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/coverage-selfpay",
                         "code": "pay" }] },
  "beneficiary": { "reference": "Patient/ana" },
  "subscriber":  { "reference": "Patient/ana" },
  "payor":       [{ "reference": "Organization/shanti-om" }],
  "period":      { "start": "2026-12-15" },
  "extension": [
    { "url": "https://biowellness.ar/fhir/StructureDefinition/tipo-cobertura", "valueCode": "membresia" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/plan-codigo", "valueString": "HEALTHSPAN_INT_PAR" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/sesiones-mes", "valueInteger": 12 },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/sesiones-mes-efectivas", "valueInteger": 6 },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/sesiones-usadas", "valueInteger": 0 },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/ciclo-mes", "valueString": "2027-01" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/saldo-recalculado-en",
      "valueInstant": "2027-01-02T03:00:00Z" }
  ]
}
```

`sesiones-mes` conserva **lo contratado**; `sesiones-mes-efectivas` es el techo del ciclo pausado y, si está, gana. Pisar `sesiones-mes` destruiría el valor contratado, que `estadoDeCoverage` lee como total.

`Task` — pausa de 15 días de enero, declarada el 25 de noviembre:

```json
{
  "resourceType": "Task",
  "identifier": [{ "system": "https://biowellness.ar/fhir/Identifier/task",
                   "value": "pausa:cov-healthspan-ana:2027-01" }],
  "status": "accepted",
  "intent": "order",
  "code": { "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/task-tipo",
                         "code": "pausa-membresia" }] },
  "for":   { "reference": "Patient/ana" },
  "focus": { "reference": "Coverage/cov-healthspan-ana" },
  "authoredOn": "2026-11-25",
  "executionPeriod": { "start": "2027-01-01", "end": "2027-01-15" },
  "requester": { "reference": "Patient/ana" },
  "input": [
    { "type": { "text": "dias-pausados" },          "valueInteger": 15 },
    { "type": { "text": "ventana" },                "valueCode": "enero" },
    { "type": { "text": "dias-anticipacion" },      "valueInteger": 37 },
    { "type": { "text": "dias-usados-en-el-anio" }, "valueInteger": 0 },
    { "type": { "text": "sesiones-asignadas-antes" }, "valueInteger": 12 },
    { "type": { "text": "sesiones-asignadas-despues" }, "valueInteger": 6 }
  ],
  "output": [
    { "type": { "text": "fin-ciclo-corrido-a" }, "valueDate": "2027-01-30" },
    { "type": { "text": "movimiento-saldo" },
      "valueReference": { "reference": "Basic/mov-pausa-2027-01" } }
  ]
}
```

El cobro prorrateado, con el campo nativo:

```json
{
  "resourceType": "ChargeItem",
  "status": "billable",
  "code": { "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/membresia",
                         "code": "HEALTHSPAN" }] },
  "subject": { "reference": "Patient/ana" },
  "quantity": { "value": 1 },
  "definitionCanonical": [
    "https://biowellness.ar/fhir/ChargeItemDefinition/membresia-HEALTHSPAN-intensivo-pareja|2026-08"
  ],
  "factorOverride": 0.5,
  "priceOverride": { "value": 2884520, "currency": "ARS" },
  "overrideReason": "Pausa 2027-01-01→2027-01-15 (15/30 días). USD 3898 × 0,5 × TC 1480. Lista 2026-08 congelada FM.",
  "extension": [
    { "url": "https://biowellness.ar/fhir/StructureDefinition/tc-aplicado", "valueDecimal": 1480 },
    { "url": "https://bio.medplum.com.ar/fhir/StructureDefinition/linea-comercial", "valueCode": "membresias" }
  ]
}
```

### 4.3 `ChargeItemDefinition` versionada, `Library` y el Patient del FM

```json
{
  "resourceType": "ChargeItemDefinition",
  "url": "https://biowellness.ar/fhir/ChargeItemDefinition/servicio-HBOT_BIPLAZA",
  "version": "2026-08",
  "identifier": [{ "system": "https://biowellness.ar/fhir/Identifier/lista-precios", "value": "2026-08" }],
  "status": "active",
  "title": "HBOT Biplaza — sesión suelta",
  "date": "2026-08-01T00:00:00.000Z",
  "effectivePeriod": { "start": "2026-08-01" },
  "code": { "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/servicio",
                         "code": "HBOT_BIPLAZA" }] },
  "propertyGroup": [
    {
      "extension": [{ "url": "https://biowellness.ar/fhir/StructureDefinition/ocupantes",
                      "valueInteger": 1 }],
      "applicability": [{ "description": "1 ocupante: la cámara se reserva completa, precio monoplaza (R-04)" }],
      "priceComponent": [{
        "type": "base",
        "code": { "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/unidad-precio",
                               "code": "total-linea" }] },
        "amount": { "value": 165, "currency": "USD" }
      }]
    },
    {
      "extension": [{ "url": "https://biowellness.ar/fhir/StructureDefinition/ocupantes",
                      "valueInteger": 2 }],
      "applicability": [{ "description": "2 ocupantes: USD 100 por persona (R-04) — total de la línea 200" }],
      "priceComponent": [{
        "type": "base",
        "code": { "coding": [{ "system": "https://biowellness.ar/fhir/CodeSystem/unidad-precio",
                               "code": "total-linea" }] },
        "amount": { "value": 200, "currency": "USD" }
      }]
    }
  ]
}
```

Manifiesto de la versión (aloja el recargo, que es atributo de la lista):

```json
{
  "resourceType": "Library",
  "url": "https://biowellness.ar/fhir/Library/lista-precios",
  "version": "2026-08",
  "identifier": [{ "system": "https://biowellness.ar/fhir/Identifier/lista-precios", "value": "2026-08" }],
  "name": "ListaPrecios202608",
  "title": "Lista de precios Biowellness — versión 2026-08 (inmutable)",
  "status": "active",
  "type": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/library-type",
                         "code": "asset-collection" }] },
  "date": "2026-08-01T00:00:00.000Z",
  "effectivePeriod": { "start": "2026-08-01" },
  "extension": [{ "url": "https://biowellness.ar/fhir/StructureDefinition/recargo-plazo-mensual",
                  "valueDecimal": 0.2 }],
  "relatedArtifact": [
    { "type": "composed-of",
      "resource": "https://biowellness.ar/fhir/ChargeItemDefinition/servicio-HBOT_BIPLAZA|2026-08" },
    { "type": "composed-of",
      "resource": "https://biowellness.ar/fhir/ChargeItemDefinition/membresia-HEALTHSPAN-standard-individual|2026-08" }
  ],
  "content": [{
    "contentType": "application/json",
    "title": "Snapshot congelado de la versión 2026-08",
    "data": "<base64 del JSON completo>",
    "hash": "<SHA-1 base64>"
  }]
}
```

El Patient del Founding Member — la versión como `identifier`, buscable sin reindexar:

```json
{
  "resourceType": "Patient",
  "id": "ana",
  "identifier": [
    { "system": "https://biowellness.ar/fhir/Identifier/dni", "value": "30111222" },
    { "system": "https://biowellness.ar/fhir/Identifier/fm", "value": "37" },
    { "system": "https://biowellness.ar/fhir/Identifier/lista-precios-fm", "value": "2026-08" }
  ],
  "extension": [
    { "url": "https://biowellness.ar/fhir/StructureDefinition/tag-fm", "valueBoolean": true },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/perfil-clinico", "valueCode": "atleta" }
  ]
}
```

---

## 5. Compatibilidad con lo que ya existe

**Lo que NO se toca.** El `Appointment.identifier` con `system = CodeSystem/combo` y la extensión `orden-protocolo`, que son la agrupación viva de combos (`_shared.ts`, `vencer-tentativas.ts`, `recordatorios.ts`). Las extensiones `recurso-fisico`, `ocupantes`, `item-tipo`, `item-codigo`, `cobertura-usada`, `vence-sena` del Appointment. `clasificacionDeServicio()` y el contrato del Panel Bio: `serviceType[0]` y `serviceCategory[0]` siguen siendo el servicio y la terapia, en esa posición (los tests lo assertean). El `Schedule` con `identifier = SCH_{codigo}` y su extensión `recurso-fisico`. El modelo de ocupación: `Slot busy` por reserva, misma ventana exacta, suma de `ocupantes`. `Coverage` como titularidad con `sesiones-usadas` como saldo leído. El contrato de pagos con `administracion`: estados de `Invoice`, `ChargeItem.code` con la **categoría** para servicios, y la extensión `linea-comercial` del namespace `bio.medplum.com.ar`. `Flag` como banner de seguridad y como bloqueo `PAGO_RECHAZADO`. `Encounter.class = AMB`.

**Lo que se agrega, sin migración.** El `ServiceRequest` cabecera del combo y `Appointment.basedOn` (`basedOn` no aparece hoy ni una vez en `src/`, `app/` ni `tests/`: está libre). `Appointment.supportingInformation → Coverage`, aditivo sobre la extensión `cobertura-usada`. La segunda entrada de `serviceCategory` con el programa, **anexada**. Los `Basic` del libro mayor. Los `Task` de pausa (los systems `task-tipo` y `Identifier/task` ya existen). Las `Observation` de perfil clínico. Los `ChargeItemDefinition` y el `Library` de la lista. El `Patient.identifier` de la versión FM. `ChargeItem.definitionCanonical`, `priceOverride`, `factorOverride`, `overrideReason` — los cuatro nativos y hoy sin usar.

**Lo que requiere cambio de código, con su costo.**

*Aplanar los lectores de `serviceCategory`* — dos líneas (`_shared.ts:1515`, `lista-espera.ts:68`). **Precondición bloqueante** de escribir el programa. Sin esto, la lista de espera deja de matchear huecos y nadie se entera.

*Clave de idempotencia por reserva y arreglo de la triple devolución* — `reservar-combo.ts` genera el `reservaId` antes de consumir; `estado-turno.ts` deduplica la devolución por combo. Un commit, obligatoriamente conjunto con el libro mayor.

*Guarda optimista en `consumirSesionDePlan` / `devolverSesionDePlan`* — cambiar `updateResource` por `patchResource` con `op: 'test'` sobre `/meta/versionId` y reintentar. Contenido en `_shared.ts`.

*Consolidar el `Encounter` a uno por visita* — sólo junto con el arreglo de `cerrarEncounter` (cerrar cuando todos los hermanos estén en estado terminal). Cambia el conteo de cualquier reporte que use Encounters como proxy de visitas: revisar `administracion` antes. **[Andrés]**

*`Location` como `participant.actor` de todo Appointment* — habilita `Appointment?location=`, que hoy devuelve vacío en todo el sistema. Toca los cuatro puntos de creación (`reservar-turno.ts` ×2, `reservar-combo.ts` ×2) y hay que hacerlo **de una vez**: un modelo mixto donde la búsqueda devuelve resultados parciales es peor que no tenerla, porque parece que funciona. Ojo: `buildSchedule` usa referencia condicional (`Location?identifier=…`), así que hay que resolver el id o usar referencias condicionales al crear.

*AccessPolicies* — agregar `ChargeItemDefinition` (readonly) y `Device` (readonly) a recepción y al portal; otorgar `ServiceRequest` acotado a recepción; acotar `Observation` de perfil en el portal; revisar `POLICY_ENFERMERA`. **Y sincronizar el espejo `portal/docs/medplum/access-policy-paciente-portal.json`**: el seed hace upsert por `name` y ya borró tres veces entradas aplicadas a mano (Coverage HIP, ServiceRequest, Consent), dejando el portal en 403.

*Reconciliación de los dos inventarios de recursos* — `src/config/recursos.ts` (14 recursos, que es lo que seedea) contra `src/motor-agenda/config/recursos.ts`. Precondición de: dar de alta las tumbonas de sala, separar `R_SALA_TB` del puesto IV 1, migrar a `Device`, y del `Coverage.class` de membresías. **[Andrés]**

*Conectar `finDeCiclo()` y hacer avanzar `Coverage.period` en la renovación* — precondición de escribir cualquier `period.end` en membresías. **[Andrés]**

**Lo que NO se hace.** No se ensancha el criteria de `Basic` en la policy de recepción: la escritura del saldo ocurre bajo la identidad del Bot (`executeBot`), no del mostrador — recepción tiene `Coverage` readonly y las reservas funcionan igual. No se crea una segunda `Coverage` para la pareja. No se backfillea `period.end`. No se siembra `serviceCategory` en Slots como si fuera enforcement.

---

## 6. Riesgos y deudas conocidas

**Zona horaria.** `src/lib/slots.ts` tiene `const OFFSET_ARG = '-03:00'` hardcodeado **dentro de la función pura de generación**, mientras `src/config/horario.ts` ya define `TZ = 'America/Argentina/Buenos_Aires'`. Argentina no aplica horario de verano desde 2009, así que hoy funciona; si vuelve a moverse el reloj, la grilla entera se corre una hora.

**Volumen de Slots.** Con `SLOT_GRANULARIDAD_MIN = 30` y horario 08:00–22:00 L–V / 08:00–20:00 sábado son 164 slots por semana y por recurso: ~119.000 al año para 14 recursos, y eso antes de sumar tumbonas con sub-ventanas propias. `Schedule.planningHorizon` (0..1 `Period`, disponible y hoy sin usar) y una rutina de poda pasan de "conviene" a obligatorias.

**Dos poblaciones de Slots que no se reconcilian.** Los `free` del seed (`--with-slots`) y los `busy` ad-hoc de los bots conviven sin tocarse: para un mismo recurso y ventana puede haber uno de cada. Es preexistente, pero cualquier diseño que asuma "grilla fija free→busy" parte de una premisa falsa.

**Doble escritura caché / libro mayor.** Mientras `sesiones-usadas` conviva con los `Basic` hay dos fuentes y pueden divergir. Está mitigado (el libro mayor manda, un cron concilia), pero entre la deriva y la conciliación nocturna el dashboard puede dejar reservar una sesión de más. Definir por contrato que el libro mayor gana, y considerar reconciliar en caliente cuando `saldo-recalculado-en` está viejo.

**Conmutatividad del libro mayor.** Con `created` a granularidad de día no hay orden intra-día. La conciliación debe sumar deltas y nunca depender del orden; si alguna vez se agrega un movimiento no conmutativo (un `set` en vez de un `delta`), el saldo pasa a depender de un orden que el modelo no puede garantizar.

**R-03 sobre datos que no existen.** No hay ningún `ServiceRequest` cargado. Activar la regla rechaza el 100 % de las reservas de IV y TB hasta que el Dr. Conrado cargue autorizaciones. Un flag de config que module la transición es en sí mismo un riesgo: si se pone, con fecha de vencimiento y aviso visible en el dashboard.

**Dependencia de search params propios de Medplum.** `Appointment?end=`, `Slot?end=`, `Flag?status=` y `Flag?category=` no son R4 base. Funcionan en `api.medplum.com.ar` y no son portables: documentarlos donde se usen.

**Semántica `date` contra `Period`, no verificada.** Afecta a `ServiceRequest?occurrence=`, `Task?period=` y `ChargeItemDefinition?effective=`. R-03 está deliberadamente blindado (decide una función pura) y el tope de pausas también se cuenta en código. Lo que queda expuesto son avisos comerciales, donde un falso positivo es inocuo.

**Nada sobre search params está verificado en este árbol.** `@medplum/definitions` no está instalado. Antes de escribir código que dependa de ellos hay que hacer `npm i -D @medplum/definitions` o smoke-testear contra el servidor. Los más críticos, en orden: `Contract?instantiates` (si falla, se cae la auditoría del FM), `Observation` `code-value-concept` (toda la segmentación de perfiles), `Task?focus` (el skip de cobro de una membresía pausada — si no existe, se le cobra a un socio pausado), `Coverage` `class-type`/`class-value`.

**Extensiones nuevas sin registrar.** `capacidad`, `minimo-operativo`, `reserva-exclusiva`, `sesiones-mes-efectivas`, `movimiento-delta`, `movimiento-motivo`, `movimiento-instante`, `movimiento-reserva`, `movimiento-ciclo`, `saldo-recalculado-en`, `recargo-plazo-mensual`, `unidad-precio` no están en `EXT` (`identifiers.ts`) ni en `SPECS` (`extensions.ts`), contra la convención de centralización. Y el generador emite `context: [{ type: 'element', expression }]` con el nombre del recurso: `ChargeItemDefinition.propertyGroup` es una **ruta de elemento** — hay que probar que el generador y Medplum la acepten antes de darlo por hecho.

**Inconsistencia de URL canónica.** El único `Library` existente usa `https://biowellness.ar/Library/consentimiento-informado` (**sin** `/fhir`) mientras `canonical()` genera `https://biowellness.ar/fhir/{Tipo}/{codigo}`. Elegir uno. Y `Library` está `readonly` en las dos AccessPolicies: el snapshot base64 de la lista de precios quedaría legible por recepción y por cualquier paciente logueado — decidirlo a propósito.

**Congelamiento del FM: tres mecanismos declarados.** `tc-bloqueo-fm`, `precio-bloqueado-fm` y `version`. Ninguno congela *la lista*. Hay que declarar cuál gana y cuáles se retiran antes de agregar el identifier nuevo. **[Andrés]**

**El formato `AAAA-MM.rN` no ordena como string** (`2026-08.r10` < `2026-08.r2`). El orden entre versiones se resuelve **siempre** por `date`. Cualquier código que ordene versiones comparando strings es un bug latente.

**Contradicción de precio ya viva.** `src/lib/pricing.ts` cobra multiplaza `precioUSD * max(ocupantes, 3)` (piso de facturación 3), mientras `src/motor-agenda/comercial/precios.ts` documenta "USD 80 por persona desde uno, sin piso de sesión". Escribir el `propertyGroup` de 1 ocupante obliga a elegir 80 o 240. **[Andrés]** — decisión comercial, no de modelado.

---

## 7. Afirmaciones verificadas contra `@medplum/fhirtypes@5.1.24`

Todo lo de abajo se leyó en `node_modules/@medplum/fhirtypes/dist/*.d.ts` en este árbol. Los `.d.ts` prueban **cardinalidad, tipo y targets de `Reference`**; no llevan información de binding ni de search parameters, y el paquete incluye backports de R5 (`HealthcareService.offeredIn`), así que no sirven como prueba de pertenencia a R4.

- `Appointment` **no tiene `partOf`** ni `encounter` ni `subject`. Las únicas apariciones de "encounter" en `Appointment.d.ts` son texto de comentarios.
- `Appointment.basedOn?: Reference<ServiceRequest>[]` (línea 245) — 0..\*, y `ServiceRequest` es el **único** target aceptado.
- `Appointment.slot?: Reference<Slot>[]` (218) — 0..\*.
- `Appointment.participant: AppointmentParticipant[]` (250) — **1..\*, obligatorio**.
- `AppointmentParticipant.actor?: Reference<Patient | Practitioner | PractitionerRole | RelatedPerson | Device | HealthcareService | Location>` (313) — `Location` y `Device` incluidos; `Schedule` y `Slot` no.
- `AppointmentParticipant.period?: Period` (331) — 0..1, "Participation period of the actor".
- `Appointment.serviceCategory?: CodeableConcept[]`, `serviceType?: CodeableConcept[]`, `specialty?: CodeableConcept[]` — 0..\*; `appointmentType?: CodeableConcept` — **0..1**.
- `Encounter.appointment?: Reference<Appointment>[]` (202) — 0..\*: la dirección del puntero en R4 es Encounter→Appointment.
- `Encounter.class: Coding` (140) — **1..1 obligatorio**, tipo `Coding`, no `CodeableConcept`.
- `Encounter.type?: CodeableConcept[]` (158) — 0..\*; `Encounter.serviceType?: CodeableConcept` (164) — 0..1 **singular**.
- `Encounter.location?: EncounterLocation[]` (245) — 0..\*, con `location` 1..1, `period?` y `status?` (`planned|active|reserved|completed`); `Encounter.basedOn?: Reference<ServiceRequest>[]` (192); `Encounter.partOf?: Reference<Encounter>` (261).
- `Slot.schedule: Reference<Schedule>`, `Slot.status`, `Slot.start` y `Slot.end` son **obligatorios**; `status` es exactamente `busy | free | busy-unavailable | busy-tentative | entered-in-error`; `Slot.overbooked?: boolean` es 0..1 y su definición literal es una advertencia de sobreventa, no un contador.
- `Schedule.actor` es **1..\*** y acepta `Device`, `HealthcareService` y `Location`, entre otros; `Schedule.planningHorizon?: Period` existe y hoy no se usa.
- `Coverage.status: 'active' | 'cancelled' | 'draft' | 'entered-in-error'` (`Coverage.d.ts:113`) — **no existe `suspended`**, y el campo es obligatorio: TypeScript no compila el valor.
- `Coverage` no tiene ningún elemento de balance de beneficios. `beneficiary` es 1..1, `payor` es **1..\* obligatorio**, `period` 0..1, `contract` 0..\*, `class` 0..\* con `type` 1..1 y `value` 1..1.
- `ServiceRequest.subject: Reference<Patient | Group | Location | Device>` (235) — **1..1**; `status` e `intent` obligatorios, con `intent` de nueve valores incluidos `plan`, `order` y `original-order` (172).
- `ServiceRequest.requisition?: Identifier` (161) — 0..1; `occurrencePeriod?: Period` (251); `insurance?: Reference<Coverage | ClaimResponse>[]` (324); `code?: CodeableConcept` **0..1** (su ausencia es el mapeo del comodín `'*'`).
- `ServiceRequest.requester?` acepta también `Patient`, `RelatedPerson`, `Organization` y `Device`: su presencia no prueba autoría médica.
- `ServiceRequest.basedOn` acepta `CarePlan | ServiceRequest | MedicationRequest` — **no acepta `Appointment`**: la relación sólo puede ir en la dirección `Appointment.basedOn`.
- `Task.status` incluye `'on-hold'` (182); `focus?: Reference<Resource>` (221), `for?: Reference<Resource>` (227), `executionPeriod?: Period` (240), `authoredOn?` (245). `TaskInput`/`TaskOutput` tienen `type` 1..1 y `value[x]` con todo el abanico de tipos: no hacen falta extensiones.
- `Basic` tiene exactamente `identifier?`, `code` **1..1 obligatorio** (115), `subject?: Reference<Resource>` (121), `created?: string` (126) y `author?` — **no tiene `status` ni `period`**. Que `created` sea de tipo `date` (día) no se lee en el `.d.ts` (que lo aplana a `string`) pero está documentado y aplicado tres veces en este repo con `.slice(0, 10)`.
- `Provenance` **no tiene elemento `identifier`**: sin clave de negocio no hay conditional create ni idempotencia.
- `ChargeItemDefinition.url: string` (118) — **1..1 obligatorio**; `version?` (140), `effectivePeriod?` (246), `code?: CodeableConcept` **0..1** (252), `propertyGroup?` (270); `propertyGroup` **no tiene elemento `code`**; `priceComponent.type` es `base | surcharge | deduction | discount | tax | informational`, con `factor?: number` y `amount?: Money`. `ChargeItemDefinition.instance` sólo acepta `Reference<Medication | Substance | Device>`: no acepta `ActivityDefinition` ni `PlanDefinition`.
- `ChargeItem.definitionCanonical?: string[]` (143), `factorOverride?: number` (223), `priceOverride?: Money` (229), `overrideReason?: string` (236) — los cuatro existen y hoy no se usan.
- `Library.type: CodeableConcept` (178) — **1..1 obligatorio**; `url?`, `version?`, `status`, `effectivePeriod?`, `relatedArtifact?`, `content?: Attachment[]`. `RelatedArtifact.type` incluye `composed-of`, `predecessor` y `successor`.
- `Money.currency` incluye tanto `'USD'` como `'ARS'`.
- `InsurancePlan` **no tiene `url` ni `version`**; `plan.specificCost.benefit.cost.value` es `Quantity` (que no tiene `currency`), no `Money`. `List` no tiene `url`, `version` ni `effectivePeriod`, y su `status` no incluye `draft`.
- `Device.location?: Reference<Location>` (231) — existe; `Device.parent?: Reference<Device>` (253); `Device.property?` (209) con `type` 1..1 y `valueQuantity`/`valueCode` 0..\*; `Device.status?: 'active' | 'inactive' | 'entered-in-error' | 'unknown'` (128).
- `Location.partOf?: Reference<Location>` (184), `physicalType?: CodeableConcept` (167), `mode?: 'instance' | 'kind'` (145). `Location` no tiene ningún campo de capacidad.
- `EpisodeOfCare.statusHistory[]` tiene `period` **1..1 obligatorio**: auditoría nativa de cambios de estado, que ningún otro candidato ofrece.
- En `@medplum/core@5.1.24`: `PatchOperation.op` incluye `'test'`, existen `patchResource()`, `createResourceIfNoneExist()` y `upsertResource()`, y `updateResource()` **no tiene parámetro de versión ni manda `If-Match`** (cero apariciones de `If-Match` en el `.d.ts`). El lost-update descrito en §3.4 es real.
- `AccessPolicy.resource[]` (de Medplum, no de R4) tiene `criteria?`, `hiddenFields?`, `readonlyFields?` y `writeConstraint?`. `readonlyFields` ya se usa en producción en `POLICY_PACIENTE_PORTAL`.

**No verificable en este árbol, y por lo tanto no afirmado como verificado:** la existencia y la expresión de cualquier search parameter (R4 o propio de Medplum), la *binding strength* de cualquier elemento, el contenido de cualquier CodeSystem o ValueSet de HL7, la implementación de `ChargeItemDefinition/$apply` en Medplum, la semántica de prefijos `date` contra `Period` en este servidor, y todo lo relativo a R5 más allá de la estructura de los tipos.
