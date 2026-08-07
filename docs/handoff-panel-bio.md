# Respuesta a "Sesiones acumuladas": lo que recepción escribe en el turno

> **Qué es este documento.** La respuesta a los cuatro pedidos del handoff del
> Panel Bio (`RECEPCIONINTEGRACION.md` §6). Contesta las tres preguntas
> abiertas, corrige dos supuestos que habrían fallado en silencio y describe el
> cambio que hicimos de este lado para que el conteo no dependa de adivinar.
>
> Interlocutor: repo del dashboard clínico (Panel Bio). Este repo:
> `recepcion.biowellness.ar`.

---

## Resumen

Las tres preguntas están contestadas y **dos de los supuestos del handoff no se
sostenían**:

1. La extensión **no** es `/itemCodigo` sino `/item-codigo` (kebab-case). El
   sondeo de `codigoServicioDeTurno()` no iba a encontrar nada — y como el
   fallback es silencioso, el conteo habría dado cero sin avisar.
2. En un turno de **combo**, `item-codigo` trae el código del **combo**
   (`BIO_OXYGEN`), no el del servicio. Es correcto para facturación y es
   inservible para el conteo clínico: seis de los nueve combos incluyen HBOT, y
   las dos patas del combo llevan el mismo código, así que atribuir por ahí
   contaría doble o no contaría nada.

Por eso **el turno ahora dice qué terapia se administra en campos nativos de
FHIR**: `Appointment.serviceType` (el servicio) y `Appointment.serviceCategory`
(la terapia). El sondeo #1 que ya tienen escrito funciona sin cambios de su
lado. Ver §2 y §6.

Y sí: **recepción cierra los turnos en `fulfilled`** — hay botón y bot. Con una
salvedad operativa que importa para el umbral de seguridad (§4).

---

## 1. Los códigos de servicio (pedido 1)

Son **36 servicios en 10 categorías**. La fuente de verdad es
[`src/config/catalogo.ts`](../src/config/catalogo.ts); el seed los publica como
`ActivityDefinition` con `identifier.system =
https://biowellness.ar/fhir/CodeSystem/servicio`.

Lo importante para ustedes: **la agrupación por terapia ya existe en el
catálogo** y se llama `categoria`. Es exactamente lo que el handoff pedía
cuando decía "una terapia puede tener varios códigos".

| Categoría (terapia) | Códigos de servicio |
| --- | --- |
| `HBOT` | `HBOT_MONO`, `HBOT_BIPLAZA`, `HBOT_MULTIPLAZA` |
| `IHHT` | `IHHT` |
| `RED_LIGHT` | `RED_LIGHT` |
| `RECOVERY_PRO` | `RECOVERY_PRO` |
| `COMPRESION` | `COMPRESION` |
| `CRIO` | `CRIO` |
| `IV_THERAPY` | `IV_HIDRATACION`, `IV_PERFORMANCE`, `IV_NAD` |
| `MASAJE_OSTEOPATIA` | `MASAJE_DESCONTRACTURANTE`, `MASAJE_DEPORTIVO`, `OSTEOPATIA` |
| `CONSULTA` | `CONSULTA_MED_DALESSANDRO`, `CONSULTA_MED_DOS_SANTOS`, `CONSULTA_MED_CONRADO`, `CHEQUEO_BW` |
| `TERAPIA_BIOLOGICA` | `PRP`, `PEPTIDOS_G1`, `PEPTIDOS_G2`, `PEPTIDOS_G3`, `EXOSOMAS`, `LISADO_PLAQUETARIO`, `AC_HIALURONICO_APM`, `AC_HIALURONICO_BPM`, `COLIRIO_PLASMA`, `COLIRIO_PLASMA_COAGULO`, `PRP_BIOFILLER_ESTETICO`, `PRP_BIOFILLER_TRAUMATICO`, `CREMA_DERMATO`, `CELULAS_MADRE`, `EXPANSION_10MM`, `EXPANSION_20MM`, `EXPANSION_30MM`, `EXPANSION_60MM` |

Las tres cámaras son tres servicios y **una sola exposición**: se diferencian en
cuánta gente entra (mono 1, biplaza 2, multiplaza hasta 6), no en el protocolo.
Para el tope acumulado de HBOT, los tres suman igual.

**Sugerencia fuerte: no copien esta tabla.** Si `therapy-definitions.json`
guarda la lista de 36 códigos, queda desincronizado el día que agreguemos un
servicio (`CHEQUEO_BW` se agregó hace tres semanas) y su contador va a marcar
`confiable: false` por un código que para nosotros no es nuevo en absoluto.
Agrupen por `serviceCategory` (§2) y el problema no existe: un servicio nuevo de
HBOT llega ya clasificado como `HBOT`.

