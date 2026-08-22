# Pasarelas de pago — evaluación de Clover frente a MercadoPago

**Fecha:** 2026-08-22 · **Estado:** evaluación abierta, sin decisión tomada.
**Para:** Andrés (decide) y Desarrollo (implementa).

Hoy los cobros salen por **MercadoPago**. Este documento evalúa **Clover**
(Fiserv Argentina) como alternativa o complemento, estima la probabilidad de que
terminemos usándolo y deja un **camino rápido** para resolverlo con datos en vez
de opiniones.

---

## ⚠️ Cómo leer este documento (limitación de método)

La investigación se hizo desde un entorno cuya **política de red bloqueó los seis
dominios primarios** que hacían falta:

```
ar.clover.com · docs.clover.com · www.fiserv.com.ar
developer.fiserv.com · www.mercadopago.com.ar · developers.mercadopago.com
```

Todos devolvieron `403` en el proxy de egress. **No se pudo leer una sola página
oficial de Clover, Fiserv ni MercadoPago.** Todo lo referido a capacidades,
aranceles y plazos de esos proveedores viene de resúmenes de buscador y prensa:
sirve para saber **qué preguntar**, no para firmar nada.

Lo único verificado de primera mano es **el código de este repo**, que se leyó
línea por línea. Por eso cada afirmación va marcada:

| Marca | Significa |
|---|---|
| ✅ | Verificado en el repo, con ruta y línea. Se puede confiar. |
| 📰 | Prensa o resumen de buscador. **Sin fuente primaria.** Hay que confirmarlo. |
| ❓ | No se pudo confirmar. Es una pregunta abierta, no un dato. |

> Si alguien cita un número de este documento en una reunión, que cite también su
> marca. Un 📰 en una negociación es una hipótesis, no un argumento.

---

## 1. La respuesta corta

**Clover no reemplaza a MercadoPago.** Toda la evidencia disponible (📰) apunta a
que en Argentina Clover es un producto **card-present**: terminal física + QR.
Las capacidades online (checkout hosteado, tokenización para recurrencia)
aparecen documentadas para EEUU y Canadá, no para la región LA.

Pero la pregunta correcta no es "¿Clover o MercadoPago?". Es **"¿qué problema
estamos tratando de resolver?"**, y ahí aparecen dos cosas distintas que conviene
no mezclar:

| Problema | Quién lo resuelve | Cuánto cuesta resolverlo |
|---|---|---|
| **Pagamos mucho arancel** | Se resuelve **cambiando de adquirente o renegociando**. No requiere una línea de código: la recepción ya tipea el medio a mano. | 0 días de desarrollo |
| **La recepción tipea a mano lo que la terminal ya sabe** | Se resuelve **integrando la terminal** (Clover o MercadoPago Point). | 6 a 15 días de desarrollo |

**El error a evitar es justificar el segundo gasto con el primer ahorro.** Los
días de desarrollo no bajan el arancel ni un punto; compran prolijidad operativa
y conciliación automática. Son dos decisiones separables y hay que decidirlas por
separado.

Y hay un piso que conviene tener claro antes de negociar con nadie:

> **Cambiar de procesador no cambia el costo de las tarjetas.** La tasa de
> intercambio (lo que se lleva el banco emisor) y el arancel de marca (Visa,
> Mastercard) son costo de industria y los paga cualquiera. Lo único negociable
> es **el margen del procesador**. Nadie va a pasar de 6% a 1,8%: esa diferencia
> incluye plata que ni Fiserv ni MercadoPago se quedan.

---

## 2. Qué necesita Biowellness, y quién lo cubre

Cinco flujos de cobro, en orden de importancia:

| # | Flujo | Hoy | ¿Clover en AR? |
|---|---|---|---|
| 1 | **Seña 50% por link de WhatsApp**, vence en horas, confirma el turno (R-19) | MercadoPago Checkout Pro ✅ | ❓ Sin evidencia de producto equivalente. 📰 apunta a que no. |
| 2 | **Saldo restante online** | MercadoPago ✅ | ❓ Igual que el anterior. |
| 3 | **Cuota mensual de membresía** (débito recurrente) | ⚠️ **Codeado pero inerte** — ver §3 | ❓ Fiserv tiene un "Débito Automático" separado 📰; sin confirmar API. |
| 4 | **Cobro presencial en el mostrador** | Terminal **no integrada**: se tipea a mano ✅ | ✅ **Es exactamente lo que Clover hace.** Es su único terreno fuerte. |
| 5 | Efectivo / transferencia | Se registra a mano ✅ | No aplica |

