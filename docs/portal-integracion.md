# Integración Recepción ↔ Portal del paciente

Contrato de integración entre **esta app (recepción)** y el **portal del paciente**
(`biowellness/portal`, basado en FooMedical, publicado en `app.biowellness.ar`).

Las dos apps comparten el **mismo servidor y proyecto Medplum**. La recepción es
para el staff (con su AccessPolicy operativa); el portal es para el paciente, que
ve **solo lo suyo** vía la AccessPolicy **"Paciente — Portal"**
(`src/fhir/access-policies.ts`).

> Estado: **integrado (eje Cliente, solo lectura).** El repo `biowellness/portal`
> ya está en scope y cableado: el portal muestra **Sesiones** y **Pagos** reales y
> la AccessPolicy quedó reconciliada (ver "Hecho" más abajo). Lo que sigue es la
> **reserva online** por *modelo de solicitud* (el paciente pide, Recepción
> confirma) — ver el handoff del portal `docs/cliente-negocio-handoff.md`.

## Hecho (cableado actual)

- **Sesiones/Pagos** en `/membership` del portal: leen `Coverage`/`Invoice` del
  paciente y arman el saldo (módulo `portal/src/fhir/membership.ts`), espejando
  `src/fhir/coverage.ts` + `src/lib/planes.ts`. El portal no recalcula reglas.
- **AccessPolicy "Paciente — Portal" reconciliada.** Se sumó `Invoice` (faltaba en
  el espejo del portal) y se unificó esta definición (la del seed) con la del
  portal. Es la **fuente de verdad**: `npm run seed` la aplica por `name`, así que
  el espejo `portal/docs/medplum/access-policy-paciente-portal.json` debe quedar
  idéntico. `Coverage`/`Invoice`/`Appointment` son de **solo lectura** para el
  paciente; escribe solo su autogestión (perfil, vitales, cuestionarios,
  consentimientos, mensajes).
