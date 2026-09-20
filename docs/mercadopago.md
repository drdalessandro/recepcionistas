# MercadoPago — estado real de la integración

Qué está vivo, qué está codeado pero inerte, y qué falta. Complementa el paso a
paso de credenciales de [`puesta-en-produccion.md`](puesta-en-produccion.md) §7.

## Lo que funciona

| Camino | Estado |
| --- | --- |
| Link de pago de la **seña** (50 %, R-19, con vencimiento) | ✅ |
| Link del **saldo restante** | ✅ |
| **Envío** del link del saldo por WhatsApp (botón en el turno) | ✅ desde 2026-09-20 |
| Link de la **cuota mensual** de membresía | ✅ |
| **Webhook** de pagos (verifica contra la API de MP, no confía en el payload) | ✅ |
| Acreditación automática: turno confirmado / plan activado / saldo saldado | ✅ |
| Detección de **pago duplicado** y de pago sin registro interno | ✅ |
| Diagnóstico `npm run mp:test` · últimos pagos `npm run mp:ordenes` | ✅ |

## Cuotas: decisión comercial, ahora explícita

`crearPreferenciaMP` manda `payment_methods.installments` desde
`MERCADOPAGO.maxCuotas` (`src/config/reglas.ts`), fijado en **3**
(Andrés, 2026-08-22).

> `installments` es un **máximo, no una lista**: con 3, el cliente ve las
> opciones de 1, 2 y 3. MercadoPago no permite ofrecer "1 y 3" salteando el 2.

El **resto de los medios queda abierto** a propósito: no se mandan
`excluded_payment_types` ni `excluded_payment_methods`, así que siguen sirviendo
tarjeta, dinero en cuenta, transferencia y efectivo.

Hasta 2026-08-22 no se mandaba nada: cada link aceptaba **el máximo de cuotas
que la cuenta ofreciera por default**. Quién paga ese financiamiento depende de
la configuración de la cuenta de MP —si tiene "cuotas sin interés", lo absorbe
Biowellness; si no, lo paga el cliente— y como el sistema guarda **montos
brutos** a propósito (R-18: la comisión es gasto del P&L de Administración), la
diferencia **no aparece en ningún tablero**: sale recién en la liquidación.

> **Para Andrés:** subir el número es una línea. Antes de decidir conviene mirar
> en el panel de MP si la cuenta tiene cuotas sin interés activadas, porque eso
> define si el costo lo paga el centro o el cliente.

## Débito automático: **codeado pero INERTE**

`cobro-membresias.ts` sabe cobrar con tarjeta guardada: lee `mp-customer-id` y
`mp-card-id` del `Coverage`, tokeniza y cobra. **Pero ningún flujo del sistema
escribe esas dos extensiones.** No existe la captura de tarjeta, así que hoy
**todas** las cuotas salen por link de pago.

Que quede dicho sin vueltas: el débito automático **no es un activo que
tengamos**, es un requisito pendiente. Presupuestar una migración de pasarela
incluyendo "re-tokenizar a los socios" sería pagar por un problema que no
existe.

### Qué falta para activarlo

1. **Front**: un formulario de tarjeta con MP Bricks / CardForm usando la
   `MERCADOPAGO_PUBLIC_KEY` (que ya está en `.env.example` y hoy **no la usa
   nadie**). Tokeniza del lado del navegador: los datos de tarjeta nunca pasan
   por nuestro servidor (Anexo B).
2. **Bot**: con ese token, crear/asociar el customer y la card en MP, y guardar
   los dos ids en el `Coverage` del socio.
3. **Nada más**: el cobro mensual ya está escrito y probado.

> **Por qué no está hecho todavía:** el contrato exacto de esos endpoints hay
> que verificarlo contra la documentación de MercadoPago, y desde este entorno
> el egress a `mercadopago.com.ar` está bloqueado. Escribir un flujo de tarjetas
> adivinando la API es exactamente donde adivinar sale peor: un `card_id` mal
> guardado le cobra —o le falla el cobro— a un socio real todos los meses.

### Mientras tanto, está protegido

