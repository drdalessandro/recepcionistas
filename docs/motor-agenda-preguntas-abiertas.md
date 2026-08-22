# Motor de agenda — preguntas abiertas

Lo que quedó sin decidir después de implementar el motor. Ninguna frena el
desarrollo: el módulo arranca, corre y tiene sus tests verdes. Pero cada una es
un número o una regla que hoy el sistema usa sin que nadie la haya acordado, y
eso conviene que se vea.

Están separadas en clínicas y de producto porque las contesta gente distinta.

---

## Clínicas

### C-1 · El turnaround del puesto IHHT no tiene margen 🔴

Es la única que califica de bloqueante. El turnaround depende del protocolo de
higiene de máscara y clip de dedo entre cliente y cliente, y ese protocolo
todavía no existe como documento escrito. Los 5 minutos de la tabla son una
estimación.

El problema es la aritmética: `3 setup + 22 terapia + 5 turnaround = 30`, que es
exactamente el slot. **El margen es cero.** Si el protocolo real pide un minuto
más, la grilla de media hora deja de cerrar y hay que rehacerla — y un recurso que
no cierra genera atraso acumulativo a lo largo del día, no un atraso puntual.

El valor está marcado como no ratificado en
[`config/recursos.ts`](../src/motor-agenda/config/recursos.ts) y el motor lo
arrastra como advertencia hasta el plan de reserva.

**Se necesita:** el protocolo escrito y el tiempo real que lleva ejecutarlo.

### C-2 · Setup y terapia de IHHT, Red Light, Compresión y Crioterapia

Los cuatro están marcados `[PROPUESTA]`: son estimaciones sin medición formal.
Red Light (3 + 20 + 7 = 30) y Compresión y Crioterapia (2 + 25 + 3 = 30) también
consumen el slot entero, así que tienen el mismo problema de margen que C-1,
aunque sin un protocolo pendiente detrás.

**Se necesita:** cronometrar una jornada real de cada uno.

### C-3 · Los dos minutos que le sobran a HBOT

La tabla dice setup 3 y terapia ~50, que suman 53, pero el ancla de salida
—decidida— es el minuto 55. El motor usa el ancla, que es lo correcto. Queda
saber qué son esos dos minutos: ¿parte del descenso que la tabla redondeó hacia
abajo? ¿La terapia son en realidad 52?

No cambia ningún resultado hoy. Importa el día que alguien lea la tabla y saque
sus propias cuentas.

### C-4 · Qué incluye el turnaround de Recovery Pro

Recovery Pro declara turnaround 12, pero la secuencia interna dice que del minuto
48 al 56 el cliente se está duchando y vistiendo. O sea que de esos 12 minutos, 8
son del cliente y sólo 4 son de limpieza del gabinete.

Si la limpieza real lleva más de 4 minutos, el gabinete no está listo para el
turno siguiente y el desfasaje de 30 empieza a correrse. **Confirmar que 4
minutos alcanzan** para dejar el gabinete en condiciones.

### C-5 · Los recursos sin tiempos medidos

La camilla de masajes, el consultorio médico, la sala TB y los puestos IV no
tienen slot, setup, terapia ni turnaround. Hoy están declarados con su motivo y
agendarlos devuelve `RECURSO_SIN_TIEMPOS` — no hay default silencioso, pero
tampoco se pueden agendar.

Cada uno tiene su propia pregunta:

- **Consultorio**: la duración la fija el médico, no el equipamiento. ¿Un slot
  único para todos? ¿Uno por médico?
- **Puesto IV**: ¿cuánto lleva cada protocolo (hidratación, performance, NAD+)?
  Son duraciones muy distintas entre sí.
- **Sala TB**: cada terapia biológica tiene su propia preparación y aplicación.
  Falta la tabla completa.
- **Camilla de masajes**: descontracturante, deportivo y osteopatía, ¿comparten
  slot?

### C-6 · ¿Hace falta un intervalo entre HBOT y Recovery Pro?

El enunciado aclara —y el modelo lo aprovecha— que no hace falta ningún intervalo
de lavado entre HBOT e IHHT, porque el descenso ya se hace respirando aire.

No dice nada de HBOT → Recovery Pro, que es el encadenamiento de BIO RECOVERY y
el último tramo de BIO LONGEVITY. Ahí el cliente sale de la cámara y cinco
minutos después entra a una sauna, y quince minutos más tarde a un cold plunge.
Hoy el motor los encadena sin intervalo.

