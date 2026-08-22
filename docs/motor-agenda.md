# Motor de agenda

Decide si una reserva es posible, qué recursos físicos bloquea y en qué orden.
Vive en [`src/motor-agenda/`](../src/motor-agenda/) y es **lógica pura**: no habla
FHIR, no toca la red y no tiene reloj propio —el instante «ahora» viaja en la
solicitud—. El mapeo a Medplum está en
[`motor-agenda-fhir.md`](motor-agenda-fhir.md); lo que quedó sin decidir, en
[`motor-agenda-preguntas-abiertas.md`](motor-agenda-preguntas-abiertas.md).

```ts
const motor = compilarConfig(configSanIsidro());   // falla al arrancar si algo no cierra
const resultado = evaluarReserva({ motor, solicitud, agenda });

if (resultado.ok) escribirEnLaAgenda(resultado.valor.ocupaciones);
else mostrarleARecepcion(resultado.rechazos);      // todos los motivos, no el primero
```

## El principio

**Los tiempos son atributos del recurso, no del producto.** Cada recurso declara
`setup`, `terapia` y `turnaround`, y de ahí sale todo lo demás:

```
salida del cliente   = setup + terapia          (o el ancla, si la hay)
recurso liberado     = setup + terapia + turnaround
inicio del tramo N+1 = alinearAGrilla(salida del tramo N, grilla del recurso N+1)
```

Un combo declara qué servicios y en qué orden. **Nunca en qué minuto.** Si un
combo necesitara una regla escrita a mano, el modelo estaría mal.

La prueba de que el modelo cierra es que reproduce el catálogo comercial sin que
nadie se lo diga:

| Combo | Cadena derivada | Duración | Manual v9 |
|---|---|---|---|
| BIO ENERGY | IHHT 0–30 (sale :25) → tumbona 30–60 | 60 | 60 |
| BIO OXYGEN | HBOT 0–60 (sale :55) → IHHT 60–90 | 90 | 90 |
| BIO RECOVERY | HBOT 0–60 (sale :55) → Recovery Pro 60–120 | 120 | 120 |
| BIO LONGEVITY | HBOT (sale :55) → IHHT 60–90 (sale :85) → Recovery Pro 90–150 | 150 | 150 |
| BIO COMPRESS | Compresión 0–30 (sale :27) → tumbona 30–60 | 60 | 60 |

BIO LONGEVITY es el caso interesante. El cliente sale del IHHT en el minuto 85,
pero el gabinete de Recovery Pro abre cada 30 minutos, así que entra a los 90 y
sale a los 150. Los 150 minutos publicados no están escritos en ninguna parte del
código: salen de esa aritmética. El validador de configuración compara la
duración derivada contra la publicada y avisa si dejan de coincidir.

## Las dos anclas

Cuando la salida real del cliente no es `setup + terapia`, se declara aparte.
Pasa dos veces, y ninguna es un capricho.

**HBOT.** El protocolo tiene tres tramos —presurización, isopresión, descenso— y
el operador reparte los minutos según el cliente. El motor no los modela: modela
un único invariante, que el cliente sale del recinto en el **minuto 55**. Los
tramos y la ATA se registran como datos clínicos de la sesión ejecutada, no como
parámetros de agenda. (Nota clínica que el modelo aprovecha: el descenso ya se
hace respirando aire, no oxígeno, así que no hace falta ningún intervalo de
lavado entre HBOT e IHHT.)

Cuando hay ancla, el turnaround cuelga de ella: la limpieza arranca cuando el
cliente sale, no cuando terminaban nominalmente los minutos de terapia. Por eso
la cámara se libera en el minuto 60 (55 + 5) y no en el 58 — si no, quedaría
publicada como libre dos minutos mientras todavía se está higienizando.

**Recovery Pro.** No hace falta declararla: se deriva de la secuencia interna.
Ahí el turnaround no cuelga del ancla, porque los 12 minutos ya incluyen tiempo
del cliente (la ducha es la etapa 48–56) y sumarlos otra vez los contaría dos
veces.

## Recovery Pro y el desfasaje que nadie escribió

La secuencia interna de Recovery Pro es protocolo, no sugerencia:

| Minuto | Etapa | Recurso |
|---|---|---|
| 0–12 | Sauna | gabinete |
| 12–15 | Cold plunge | gabinete |
| 15–25 | Sauna | gabinete |
| 25–28 | Cold plunge | gabinete |
| **28–48** | **Red Light** | **tumbona del pool** |
| 48–56 | Ducha y vestuario | gabinete |
| 56–60 | Salida | — |

El cliente suelta la tumbona en el minuto 48, mientras todavía se está duchando.
Y sale a los 56, que es de dónde sale el ancla.