**Los flujos 1 y 2 son el corazón del sistema y hoy solo MercadoPago los cubre.**
El flujo 4 es el único hueco real, y ese hueco lo pueden llenar **tanto Clover
como MercadoPago Point** — con la diferencia de que Point corre sobre la cuenta,
el token, el webhook y el bloque nginx que ya están en producción.

---

## 3. Tres cosas incómodas del estado actual (verificadas ✅)

Antes de mirar proveedores, hay tres cosas del propio sistema que conviene saber,
porque **cambian el encuadre de la discusión** y ninguna depende de qué pasarela
usemos.

### 3.1. El cobro recurrente con tarjeta guardada está codeado, pero **inerte**

`src/bots/cobro-membresias.ts:117-118` lee las extensiones `mp-customer-id` y
`mp-card-id` del `Coverage` para cobrar con la tarjeta guardada. Pero **ningún
archivo del repo las escribe**: no existe el flujo de captura de tarjeta.

```
grep -rn "mpCustomerId\|mpCardId" src/ app/   → solo lecturas, cero escrituras
```

**Consecuencia:** hoy **todas** las cuotas de membresía salen por link de pago.
El débito automático no es un activo que perdemos si migramos — es un **requisito
pendiente con cualquier proveedor**. Presupuestar una migración incluyendo
"re-tokenizar a los socios" sería pagar por un problema que no existe.

### 3.2. Las cuotas del link de seña están sin control

`crearPreferenciaMP` (`src/bots/_shared.ts:1112-1132`) **no manda
`payment_methods` ni `installments`**. El único `installments: 1` del repo está en
`cobro-membresias.ts:227`, o sea en la rama muerta del punto anterior.

Resultado: cada link de seña acepta el máximo de cuotas que la cuenta ofrezca por
default, y **el costo financiero lo absorbe Biowellness** sobre precios de lista
en USD. Como el sistema guarda montos **brutos** a propósito (la comisión es un
gasto del P&L de Administración, R-18 — `docs/bots.md:342`), esto **no se ve en
ningún tablero**: solo aparece en la liquidación.

Es un cambio de una línea y no depende de ninguna decisión de proveedor.

### 3.3. Una membresía rechazada el día 1 no se reintenta

`cobro-membresias.ts:78-90` escribe `ciclo-mes = ciclo` en el `Coverage`
**antes** de intentar el cobro. Como `debeRenovarMembresia` filtra por ese campo,
si el cobro falla el día 1, los días 2 a 5 el socio ya está marcado como
facturado: **un solo intento por ciclo**, y R-11 lo bloquea al primer rechazo.

Esto es un bug, no una palanca. Se arregla ya, sin esperar a nadie.

---

## 4. Análisis de probabilidad de uso de Clover

**Probabilidad de que Clover termine procesando algún pago de Biowellness:
media-baja, en torno al 30%** — y concentrada en un solo escenario (el mostrador).

| Escenario | Probabilidad | Por qué |
|---|---|---|
| **Reemplazo total de MP por Clover** | **~5%** (muy baja) | Es la única estimación con evidencia convergente y negativa: los flujos 1 y 2 son el corazón del sistema y no hay indicio de producto Clover argentino que los cubra. 📰 |
| **Híbrido: Clover en el mostrador + MP online** | **20-30%** | Es el techo realista de Clover acá. Vive o muere con dos respuestas: el arancel por escrito y si la terminal se puede disparar desde la nube. |
| **MP end-to-end (integrar Point)** | **25-35%** | Cierra el mismo hueco sin segundo contrato, sin segunda conciliación y sin tocar `MEDIOS_PAGO`. |
| **Status quo mejorado / renegociar con MP** | **25-35%** | Las palancas internas (§3) probablemente valgan más plata que la diferencia de arancel, y el arancel está desregulado, o sea negociable con MP también. |
| **Cambiar de adquirente sin integrar nada** | **~10%** | Terminal de quien cotice mejor, la recepción sigue tipeando. Captura todo el ahorro de arancel con 0 días de desarrollo. |