- **`ServiceRequest` — estudios de laboratorio (2026-08-13).** `ServiceRequest`
  no estaba en la policy: el portal ni siquiera podía **buscar** los pedidos del
  paciente (403 en `GET ServiceRequest?subject=Patient/…`, con el cartel *"No
  pudimos registrar tu solicitud"* en "Mis estudios"). Se agregaron dos entradas,
  el mismo patrón de Coverage: **lectura** amplia de lo propio
  (`ServiceRequest?subject=%patient`, incluidas las órdenes que le indica el
  médico) y **escritura acotada a propuestas**
  (`…&intent=proposal,plan`) — una solicitud del portal es un pedido, nunca una
  orden médica autorizada, así que el paciente no puede auto-indicarse estudios.
  ⚠️ Si el portal crea la solicitud con `intent=order`, el 403 sigue: lo correcto
  es que mande `proposal`. Actualizar el espejo del portal con estas entradas.
- **Reserva por *solicitud* (implementada).** El paciente pide desde el portal y se
  crea un `Task` (`code=solicitud-turno`) vía el bot **`bw-solicitar-turno`**
  (lógica pura en `src/lib/solicitudes.ts`), que avisa a Recepción por WhatsApp
  (secret `RECEPCION_WHATSAPP_TO`). La app de recepción tiene la vista **"Solicitudes"**
  para atenderlas y confirmarlas con los bots de reserva. El paciente solo **lee** sus
  `Task` y solo puede **ejecutar** ese bot (AccessPolicy acotada). No escribe agenda.
  Para activarlo: `npm run deploy:bots` + `npm run seed` + secret `RECEPCION_WHATSAPP_TO`.

## Cómo se conectan (hoy)

- **Alta de paciente** (`bw-alta-paciente`): la recepción crea el `Patient`
  (dedupe por DNI/email/teléfono). No da login.
- **Invitación al portal** (`bw-invitar-paciente`, requiere admin): hace el
  *invite* de Medplum (`sendEmail:false`, `upsert:true` → reusa el `Patient`,
  no duplica) con la AccessPolicy "Paciente — Portal", y entrega el link mágico
  `/<portal>/setpassword/{id}/{secret}` por **WhatsApp / email / QR**.
- **Auto-registro** (portal, "Crear cuenta"): el paciente se crea solo. Medplum le
  asigna el **default patient access policy** del proyecto.

El link de invitación apunta al portal vía el secret **`PORTAL_BASE_URL`**
(default `https://app.biowellness.ar`).

> **2026-08-12 — Handoff nuevo para el portal:**
> [`handoff-portal-reservas-notificaciones.md`](handoff-portal-reservas-notificaciones.md)
> (feedback de recepción): Reservas debe pintar los chips de
> `bw-disponibilidad` (sin grilla fija de fallback), manejar el rechazo
> `horario-ocupado` de `bw-solicitar-turno` (nuevo), e implementar la
> campanita de mensajes (la policy ya lo permite).

## Checklist de revisión del repo del portal

1. **Mismo proyecto Medplum.** El portal debe registrar/loguear contra el mismo
   project que recepción (`7f068d7d-4633-46e9-9eff-d52bc03625b9`) en el mismo
   `MEDPLUM_BASE_URL` (`https://api.medplum.com.ar/`). Si fuera otro proyecto, los
   `Patient` no se comparten y la integración no funciona.
   → revisar config del `MedplumClient` / `projectId` / variables de entorno.

2. **Ruta `/setpassword/:id/:secret` — ✅ YA EXISTE en el portal.**
   El portal tiene `SetPasswordPage` (`portal/src/pages/SetPasswordPage.tsx`) como
   ruta **pública** que hace `POST auth/setpassword` y redirige a `/signin`. El link
   de invitación a `app.biowellness.ar/setpassword/...` ya funciona end-to-end; no
   hace falta el stopgap de apuntar a `app.medplum.com.ar`.

   <details><summary>Referencia (la página ya implementada en el portal)</summary>

   ```tsx
   // SetPasswordPage.tsx (portal)
   import { PasswordInput, Button, Title, Stack, Alert } from '@mantine/core';
   import { normalizeErrorString } from '@medplum/core';
   import { Document, Form, Logo, useMedplum } from '@medplum/react';
   import { useState } from 'react';
   import { useParams, useNavigate } from 'react-router-dom';

   export function SetPasswordPage(): JSX.Element {
     const { id, secret } = useParams() as { id: string; secret: string };
     const medplum = useMedplum();
     const navigate = useNavigate();
     const [error, setError] = useState<string>();
     return (
       <Document width={450}>
         <Form onSubmit={async (formData) => {
           if (formData.password !== formData.confirm) { setError('No coinciden'); return; }
           try {
             await medplum.post('auth/setpassword', { id, secret, password: formData.password });
             navigate('/signin');
           } catch (err) { setError(normalizeErrorString(err)); }
         }}>
           <Stack><Logo size={32} /><Title>Elegí tu contraseña</Title>
             <PasswordInput name="password" label="Nueva contraseña" required />
             <PasswordInput name="confirm" label="Repetir contraseña" required />
             {error && <Alert color="red">{error}</Alert>}
             <Button type="submit">Guardar</Button>
           </Stack>
         </Form>
       </Document>
     );
   }
   ```
   ```tsx
   // en el router del portal (zona pública, sin guard de sesión):
   <Route path="/setpassword/:id/:secret" element={<SetPasswordPage />} />
   ```
   Referencia canónica: `medplum/packages/app/src/SetPasswordPage.tsx` (open source).
   </details>

   `PORTAL_BASE_URL` debe quedar en `https://app.biowellness.ar` (default). Ya no se
   necesita el stopgap a `app.medplum.com.ar`.

3. **Default patient access policy = "Paciente — Portal".** Para que el
   auto-registrado y el invitado queden con el **mismo** alcance, configurar en el
   proyecto Medplum el *default patient access policy* apuntando a la policy del
   seed. (Sin esto, el auto-registro podría quedar sin policy o con otra.)

4. **Recursos que lee/escribe el portal — ✅ reconciliado.** "Paciente — Portal"
   ahora cubre lo que el portal usa de verdad: su compartimento clínico/financiero
   de **solo lectura** (Appointment/Coverage/**Invoice**/DiagnosticReport/CarePlan/
   MedicationRequest/Immunization) + **escritura** de autogestión (Patient/
   Observation/QuestionnaireResponse/DocumentReference/Communication) + catálogo y
   agenda de lectura (Schedule/Slot/HealthcareService/Practitioner/…). La definición
   vive en `src/fhir/access-policies.ts` (fuente de verdad del seed) y su espejo en
   `portal/docs/medplum/access-policy-paciente-portal.json`.

   **Reserva = modelo de solicitud** (implementado): el paciente **no** crea
   `Appointment` ni ejecuta bots de reserva. La policy le suma `Task` de solo lectura
   (`Task?patient=%patient`) y `Bot` acotado a `bw-solicitar-turno`
   (`Bot?name=bw-solicitar-turno`) — el único bot que puede ejecutar. Si más adelante
   se opta por reserva inmediata por bots (`bw-reservar-turno`/`bw-reservar-combo`),
   antes endurecerlos para derivar el paciente del login (no del input) y habilitar la
   ejecución solo de esos bots.

5. **Branding/seguridad** ya consistente (theme Biowellness en `app.biowellness.ar`).
   Verificar `recaptchaSiteKey`/`googleClientId` si el registro los usa.

## Cómo dar acceso al repo del portal

Desde **Claude Code web → entorno de esta sesión → Repositories/Sources**, agregar
`biowellness/portal` a los repos permitidos y reabrir la sesión. Doc:
https://code.claude.com/docs/en/claude-code-on-the-web

Mientras no esté en el scope, recepción **no** puede leer ese repo (proxy de git y
GitHub MCP están acotados a `biowellness/recepcionistas`).


## Catálogo de servicios — misma lista que Recepción

El catálogo v9 (fuente de verdad: este repo, `src/config/catalogo.ts`) se seedea en
Medplum como recursos FHIR. Desde 2026-07-13 la AccessPolicy **"Paciente — Portal"**
permite leerlos (`ActivityDefinition` y `PlanDefinition`, sólo lectura), así el
portal arma su selector de servicios desde el servidor y **siempre ve lo mismo que
Recepción** (sin listas duplicadas ni hardcodeadas).

Consultas (con el login del paciente):

- Servicios: `ActivityDefinition?status=active&_count=100`
  - código de negocio: `identifier` con system `https://biowellness.ar/fhir/CodeSystem/servicio` (ej. `HBOT_MONO`, `IHHT`)
  - nombre visible: `title` · categoría: `topic[0].text` (HBOT, IHHT, …)
  - precio USD: extensión `https://biowellness.ar/fhir/StructureDefinition/precio-usd` (decimal); consultas en ARS: `precio-ars`
  - requiere prescripción (IV/TB): extensión `https://biowellness.ar/fhir/StructureDefinition/requiere-prescripcion` (boolean) — el portal puede ocultarlos o marcarlos "requiere consulta médica"
  - duración: `timingTiming.repeat.duration` (minutos)
- Combos: `PlanDefinition?type=combo&status=active` (título, precio en ext `precio-usd`)

Al crear la solicitud (`bw-solicitar-turno`), mandar **`terapiaCodigo`** con el
código de negocio del servicio elegido (o su categoría). Ese dato permite que,
cuando Recepción reserva el turno, el bot resuelva la solicitud correcta
automáticamente (ver abajo).

## Auto-resolución de solicitudes (2026-07-13)

`bw-reservar-turno` y `bw-reservar-combo` completan solos el `Task` de solicitud
pendiente del paciente al reservar: si hay UNA pendiente se completa esa; si hay
varias, la que coincida por `terapiaCodigo` (código de servicio o categoría); si
ninguna coincide, no se toca (se resuelve a mano). El Task completado guarda la
referencia del turno en `output` (`type.text = "appointment"`). El portal puede
mostrar la solicitud como "confirmada" leyendo ese output.
