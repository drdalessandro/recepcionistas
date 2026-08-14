# Decisiones pendientes

Definiciones que dependen de Andrés u otras fuentes. Las **bloqueantes** frenan
una parte del avance; el resto se resuelve en paralelo.

## Walk-in · referidos y derivaciones — POSTERGADO hasta septiembre (2026-08-14)

Decisión de Andrés: **no se construyen hasta la segunda quincena de septiembre**.

Motivo: con las campañas online y las redes personales se espera **lista de
espera**. Con demanda por encima de la capacidad, un programa de referidos y un
circuito de derivadores **agregan operación sin resolver el cuello** — y el
cuello no es conseguir gente, es atenderla.

Qué queda pendiente para esa fecha:

| Caso | Qué falta | Por qué está bloqueado |
|---|---|---|
| **Referido** ("me mandó Fulano") | Definir **qué gana el que refiere**. La atribución ya existe (`origen-lead=referido`); sin el incentivo definido solo se puede construir la mitad. | Decisión de negocio |
| **Derivado** (médico, gimnasio, empresa) | Circuito de convenios: quién deriva, si saltea la consulta, si hay condiciones comerciales. | Decisión de negocio |

> Revisar en la **segunda quincena de septiembre 2026**. Si para entonces NO hay
> lista de espera, la prioridad de estos dos sube: pasan de "más trabajo" a
> "canal de adquisición barato".

## Lista de espera — 2 preguntas abiertas (2026-08-14)

Se implementó la lista de espera (anotar a quien no consiguió lugar y avisar
cuando se libera uno). Dos decisiones quedaron tomadas de la forma conservadora,
a la espera de Andrés — **ninguna frena nada**:

| Tema | Cómo está hoy | La pregunta |
|---|---|---|
| **¿Se le avisa solo al paciente?** | NO: el bot deja el aviso a Recepción con los candidatos y el texto listo, y el WhatsApp lo manda una persona de un clic. | Avisar automáticamente al primero es más rápido y cumple mejor la promesa del portal, pero el lugar **no queda reservado**: dos personas pueden decir que sí al mismo turno. Con una reserva provisoria (tipo R-19, con vencimiento) sí se podría automatizar. |
| **¿En qué orden?** | Orden de llegada (FIFO), tomando los 3 primeros. | Si Pareja/Prime tiene prioridad (ver Catálogo v9), la regla tiene que estar escrita: hoy no se inventa acá. |

## Agenda — RESUELTO ✅ (2026-06-20)

| # | Decisión | Definición confirmada por Andrés |
|---|---|---|
| 1 | **Horario de atención** | Lunes a Viernes 08:00–22:00 · Sábados 08:00–20:00 · Domingo cerrado · franja de 30 min (`src/config/horario.ts`). |
| 2 | **Lista definitiva de salas y equipos** | Los 13 recursos del Requerimientos §6.2, confirmados sin cambios (`src/config/recursos.ts`). 2026-07: se sumó el **Puesto IV 2** (handoff v9 de Administración) ⇒ 14 recursos. |

> Para cargar la agenda real en Medplum: `npm run seed -- --with-slots --dias=14`
> (genera ~4.592 franjas: 14 salas × 2 semanas).

## Catálogo (v9)

**2026-07-12 — Manual v9 final aplicado al catálogo** (fuente de verdad):
IHHT vuelve a ser **sesión única 45 min / USD 90** (Express/Premium descartados);
combos con IHHT recalculados (BIO ENERGY 140/112 · BIO OXYGEN 255/200 **OFF 21%**
· Pareja 380/300 · BIO LONGEVITY 455/364 · Pareja 580/464); membresías FOCUS
(718/1008) y HEALTHSPAN (2184/3058/2784/3898) arrastran los combos nuevos, PRIME
sin cambios; paquetes con nombre comercial **Starter/Core/Pro** (paquete IHHT
base 90: 428/810/1530); Terapias Biológicas ya estaban al día (18 terapias,
Esferoides dado de baja).