> **Honestidad sobre estos números:** hay tres incógnitas bloqueantes (§8) y
> mientras sigan abiertas, la diferencia entre 25% y 35% es ruido. No los uses
> como si alguien hubiera ponderado algo fino. Lo que sí es defendible es el
> **orden** y el **~5% del reemplazo total**.

### El árbol que reemplaza a los porcentajes

Tres preguntas binarias resuelven la decisión sin necesidad de estimar nada:

```
¿El presencial con tarjeta supera el 20% del volumen?
├─ NO  → Status quo mejorado. Fin de la evaluación. No se integra ninguna terminal.
└─ SÍ  → ¿La terminal Clover se puede disparar desde un backend en la nube?
         ├─ NO (solo LAN) → MercadoPago Point. Fin.
         └─ SÍ → ¿Fiserv cotiza al menos X puntos abajo de MP sobre el volumen medido?
                 ├─ NO → MercadoPago Point. Fin.
                 └─ SÍ → Híbrido: Clover mostrador + MP online.
```

**X se define ANTES de pedir la cotización.** Definirlo después es acomodar el
criterio al resultado. Ver §6 para calcularlo.

---

## 5. Matriz comparativa

Solo con lo que se pudo establecer. La columna de confianza importa tanto como el
contenido.

| Criterio | Peso | MercadoPago (hoy) | Clover / Fiserv AR | Gana |
|---|---|---|---|---|
| **Link de pago remoto por API** (seña que vence en horas) | crítico | ✅ En producción: `POST /checkout/preferences` con `external_reference`, `binary_mode`, `expiration_date_to`, `notification_url`. 5 call sites. | ❓ Sin evidencia de equivalente argentino. 📰 apunta a que el checkout hosteado es US/CA. | **MP, con distancia.** Este criterio solo ya descarta el reemplazo total. |
| **Cobro recurrente con tarjeta guardada** | crítico | ⚠️ Implementado pero **inerte** (§3.1). La capacidad existe en la API; el flujo de captura no está construido. | ❓ Fiserv comercializa un "Débito Automático" separado 📰; sin confirmar si tiene API. | **MP** — pero es un requisito pendiente en los dos, no una ventaja actual. |
| **Terminal física integrada** | crítico | 📰 Point Smart en modo PDV, empujando el cobro desde el backend por API. Es una llamada REST, compatible con los bots. ❓ sin leer la doc. | 📰 Es su fortaleza: base instalada grande en AR, App Market local, QR interoperable, impresora fiscal. **Pero** la semi-integración documentada corre por **LAN** contra el dispositivo. | **Depende de una sola respuesta** (§8). Nuestros bots corren en el servidor Medplum, no en la clínica. |
| **Costo por transacción presencial** | crítico | 📰 Fee de agregador. Fuentes públicas contradictorias. | 📰 Adquirente directo: estructuralmente debería ser menor. Grilla **no publicada** por nadie. | **Indeterminado.** El único criterio crítico sin un solo número confiable. Se resuelve con cotización, no con análisis. |
| **Costo por transacción online** | crítico | 📰 Fuentes 2026 van de ~3,49% a ~6,49% + IVA para el mismo producto. El dato real está en **nuestra liquidación**. | No aplica: sin producto online argentino confirmado. | **MP por defecto**, no por precio. |
| **Plazo de acreditación** | alto | Configurable; la comisión es función del plazo. ❓ No sabemos con qué plazo está la cuenta. | 📰 Débito 24 h, crédito 8 días hábiles. **Ojo:** eso no es política de Fiserv, es plazo **regulado por el BCRA** e igual para todos. | **Empate estructural.** Lo que decide es el costo del adelanto, y ahí no hay números. |
| **Webhooks y conciliación** | alto | ✅ HMAC-SHA256 con 4 tests (`src/lib/mercadopago.ts`), re-verificación autoritativa contra la API, semántica de reintentos explícita, manejo de contracargos con alertas. | 📰 Verificación con código **estático** en header, no HMAC; el HMAC aparece solo en el producto US/CA. Reintentos sin garantía documentada. | **MP**, claramente. |
| **Esfuerzo de desarrollo** | alto | Point: **6-9 días**. Reusa token, webhook, ruteo y nginx existentes. | Híbrido: **10-15 días** + 4-8 semanas de alta comercial y hardware. Y **±5x de incertidumbre** hasta responder lo del LAN. | **MP Point**, por bastante. |
| **Impacto en el contrato con Administración** | alto | Point se reporta con los códigos existentes `tarjeta-debito`/`tarjeta-credito`. Histórico intacto. | Obliga a decidir cómo se codifica el procesador sin romper `MEDIOS_PAGO` (✅ declarado **INAMOVIBLE** en `src/fhir/identifiers.ts:423-436`). | **MP.** Es el costo de cambio más sólido y el único enteramente bajo nuestro control. |
| **Cobro en dólares con débito** (BCRA Com. A8180) | alto | 📰 Las billeteras fintech quedaron **afuera** del régimen. | 📰 Fiserv lo declara operativo en PosNet y Clover, con liquidación en cuenta en dólares. | **Clover.** Es el **único diferencial duro** a su favor, y con lista de precios en USD (`MONEDA_LISTA` ✅) no es menor. |
| **Riesgo de lock-in** | medio | Agregador, alta self-service, sin hardware en comodato. El acoplamiento de código es chico (§9). | 📰 Comodato con permanencia mínima y penalidad ❓. Y 📰 Fiserv recortó guidance 2026 citando el deterioro de Argentina. | **MP.** |
| **Soporte local** | medio | Masivo, sin ejecutivo de cuenta salvo volumen. | 📰 Ejecutivo de cuenta asignado y 0800. Contra: 📰 soporte a desarrolladores con SLA declarado de 5 días hábiles. | **Empate incómodo.** |
| **Documentación para Argentina** | alto | En español, dominio `.com.ar`, changelog, sandbox. | ❓ El portal autoritativo para AR **no** es `docs.clover.com` (esa es Norteamérica). Esa confusión de portales es la trampa principal de toda esta evaluación. | **MP** para nuestro stack. |

