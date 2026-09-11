# Handoff: catálogo — servicios retirados y viñetas por familia

> **Qué es este documento.** Dos cambios en el catálogo pedidos por Andrés
> (2026-09-11) que ya están publicados en Medplum y **necesitan trabajo del
> lado del portal** para verse. Sin ese trabajo, el portal sigue mostrando lo
> de antes: no rompe nada, pero el cambio no llega a la paciente.
>
> Interlocutor: repo del portal del paciente (`app.biowellness.ar`).
> Este repo: `recepcion.biowellness.ar` — es el **dueño del catálogo**.

---

## Cómo viaja el catálogo (contexto, por si no está claro)

`src/config/catalogo.ts` (este repo) → `npm run seed` → `ActivityDefinition` en
Medplum → el portal los lee. Una sola dirección. El portal **no** decide qué
servicios existen, cómo se llaman, ni en qué orden van: todo eso viaja en el
recurso.

---

## 1. Servicios retirados — el portal tiene que filtrar por `status`

**Qué cambió.** Cuatro servicios dejaron de ofrecerse:

| código | nombre |
|---|---|
| `MASAJE_DESCONTRACTURANTE` | Masaje Descontracturante |
| `COLIRIO_PLASMA` | Colirio de Plasma |
| `COLIRIO_PLASMA_COAGULO` | Colirio de Plasma Coágulo |
| `CREMA_DERMATO` | Crema Dermato (por frasco) |

**Cómo llegan.** No se borraron del servidor: siguen existiendo como
`ActivityDefinition` pero con **`status: 'retired'`** en vez de `'active'`.

Se hizo así a propósito, por dos motivos:

- Borrarlos rompería el histórico: hay turnos, cobros y reportes que los
  referencian por código, y de este lado `getServicio()` tira si el código no
  existe.
- El seed hace upsert y **no borra**. Si simplemente los sacáramos del archivo,
  el recurso viejo se quedaría `active` en el servidor y ustedes los seguirían
  mostrando. Publicarlos como `retired` es lo que hace que el cambio llegue.

### Lo que hay que hacer

**Filtrar por `status=active` en la búsqueda de servicios de la góndola.**

```ts
// Antes (trae también los retirados):
medplum.searchResources('ActivityDefinition', { _count: 200 })

// Ahora:
medplum.searchResources('ActivityDefinition', { status: 'active', _count: 200 })
```

⚠️ **No filtren solo en la góndola.** Si el portal resuelve el nombre de un
servicio en "Mis turnos" o en el historial buscando por código, esa consulta
**tiene que seguir trayendo los retirados** — si no, un turno viejo de masaje
descontracturante se queda sin nombre. El filtro va en la vidriera, no en el
lookup.

---

## 2. Terapias Biológicas — de 18 tarjetas a 6 viñetas

**El problema.** La sección mostraba 18 servicios sueltos, cada uno con su
tarjeta, los 18 repitiendo la misma bajada. Palabras de Andrés: *"lo de
Regenerar es eteeeerno, obvio que hay que recontra acortar"*.

**Lo que pidió.** Título + bajada + viñetas:

```
Terapias Biológicas
Medicina regenerativa avanzada con indicación médica personalizada.
El primer paso es la consulta.

  • Células Madre
  • Exosomas
  • Péptidos
  • Lisado Plaquetario
  • PRP
  • Ácido Hialurónico
```

Mismo criterio para **Terapias IV**: título + la bajada que ya viene
(*"Vitaminas, minerales y antioxidantes directo en sangre, según tu objetivo.
Siempre con evaluación médica previa."*).

### Cómo llega el agrupamiento

Dos extensiones nuevas en el `ActivityDefinition`:

| extensión | tipo | qué es |
|---|---|---|
| `https://biowellness.ar/fhir/StructureDefinition/familia` | `valueString` | La viñeta: `"PRP"`, `"Células Madre"`, … |
| `https://biowellness.ar/fhir/StructureDefinition/familia-orden` | `valueInteger` | Posición de la viñeta, 1-based |

El **orden viaja** porque ustedes no importan nuestro código: si solo mandáramos
el nombre, tendrían que decidir el orden y no es su decisión.

El título de la sección sigue viniendo en `topic[0].text` (`"Terapias
Biológicas"`) y la bajada en `description`, como siempre.

### Lo que hay que hacer

Dentro de una sección, agrupar por `familia`:

```ts
const familia = (ad) =>
  ad.extension?.find((e) => e.url === `${BASE}/StructureDefinition/familia`)?.valueString;
const familiaOrden = (ad) =>
  ad.extension?.find((e) => e.url === `${BASE}/StructureDefinition/familia-orden`)?.valueInteger
  ?? Number.MAX_SAFE_INTEGER;
```

- Servicios **con** `familia` → una viñeta por familia, ordenadas por
  `familia-orden` ascendente. La viñeta muestra el **nombre de la familia**, no
  los nombres de los servicios que agrupa.
- Servicios **sin** `familia` → se muestran como hasta ahora (sueltos). Hoy es
  todo el resto del catálogo: el agrupamiento solo aplica a Terapias Biológicas.
- La bajada de la sección se muestra **una vez**, no una por servicio. Eso es
  justamente lo que la hacía eterna.

### El mapeo actual (referencia, no lo hardcodeen)

Sale del servidor; va acá solo para que puedan verificar el render:

| viñeta | orden | servicios que agrupa |
|---|---|---|
| Células Madre | 1 | Concentrado Celular, Expansión 10/20/30/60MM |
| Exosomas | 2 | Exosomas |
| Péptidos | 3 | G1, G2, G3 |
| Lisado Plaquetario | 4 | Lisado Plaquetario |
| PRP | 5 | PRP, Biofiller estético, Biofiller traumático |
| Ácido Hialurónico | 6 | APM, BPM |

**No lo hardcodeen**: sumar un producto a una familia, o una familia nueva, es
tocar nuestro archivo y correr el seed. Si el portal lo replica, la próxima vez
quedan desincronizados.

### ¿Y el precio, si una viñeta agrupa varios?

Cada servicio conserva su `precio-usd`. Cómo mostrarlo en una viñeta que agrupa
cinco productos con precios distintos —"desde USD X", un rango, o nada— es
**decisión de ustedes con Andrés**: no la tomamos de este lado. Lo que sí está
definido es que estos servicios llevan badge de *requiere consulta médica* y que
el primer paso es la consulta, así que el precio no es lo que dispara la acción.

---

## Cómo verificar

Los cuatro retirados no deberían aparecer en la góndola, y Terapias Biológicas
debería mostrar 6 viñetas en vez de 18 tarjetas.

De nuestro lado, el catálogo publicado se revisa con:

```bash
npm run seed -- --dry-run   # construye el catálogo sin conectarse
```

Si algo no coincide con lo que dice este documento, avisen antes de
implementarlo: es más barato que lo corrijamos acá que que ustedes compensen.