La tumbona, eso sí, queda bloqueada hasta el 55: estar prestada a Recovery Pro no
la exime de su propio turnaround. Los tiempos son atributos del recurso, y eso
vale también cuando el recurso está trabajando para otro.

R-07 pedía que el desfasaje de 30 minutos entre gabinetes **emergiera** en vez de
estar escrito a mano. Emerge: el gabinete 1 a las 10:00 pide dos tumbonas de sala
para 10:28–10:55; el gabinete 2 a las 10:00 pediría otras dos para la misma
ventana, y el sub-pool de la sala tiene dos. El pedido se cae solo. A las 10:30,
en cambio, pide 10:58–11:25 y no se tocan —por tres minutos—. Buscar la constante
«30» en el código es inútil: no está.

Y si la ducha se hiciera antes de la luz roja, las ventanas se solaparían y el
desfasaje dejaría de cerrar. Por eso las etapas se validan contiguas.

## El pool de tumbonas es direccional

Las tres tumbonas no tienen dueño fijo, pero la asignación no es simétrica
([`pool-tumbonas.ts`](../src/motor-agenda/agenda/pool-tumbonas.ts)):

- **Recovery Pro** sólo puede tomar las dos de su sala. Nunca la standalone, ni
  siquiera cuando es la única libre: el cliente paga un gabinete privado y
  mandarlo al área común rompe el producto. Cuando eso pasa, el rechazo lo dice
  con todas las letras, porque desde el mostrador parece que hay una tumbona
  disponible y el sistema la rechaza.
- **Todo lo demás** (BIO ENERGY, BIO COMPRESS, Red Light suelta) prefiere la
  standalone y recién después toma una de la sala. La preferencia deja las de la
  sala para quien no tiene alternativa.

## Lo que no está escrito a mano

Dos reglas del enunciado suenan a caso especial y no lo son.

**«HBOT Multiplaza no encadena con IHHT.»** No hay ninguna regla sobre
multiplaza. Hay un asignador genérico que pide `ocupantes` puestos de IHHT en la
ventana del tramo siguiente y encuentra dos. Con cuatro ocupantes el pedido se
cae; con dos, entra. Lo único que el código agrega es un mensaje que le explique
a recepción qué pasó, en vez de un «no hay lugar» pelado.

**«La combinación que encadena sin fricción es biplaza hacia 2 puestos de
IHHT.»** Tampoco está declarado. Los tramos de cámara ofrecen las tres
alternativas en orden y el expansor se queda con la primera que cierra: con dos
ocupantes, la monoplaza no los admite y sale biplaza.

## Los rechazos son datos

Un rechazo nunca es un booleano. Lleva un `codigo` tipado, la regla que lo
origina (`R-03`, `R-07`…), un mensaje en español listo para leerle al cliente y
un `detalle` con los números.

Y el motor devuelve **todos** los aplicables, no el primero. Recepción tiene al
cliente enfrente: descubrir de a una que el turno está fuera de ventana, después
que falta la autorización y después que no hay lugar son tres llamadas en vez de
una conversación.

## La configuración falla al arrancar

[`validar-config.ts`](../src/motor-agenda/validacion/validar-config.ts) corre
cuando se compila el motor, no cuando se reserva. Una configuración que no cierra
es un bug de despliegue.

El invariante que le da sentido:

```
setup + terapia + turnaround <= slot
```

Un recurso que no lo cumple no produce un atraso puntual: produce **atraso
acumulativo** a lo largo del día, porque cada turno arranca un poco más tarde que
el anterior y nadie recupera esos minutos. `compilarConfig` lanza
`ErrorDeConfiguracion` con la lista completa de problemas —no el primero: quien
la arregla quiere verlos todos de una vez—.

También verifica el ancla contra la secuencia interna, que las etapas sean
contiguas, que no haya ids repetidos, que los combos referencien servicios que
existen, y que ninguna duración publicada se haya despegado de la derivada.

### Valores que faltan y valores que no están ratificados

Son dos cosas distintas y ninguna toma un default silencioso.

**No ratificados**: existen y el motor los usa, pero nadie los acordó. Se marcan
en la configuración con el motivo, el informe los lista al arrancar y cada plan
que los toca arrastra la advertencia. El caso que hay que mirar es el turnaround
del puesto IHHT: depende de un protocolo de higiene de máscara y clip de dedo que
todavía no existe como documento escrito, y el margen es exactamente cero
(3 + 22 + 5 = 30 = el slot). Si el protocolo real pide un minuto más, la grilla
de media hora deja de cerrar.