### Combos

Hay 9 combos, que son **paquetes comerciales de servicios que ya están en la
tabla de arriba** — no son terapias nuevas:

| Combo | Servicios que ejecuta |
| --- | --- |
| `BIO_ENERGY` | `IHHT`, `RED_LIGHT` |
| `BIO_COMPRESS` | `COMPRESION`, `RED_LIGHT` |
| `BIO_CRYO` | `CRIO`, `COMPRESION` |
| `BIO_OXYGEN` | `HBOT_MONO`, `IHHT` |
| `BIO_OXYGEN_PAREJA` | `HBOT_BIPLAZA`, `IHHT` |
| `BIO_RECOVERY` | `HBOT_MONO`, `RECOVERY_PRO` |
| `BIO_RECOVERY_PAREJA` | `HBOT_BIPLAZA`, `RECOVERY_PRO` |
| `BIO_LONGEVITY` | `HBOT_MONO`, `IHHT`, `RECOVERY_PRO` |
| `BIO_LONGEVITY_PAREJA` | `HBOT_BIPLAZA`, `IHHT`, `RECOVERY_PRO` |

Un combo genera **un `Appointment` por servicio** (no uno solo): `BIO_LONGEVITY`
crea tres turnos, encadenados por `identifier` de instancia de combo y ordenados
por la extensión `orden-protocolo`. Cada uno ocupa su sala y se cierra por
separado. Con `serviceCategory` cada pata cuenta en su terapia y ninguna cuenta
de más.

---

## 2. Dónde viaja el código en el `Appointment` (pedido 2)

### Lo que había — y por qué su sondeo fallaba

`Appointment.extension`, con la URL en **kebab-case**, que es la convención de
todo este repo (`CLAUDE.md` § Convenciones):

```
https://biowellness.ar/fhir/StructureDefinition/item-tipo     valueCode:   "servicio" | "combo"
https://biowellness.ar/fhir/StructureDefinition/item-codigo   valueString: "HBOT_MONO" | "BIO_OXYGEN"
```

El handoff buscaba una extensión terminada en `/itemCodigo`. Ese string no
existe ni existió: `EXT.itemCodigo` es el nombre de la **constante TypeScript**,
y su valor es `.../item-codigo`. Hay ahora un test que lo fija
(`tests/clasificacion-servicio.test.ts`).

Y aunque hubieran acertado la URL, **`item-codigo` es el ítem que se cobra**, no
el que se administra. Lo lee el circuito de seña/saldo para calcular el 50 %. En
un combo dice `BIO_OXYGEN` en las dos patas. Es el campo correcto para
facturación y el incorrecto para exposición clínica.

### Lo que hay ahora

Desde este cambio, todo `Appointment` que crea recepción lleva además los dos
campos nativos de FHIR, con el servicio **efectivo** de esa sala:

```jsonc
{
  "resourceType": "Appointment",
  "status": "fulfilled",
  "description": "Cámara Hiperbárica (HBOT) — Monoplaza",

  // ── Lo que se HACE (esto es lo suyo) ───────────────────────────
  "serviceType": [{
    "coding": [{
      "system": "https://biowellness.ar/fhir/CodeSystem/servicio",
      "code": "HBOT_MONO",
      "display": "Cámara Hiperbárica (HBOT) — Monoplaza"
    }],
    "text": "Cámara Hiperbárica (HBOT) — Monoplaza"
  }],
  "serviceCategory": [{
    "coding": [{
      "system": "https://biowellness.ar/fhir/CodeSystem/categoria-servicio",
      "code": "HBOT",
      "display": "Cámara Hiperbárica"
    }],
    "text": "Cámara Hiperbárica"
  }],

  "start": "2026-08-07T14:00:00.000Z",
  "end": "2026-08-07T15:00:00.000Z",
  "slot": [{ "reference": "Slot/..." }],
  "participant": [
    { "actor": { "reference": "Patient/..." }, "status": "accepted" }
  ],

  // ── Lo que se COBRA (contrato de facturación, no lo usen para contar) ──
  "extension": [
    { "url": "https://biowellness.ar/fhir/StructureDefinition/recurso-fisico", "valueString": "R_HBOT_MONO" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/ocupantes", "valueInteger": 1 },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/item-tipo", "valueCode": "servicio" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/item-codigo", "valueString": "HBOT_MONO" },
    { "url": "https://biowellness.ar/fhir/StructureDefinition/cobertura-usada", "valueString": "Coverage/..." }
  ]
}
```

Ese JSON está armado a partir del código que lo escribe
([`src/bots/reservar-turno.ts`](../src/bots/reservar-turno.ts)), no es un dump
de producción — en este contenedor no hay credenciales. **Pero no hace falta que
se lo pasemos**: comparten el proyecto Medplum, así que lo pueden traer ustedes
y ver el recurso real:

