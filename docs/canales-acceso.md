# Canales de acceso a Biowellness San Isidro — rol de Recepción

Cómo llega una persona a los servicios, qué hace Recepción en cada caso y por
dónde entra la solicitud al sistema (FHIR R4). La idea central: **todos los
canales desembocan en una de tres puertas**, y Recepción trabaja siempre sobre
esas tres pantallas — no importa de dónde vino la persona.

## Las tres puertas de entrada (FHIR)

| Puerta | Recurso FHIR | Dónde lo ve Recepción | Qué hace el sistema solo |
|---|---|---|---|
| **1. Conversación** | `Communication` (hilo + mensajes; ext `canal=whatsapp`) | **Mensajes** (badge verde con no leídos, tiempo real) | WhatsApp entrante se enruta a la ficha por teléfono; número desconocido → alerta. Adjuntos quedan en el hilo. La respuesta se espeja al WhatsApp. |
| **2. Solicitud** | `Task` (`solicitud-turno`, alertas operativas) | **Solicitudes** (badge rojo con pendientes) | La solicitud del portal se resuelve sola al confirmar el turno; los duplicados abren su propia tarea. |
| **3. Ficha + reserva** | `Patient` (ext `origen-lead`) → `Appointment` | **Atender / Agenda** | Dedup por DNI/email/teléfono; la tentativa nace con link de seña y vencimiento (R-19); recordatorios y liberación son automáticos. |

**El rol de Recepción, en una frase**: identificar a la persona, meterla por la
puerta que corresponde y dejar que el sistema calcule y persiga (precios, seña,
recordatorios, vencimientos). La recepción no calcula ni decide nada que el
sistema pueda calcular o decidir.

## Canales, uno por uno

> ⚠️ **Cambio de número (2026-08-12):** el WhatsApp pasó de +54 9 11 6247-0002
> a **+54 9 11 7250-9550**. QRs y links de este repo ya regenerados — pero
> TODO lo publicado con el número viejo hay que reemplazarlo a mano: QRs
> impresos en el local/flyers, link de la bio de Instagram, botón del sitio,
> ficha de Google. Un QR viejo escaneado abre un chat que nadie atiende.

### 1. WhatsApp directo — `wa.me/5491172509550` ✅ operativo
El canal estrella: cualquier pieza (bio de Instagram, post de LinkedIn, QR,
Google) puede apuntar al link `wa.me`. El mensaje entra **solo** a la bandeja.

- **Rol de Recepción**: responder desde Mensajes (como un WhatsApp más). Si el
  número no matchea ninguna ficha, llega la alerta "WhatsApp de número
  desconocido": crear la ficha con ese teléfono (alta con dedup) y el próximo
  mensaje ya entra al hilo del paciente. De la conversación se pasa directo a
  reservar; la seña autoservicio hace el resto.
- **FHIR**: webhook Twilio → `bw-whatsapp-entrante` → `Communication` (puerta 1)
  o `Task` de alerta (puerta 2).

### 2. Instagram — enlace en bio / stories ✅ (con el enlace correcto)
El enlace de la bio apunta a `wa.me` (o al portal). Instagram es la vidriera;
la conversación ocurre en WhatsApp, que ya está integrado.

- **Rol de Recepción**: igual que el canal 1. Al crear la ficha, cargar
  `origen-lead = instagram` para que el CRM sepa de dónde vino.
- **FHIR**: puerta 1 (o 3 si se registra en el portal). `Patient.extension`
  `origen-lead` guarda la fuente.

### 3. Instagram / Facebook DM (mensaje directo) ⚠️ manual hoy
Los DMs se responden en la app de Instagram y se invita a la persona a seguir
por WhatsApp ("escribinos al …" con el link wa.me) o al portal.

- **Rol de Recepción**: puente — contestar corto en el DM y mover la charla a
  WhatsApp, donde queda registrada en la ficha.
- **FHIR**: entra recién cuando la persona escribe por WhatsApp (puerta 1).
- *Futuro posible*: integrar Messenger/IG por API a la misma bandeja (el modelo
  `Communication` ya lo soporta; sería otro webhook con ext `canal=instagram`).

### 4. LinkedIn — post con enlace o QR ✅ (con el enlace correcto)
Un post corporativo (Andrés, la empresa) con QR o enlace a `wa.me` o al portal.
Público más "corporate wellness" / profesionales.