---

## 6. La cuenta: cuánta plata es esto

Ningún documento de este tipo sirve si no responde *"¿cuánto es en pesos?"*. No
tenemos los insumos todavía, pero **la fórmula se puede escribir hoy** y se
completa con dos números que están a un par de horas de distancia (§7, pasos 1 y 2):

```
ahorro_mensual      = volumen_presencial_ARS × (arancel_actual − arancel_nuevo)
costo_fijo_mensual  = alquiler_terminal + horas_mes_de_doble_conciliación × costo_hora
costo_único         = días_de_desarrollo × costo_día

volumen_de_equilibrio = costo_fijo_mensual / (arancel_actual − arancel_nuevo)
meses_para_recuperar  = costo_único / (ahorro_mensual − costo_fijo_mensual)
```

**El `volumen_de_equilibrio` es el número que mata o salva el proyecto.** El
alquiler de la terminal es un costo **fijo** contra un ahorro **variable**: a bajo
volumen se lo come entero. Ejemplo puramente ilustrativo de la mecánica (los
valores son inventados, no cotizados): con una diferencia de arancel de 1,5 puntos
y un alquiler de $50.000/mes, hace falta facturar **más de $3.300.000 por mes en
tarjeta presencial** solo para empatar el alquiler. Una clínica puede estar
perfectamente por debajo de eso.

**Tres costos que no se pueden olvidar al comparar:**

- **IVA de la comisión.** Si las prestaciones de salud están exentas de IVA, el
  IVA de la comisión **no se computa como crédito fiscal**: es costo hundido. Una
  comisión de "3,5% + IVA" es en realidad **4,235% efectivo**. ❓ Confirmar el
  encuadre con el contador — cambia la magnitud de todo el análisis.
- **Impuesto a los débitos y créditos** (0,6% + 0,6%) al mover fondos de un
  segundo procesador a la cuenta operativa. ❓ Confirmar con el contador.
- **Sostener dos integraciones** es un costo **recurrente**, no de proyecto: dos
  conciliaciones, dos liquidaciones que el contador cruza, dos paneles, dos juegos
  de secrets a rotar, dos superficies de incidente. Más el entrenamiento de
  Recepción y el pico de error humano durante la transición.

---

## 7. Camino rápido

Ordenado de más barato a más caro. **Los primeros cuatro pasos no cuestan plata ni
código** y pueden cerrar la evaluación entera.

