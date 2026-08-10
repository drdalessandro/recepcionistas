# Handoff: Caja chica de recepción — nueva fuente de datos para Administración

> **Qué es este documento.** Aviso de una capacidad nueva del lado recepción y
> el contrato para consumirla. Desde 2026-08-10 la recepción registra su caja
> chica (gastos, reposiciones y arqueos) en el mismo proyecto Medplum que ya
> leen. **Su contrato existente no cambia en nada**: `ChargeItem` e `Invoice`
> siguen exactamente igual — los ingresos en efectivo NO se re-registran en la
> caja, se derivan de los `Invoice` que ya conocen.
>
> Interlocutor: repo de Administración. Este repo: `recepcion.biowellness.ar`.

---

## Resumen

La recepción ahora registra en FHIR lo único que antes vivía en un cuaderno:

- **Movimientos de caja** (gasto / reposición / ajuste) → `Basic` con
  `code = https://biowellness.ar/fhir/CodeSystem/caja`.
- **Arqueos** (cierre de caja contra efectivo físico contado) →
  `PaymentReconciliation` con `identifier.system` de ese mismo sistema.

El diseño tiene una sola idea fuerza: **el saldo esperado se deriva, nunca se
declara**. Recepción no puede "dibujar" la caja porque los ingresos salen de
los cobros reales (`Invoice` balanced con medio de pago efectivo) y los egresos
quedan firmados por quien los cargó (`meta.author`, inmutable, con `AuditEvent`
de Medplum atrás). Ustedes pueden reconstruir y auditar todo sin pedirle nada a
recepción.

```
saldo esperado = contado del último arqueo
               + Invoices en efectivo del período
               + reposiciones y ajustes del período
               − egresos del período
```

---

## 1. Movimientos: `Basic`

Un movimiento por recurso. El tipo va en `code.coding` (system
`https://biowellness.ar/fhir/CodeSystem/caja`):

| Código | Qué es | Efecto en el saldo |
| --- | --- | --- |
| `egreso` | Gasto de caja chica | Resta (el monto se guarda positivo) |
| `reposicion` | Plata que entra para reponer el fondo | Suma |
| `ajuste` | Corrección puntual | El monto lleva signo (±) |

Extensiones (URLs bajo `https://biowellness.ar/fhir/StructureDefinition/`):

| Extensión | Tipo | Contenido |
| --- | --- | --- |
| `caja-monto-ars` | `valueDecimal` | Monto en ARS. Positivo salvo en `ajuste`. |
| `caja-categoria` | `valueCode` | Solo egresos. Lista CERRADA: `insumos`, `limpieza`, `mantenimiento`, `viaticos-mensajeria`, `libreria`, `otros`. No hay texto libre: pueden agrupar por rubro con confianza. |
| `caja-autorizado` | `valueBoolean` | Presente (`true`) solo si el gasto superó el tope y recepción declaró tener autorización previa de Administración. |

El detalle libre ("alcohol y algodón — farmacia") va en `code.text`. Quién y
cuándo: `meta.author` y `meta.lastUpdated` — los pone el servidor, nadie los
edita.

```
GET /fhir/R4/Basic?code=https://biowellness.ar/fhir/CodeSystem/caja|&_sort=-_lastUpdated&_count=100
```

> Nota: las extensiones no están indexadas para búsqueda — para "egresos de
> `limpieza` del mes" traigan los movimientos del período y filtren por la
> extensión del lado de ustedes.

## 2. Arqueos: `PaymentReconciliation`

Uno por cierre de caja. Campos que importan:

| Campo | Contenido |
| --- | --- |
| `identifier` | `{system: …/CodeSystem/caja, value: "arqueo-<ISO del cierre>"}` (antiduplicados) |
| `period` | Ventana que cierra: desde el arqueo anterior hasta este |
| `paymentAmount` | El efectivo **contado físicamente** (ARS) |
| ext `caja-esperado` | Lo que el sistema esperaba encontrar |
| ext `caja-diferencia` | `contado − esperado`. **Negativo = faltó plata.** |
| `disposition` | Resumen legible ("Arqueo OK…" / "DIFERENCIA de …") |

```
GET /fhir/R4/PaymentReconciliation?identifier=https://biowellness.ar/fhir/CodeSystem/caja|&_sort=-created&_count=50
```

El período siguiente arranca del **contado** de este arqueo (no del esperado):
una diferencia se absorbe una sola vez y queda registrada, no se arrastra.

## 3. Alertas que ya se disparan solas

Si un arqueo cierra con diferencia ≠ 0, además del registro se crea un `Task`
`priority=urgent` con `code.text = "Diferencia en arqueo de caja"` y el detalle
en `description`. Si quieren enterarse en el momento, una `Subscription` sobre
`Task` con ese criterio es todo lo que necesitan.

## 4. Controles que ya corren del lado recepción

- Categoría de gasto obligatoria y de lista cerrada (no hay "varios").
- Tope por gasto individual: por encima, la UI exige la marca de autorización
  previa (queda en `caja-autorizado` — auditable).
- La diferencia de arqueo no puede pasar en silencio (alerta del §3) y el
  cierre con diferencia pide confirmación en dos pasos.
- La AccessPolicy de recepción solo permite escribir `Basic` **con el code de
  caja**: el mostrador no puede tocar ningún otro `Basic` (p. ej. el config del
  tipo de cambio).
- Un arqueo cerrado no se edita: correcciones = movimiento `ajuste`, que deja
  rastro propio.

## 5. Parámetros PROVISORIOS — Andrés tiene que confirmar 4 números

Viven en un solo archivo de este repo
([`src/config/caja.ts`](../src/config/caja.ts)); cambiarlos no toca nada más:

| Parámetro | Valor provisorio |
| --- | --- |
| Fondo fijo de la caja | **$200.000** |
| Tope por gasto sin autorización previa | **$25.000** |
| Frecuencia de arqueo (operativa, no forzada por sistema) | **Diario, al cierre** |
| Quién registra reposiciones | Recepción (queda firmada por `meta.author`) |

## 6. Resumen para su backlog

1. **Leer**: las dos queries de §1 y §2 alcanzan para un tablero de caja
   (saldo, egresos por rubro, historial de arqueos y diferencias).
2. **Alertar**: `Subscription` sobre el `Task` de §3 si quieren la diferencia
   en tiempo real.
3. **No hacer**: no re-registren ingresos en efectivo como movimientos de
   caja — ya están en los `Invoice` que consumen hoy; duplicarían.
4. **Si escriben** (p. ej. registrar una reposición desde su panel): usen el
   mismo shape de §1 (`Basic` + code `reposicion` + `caja-monto-ars`); la
   vista de recepción lo levanta sin cambios.
5. **Confirmar** los 4 valores de §5 y avisarnos: es un edit de un archivo.
