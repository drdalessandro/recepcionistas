# Handoff → recepcionistas: Chequeo BioWellness + policy del portal

> Para pegar en una sesión del repo `biowellness/recepcionistas`.
> Contexto: el portal adopta el journey "Chequeo BioWellness" (evaluación
> inicial como producto de entrada — ver `portal/docs/chequeo-biowellness-journey.md`).
> Decisiones de Andrés del 2026-07-20 incluidas acá. Tres tareas, en orden de
> urgencia (la 1 es un fix de seguridad operativa, las otras dos son del
> lanzamiento 10/08).

## 1 · ⚠️ CRÍTICO — AccessPolicy "Paciente — Portal": entrada Coverage HIP

El portal sumó "Datos de cobertura" (Perfil): el paciente registra su obra
social/prepaga como un `Coverage` con `type` ActCode `HIP`. Para eso la policy
del server tiene hoy una entrada de **escritura acotada por type** (aplicada a
mano el 2026-07-20), además de la readonly amplia.

**El problema**: `npm run seed` aplica la policy por `name` y la definición en
`src/fhir/access-policies.ts` (línea ~140) solo tiene la readonly:

```ts
{ resourceType: 'Coverage', readonly: true, criteria: 'Coverage?beneficiary=%patient' },
```

El próximo seed **pisa la entrada HIP** y rompe el guardado de cobertura en el
portal (403). Agregar en el seed, junto a la readonly (las dos conviven):

```ts
// Cobertura de salud del paciente (obra social/prepaga): escritura SOLO de
// Coverages marcadas con type ActCode HIP. Las membresías/paquetes BW no
// llevan ese type → siguen fuera del alcance del paciente.
{
  resourceType: 'Coverage',
  criteria: 'Coverage?beneficiary=%patient&type=http://terminology.hl7.org/CodeSystem/v3-ActCode|HIP',
},
```

Además, al listar planes (dashboard "Planes y sesiones", `panelPlanes.ts` /
`saldoPlan`), **filtrar las Coverage que no tengan extensiones BW**
(`tipo-cobertura` / `sesiones-mes` / `sesiones-total`): la obra social del
paciente no es un plan y no debe aparecer como fila. El portal ya filtra igual
(`portal/src/fhir/membership.ts`). Convención completa:
`portal/docs/medplum/codesystems-biowellness.md` ("los dos usos de Coverage").

Cierre: diff del mirror `portal/docs/medplum/access-policy-paciente-portal.json`
contra `access-policies.ts` para confirmar que el seed no pierde ninguna otra
entrada (Bot `bw-solicitar-turno`, `Subscription?type=websocket`, `Consent`,
`Binary`, `Task` readonly…). El seed es la fuente de verdad: lo que falte ahí,
se pierde en el próximo `npm run seed`.

## 2 · Producto `CHEQUEO_BW` en el catálogo + seed

Nuevo servicio (decisiones: precio = consulta; devolución con Dalessandro o
Dos Santos indistinto; la orden de laboratorio no se cobra — el paciente la
resuelve por su cobertura y sube el PDF al portal):

- `codigo: 'CHEQUEO_BW'` · nombre **"Chequeo BioWellness"**.
- Categoría: la misma de las consultas médicas (comparte el consultorio y las
  reglas R-07); si el catálogo distingue, puede ir como categoría propia
  "Evaluación".
- Precio: **ARS 120.000** (como las consultas: extensión `precio-ars`, no USD).
  Si Andrés confirma otro precio, ajustar acá y avisar al portal.
- Duración: 60 min (la de una consulta).
- `requierePrescripcion: false` · split `BW_100` (igual que consultas — el
  split de honorarios de consulta sigue "a definir" en decisiones-pendientes).
- Descripción en voz de paciente (el portal la muestra tal cual):
  *"Tu evaluación inicial completa: consulta médica, orden de laboratorio y
  devolución con tu plan personalizado. Completá tu score de salud (Life's
  Essential 8) y arrancá tu protocolo con datos reales."*
- Correr `npm run seed` para publicarlo como `ActivityDefinition` (el portal lo
  lee por identifier `servicio|CHEQUEO_BW`). **Antes, aplicar la tarea 1** (el
  mismo seed pisa la policy).

## 3 · Verificar seña R-19 en consultas confirmadas desde el portal

Regla confirmada por Andrés: **no hay reserva de consulta sin seña del 50%**
(link MP + vencimiento 2 h, mismo circuito R-19 de los turnos sueltos).

Verificar que cuando Recepción confirma una **solicitud de consulta del portal**
(Task `solicitud-turno` con `terapiaCodigo` `CONSULTA_*` o `CHEQUEO_BW`), el
turno nazca **tentativo con seña** como cualquier suelta: WhatsApp con monto
(50% de ARS 120.000), link de MP y hora límite; recordatorio a los 60 min;
liberación automática al vencer. Si `bw-reservar-turno` ya trata la consulta
como servicio del catálogo, no hay nada que tocar — solo confirmar con una
prueba end-to-end (solicitud desde el portal → confirmar → WhatsApp con link).

## Aviso (sin acción): atribución del portal al CRM

El portal va a empezar a escribir en el autoregistro, además de su extensión
`canal-origen`:

- `origen-lead` (la MISMA extensión del contrato CRM, lista cerrada
  `ORIGENES_LEAD`): mapeo del `?ref=` al canal (`ig` → `instagram`, etc.),
  default `web`. Atribución first-touch: si la ficha ya la trae (alta previa de
  Recepción), no se pisa.
- `fecha-alta` (`valueDate`), para las cohortes mensuales.

Con esto los registrados por la app aparecen en el tablero de Administración
(`npm run crm:canales` y el panel del AdminDashboard) desde el lanzamiento.
No requiere cambios en recepcionistas — el SearchParameter `origen-lead` ya
está seedeado.
