# MercadoPago — estado real de la integración

Qué está vivo, qué está codeado pero inerte, y qué falta. Complementa el paso a
paso de credenciales de [`puesta-en-produccion.md`](puesta-en-produccion.md) §7.

## Lo que funciona

| Camino | Estado |
| --- | --- |
| Link de pago de la **seña** (50 %, R-19, con vencimiento) | ✅ |
| Link del **saldo restante** | ✅ |
| Link de la **cuota mensual** de membresía | ✅ |
| **Webhook** de pagos (verifica contra la API de MP, no confía en el payload) | ✅ |
| Acreditación automática: turno confirmado / plan activado / saldo saldado | ✅ |
| Detección de **pago duplicado** y de pago sin registro interno | ✅ |
| Diagnóstico `npm run mp:test` · últimos pagos `npm run mp:ordenes` | ✅ |

## Cuotas: decisión comercial, ahora explícita

`crearPreferenciaMP` manda `payment_methods.installments` desde
`MERCADOPAGO.maxCuotas` (`src/config/reglas.ts`), fijado en **1**.

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

## Lo que sigue sin resolver

- **Reembolsos y contracargos**: si un pago se devuelve desde el panel de MP, el
  sistema no se entera (el webhook ignora `refunded` / `charged_back`), así que
  el Invoice queda como cobrado.
- **Un rechazo real de tarjeta no se reintenta** dentro del mismo ciclo: aplica
  R-11 y el socio regulariza en mostrador. Es el diseño actual, no un bug — pero
  conviene decidirlo a conciencia cuando exista el débito automático.