Si algún día se cargan esos ids a mano, el camino no puede hacer daño: un error
de sistema (token mal cargado, MP caída) devuelve `'error'`, **no** `'rejected'`.
La diferencia importa — tratarlo como rechazo cancelaba el Invoice y aplicaba el
bloqueo R-11, así que un access token mal cargado bloqueaba **a todos** los
socios con tarjeta guardada el día 1 del mes.

## El cobro mensual y el orden de las escrituras

El cron (días 1-5) hace, **en este orden**:

1. **Emite el Invoice** del ciclo (idempotente por `plan-{coverage}-{ciclo}`).
2. **Recién ahí** resetea las sesiones y marca el ciclo como facturado.
3. Cobra: tarjeta guardada (inerte, ver arriba) o link de pago por WhatsApp.

El orden no es cosmético. Al revés —como estaba hasta 2026-08-22— si el proceso
moría entre 2 y 1, el socio quedaba marcado como facturado **sin que existiera
la factura**; `debeRenovarMembresia` filtra por ese campo y el cron solo corre
los días 1-5, así que **ese mes no se cobraba nunca y nadie se enteraba**. Con
el orden actual la ventana es inofensiva: la corrida siguiente vuelve a entrar y
el Invoice no se duplica. Hay test.

## Auditoría contra la documentación oficial (2026-09-11)

Se contrastó la integración campo por campo con la doc de MercadoPago (MLA, vía
el MCP de MP). **Todo lo crítico coincide**; queda constancia de qué se verificó
para no volver a revisarlo desde cero.

| Qué | Qué pide la doc | Nuestro código |
| --- | --- | --- |
| `expiration_date_to` | `"2017-02-28T12:00:00.000-04:00"` | `isoArgentina` (`lib/sena.ts`) da `…T17:05:00.000-03:00` — **exacto**, con milisegundos y offset. Ojo: el otro `isoArgentina` del repo (`isoHorarioPortal`) NO lleva milisegundos y acá no sirve |
| `binary_mode` | válido; advierte que **baja la tasa de aprobación** | Solo en la seña, a propósito: un ticket de Rapipago acredita en días y la tentativa vence en horas |
| `auto_return` + `back_urls` | `"approved"` con las tres URLs | ✓ Las tres al **portal del paciente** (`PORTAL_BASE_URL`, default `https://app.biowellness.ar`). Hasta el 2026-09-20 iban a la app de recepción, que es un login de personal: el paciente pagaba y caía en una pantalla que no era para él |
| `payment_methods.installments` | `"installments": 12` | ✓ (de `MERCADOPAGO.maxCuotas`) |
| `statement_descriptor` | `"MINEGOCIO"` | ✓ `BIOWELLNESS` |
| Firma: template del manifiesto | `id:…;request-id:…;ts:…;` | ✓ |
| Firma: omitir las partes ausentes | *"debes removerlo del manifest"* | ✓ |
| Firma: id alfanumérico en minúsculas | `ORD01JQ…` → `ord01jq…` | ✓ |
| Tipos de suscripción | `subscription_authorized_payment`, `subscription_preapproval` | ✓ los dos |
| Reintentos | 200/201 antes de **22 s**, si no reintenta **cada 15 min** | `confirmarReserva` es idempotente por `sena-{turno}` **y** `mp-{paymentId}`, y distingue un reintento del mismo pago de un pago doble real (el segundo levanta alerta para devolver) |

### Tres divergencias conocidas (ninguna rompe hoy)

1. **`data.id` se lee del BODY, no de los query params.** La doc es explícita:
   *"`[data.id_url]` se sustituirá por el valor del parámetro `data.id` recibido
   en los **query params de la URL**"*. En la práctica MP manda los dos y
   coinciden, por eso la firma valida. Si alguna vez difirieran, descartaríamos
   notificaciones legítimas **en silencio**: con firma inválida devolvemos 200,
   así que MP no reintenta. Antes de "arreglarlo" hay que averiguar si un bot de
   Medplum puede leer los query params del request — si no puede, esto es un
   límite documentado, no una deuda.

2. **`subscription_preapproval_plan` no está manejado.** Es el tercer tipo de
   suscripción de la doc (vinculación de un *plan*). Hoy no aplica —D16: la
   suscripción la arma Recepción a mano en el panel de MP— pero si llegara, cae
   en "evento ignorado" sin hacer ruido.

