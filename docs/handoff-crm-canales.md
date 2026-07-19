# Handoff · Panel "Clientes por canal" para el AdminDashboard (repo `administracion`)

> **Para**: la sesión de Claude Code que trabaje sobre
> `github.com/biowellness/administracion`. Este documento es autocontenido:
> tiene el contrato de datos, las queries, la spec del panel y la verificación.
> Lo produce el repo `recepcionistas` (donde nace el dato).

## Objetivo

Sumar al AdminDashboard (KPI metrics) un panel **"Clientes por canal"** que
compare los canales de adquisición de BioWellness San Isidro: cuántos clientes
trae cada canal y cuántos convierten (turno → pago → socio), con evolución
mensual. El dato ya existe en el servidor Medplum compartido
(`https://api.medplum.com.ar/`, proyecto BioWellness San Isidro): lo carga
Recepción en cada alta.

## Contrato de datos (estable — NO renombrar códigos)

| Dato | Dónde vive | Valores |
|---|---|---|
| Canal de origen | `Patient.extension` · `url = https://biowellness.ar/fhir/StructureDefinition/origen-lead` · `valueString` | `instagram · linkedin · google · qr-local · qr-evento · web · telefono · walk-in · referido · derivacion · otro` |
| Fecha de alta | `Patient.extension` · `url = https://biowellness.ar/fhir/StructureDefinition/fecha-alta` · `valueDate` | `YYYY-MM-DD` (estampada al crear la ficha) |

Semántica:
- **Atribución al primer canal** (first-touch): Recepción nunca pisa el origen
  de una ficha existente.
- **Extensión ausente = "(sin datos)"** — fichas anteriores a la regla
  (2026-07). Decisión de negocio: NO se retro-etiquetan; el panel las muestra
  como una fila/serie propia y su proporción va a decrecer sola.
- Ampliar la lista de códigos es compatible; **renombrar rompe** (misma regla
  que los medios de pago del contrato de Administración).
- Lanzamiento del local: **10/08/2026** → la primera cohorte mensual completa
  es agosto 2026.

## Queries

**Conteo por canal** (rápido, para las cards): existe el SearchParameter
`origen-lead` sobre Patient (lo crea el seed de recepcionistas):

```
GET /fhir/R4/Patient?origen-lead=instagram&_summary=count
```

> Si devuelve "Unknown search parameter": falta el seed de recepcionistas o el
> reindex de `Patient` (Super Admin → Rebuild/Reindex, una sola vez).

**Detalle + conversión** (para la tabla y el gráfico): leer y agrupar en el
bot/panel — paginar con `_count=200&_offset=N` hasta lote corto:

```
GET /fhir/R4/Patient?_elements=extension,active,link&_count=200&_offset=0
GET /fhir/R4/Appointment?_elements=participant,status&_count=200&_offset=0
GET /fhir/R4/Invoice?status=balanced&_elements=subject,status&_count=200&_offset=0
GET /fhir/R4/Coverage?status=active&_elements=beneficiary,extension,status&_count=200&_offset=0
```

Reglas de agregación (implementación de referencia:
`recepcionistas/src/lib/canales.ts` → `resumenPorCanal` y `altasPorMes`,
con tests en `tests/canales.test.ts`):

- **Universo**: Patients con `active !== false` y sin `link` (los `link` son
  duplicados ya fusionados).
- **Con turno**: participa (`participant.actor = Patient/{id}`) de algún
  Appointment en `booked | arrived | checked-in | fulfilled`
  (`pending`/`proposed` NO cuentan: son tentativas sin seña).
- **Con pago**: `subject` de algún Invoice `balanced`.
- **Socio**: `beneficiary` de algún Coverage `active` cuya extensión
  `https://biowellness.ar/fhir/StructureDefinition/tipo-cobertura`
  (`valueCode`) sea `membresia` — si la extensión falta, tratar como membresía.
- **Cohortes**: mes = `fecha-alta[0..7]` (`YYYY-MM`); sin fecha → serie
  "(sin fecha)" aparte.

## Spec del panel (sugerida)

1. **Cards** arriba: total clientes · % con canal cargado · canal top del mes.
2. **Tabla** "Canal · Clientes · Con turno (%) · Con pago (%) · Socios (%)",
   ordenada por clientes desc, "(sin datos)" al final (etiquetas humanas:
   Instagram, LinkedIn, Google (Maps / búsqueda), QR en el local, QR en evento,
   Sitio web / portal, Teléfono, Mostrador (walk-in), Referido, Derivación
   médica, Otro).
3. **Gráfico de barras apiladas** "Altas por mes y canal" desde 2026-08.
4. Refresco: el que use el resto del AdminDashboard (no necesita tiempo real).

## Verificación cruzada

En el repo `recepcionistas` (EC2): `npm run crm:canales` imprime exactamente
las mismas tablas desde el mismo servidor. Si el panel y el script no dan
igual, el panel tiene un bug de agregación (el script es la referencia).

## Reglas duras

- **Solo lectura**: el panel no escribe ni modifica recursos de Recepción.
- No tocar bots ni AccessPolicies del proyecto de Recepción.
- No renombrar los códigos del contrato (ampliar sí, renombrar no).
- Credenciales por variables de entorno; nada de secretos en el código.