| Tema | Detalle | Estado |
|---|---|---|
| IHHT en pareja (combos Pareja) | Físicamente usa los 2 puestos JAY-20H, pero la reserva de combo Pareja hoy ocupa 1 puesto (una reserva con `ocupantes: 2`); el otro puesto queda reservable. Pendiente: asignación multi-puesto en `planificarCombo`. | Mejora pendiente |
| Prioridad de reserva Pareja | v9: "Miembros PAREJA tienen prioridad de reserva en Membresías Prime y Healthspan". Es cualitativo (sin ventana ni número). ¿Cómo se operativiza? (¿más días de anticipación? ¿prioridad en lista de espera?) **La lista de espera ya existe (2026-08-14) y ordena por LLEGADA**: el que pidió primero, primero. Es la única regla que no se discute en el mostrador; si Pareja tiene que saltearla, hace falta la regla escrita. | ⚠️ Preguntar a Andrés |
| FM en masajes/osteopatía | ¿El 20% FM aplica a masajes/osteopatía sueltos? Hoy `fmAplica = false` para ellos. | A confirmar |
| Insumos Regenerar (cascada TB) | La cascada de IV/TB (R-08) necesita el costo de insumo por terapia (lista Regenerar) para el neto real de BW. Hoy se pasa como parámetro. | A confirmar |
| Parámetros de caja chica | Diseño aprobado (opción 2, 2026-08-09) e implementado (vista **Caja**). **Confirmados por Andrés vía Administración el 2026-08-10, sin cambios**: fondo fijo **$200.000**, tope por gasto sin autorización **$25.000**, arqueo **diario al cierre**, reposición la registra recepción (auditada por `meta.author`). El tablero de Admin ya lee la caja y la alerta de diferencia está activa en pantalla (la `Subscription` en tiempo real queda para cuando definan endpoint). Valores en `src/config/caja.ts`. | ✅ Resuelto (2026-08-10) |

## Clínico

| Tema | Detalle | Estado |
|---|---|---|
| Tabla de contraindicaciones | Ni v8 ni v9 la incluían; se cargó un borrador estándar HBOT/IHHT (`src/config/contraindicaciones.ts`). **Validada tal cual por el Dr. Conrado López Alonso (Director Médico) el 2026-08-09**; CodeSystem `active`. Una entrada nueva sin validar lo vuelve a `draft`. Cubre HBOT e IHHT: si el DM quiere codificar contraindicaciones de otras terapias (Crio, IV/TB), entran como borrador. | ✅ Resuelto (2026-08-09) |
| Rol/alcance Dr. López Alonso | Pendiente de reunión. No frena la recepción. | A confirmar |
| Péptidos nombrados (TB) | Marketing publica péptidos por nombre (Retatrutide, AOD-9604, SLU-PP-332, MOTS-c, Tesamorelina, …: `info.biowellness.ar/terapias-biologicas.html`). El catálogo los vende por GRUPO (`PEPTIDOS_G1` 36 / `G2` 13 / `G3` 5, precios del Manual v9). Si recepción debe verlos por nombre, falta el mapeo nombre→grupo (lista Regenerar / anexo del Manual). Mientras tanto se venden por grupo, con prescripción + consentimiento (R-03). | ⚠️ Pedir mapeo a Andrés |
| Precio consulta Dr. Conrado (Director) | **PROVISORIO: ARS 150.000** en `src/config/medicos.ts` (`precioProvisorio`). Dalessandro y Dos Santos = ARS 120.000 (confirmados). | ⚠️ Confirmar monto |
| Consentimiento: contrato con el portal | **ACORDADO con Alejandro (MedTech) 2026-08-14**: el recurso legal es `Consent` (FHIR R4) para los dos flujos, con el `DocumentReference` como evidencia firmada, enlazados por `sourceReference`. El código de BW va en **`policyRule`** (NO en `category`, que usa systems estándar). Ya funciona el flujo de laboratorio (`procesamiento-datos-salud`). **Falta que el portal cree el `Consent` del consentimiento general** en `firmarConsentimiento()` (~15 líneas, snippet en [`handoff-portal-consentimiento.md`](handoff-portal-consentimiento.md) §3); mientras tanto el bot reconoce el `DocumentReference` LOINC 59284-0, así que las firmas existentes ya cuentan. | ⚠️ Falta el cambio del portal |
| Consentimiento: alcance | **Respondido (2026-08-14)**: existen DOS consentimientos y ambos son `Consent` — el **general de atención** (onboarding paso a paso, `atencion`) y el de **procesamiento de datos de salud** al subir un PDF de laboratorio (`procesamiento-datos-salud`, Ley 25.326). El badge de la ficha pregunta por el general. Queda por definir si además existe uno específico de **Terapias Biológicas** para R-03, o si el general lo cubre. | ⚠️ Falta definir el de TB |
| Consentimiento: ¿vence? | `estadoConsentimiento` acepta `vigenciaMeses` pero hoy se usa SIN vencimiento (una firma vale para siempre). Definir si vence y si es uno por terapia o uno por categoría. | A definir |
| Split / honorario de consultas | Hoy la consulta se cobra entera (split `BW_100`). Falta definir cómo se reparte el honorario del médico. | A definir |
| Superposición de agenda: Dos Santos ↔ Conrado | Ambos publicaban **miércoles 17-20** con **un solo consultorio**: el portal ofrecía las dos y R-07 dejaba reservar una sola. **Resuelto por Andrés (2026-08-13): el Dr. Conrado pasó a viernes 17-20** y el miércoles quedó para la Dra. Dos Santos. `solapamientosDeAgendas()` lo verifica en cada test y el seed / `agenda:check` avisan si aparece un cruce nuevo. | ✅ Resuelto (2026-08-13) |