| # | Qué | Quién | Costo | Cómo se sabe que salió bien | Puerta de salida |
|---|---|---|---|---|---|
| **0** | Preguntarle a Recepción cuánto duele hoy el tipeo manual: cuántos descuadres de caja por mes, cuántos minutos por cobro, cuánta plata se perdió por error. | Recepción | **10 min** | Tener el dolor en números, no en anécdota. | Si no hay descuadres ni queja, el proyecto pierde su motivo operativo y queda solo el arancel → saltar al paso 4. |
| **1** | **Medir el volumen presencial.** Sumar los `Invoice` de los últimos 90 días agrupados por la extensión `medio-pago`: qué % es `tarjeta-debito`/`tarjeta-credito` vs `mercadopago`. De paso, confirmar que hay **cero** `Coverage` con `mp-customer-id` poblado (§3.1). | Desarrollo | **1-2 h**, $0 | Una frase: "el X% del volumen de los últimos 90 días fue tarjeta presencial". | **Si el presencial es menor al 20%, se cierra la evaluación de terminales.** Integrar cualquier terminal es un proyecto caro para poca plata. |
| **2** | **Bajar la liquidación real de MercadoPago** de 3 meses. Restar bruto facturado menos neto acreditado: eso da el **arancel efectivo real**, el único número que no depende de ninguna fuente pública. Anotar también con qué plazo de acreditación está configurada la cuenta. | Andrés | **30 min**, $0 | Tener la grilla real de la cuenta. Las fuentes públicas para el mismo producto van de 3,49% a 6,49%: sin este dato, ninguna comparación significa nada. | Si el arancel efectivo ya está en la banda baja, el argumento económico de cambiar se debilita mucho. |
| **3** | **Calcular el techo del ahorro** con los pasos 1 y 2 y la fórmula de §6. Es una planilla de cinco filas. Acá se define la **X** del árbol de decisión (§4). | Andrés + Desarrollo | **1 h**, $0 | Un número: "el ahorro máximo imaginable es $N por mes". | **Si el techo del ahorro es menor que el costo del proyecto más el alquiler anual, se cierra sin llamar a nadie.** |
| **4** | **Arreglar lo que ya sabemos que está mal** (§3), en paralelo y sin depender de nadie: (a) el bug del ciclo de membresías — es lo más urgente, hoy bloquea socios por R-11 al primer rechazo; (b) acotar cuotas en `crearPreferenciaMP`; (c) cerrar el fallback abierto de la firma del webhook (`webhook-mercadopago.ts:68`: si el secret falta, el endpoint público deja de validar **en silencio**); (d) sacar el default `?? 'mercadopago'` de `_shared.ts:1845`. | Desarrollo | **1-2 días** | `npm run verify` en verde y una cuota rechazada el día 1 que se reintenta el día 2 en staging. | Ninguno depende de la decisión de pasarela. El (a) toca R-11: va con test antes. |
| **5** | **Releer desde una red sin filtro** las páginas que acá dieron 403 (§⚠️). Ojo: el portal autoritativo de Clover para Argentina **no** es `docs.clover.com`. | Desarrollo | **1 h**, $0 | Responder de fuente primaria si Clover en AR tiene link de pago por API y tokenización recurrente. | Si confirma que en AR es solo card-present, el reemplazo total se descarta formalmente. |
| **6** | **Pedir cotización por escrito, en paralelo, a Fiserv y a MercadoPago**, con el cuadro de §8. Aclarar volumen real (paso 1), rubro salud y CABA. Exigir IVA discriminado y **cláusula de preaviso** para modificar aranceles. | Andrés | 2-3 llamadas + 1-3 semanas | Dos PDFs comparables lado a lado. | Si Fiserv no entrega grilla por escrito, es señal en sí misma: no se firma un comodato contra un precio de palabra. |
| **7** | **Acordar con Administración cómo se codifica un cobro por terminal**, antes de escribir una línea de adapter. Ver §9. | Administración | 1 reunión | Un sí por escrito. | Si exigen un código nuevo dentro de `MEDIOS_PAGO`, es un cambio coordinado en dos repos: sube el costo de todos los escenarios con terminal. |
| **8** | **Piloto** con el ganador, en **un solo puesto**, en paralelo con la carga manual, durante dos semanas. | Desarrollo | 6-15 días según proveedor | Dos semanas con el 100% de los cobros del puesto conciliados automáticamente, cero huérfanos, cero dobles. | Los dos modos de falla a vigilar: **cobro huérfano** (la terminal cobró, el sistema no se enteró) y **doble contabilización**. Si aparecen, se vuelve a manual en ese puesto sin afectar al resto. |

