# «¿Olvidaste tu contraseña?»: el circuito completo y el fix del portal

> **Estado: BUG confirmado en el portal (2026-08-20).** La página de reset de
> `app.biowellness.ar` crashea con **`Can't find variable: grecaptcha`** antes de
> llamar al servidor: el paciente que olvidó su contraseña hoy no tiene camino
> de autoservicio. Este documento explica el circuito entero (portal + servidor
> Medplum + email), las dos opciones de fix del lado del portal, y qué hay que
> revisar del lado del servidor para que el link del email apunte bien.
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

### Opción A — configurar reCAPTCHA de verdad

1. Crear claves reCAPTCHA **v3** en Google para el dominio `app.biowellness.ar`.
2. *Site key* → variable de build del portal (donde el código la espera) y
   rebuild.
3. *Secret key* → config del servidor Medplum (`recaptchaSecretKey`) +
   `pm2 restart`, para que el server valide el token que ahora sí va a llegar.

Más pasos, pero deja protección anti-abuso en un endpoint público que manda
emails.

### Opción B — sacar reCAPTCHA de la página de reset

Self-hosted, el server **solo exige** `recaptchaToken` si tiene
`recaptchaSecretKey` configurado. Si no lo tiene (verificarlo en el config de
la EC2), el portal puede llamar `POST auth/resetpassword` con `{ email }` a
secas: quitar `initRecaptcha`/`getRecaptcha` de la página y listo.

Mitigación recomendada si se elige B: rate-limit en el nginx del server para
`/auth/resetpassword` (misma receta `limit_req` que cualquier endpoint público).

**Recomendación: B ahora** (destraba el autoservicio con un cambio de una
página y cero dependencias), **A después** si el endpoint empieza a recibir
abuso.

## 3. Qué NO está roto (para no arreglar de más)

- **La reinvitación desde Recepción.** `bw-invitar-paciente` no pasa por esta
  página ni por reCAPTCHA: llama `auth/resetpassword` con `sendEmail:false`,
  lee el `UserSecurityRequest` y arma el link él mismo sobre `PORTAL_BASE_URL`,
  entregándolo por WhatsApp/email/QR. **Hoy es el único camino que funciona**
  para un paciente sin contraseña: Atender → reinvitar. Sirve de workaround
  mientras el portal no se arregle — y es la vara para probar el fix (los dos
  caminos tienen que dejar al paciente en la misma pantalla de `setpassword`).
- **El email en sí.** SES + `medplum.sendEmail()` funcionan (verificado
  2026-08-20 con `npm run email:test`). Lo único pendiente del lado email es el
  remitente por defecto (`supportEmail` → `info@biowellness.ar`, arriba).

## 4. Prueba de aceptación del circuito (después del fix)

1. En el portal, «¿Olvidaste tu contraseña?» con el email de un paciente de
   prueba → **sin errores en pantalla**.
2. Llega el email: remitente `info@biowellness.ar` (si ya se cambió
   `supportEmail`), y el link apunta a `https://app.biowellness.ar/setpassword/…`.
3. El link abre el portal, deja crear la contraseña nueva y el login siguiente
   funciona.
4. Control cruzado: reinvitar al mismo paciente desde Recepción (Atender) sigue
   funcionando igual que antes.
