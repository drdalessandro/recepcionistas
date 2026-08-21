# «¿Olvidaste tu contraseña?»: el circuito completo

> **Estado: RESUELTO (2026-08-21).** El autoservicio funciona: el paciente que
> olvidó su contraseña entra a «¿Olvidaste tu contraseña?», recibe el mail y
> crea una nueva. Se arregló por la **opción A** (configurar reCAPTCHA de
> verdad), en el proyecto conjunto portal + recepcionistas.
>
> Queda un detalle **no bloqueante**: el mail sale como `hola@medplum.com.ar`
> en vez de `Biowellness <info@biowellness.ar>` — es el `supportEmail` del
> servidor (§1).
>
> El documento se conserva porque describe el circuito completo y porque el fix
> tuvo una **consecuencia para Recepción** que conviene no olvidar (§5).
>
> Repos: portal del paciente (`app.biowellness.ar`) ↔ `recepcionistas`
> (`recepcion.medplum.com.ar`). Interlocutor: Alejandro (MedTech).

---

## 1. El circuito completo (cuando funcione)

```
Paciente → portal /reset  →  POST auth/resetpassword (server Medplum)
                                   │  crea un UserSecurityRequest
                                   │  y manda el EMAIL él mismo:
                                   │   · remitente  = supportEmail  (config del server, EC2)
                                   │   · link       = {appBaseUrl}setpassword/{id}/{secret}
                                   ▼
                          Paciente abre el link → setpassword en el portal → listo
```

Dos configuraciones del **servidor** (EC2, config de Medplum, `pm2 restart`
después de tocarlas) participan aunque el bug sea del portal:

| Config del server | Qué decide | Valor que necesita |
| --- | --- | --- |
| `supportEmail` | El **remitente** del email de reset (y de todo email sin `from` explícito). | `info@biowellness.ar` (identidad SES verificada en sa-east-1). |
| `appBaseUrl` | **Adónde apunta el link** del email (`{appBaseUrl}setpassword/…`). | La URL del portal, `https://app.biowellness.ar/` — **verificar antes de asumir**: si apunta a otro lado (p. ej. la consola de Medplum), el email llega pero el link cae en el sitio equivocado. Ojo: `appBaseUrl` también se usa para otros links que emite el server; si hoy apunta a otra app a propósito, conversarlo antes de cambiarlo. |

## 2. El bug del portal: `Can't find variable: grecaptcha`

La página de reset (herencia de FooMedical) llama a `grecaptcha.execute(...)`
al enviar el formulario, pero el **script de reCAPTCHA nunca se cargó** —
típicamente porque el *site key* no está configurado en el build del portal
(la variable de entorno del fork, buscar `initRecaptcha` / `getRecaptcha` /
`recaptchaSiteKey` en el código). Resultado: `ReferenceError` **antes** de que
el request salga; el servidor nunca se entera.

### Cómo se resolvió: opción A — configurar reCAPTCHA de verdad

1. Claves reCAPTCHA **v3** en Google para el dominio `app.biowellness.ar`.
2. *Site key* → variable de build del portal, y rebuild.
3. *Secret key* → config del servidor Medplum (`recaptchaSecretKey`).

Deja protección anti-abuso en un endpoint público que manda emails. (La opción
descartada era sacar reCAPTCHA de la página y compensar con `limit_req` en
nginx; se eligió A, que es la más sólida.)

## 3. El email

SES + `medplum.sendEmail()` funcionan (verificado 2026-08-20 con
`npm run email:test`). Pendiente **no bloqueante**: el mail de reset sale con
el remitente por defecto del servidor. Cambiar `supportEmail` a
`info@biowellness.ar` en la EC2 + `pm2 restart` (§1).

## 4. Prueba de aceptación del circuito

1. En el portal, «¿Olvidaste tu contraseña?» con el email de un paciente de
   prueba → sin errores en pantalla. ✔
2. Llega el email y el link apunta a `https://app.biowellness.ar/setpassword/…`. ✔
   (Remitente: `hola@medplum.com.ar` hasta que se cambie `supportEmail`.)
3. El link abre el portal, deja crear la contraseña nueva y el login funciona. ✔

## 5. Consecuencia para Recepción: reinvitar ya no repone contraseñas

Con `recaptchaSecretKey` configurado, **`auth/resetpassword` exige un token de
reCAPTCHA a todo el mundo** — y un token de reCAPTCHA solo lo puede producir un
navegador. `bw-invitar-paciente` llama a ese endpoint de servidor a servidor,
así que ahora recibe `Recaptcha token is required` y **no puede generar un link
para un paciente que ya tiene cuenta**. Es un efecto colateral esperable del
fix, no una regresión a arreglar.

Reparto de tareas resultante, que conviene respetar:

| Situación | Camino |
| --- | --- |
| Paciente **nuevo** (nunca activó) | Recepción → Atender → Invitar al portal. El `invite` de Medplum crea el link y el bot lo entrega por WhatsApp/email/QR. |
| Paciente que **ya activó** y perdió la clave | El paciente, desde el portal → «¿Olvidaste tu contraseña?». |

El bot detecta el error de reCAPTCHA y le dice eso mismo a Recepción, en vez de
mostrar una falla. `npm run portal:check -- <email>` distingue los dos casos.

> Si alguna vez se quisiera que reinvitar **también** repusiera contraseñas,
> haría falta que el bot cree el `UserSecurityRequest` por su cuenta (es project
> admin, así que puede) en lugar de pasar por `auth/resetpassword`. Es viable
> —`setpassword` solo compara el `secret` en texto plano y no valida
> vencimiento— pero significa escribir a mano un recurso interno de seguridad de
> Medplum, sin contrato estable entre versiones. **No se hizo**: hoy el portal
> cubre ese caso y no vale la pena el riesgo.