> **Los pasos 0 a 3 son el corazón de todo esto: cuatro horas de trabajo, cero
> pesos, y pueden cerrar la discusión.** Todo lo demás recién tiene sentido si
> esos números dan que vale la pena.

---

## 8. Las preguntas exactas para Fiserv / Clover Argentina

Ordenadas por criticidad. Las tres primeras pueden cerrar la evaluación.

1. **Semi-integración (la que más importa).** ¿Un backend nuestro alojado en la
   nube, **fuera de la clínica**, puede enviarle un monto a la terminal Clover
   instalada en el local y recibir el resultado (autorización, últimos 4 dígitos,
   estado) **sin ningún software corriendo dentro de la clínica**? ¿O la terminal
   dialoga solo por red local? ¿Cuáles son, por nombre, los modos de integración
   disponibles para Argentina, y cuál exige certificación PCI de nuestro lado?
   → *Por qué mata:* nuestros bots corren en el servidor Medplum. Si es solo LAN,
   hay que invertir el flujo hacia la app del navegador o poner un componente
   local que el proyecto **no tiene en ningún lado hoy**. Cambia la estimación
   entre 8 horas y 40. **Esta pregunta va antes que las de precio.**

2. **Link de pago por API.** ¿Puedo generar links desde mi backend, para mandar
   por WhatsApp, con vencimiento en horas, referencia externa propia y webhook a
   mi servidor, con número de comercio argentino y en pesos? ¿Bajo qué producto
   exacto y cuál es la URL de la documentación **argentina**?
   → *Por qué mata:* es el flujo más usado del sistema. Un "consultá con tu
   ejecutivo" equivale a un no para planificar.

3. **Grilla de aranceles por escrito** para salud/wellness en CABA con nuestro
   volumen: débito, débito en dólares, crédito en 1 pago, crédito en cuotas, QR.
   Con IVA discriminado. **¿Qué preaviso contractual tienen para modificarla?**
   → *Por qué mata:* es el costo variable número uno y no está publicado en
   ninguna parte. Y con el arancel desregulado no hay tope legal: sin cláusula de
   preaviso, el precio se puede mover después de firmar.

4. **Tokenización y recurrencia.** ¿Puedo guardar la tarjeta de un socio y
   debitarle la cuota mensual server-to-server, sin presencia del cliente, con
   número de comercio argentino? ¿Por API o por presentación de archivos? ¿Qué
   tarjetas quedan afuera?

5. **Alquiler y permanencia.** ¿Cuánto cuesta por mes cada modelo? ¿Con qué índice
   y frecuencia se ajusta? ¿Plazo mínimo de permanencia y penalidad por baja?
   → El alquiler se debita de la misma cuenta donde se acreditan los cupones: un
   ajuste no avisado golpea la caja sin fricción.

6. **Bimonetarismo.** ¿Podemos cobrar en dólares con débito (Com. BCRA A8180) y
   liquidar en cuenta en dólares? ¿Mismos aranceles que en pesos? ¿Qué hace falta
   y cuánto tarda? → Es el único diferencial duro a favor de Clover y nuestra
   lista de precios es en USD.

7. **Plazos y adelanto.** ¿Qué plazos aplican a nuestro encuadre? ¿El servicio de
   adelanto está habilitado para el rubro salud o está entre las actividades
   restringidas? ¿Costo efectivo del adelanto por plazo?

8. **Webhooks.** ¿Van firmados? ¿Con qué esquema? ¿Política de reintentos por
   escrito? ¿Aceptan un header de autenticación custom en la URL de destino, o
   tiene que ser pública sin credenciales?

9. **QR de Mercado Pago.** ¿La terminal acepta el QR de la billetera de Mercado
   Pago y las tarjetas guardadas dentro de ella? → Dado el peso de MP entre
   pacientes, no aceptarlo sería un problema de conversión. Se descubre el primer
   día de operación, no antes.