- **Rol de Recepción**: igual que canales 1/6; `origen-lead = linkedin`.
- **FHIR**: puerta 1 (WhatsApp) o puertas 2/3 (portal).

### 5. QR físico — mostrador, flyers, eventos ✅ (con el QR correcto)
QR impreso que apunta a `wa.me` (conversar) o al portal (autogestión). Ideal
para eventos y para el local mismo (la persona lo escanea mientras espera).

- **Rol de Recepción**: en el local, asistir el escaneo; después, igual que el
  canal del destino. `origen-lead = qr-local` / `qr-evento`.
- **FHIR**: según destino del QR (puerta 1 o 2/3).

### 6. Sitio web / landing → Portal del paciente ✅ operativo
El botón "Reservar" lleva al portal (`app.biowellness.ar`): la persona se
registra, ve **el mismo catálogo de servicios que Recepción** (misma fuente
FHIR) y pide turno.

- **Rol de Recepción**: la solicitud cae en **Solicitudes** con badge rojo;
  Recepción elige sala/horario y confirma. El WhatsApp con seña + link +
  vencimiento sale solo, y la solicitud se marca resuelta automáticamente.
- **FHIR**: portal → `bw-solicitar-turno` → `Task solicitud-turno` (puerta 2)
  → `Appointment` tentativo (puerta 3).

### 7. Teléfono / llamada ✅ operativo (flujo manual asistido)
- **Rol de Recepción**: es el canal donde Recepción ES la interfaz: crear la
  ficha en el momento (el dedup evita duplicados), reservar en la Agenda y
  avisar que le llega el WhatsApp con el link de la seña. `origen-lead =
  telefono`.
- **FHIR**: puerta 3 directa (`bw-alta-paciente` + `bw-reservar-turno`).

### 8. Mostrador (walk-in) ✅ operativo
- **Rol de Recepción**: igual que teléfono, con la opción de cobrar la seña o
  el servicio completo en el momento (efectivo/tarjeta/transferencia/MP) con
  `Registrar cobro`. `origen-lead = walk-in`.
- **FHIR**: puerta 3 + `Invoice`/`ChargeItem` (contrato con Administración).

### 9. Email — biowellness.ar@gmail.com ⚠️ manual hoy
- **Rol de Recepción**: responder e invitar a WhatsApp o al portal (donde todo
  queda registrado). Si ya es paciente, se le puede escribir desde Mensajes
  (queda en su ficha) en lugar de contestar por Gmail.
- **FHIR**: el sistema **envía** emails (SES) pero no ingesta los entrantes.
- *Futuro posible*: ingesta de email entrante a la bandeja (mismo modelo que
  WhatsApp, ext `canal=email`).

### 10. Google (Maps / Búsqueda / ficha de negocio) ✅ (con botones correctos)
La ficha de Google ofrece llamar / sitio web / WhatsApp: cada botón desemboca
en los canales 7, 6 o 1.

- **Rol de Recepción**: ninguno extra — atender el canal por donde entró.

### 11. Referidos (socio trae socio) ✅ (con el enlace correcto)
Un socio comparte el link `wa.me` o el QR. 

- **Rol de Recepción**: al crear la ficha, `origen-lead = referido` (y anotar
  quién refirió en la ficha) — insumo directo para el programa de referidos.
- **FHIR**: puerta 1 o 2/3 según el enlace compartido.

### 12. Derivación médica (prescriptores) ✅ parcial
La Dra. Dos Santos / Dr. Dalessandro indican IV/TB u otros servicios.

- **Rol de Recepción**: agendar la consulta o la sesión indicada; el sistema ya
  exige prescripción activa para IV/TB (R-03) y contraindicaciones (R-02).
  `origen-lead = derivacion`.
- **FHIR**: puerta 3; la prescripción se modela con `ServiceRequest` (slice
  futuro; hoy es un flag explícito al reservar).

### 13. Empresas / alianzas (corporate wellness) 🕐 sin definir
Paquetes para equipos (p. ej. vía LinkedIn). Requiere definición comercial
(¿quién paga? ¿cupos?) antes de modelarlo (`Account`/`Group` lo soportan).

- **Rol de Recepción**: por ahora, derivar el contacto a Andrés.

## Resumen para el equipo de Recepción