## Gestión de sesiones — CERRADO ✅

El bloque está implementado, testeado y deployado: dashboard "Planes y sesiones"
(saldo en riesgo), pre-agenda de membresías (serie 2x/3x) y recordatorios de turno
(24h/1h) + saldo en riesgo por WhatsApp y email (`bw-recordatorios`, cron horario).
Ver [`docs/app-recepcion.md`](app-recepcion.md) y [`docs/bots.md`](bots.md).

> **Para que los avisos se envíen** (hoy quedan registrados como `Communication` en
> estado `preparation` hasta que estén las cuentas) falta lo de abajo + configurar
> el `cronString` del Bot `bw-recordatorios` (valor y procedimiento en
> [`puesta-en-produccion.md`](puesta-en-produccion.md)).

## Integraciones / cuentas (en paralelo)

| Cuenta | Para qué | Estado |
|---|---|---|
| WhatsApp Business (Twilio) | ✅ **OPERATIVO** (2026-07-17): Project Secrets cargados, `whatsapp:test` recibido OK. Pendiente para producción: número WhatsApp aprobado (si hoy es sandbox, solo reciben los celulares que hicieron `join`) y plantillas aprobadas por Meta para mensajes iniciados por BW fuera de la ventana de 24 h. | Plantillas/número prod |
| AWS SES | ✅ **OPERATIVO**: remitente `hola@medplum.com.ar` verificado (DKIM), emails llegan a bandeja principal. | Hecho |
| MercadoPago | Cobro de membresías/sesiones (tokeniza tarjetas; no guardamos datos de tarjeta). | A gestionar |

## Infra

| Tema | Detalle | Estado |
|---|---|---|
| Medplum Cloud → self-hosted | Arrancamos en Cloud; migrar a self-hosted (Docker, datos en Argentina) cuando esté estable. Diseñado para no acoplarse a features propietarias. | Decidido (Cloud para arrancar) |


## Pagos (Manual v9 / contrato Administración)

- **Descuento a la carte de miembros (Std 10% / Int 15%) vs FM 20%**: implementado
  PROVISORIO como "se aplica el MAYOR, no acumulan" (`src/lib/pricing.ts`).
  ⚠️ Confirmar con Andrés si acumulan o se aplica el mayor.
- **Handoff Manual v9**: ✅ APLICADO (2026-07-12) contra el PDF del Manual v9:
  catálogo TB al día, IHHT única 45/90, combos y membresías recalculados,
  paquetes Starter/Core/Pro con nombre comercial, Puesto IV 2 en agenda.
  Queda la prioridad de reserva Pareja (ver Catálogo v9: preguntar a Andrés).
  **Después de deployar: correr `npm run seed` para actualizar el catálogo en
  Medplum** (los códigos `IHHT_EXPRESS`/`IHHT_PREMIUM` viejos quedan huérfanos;
  el seed crea `IHHT` y los paquetes `PAQ_IHHT_X*`).
- **Tokenización MP para cobro recurrente**: el cron cobra con tarjeta guardada si
  el Coverage tiene `mp-customer-id`/`mp-card-id`. Falta el flujo de captura de la
  tarjeta (checkout de suscripción / Customers API) para poblar esas extensiones.