10. **SLA de reposición** ante falla del equipo, en horas hábiles, **dentro del
    contrato**. ¿Hay equipo de backup? ¿Procedimiento y plazo real de baja?
    → Un centro de salud que no puede cobrar pierde facturación ese mismo día.

11. **Catálogo argentino y apps privadas.** ¿Qué modelos se comercializan
    efectivamente en Argentina hoy? ¿Podemos publicar una app **privada, no
    listada**, solo para nuestro comercio, en la región LA? ¿Con qué costo?
    → Corrige la premisa que motivó esta evaluación: la pantalla del dashboard de
    developers que muestra Station, Kiosk y Web es el catálogo **global**, y
    algunas de esas opciones están marcadas explícitamente como US/CA.

**Para MercadoPago, en paralelo, tres:** (a) ¿qué arancel nos pueden mejorar con
este volumen?; (b) ¿Point en modo PDV está habilitado para nuestra cuenta y con
qué API exactamente?; (c) ¿hay alguna vía para cobro en dólares?

---

## 9. Si se avanza: impacto en el repo

Lo verificado ✅, para dimensionar sin sorpresas.

**Lo que NO hay que tocar** (y es la mayor parte): toda la lógica de señas,
planes, invoices, alertas, idempotencia y reglas de negocio es **agnóstica de
pasarela** y se reusa igual con cualquier proveedor. `Clover` aparece **0 veces**
en el repo hoy.

**El núcleo duro reemplazable** son cuatro piezas: `crearPreferenciaMP`
(`_shared.ts:1075`, con **5 call sites**), `webhook-mercadopago.ts`,
`cobrarTarjetaGuardada` (`cobro-membresias.ts:189`) y `src/lib/mercadopago.ts`.

**Los cuatro puntos donde un segundo procesador rompe algo:**

1. **`MEDIOS_PAGO` es INAMOVIBLE** (`src/fhir/identifiers.ts:423-436`): lo lee el
   bot `kpis-finanzas` del repo `administracion`, y `extMedioPago`
   (`_shared.ts:635-640`) **lanza en runtime** ante cualquier código fuera de los
   5. La salida limpia es **no tocar el enum** y agregar una extensión ortogonal
   `procesador-pago`: *medio* = con qué pagó el paciente (`tarjeta-credito`),
   *procesador* = por dónde entró la plata (`clover`). Requiere el sí por escrito
   de Administración (paso 7).
2. **La detección de pago doble filtra por el prefijo literal `mp-`**
   (`_shared.ts:1196`, `:1668`, `:1841`). Un pago de Clover sobre una seña ya
   cobrada por MP **no se detectaría como duplicado**. Hay que generalizarlo
   **antes** de escribir cualquier adapter, con test de regresión.
3. **`asignar-plan.ts:69`**: `esRemoto = cobrar && e.medioPago === 'mercadopago'`.
   Un link de otro procesador caería en la rama presencial y **activaría el plan
   sin haber cobrado**.
4. **`validarMedios`** (`src/lib/cobros.ts:60-65`) rechaza medios repetidos: un
   cobro mixto partido entre terminal y link con el mismo medio hoy es
   irregistrable.

**Además:** el front llama al bot por su nombre literal `bw-link-mercadopago`
(`app/src/lib/bots.ts:193`), hay **6 selects** de medio de pago en la app, **14
mensajes** de alerta nombran a MercadoPago, y haría falta un `location` nuevo en
`deploy/nginx-api-proxy.conf:82` con la misma receta de Basic auth.

**Una buena noticia verificada:** las plantillas de WhatsApp aprobadas por Meta no
nombran a MercadoPago en el cuerpo (el link viaja como variable), así que un
cambio de pasarela **no requiere re-aprobación de Meta**.

**Sobre la abstracción de pasarela:** construir el puerto y los adapters *antes*
de saber si va a haber un segundo proveedor es infraestructura especulativa. Lo
que sí se justifica solo, hoy, como deuda técnica: **el ruteo por
`external_reference` vive inline en el webhook y no tiene un solo test**. Extraerlo
a función pura con tests (doble webhook con el mismo id → 1 Invoice y 0 alertas;
otro id sobre la misma seña → alerta de duplicado; 500 → lanza; 404 → no
reintenta) es valioso con o sin Clover.

---