1. **¿Te escribieron?** → Mensajes (todo WhatsApp entra solo; desconocidos
   avisan con alerta).
2. **¿Pidieron turno por el portal?** → Solicitudes (badge rojo; confirmar y
   listo, el resto sale solo).
3. **¿Lo tenés enfrente o al teléfono?** → Ficha (con dedup) + reserva; la seña
   se persigue sola (link, recordatorio, vencimiento).
4. **Siempre**: cargar `origen-lead` al crear la ficha — es lo único que pide
   el CRM para saber qué canal funciona.

## Decisiones tomadas (2026-07)

1. **Destino canónico del enlace público: WhatsApp para todo; el portal para
   autogestión.** Toda pieza pública (bio de IG, posts, QRs, ficha de Google)
   apunta al `wa.me` del +54 9 11 7250-9550; el portal queda como segundo
   botón para quien prefiere autogestionarse.
2. **Instagram DM: se deriva a WhatsApp** (respuesta corta en el DM + link
   `wa.me`). La integración del DM a la bandeja queda como mejora futura.
3. **`origen-lead` es lista CERRADA**: `instagram · linkedin · google ·
   qr-local · qr-evento · web · telefono · walk-in · referido · derivacion ·
   otro` (`ORIGENES_LEAD` en `src/fhir/identifiers.ts`). El alta lo pide con
   el select "¿Cómo nos conoció?" y la atribución es al PRIMER canal (no se
   pisa en updates).
4. **QRs con medición: `npm run qr:canales`** genera en `qrs/` un PNG por
   canal. Cada QR/link abre WhatsApp con un texto prefijado que trae la marca
   del canal ("…vengo de Instagram"), así el primer mensaje ya dice de dónde
   vino; el QR del portal mide con UTM. Los links exactos los imprime el
   script.

En preparación (marketing): videos explicativos de los servicios para la web
e Instagram — se integran a este esquema como respuestas rápidas de la bandeja
(link al video correspondiente) y QRs por cabina en el local.

## Contrato CRM con Administración (AdminDashboard / kpis-crm)

Mismo espíritu que el contrato de pagos: **códigos estables que Administración
lee tal cual** (no se renombran; ampliar la lista es compatible, renombrar no).

**Dónde vive el dato**: `Patient.extension` con
`url = https://biowellness.ar/fhir/StructureDefinition/origen-lead` y
`valueString` ∈ lista cerrada `ORIGENES_LEAD`
(`instagram · linkedin · google · qr-local · qr-evento · web · telefono ·
walk-in · referido · derivacion · otro`). Semántica: **atribución al primer
canal** (Recepción no lo pisa en updates); ausencia de la extensión =
"sin datos" (ficha anterior a la regla o alta incompleta).

**Cómo consultar por canal** (el seed crea el SearchParameter
`origen-lead` sobre Patient):

```
GET [base]/Patient?origen-lead=instagram&_summary=count
```

> ⚠️ Una vez, tras el primer seed: reindexar `Patient` (Super Admin →
> Rebuild/Reindex) para que el parámetro alcance a las fichas existentes.
> Las creadas después se indexan solas.

**Fecha de alta (cohortes mensuales)**: `Patient.extension` con
`url = https://biowellness.ar/fhir/StructureDefinition/fecha-alta` y
`valueDate` (YYYY-MM-DD), estampada automáticamente al crear la ficha.
Las fichas anteriores quedan **sin fecha y sin canal** (decisión 2026-07: no
se retro-etiqueta). Referencia: lanzamiento del local **10/08/2026** — la
primera cohorte mensual completa es agosto 2026.

**Conversión para el dashboard** (misma agregación que
`npm run crm:canales`, que sirve de verificación cruzada):
- *Con turno*: pacientes con algún `Appointment` en
  `booked/arrived/checked-in/fulfilled` (por `participant`).
- *Con pago*: pacientes con algún `Invoice` `balanced` (por `subject`).
- *Socio*: pacientes con `Coverage` `active` cuyo `tipo-cobertura` es
  `membresia` (por `beneficiary`; la extensión ausente cuenta como membresía).
- Excluir fichas `active=false` o con `link` (duplicados ya fusionados).

Handoff completo para implementar el panel en el AdminDashboard:
[`docs/handoff-crm-canales.md`](handoff-crm-canales.md).
