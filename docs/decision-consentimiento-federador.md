# Consultar el Federador con el DNI: qué consentimiento hace falta

> Documento de decisión para Andrés. Preparado el 2026-08-25 a partir de tres
> análisis independientes (legal · operación del mostrador · confianza del
> cliente) que convergieron en el mismo diagnóstico por caminos distintos.
> **La palabra final es de Andrés con el asesor legal** — este documento existe
> para que esa conversación arranque desde opciones bien armadas, no para
> reemplazarla.

## Qué se decide

Cuando el autocompletado por DNI se destrabe (falta la credencial de aplicación
del Ministerio, ver `handoff-federador-msal.md`), cada alta va a poder consultar
el registro nacional de pacientes. **Lo delicado no es el dato que vuelve**
(nombre, fecha de nacimiento, género — identidad básica): es el que **viaja**.
Cada consulta le comunica al Estado, con fecha y hora, que esa persona con ese
DNI es cliente de un centro de longevidad. Ese hecho relacional es, en la
práctica, un dato de salud por inferencia, y va a un tercero (Ley 25.326,
art. 11: la cesión requiere consentimiento del titular salvo excepciones). La
pregunta es con qué autorización se hace esa consulta.

## El dato que cambia la discusión: el texto vigente juega EN CONTRA

Los tres análisis lo encontraron por separado. La **sección 7** del
consentimiento v1 (`src/config/consentimiento-texto.ts`) promete:

> "No ceder, vender ni **compartir la información personal del cliente con
> terceros**, salvo requerimiento judicial o **autorización expresa**."

Y la única autorización de tratamiento que el texto contiene cubre "los datos de
salud **provistos en este formulario**" — no datos que Biowellness salga a
buscar a un registro estatal. O sea: el consentimiento actual **no es que no
cubra la consulta — la prohíbe**, salvo autorización expresa que hoy no existe.
Consultar en silencio no sería un vacío legal: sería incumplir un compromiso
propio, firmado, que el propio sistema archiva como evidencia
(`DocumentReference`). Para una marca que vende discreción, el titular del día
que se descubra no es "centro usa registro público": es *"el spa prometió no
compartir tus datos y le avisa al Estado cada vez que vas"*.

## El segundo dato duro: el problema de secuencia

El consentimiento se firma en el kiosco o el portal **después** de que la ficha
existe (el kiosco exige `pacienteRef`; el portal exige invitación previa). La
consulta al Federador ocurre **en el alta, al tipear el DNI** — antes de
cualquier firma, para todo paciente nuevo. Una cláusula en el documento, por
perfecta que sea, **nunca cubre ex ante la consulta principal**, que es
prácticamente la única (el Federador sirve para autocompletar el alta). La
autorización tiene que resolverse **en el mostrador, en el momento**.

## Las opciones

### A · Solo cláusula en el texto v2 (cero fricción)

Se agrega la cláusula al consentimiento, nada cambia en el alta, y la base
legal es la interpretación de que la consulta deriva de la relación contractual
(art. 5.2.d) más el deber de información (art. 6).

- **Mostrador:** 0 segundos. **Registro:** excelente pero del momento equivocado.
- **Solidez:** débil. El flanco: la consulta *no es necesaria* para la relación
  (el alta manual existe y funciona), y la primera consulta de cada paciente
  nuevo sigue ocurriendo antes de firmar nada. Es interpretación, no certeza.
- **Percepción:** el cliente se entera leyendo un documento, como sujeto pasivo.

### B · Pregunta verbal + registro en el alta + cláusula v2 (la recomendada)

La consulta va detrás de un **botón explícito** en el alta (nunca disparada por
el tipeo). La etiqueta del botón es el guion de la recepcionista:

> *"¿Querés que traigamos tus datos del Registro Nacional así no tenés que
> deletrear nada? Solo consultamos; no compartimos nada tuyo."*