```
GET /fhir/R4/Appointment?status=fulfilled&_count=5&_sort=-date
```

### Cómo leerlo, en orden

1. `Appointment.serviceCategory[].coding[]` con system
   `.../CodeSystem/categoria-servicio` → **la terapia**. Es lo que quieren para
   el acumulado, y no requiere tabla de equivalencias.
2. `Appointment.serviceType[].coding[]` con system `.../CodeSystem/servicio` →
   el servicio puntual, si les interesa el detalle (mono vs. multiplaza).
3. Extensión `.../item-codigo` → **solo como fallback para turnos viejos**, y
   sabiendo que en combos trae el código del combo. Ver la advertencia de §6.

---

## 3. El cierre del turno (pedido 3)

**Sí, recepción mueve el turno a `fulfilled`.** No quedan en `booked` para
siempre.

El módulo es [`src/bots/estado-turno.ts`](../src/bots/estado-turno.ts) (bot
`bw-estado-turno`), y está conectado a la UI: la recepcionista abre el turno en
la agenda del día y el modal tiene los botones Llegó / En curso / Completó /
Cancelar
([`app/src/components/TurnoModal.tsx`](../app/src/components/TurnoModal.tsx) →
`cambiarEstadoTurno`). El bot hace tres cosas:

- pone `Appointment.status` en el estado pedido;
- abre el `Encounter` de la visita al llegar y lo cierra (`finished`) al
  completar — **si les sirve más un `Encounter` que un `Appointment`, existe y
  apunta al turno** (`Encounter.appointment`);
- libera la sala (`Slot` → `free`) en `fulfilled` y en `cancelled`.

Los estados que usa son los de FHIR y coinciden con lo que asumieron:
`pending` (Tentativo) · `booked` (Confirmado) · `arrived` (Llegó) ·
`checked-in` (En curso) · `fulfilled` (Completado) · `cancelled`.

---

## 4. La salvedad que sí importa: el cierre es manual

No hay ningún proceso que cierre turnos solo. `bw-vencer-tentativas` solo
cancela tentativas que no pagaron la seña; nada promueve `booked` → `fulfilled`
por el paso del tiempo.

O sea: **un turno que se atendió pero que la recepcionista no cerró queda en
`booked` o en `arrived` para siempre**, indistinguible de uno que el paciente
nunca usó. Es una falta de registro, no un bug: pasa cuando el mostrador está
lleno.

Su heurística de §4 ("ante la duda, contar de más", contar `arrived` y
`checked-in` viejos e informarlos en `sinCerrar`) es **la decisión correcta**, y
lo decimos con conocimiento del lado que genera el dato. Dos precisiones para
calibrarla:

- Un `arrived` o `checked-in` viejo es evidencia fuerte de que el paciente
  entró: alguien lo marcó presente en el mostrador. Contarlo es casi seguro
  correcto.
- Un `booked` viejo es ambiguo de verdad: significa "pago y reservado", y
  recepción no registró nada después. Si lo cuentan, va a inflar; si no lo
  cuentan, va a subestimar en la misma proporción en que el mostrador se olvida
  de cerrar. Sugerimos informarlo aparte de `sinCerrar`, como una tercera
  categoría, en vez de mezclarlo.

Si el umbral de exposición va a apoyarse en este número, lo que corresponde no
es parchearlo de ningún lado sino **mejorar la disciplina de cierre en el
mostrador**. Es una conversación con Andrés, no un cambio de código: podemos
agregar un aviso en la agenda del día para turnos pasados sin cerrar. Queda
propuesto, no implementado.

---

## 5. Los `Flag` de contraindicación (pedido 4)

Recepción escribe **dos clases de `Flag` sobre el paciente, con sistemas
distintos**, y esto es lo más importante de esta sección: **si leen todos los
`Flag` activos van a tomar bloqueos de cobranza como si fueran
contraindicaciones clínicas.**

| Sistema | Qué es | ¿Clínico? |
| --- | --- | --- |
| `https://biowellness.ar/fhir/CodeSystem/contraindicacion` | Contraindicación clínica (R-02) | **Sí** |
| `https://biowellness.ar/fhir/CodeSystem/bloqueo` | Bloqueo administrativo por pago rechazado (R-11), código `PAGO_RECHAZADO` | **No** — es cobranza |

Filtren por `code.coding[].system === '.../CodeSystem/contraindicacion'`.

La forma del recurso:

```jsonc
{
  "resourceType": "Flag",
  "status": "active",
  "category": [{ "text": "Contraindicación" }],
  "code": {
    "coding": [{
      "system": "https://biowellness.ar/fhir/CodeSystem/contraindicacion",
      "code": "HBOT_NEUMOTORAX_NO_TRATADO"
    }],
    "text": "…"
  },
  "subject": { "reference": "Patient/…" }
}
```