## 10. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|
| **Decidir con información de segunda mano** (§⚠️) | Certeza — ya pasó | Crítico | Pasos 5 y 6. Tratar este documento como mapa de preguntas. |
| **Confundir la oferta de EEUU con la de Argentina.** Es el error que la propia pantalla del dashboard induce. | Alta | Alto: se descubre después de firmar | Usar el portal LATAM como autoritativo, nunca `docs.clover.com`. Pedir el catálogo argentino por escrito. |
| **Doble cobro no detectado** al convivir dos procesadores (§9.2) | Alta si no se toca | Alto | Generalizar el prefijo antes del adapter, con test. |
| **Romper los reportes de Administración en silencio** (§9.1) | Media | Crítico: son reportes financieros en otro repo | Extensión ortogonal, confirmada por escrito. `CLAUDE.md` además exige consultar con Andrés todo cambio de regla core. |
| **La semi-integración es solo LAN** | Media-alta 📰 | Crítico para el híbrido | Pregunta 1, respondida **antes** de estimar. |
| **Cobro huérfano** por corte de red de la terminal | Media | Medio | Reusar el patrón que ya existe (alerta idempotente a Recepción) + conciliación diaria. Probarlo desenchufando la red en el piloto. |
| **El arancel cambia después de firmar** (está desregulado, sin tope legal) | Media-alta | Alto | Cláusula de preaviso y de salida (pregunta 3). |
| **Riesgo de proveedor:** 📰 Fiserv recortó guidance 2026 citando el deterioro de Argentina | Baja-media | Alto si hay comodato con permanencia | Permanencia corta y cláusula de salida. Juega **a favor** del híbrido: si nunca se apaga MP, volver es barato. |
| **El webhook deja de validar firma en silencio** si falta el secret (`webhook-mercadopago.ts:68`) | Baja pero real | Alto: es un endpoint público que asienta plata | Paso 4c. El ancla de seguridad sigue siendo la re-verificación server-side, ya implementada. |
| **Costo de oportunidad:** 6-15 días de desarrollo son 6-15 días que no van a otra cosa | Alta | Medio | Los pasos 0-3 cuestan 4 horas y deciden si vale la pena. |

---

## 11. Qué quedó sin confirmar

**Bloqueantes** (hay que responderlas para decidir):

1. ¿Qué porcentaje del volumen es presencial con tarjeta? → paso 1, lo resolvemos nosotros.
2. ¿Cuál es el arancel efectivo real que pagamos hoy? → paso 2, lo resolvemos nosotros.
3. ¿La terminal Clover se puede disparar desde la nube o solo por LAN? → pregunta 1.
4. ¿Cuánto cotiza cada uno? → pregunta 3.

**No bloqueantes pero importantes:**

- ¿Clover en Argentina tiene link de pago por API? ¿Y tokenización recurrente?
- ¿Las prestaciones de salud están exentas de IVA? (cambia la comisión efectiva
  en más de un punto). ¿Y el impuesto a los débitos y créditos?
- ¿`kpis-finanzas` agrupa por lista blanca de los 5 códigos o suma todo lo que
  encuentre? Define si una extensión nueva es segura.
- ¿Qué modelos de terminal se venden efectivamente en Argentina?

**Fuera de alcance pero conviene mirarlo:** este repo **no tiene módulo de
facturación** (cero referencias a ARCA o CAE en `src/`). 📰 Hay obligaciones de
transparencia fiscal al consumidor con sanción de clausura. Conviene confirmar con
el contador quién emite hoy los comprobantes y si ese sistema está adecuado. Es
independiente de esta evaluación y probablemente más urgente.

---

## 12. Recomendación

1. **Hacer los pasos 0 a 3 esta semana.** Cuatro horas, cero pesos. Pueden cerrar
   la discusión entera con un número.
2. **Arreglar el bug del ciclo de membresías ya** (§3.3): no depende de nada de
   esto y hoy bloquea socios.
3. **No firmar nada** hasta tener las respuestas 1 y 3 de §8 por escrito.
4. **Separar las dos decisiones**: quién procesa (precio, 0 días de desarrollo) es
   distinto de si se integra la terminal (operación, 6-15 días). Se pueden tomar
   por separado y en momentos distintos.

> Este documento se actualiza cuando lleguen los números de los pasos 1-3 y las
> respuestas de §8. Hasta entonces, no hay decisión que tomar.