El clic **escribe evidencia** (AuditEvent y/o un Consent liviano con código
propio: quién preguntó, cuándo, qué DNI, "autorización verbal recabada en
mostrador"). El "no" no cuesta nada: sin clic no hay consulta y el alta sigue
como hoy — el diseño fail-open del bot ya lo garantiza. La cláusula en el texto
v2 repara la sección 7 e informa por escrito (art. 6); la firma del kiosco,
minutos después, **ratifica** documentalmente lo autorizado de palabra.

- **Mostrador:** 0-5 segundos (se pliega en la frase con la que ya se pide el DNI).
- **Registro:** el clic deja rastro nominal ANTES de la consulta + ratificación firmada después.
- **Solidez:** la más alta disponible sin romper el flujo. Consentimiento libre
  de verdad: negarse no tiene costo alguno.
- **Percepción:** control total del cliente, enunciado como beneficio. La
  pregunta *es* el mensaje de marca.
- **Riesgo a mitigar:** con fila, el tilde degenera en "autocompletar sin
  preguntar". Mitigación: el botón-como-guion, el registro nominal de quién lo
  clickeó, y que el guion esté escrito en la pantalla.

### C · Reordenar el flujo: firma antes que consulta

Alta mínima (DNI + teléfono) → la persona firma el v2 en el kiosco → recién
entonces el sistema consulta y sugiere completar la ficha.

- **Solidez:** impecable, sin pregunta adicional.
- **Costo:** cambia la UX del alta, condiciona el autocompletado a un paso
  posterior, y ata dos cosas conceptualmente distintas (alguien puede querer
  firmar la atención y aun así no querer que se consulte el registro — y
  embutir la autorización en el texto que R-20 exige para reservar la vuelve
  no-libre: decir que no equivaldría a no poder usar el centro).

### D · No preguntar (statu quo con el Federador activo)

Descartada por los tres análisis: contradice el texto firmado, el principio de
privacidad por diseño del repo, y ante un reclamo no hay nada que mostrar.

| | A · Solo cláusula | **B · Pregunta + registro + cláusula** | C · Firma primero | D · Silencio |
|---|---|---|---|---|
| Segundos en mostrador | 0 | 0-5 | 0 (pero rehace el flujo) | 0 |
| Autorización previa a la consulta | ✗ | ✓ (verbal registrada) | ✓ (firmada) | ✗ |
| Repara la sección 7 | ✓ | ✓ | ✓ | ✗ |
| Consentimiento libre | — | ✓ | ⚠ (atado a R-20) | ✗ |
| Solidez legal | débil | alta | la más alta | nula |
| Percepción del cliente | pasiva | control + beneficio | trámite | riesgo reputacional máximo |

## Recomendación

**B.** Es la única que resuelve el problema de secuencia sin romper el flujo del
alta, convierte la obligación legal en un gesto de marca, y su costo es una
frase de siete segundos a una persona que está presente. A y C quedan como
piezas de B (la cláusula v2) o como alternativa si el asesor legal exige firma
previa (C). Decidirlo ahora es barato: la UI del alta para el Federador todavía
no existe, así que el mecanismo se diseña junto con ella, no encima.

Dos cosas que conviene pedirle al Ministerio en la misma consulta del 412:
si el **convenio del dominio 4002** ya obliga a recabar consentimiento del
titular por cada consulta (patrón RENAPER/SID — nadie del equipo lo tiene
leído), y que **retiren el scope `Patient/*.write`** o quede constancia formal
de que no se ejercita: federar (escribir) una ficha en el registro nacional es
una cesión mucho más grave que la lectura y el consentimiento que se diseñe acá
no la cubre.

## Menores

Autoriza el adulto responsable (la 25.326 no fija edad; rige la autonomía
progresiva del CCyC). El flujo del botón tiene que contemplar quién responde
cuando el titular del DNI es un menor — misma lógica que ya usa el kiosco.

## Ley 26.743: el nombre registral en el mostrador

El Federador devuelve el **nombre registral**. Si la persona usa otro nombre,
mostrárselo o comentarlo en voz alta en su primer contacto con la marca es el
daño perceptivo máximo y además incumple el art. 12 (trato digno: usar el
nombre de pila adoptado). Protocolo, en parte ya construido:

1. **Nombre primero.** La recepcionista pregunta y tipea el nombre **antes** de
   consultar. `sugerenciaParaAlta` nunca pisa lo que ya está escrito (regla
   "solo lo que falta", implementada y testeada).
2. **El campo "Nombre elegido" del alta** (implementado 2026-08-25): va primero
   en `name` con `use: usual`, y es el que muestran todas las pantallas y los
   mensajes. El registral queda como `use: official` para el Federador y lo
   fiscal.
3. Si el Federador trae un nombre distinto al declarado, **no se comenta**: la
   divergencia no es un error a corregir en voz alta, es un dato que la ficha ya
   sabe representar.