Los 13 códigos vigentes están en
[`src/config/contraindicaciones.ts`](../src/config/contraindicaciones.ts): 8 de
HBOT (`HBOT_NEUMOTORAX_NO_TRATADO`, `HBOT_MEDICACION_INCOMPATIBLE`,
`HBOT_EPOC_RETENCION_CO2`, `HBOT_INFECCION_VIA_AEREA`, `HBOT_CONVULSIONES`,
`HBOT_FIEBRE_ALTA`, `HBOT_CLAUSTROFOBIA`, `HBOT_EMBARAZO`) y 5 de IHHT
(`IHHT_SCA_RECIENTE`, `IHHT_INSUF_CARDIACA_DESCOMP`, `IHHT_HTP_SEVERA`,
`IHHT_INFECCION_RESPIRATORIA`, `IHHT_HTA_NO_CONTROLADA`). Cada uno declara
`aplicaA` (categorías afectadas) y `severidad` (`absoluta` bloquea la reserva
sin autorización médica; `relativa` advierte).

⚠️ **Esa tabla es un borrador sin aprobación médica** (`borradorPendienteRevision:
true` en cada entrada): ni el Manual v8 ni el v9 traían tabla de
contraindicaciones, así que se cargó una lista estándar para que el banner de
seguridad tuviera datos. Está pendiente la revisión del Director Médico. No la
usen como referencia clínica del Panel Bio sin ese visto bueno.

### Sobre reconciliar `Flag` con `Condition`

Coincidimos en que hoy son dos lecturas ciegas entre sí, y en que conviene
reconciliarlas. Pero no es "otro string": es decidir **cuál de los dos es la
fuente de verdad** y quién puede escribirla, y eso toca la regla de privacidad
de este repo — la recepción ve la señal binaria del banner, nunca el detalle
clínico. Si el Panel Bio pasa a escribir `Condition` y recepción las lee, hay
que definir qué se le muestra al mostrador.

Es una decisión de arquitectura entre los dos repos y va con Andrés antes de
implementarse (`CLAUDE.md` § Gobernanza). Mientras tanto, leer los `Flag` con el
system de arriba les da hoy lo que recepción tiene cargado.

---

## 6. Qué cambió de este lado, y qué tienen que saber

Cambio en este repo (`src/fhir/appointment.ts`, más el cableado en
`bw-reservar-turno`, `bw-reservar-combo` y los datos demo):

- **Nuevo:** `Appointment.serviceType` y `Appointment.serviceCategory` en todo
  turno que crea recepción, con el servicio efectivo — también en cada pata de
  un combo.
- **Nuevo sistema publicado:** `https://biowellness.ar/fhir/CodeSystem/categoria-servicio`.
- **Sin tocar:** `item-tipo` / `item-codigo` siguen exactamente igual. Son el
  contrato de facturación con Administración y no se mueven.

⚠️ **Los turnos creados antes del deploy no tienen `serviceType`.** El cambio no
es retroactivo: no reescribimos historia. Para esos turnos el único dato es la
extensión `item-codigo`, con el problema de los combos descrito en §2. Dos
consecuencias:

- El acumulado histórico va a estar incompleto hasta que los turnos viejos
  salgan de la ventana que miren. Vale la pena que el panel lo declare, en la
  misma línea de su decisión "un conteo incompleto se declara".
- Si les hace falta el histórico completo, se puede escribir una migración que
  complete `serviceType` en los `Appointment` existentes (para combos, derivando
  el servicio del combo + `orden-protocolo`). No la hicimos porque toca datos de
  producción y eso se consulta primero. Si la quieren, pídanla y la corremos.

**Depende de un deploy de bots** (`npm run deploy:bots`), que está pendiente en
este momento por otros motivos. Hasta que corra, los turnos nuevos siguen
saliendo sin `serviceType`.

---

## 7. Resumen para su backlog

| Pedido | Estado |
| --- | --- |
| 1 · Lista de códigos | Contestado (§1). Mejor que copiarla: agrupar por `serviceCategory`. |
| 2 · `Appointment` real | Contestado (§2). El sondeo `/itemCodigo` estaba mal: es `/item-codigo`, y en combos trae el combo. Ahora hay `serviceType`/`serviceCategory`. |
| 3 · ¿Llega a `fulfilled`? | Sí (§3), por `bw-estado-turno` desde el modal de la agenda. El cierre es manual: ver la salvedad de §4. |
| 4 · Sistema de los `Flag` | `.../CodeSystem/contraindicacion` (§5). Ojo con no mezclarlo con `.../CodeSystem/bloqueo`, que es cobranza. |