3. **`payment` figura como *legacy*, pero solo para Checkout API.** Para
   **Checkout Pro**, que es lo que usamos (`/checkout/preferences`), sigue
   siendo el tipo correcto. Importa el día que alguien migre a la **Orders API**:
   ahí el tipo pasa a `orders` y el webhook actual lo ignoraría.

> Lo que esta auditoría **no** puede responder: si el MONTO es el correcto. MP
> cobra bien lo que se le pide; cuánto pedir en la Multiplaza depende del piso de
> facturación de 3 personas (`Math.max(ocupantes, 3)` en `lib/pricing.ts`), que
> es una decisión comercial abierta — ver "Lo que sigue sin resolver".

## El saldo: el camino existía y no lo usaba nadie (2026-09-20)

El link del saldo estaba construido desde el principio, con el mismo mecanismo
que la seña. Lo que faltaba era que **alguien se lo mandara al paciente**: no
había plantilla, ni envío automático, ni recordatorio de saldo impago, ni forma
de que la paciente se lo generara desde el portal (el bot no está en su
AccessPolicy). El único que podía era Recepción, copiando la URL a mano de la
pantalla del turno. Un camino de cobro que exige copiar y pegar es un camino
que no se usa.

Ahora `bw-link-mercadopago` acepta `enviar: true` (solo con `concepto: 'saldo'`)
y manda el link por WhatsApp, con un botón propio en el modal del turno. **No es
idempotente a propósito**: reenviar un link que la paciente perdió es una acción
legítima del mostrador y no hay cron que pueda dispararlo de más. Cada envío
queda como `Communication` en el hilo.

La seña queda afuera de `enviar`: su link ya sale solo al reservar y de nuevo
60 min antes de vencer (R-19), así que un envío manual duplicaría.

### Dos diferencias del link del saldo contra el de la seña

| | Seña | Saldo |
| --- | --- | --- |
| `binary_mode` | sí | **no** |
| Vencimiento | 2 h (R-19) | **ninguno** |

Las dos salen del mismo hecho: **el saldo no sostiene ningún lugar**. Si no
entra, el turno sigue en pie y se cobra en el mostrador, así que no hay nada
que liberar a las dos horas. Lo que sí implica, y conviene decidirlo: el link
acepta medios que acreditan en días y **no caduca solo**. Un pago que llegue
después de que Recepción cobró en efectivo no rompe nada —el candado de
`resolverInvoicePlan` lo detecta y levanta alerta de pago duplicado— pero eso
es una red, no un diseño.

> **Para Andrés:** ponerle vencimiento al link del saldo es una decisión
> comercial, no técnica: ¿hasta cuándo se puede pagar a distancia? Ahora que el
> link se manda por WhatsApp y queda en el chat, la pregunta pesa más que antes.

## Lo que sigue sin resolver

- **Cuánto cobrar de seña en la Multiplaza** (decisión de Andrés, comercial).
  `lib/pricing.ts` cobra `precioUSD * max(ocupantes, 3)`: una persona sola paga
  USD 240 y su seña sale USD 120. El portal, en la misma pantalla, le dice
  *"Valor de referencia: USD 80"*. Apareció con plata real el 2026-09-11 (seña de
  $174.000 a TC 1450 por una reserva de UNA persona). La contradicción está
  documentada en [`motor-agenda-fhir.md`](motor-agenda-fhir.md) §713: el motor
  comercial dice "USD 80 por persona desde uno, **sin piso de sesión**". Ojo con
  el matiz: el mínimo de 3 de la agenda es **operativo** (`validarMinimoGrupal`
  advierte, no bloquea), no un piso de facturación — hoy el código trata lo mismo
  de dos maneras. Si gana el piso, el portal tiene que decirlo antes de reservar.
- **Reembolsos y contracargos**: si un pago se devuelve desde el panel de MP, el
  sistema no se entera (el webhook ignora `refunded` / `charged_back`), así que
  el Invoice queda como cobrado.
- **Un rechazo real de tarjeta no se reintenta** dentro del mismo ciclo: aplica
  R-11 y el socio regulariza en mostrador. Es el diseño actual, no un bug — pero
  conviene decidirlo a conciencia cuando exista el débito automático.