El informe trae además `avisos`: cosas que funcionan **por poco margen**. Hoy hay
uno solo y conviene tenerlo a la vista — el desfasaje de R-07 cierra por tres
minutos, y esos tres minutos dependen de un turnaround de tumbona que nadie midió.

**Faltantes**: no existen. La camilla de masajes, el consultorio, la sala TB y
los puestos IV no tienen tiempos medidos; inventarlos sería peor que no tenerlos.
Se declaran con `sinTiempos` explicando por qué, el validador los reporta, y
agendarlos devuelve `RECURSO_SIN_TIEMPOS`. Lo mismo con los precios: sólo están
cargados los de R-04 y R-06, y cotizar cualquier otro devuelve
`PRECIO_NO_DEFINIDO` en vez de un número inventado.

Dos interruptores de configuración endurecen esto el día que el Manual cierre sus
pendientes: `exigirRatificacion` convierte los no ratificados en errores fatales,
y `exigirCatalogoDePreciosCompleto` hace lo mismo con los precios faltantes.

## La lista de precios del Founding Member

El FM **no** congela el precio de su membresía: congela la lista completa vigente
el día de su inscripción. La diferencia importa el día que cambia de producto. Si
entró en agosto de 2026 con FOCUS y en 2028 pasa a HEALTHSPAN, paga el HEALTHSPAN
de agosto de 2026 —un producto que en su momento ni contrató—.

Por eso el cliente guarda una **versión**, no un precio, y por eso las versiones
son inmutables: si alguien editara la lista de agosto de 2026, el beneficio se
evaporaría sin que nadie lo notara. Regla de oro: una versión publicada nunca se
edita, se publica otra.

Y por eso una versión desconocida es un rechazo y no un fallback a la lista
vigente: cotizarle a un fundador contra la lista de hoy es exactamente el error
que el programa promete no cometer.

R-09 revisada le pone condiciones al tag: exige membresía vigente y sin mora. El
fundador cambia libremente de tier y modalidad sin perderlo, pero si queda sin
membresía activa cae a la ventana de reserva de su categoría como cualquiera. Por
eso nadie debería leer `cliente.tagFoundingMember` suelto: el tag es el dato
guardado, `fmVigente()` es la respuesta.

## Mapa de archivos

```
src/motor-agenda/
  index.ts                      API pública
  dominio/
    tipos.ts                    Recurso, Servicio, Combo, Titularidad, PlanDeReserva…
    rechazos.ts                 CodigoRechazo, Resultado<T>, ErrorDeConfiguracion
    tiempo.ts                   aritmética de minutos y hora local de San Isidro
  config/
    tipos.ts                    forma de ConfigMotor
    recursos.ts                 los 12 recursos, sus tiempos y sus cantidades
    catalogo.ts                 servicios y combos
    comercial.ts                membresías y listas de precios versionadas
    index.ts                    la configuración de San Isidro, armada
  validacion/
    validar-config.ts           el invariante, el resto de las verificaciones, compilarConfig
  agenda/
    encadenamiento.ts           la derivación de tiempos: el corazón del principio
    ocupacion.ts                qué unidad está tomada y cuándo
    pool-tumbonas.ts            el asignador direccional
    expansor.ts                 combo + hora + ocupantes → cadena de reservas
  reglas/
    calendario.ts               horario de atención y franja clínica
    acceso.ts                   ventanas de reserva, R-03, saldo de membresía
    motor.ts                    evaluarReserva: orquesta todo
  comercial/
    founding.ts                 R-09: el tag y sus condiciones
    precios.ts                  cotización contra listas versionadas
    membresias.ts               ciclo, saldo, pausa proporcional, cancelación
```

## Tests

[`tests/motor-agenda/casos-obligatorios.test.ts`](../tests/motor-agenda/casos-obligatorios.test.ts)
es la especificación ejecutable: cada `describe` es uno de los once casos que el
motor tiene que cumplir, con el enunciado textual arriba. Si alguno se cae, el
motor está mal, no el test.

```bash
npx vitest run tests/motor-agenda/
npm run verify              # gate completo del repo
```

## Relación con el resto del repo

El módulo es **autocontenido y aditivo**: no importa nada de `src/lib`,
`src/bots` ni `src/config`, y nada del repo lo importa todavía. Los bots de
reserva que hoy están en producción siguen funcionando igual.

Eso es deliberado, porque este modelo **revisa** reglas que el resto del repo ya
tiene implementadas de otra manera —R-06, R-07, R-09, la estructura y los precios
de las membresías, la franja clínica, el versionado de precios—. Unificarlos es
una migración de fondo, con su propia decisión de producto detrás; hasta que se
tome, conviven sin pisarse. Las diferencias están listadas en las
[preguntas abiertas](motor-agenda-preguntas-abiertas.md).