**¿Hay alguna contraindicación en pasar de hiperbárica a sauna y agua fría con
ese margen?**

### C-7 · La secuencia de Recovery Pro con dos personas

El modelo asume que la secuencia interna es idéntica con uno o con dos ocupantes:
mismos minutos de sauna y cold plunge, y dos tumbonas en paralelo del 28 al 48.

Si con dos personas el cold plunge se hace por turnos, la secuencia se estira y
el desfasaje de 30 deja de cerrar. **Confirmar que las etapas son simultáneas.**

### C-8 · Sábados sin franja clínica

La franja clínica es de lunes a viernes. Como toda IV y toda TB son clínicas sin
excepción, **el sábado no se puede hacer ninguna de las dos**. Es una consecuencia
del modelo, no algo que el enunciado diga.

¿Es lo buscado, o el sábado debería tener su propia franja?

---

## De producto

### P-1 · La estructura de membresías no está ratificada, y además cambió 🔴

El enunciado marca la tabla de membresías como `[PROPUESTA NO RATIFICADA]`, así
que está cargada como configuración editable y el motor la arrastra como
advertencia. Pero hay algo más grande: **contradice lo que hoy tiene el repo**.

| | Esta propuesta | Lo que hay en `src/config/membresias.ts` |
|---|---|---|
| Combo base de FOCUS | BIO OXYGEN | BIO ENERGY |
| FOCUS Standard Individual | USD 1.200 | USD 716,80 |
| FOCUS Intensivo Individual | USD 1.680 | USD 1.008 |
| Cómo se calcula el precio | tabla directa | derivado de combo × sesiones × (1 − descuento) |
| Plazos | mensual +20 %, trimestral base | compromiso de 3 meses |

No es un ajuste de números: cambia el producto (FOCUS pasa de IHHT + Red Light a
HBOT + IHHT) y cambia el método (precio de tabla en vez de precio derivado).
Mientras no se resuelva, el motor de agenda y la app de recepción cotizan
distinto la misma membresía.

**Se necesita:** ratificar la tabla y decidir si reemplaza a la del Manual v9.

### P-2 · ¿Multiplaza con IHHT está prohibido, o sólo limitado por capacidad?

El enunciado titula la restricción como «HBOT Multiplaza no encadena con IHHT»,
pero la regla operativa que da a continuación es de capacidad: rechazar cuando
los ocupantes superen los puestos de IHHT libres en el tramo siguiente.

Están implementadas como la misma cosa —la de capacidad—, así que hoy **BIO
OXYGEN sobre multiplaza con 1 o 2 ocupantes se acepta**. Si la intención era
prohibirlo siempre, hay que decirlo: es un caso especial y habría que declararlo
como tal en el catálogo, no esconderlo en el motor.

### P-3 · Hacia qué lado se redondean las sesiones al pausar

Con 15 días sobre una base de 30 la proporción da exacta: 8 sesiones → 4. Con un
bloque de 20 días da 2,67 y hay que redondear. Hoy está en `'cercano'`
(→ 3 sesiones), que es lo más parecido a «proporcional», pero nadie lo decidió.

`abajo` favorece al centro, `arriba` al socio. Es configuración
(`pausa.redondeoSesiones`), así que cambiarlo es una línea.

### P-4 · ¿La franja clínica bloquea el flujo normal?

El enunciado dice que la franja «sólo habilita reservas clínicas dentro de esa
ventana y las bloquea fuera». Eso es una afirmación sobre las reservas clínicas.
No dice si de 12:00 a 17:00 se pueden seguir agendando turnos de bienestar.

Hoy está en `false` (el flujo normal convive con la franja). El interruptor es
`franjaClinica.bloqueaFlujoNormal` y darlo vuelta es una línea, pero cambia
radicalmente la capacidad del centro: son 25 horas semanales.

### P-5 · Contratar el 25 deja seis días para ocho sesiones

Las sesiones vencen el último día del mes o a los 30 días de contratado, lo que
ocurra primero. Quien contrata un 25 tiene seis días para usar ocho sesiones
—doce si es Intensivo—, lo cual es materialmente imposible.

El modelo lo implementa tal cual está escrito. **¿Es intencional** (y entonces la
venta a fin de mes necesita un descargo explícito), o el primer ciclo debería
prorratearse?

### P-6 · ¿Una membresía pausada puede reservar?

Hoy no: `puedeConsumirSesion` rechaza el estado `pausada`, que es lo que hace que
la pausa signifique algo. Pero el tag de Founding Member **sí** sobrevive a la
pausa, porque la pausa es un derecho del socio y no una baja.

Confirmar que las dos cosas son lo buscado: sin sesiones durante la pausa, pero
sin perder el tag.

### P-7 · Los precios de sesión suelta que faltan

De todo el catálogo, sólo están decididos los de R-04 (biplaza: 165 con una
persona, 100 por persona con dos) y R-06 (multiplaza: 80 por persona). Faltan
monoplaza, IHHT, Red Light, Recovery Pro, compresión, crioterapia, masajes,
consulta médica, IV y TB.

No se inventaron: cotizarlos devuelve `PRECIO_NO_DEFINIDO`, el turno se puede
agendar igual y recepción ve la advertencia. Cuando la lista esté completa se
prende `exigirCatalogoDePreciosCompleto` y los faltantes pasan a ser un error de
arranque.

### P-8 · Un grupo de tres en Recovery Pro

El gabinete tiene capacidad 2 y hay dos gabinetes. Con tres personas, el modelo
asigna dos al gabinete 1 y una al gabinete 2, consumiendo los dos gabinetes y
tres tumbonas de un sub-pool de dos → se rechaza.

Antes de que eso importe: **¿el gabinete es indivisible comercialmente?** El
catálogo actual del repo lo trata así («Recovery Pro 200 por gabinete
INDIVISIBLE, 1 o 2 personas»). Si lo es, un grupo de tres debería rechazarse con
un mensaje que lo explique, no caerse por falta de tumbonas.

### P-9 · Precio de la multiplaza cuando alguien se suma

R-06 permite sumarse a una tanda ya reservada hasta el inicio, sin piso de
sesión, a USD 80 por persona. El motor lo implementa: la unidad se comparte
mientras la ventana sea idéntica y las plazas alcancen.

Queda la pregunta comercial: si la tanda termina siendo de una sola persona,
¿sigue pagando 80? Hoy sí. Con seis personas la sesión factura 480 y con una, 80,
sobre el mismo costo de operación.

### P-10 · La cámara arranca en hora en punto

La grilla de inicio de HBOT es 60 minutos, así que una cámara no se puede
reservar a las 10:30 (`INICIO_FUERA_DE_GRILLA`). Los demás recursos arrancan cada
30.

Es configuración por recurso (`grillaInicioMin`) y hoy nadie lo pidió
explícitamente: se dedujo del slot de 60. **Confirmar que la cámara no puede
arrancar a y media**, porque si pudiera, BIO LONGEVITY tendría más lugares donde
entrar.

### P-11 · El hueco de cinco minutos de BIO LONGEVITY

El cliente sale del IHHT en el minuto 85 y entra a Recovery Pro en el 90. Son
cinco minutos de espera, y son los que hacen que el combo cierre en los 150
publicados en vez de estirarse.

Es sano —da margen para el traslado de planta baja a planta alta— pero conviene
que esté dicho: el cliente va a esperar cinco minutos y recepción debería saber
por qué.

### P-12 · Los perfiles clínicos son sólo una sugerencia

Los cuatro perfiles (Fatiga Crónica, Atleta, Anti-aging, Estrés Crónico) están en
el modelo como dato del cliente, separados de la capa comercial, y **el ruteo a
membresía no está implementado como regla**: nada impide que un perfil de Fatiga
Crónica contrate HEALTHSPAN.

Confirmar que el ruteo es orientativo para la conversación de venta y no una
restricción del sistema.

### P-13 · La convivencia con lo que ya está en producción

El módulo es aditivo y no toca nada. Pero revisa reglas que el repo ya tiene
implementadas de otra manera: R-06, R-07, R-09, la franja clínica (que hoy no
existe), el versionado de precios (que hoy no existe) y las membresías (P-1).

Mientras convivan, el motor de agenda y los bots de reserva pueden dar respuestas
distintas para el mismo turno. **Hay que decidir si este modelo reemplaza al
anterior** y, si sí, planificar la migración — que incluye reescribir
`bw-reservar-turno` y `bw-reservar-combo` sobre este motor.
