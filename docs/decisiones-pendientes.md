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

## Teleconsulta — APROBADA PARA AVANZAR (Andrés, 2026-09-16) · Fase 0 en curso

Piloto de **Cardiología, Nutrición y Endocrinología** por videollamada (Jitsi
Meet en una EC2 propia). Visión, modelo FHIR, bots y circuito en
[`teleconsulta.md`](teleconsulta.md); la Fase 0 (infraestructura, sin código)
tiene su runbook en [`teleconsulta-fase0.md`](teleconsulta-fase0.md) e instala
Jitsi con **paquetes Debian**, no Docker (comparación en su §1). De las nueve
decisiones de `teleconsulta.md` §10, la Fase 0 solo asume el **dominio**
(`meet.biowellness.ar`). Las otras ocho **siguen abiertas** y se cierran una
por una antes de la Fase 1: cobro 100 % anticipado, honorarios y precio de los
especialistas, aptitud en modalidad virtual (R-20 sin el cuestionario de
ingreso), no-show, acceso solo con portal, Recepción fuera de la sala y grilla
de 30 min.

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
| Tabla de contraindicaciones | **CERRADA el 2026-09-09.** Firma conjunta del **Dr. Alejandro Sergio D'Alessandro (MN 92179)** y el **Dr. Conrado López Alonso**. Concilia en una sola revisión las dos fuentes que estaban en conflicto —la tabla de Conrado del 9-ago y el documento de admisión del 25-ago—. El criterio es UHMS: la única absoluta de HBOT es el neumotórax no tratado; doxorrubicina, bleomicina, implante no certificado y cirugía ONT reciente quedan absolutas *con posibilidad de consulta médica*; el embarazo se parte por terapia (relativa en HBOT, **absoluta en IHHT**, sin evidencia de seguridad). El CodeSystem sale `active` y el seed dejó de avisar. **Sigue abierto lo otro**: 17 de 33 entradas no tienen pregunta en el screening y por eso nunca se activan (`src/config/cuestionario-ingreso.ts`). | ✅ Firmada |
| Rol/alcance Dr. López Alonso | Pendiente de reunión. No frena la recepción. | A confirmar |
| Screening: preguntas sin código | **Cerrado el 2026-09-01** por el documento de admisión: las tres que faltaban (`hbot-marcapasos`, `ihht-tvp`, `ihht-epoc`) y la candidata `cirugia-reciente-ont` ya tienen código y bloquean. Hoy **ninguna pregunta de riesgo queda sin mapear** (hay test que lo fija). Los códigos entraron como borrador: la validación viaja con la fila de arriba. | ✅ Resuelto (2026-09-01) |
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

> **2026-09-01 — la pre-agenda mensual fue reemplazada por la agenda semanal
> (R-21):** las sesiones de la membresía se gestionan por semana calendario
> (preferencia de días + hora en el `Coverage`, asignación automática con
> `bw-agenda-semanal` apenas se abre la ventana R-13 de cada socio, tope duro =
> frecuencia del plan sin recupero). Decidido con Andrés: reasignación
> automática, tope duro, alternativa cercana del mismo día si la hora está
> ocupada, y mostrador libre (el tope rige solo portal/cron). Ver
> [`reglas-negocio.md`](reglas-negocio.md) R-21 y [`bots.md`](bots.md).

> **Para que los avisos se envíen** (hoy quedan registrados como `Communication` en
> estado `preparation` hasta que estén las cuentas) falta lo de abajo + configurar
> el `cronString` del Bot `bw-recordatorios` (valor y procedimiento en
> [`puesta-en-produccion.md`](puesta-en-produccion.md)).

## Integraciones / cuentas (en paralelo)

| Cuenta | Para qué | Estado |
|---|---|---|
| WhatsApp Business (Twilio) | ✅ **OPERATIVO**. 2026-07-17: Project Secrets cargados, `whatsapp:test` OK. **2026-08-14: las 10 plantillas están `approved` por Meta** (`npm run whatsapp:plantilla`) y se verificó un envío real entregado (`DELIVERED`) que salió **por la plantilla específica**, no por la genérica — o sea que los mensajes iniciados por BW fuera de la ventana de 24 h ya funcionan. Detalle y mapeo en [`whatsapp-plantillas.md`](whatsapp-plantillas.md). | ✅ Resuelto (2026-08-14) |
| AWS SES | ✅ **OPERATIVO**: remitente `hola@medplum.com.ar` verificado (DKIM), emails llegan a bandeja principal. | Hecho |
| MercadoPago | Cobro de membresías/sesiones (tokeniza tarjetas; no guardamos datos de tarjeta). 2026-08-20: hay credenciales de prueba **y productivas**; el circuito (links, webhook con firma, cron) quedó endurecido para plata real. El pasaje de credenciales es operativo: checklist en [`puesta-en-produccion.md` §7](puesta-en-produccion.md). Decisión de UX pendiente: `back_urls` hoy vuelve a la app de recepción — ¿debería volver al portal del paciente? **2026-08-22: se abrió la evaluación de Clover (Fiserv) como alternativa o complemento** — análisis, matriz y camino rápido en [`pasarelas-de-pago.md`](pasarelas-de-pago.md). No frena nada: los 4 primeros pasos cuestan 4 h y cero pesos. | Credenciales listas · cutover pendiente (§7) · evaluación de pasarela abierta |

## Infra

| Tema | Detalle | Estado |
|---|---|---|
| Medplum Cloud → self-hosted | Arrancamos en Cloud; migrar a self-hosted (Docker, datos en Argentina) cuando esté estable. Diseñado para no acoplarse a features propietarias. | Decidido (Cloud para arrancar) |


## Plan Bienestar 100 Días (PB100D)

| Tema | Detalle | Estado |
|---|---|---|
| **Cadencia del cobro mensual** | El handoff dice dos cosas incompatibles: "suscripción de Mercado Pago **cada 30 días**" y "lo cobra **`bw-cobro-membresias`**", que corre los días 1-5 del **mes calendario**. No es lo mismo para quien se da de alta el 20. Hoy el alta cobra el PRIMER mes y la **renovación no existe**: el cron filtra por `tipo === 'membresia'` y saltea los programas (hay test que lo fija como deliberado). Decidir: (a) mes calendario, igual que las membresías —consistente y ya construido—, o (b) cada 30 días desde el alta, que además implica la **suscripción (preapproval) de MP**, una integración que no tenemos (ver `docs/mercadopago.md`: el débito automático sigue sin captura de tarjeta). | ⚠️ Andrés |
| Cancelación del programa | El handoff dice "la paciente pide desde el portal (`Task`) y Recepción cierra". Falta definir qué pasa con el Coverage (`cancelled` al toque o al fin del período pago) y si se devuelve algo del pago único de 100 días. | ⚠️ Definir |
| Tareas del equipo (§3) | Los bots del dashboard crean `Task` con `code` del CodeSystem `tarea` (`pb100d-silencio`, `pb100d-adherencia`, …). La vista **Avisos de Recepción lista solo `code=aviso-recepcion`**, así que hoy no los vería. Dos de los seis códigos enrutan a Recepción (`pb100d-silencio` → llamar; `pb100d-adherencia` → llamar). Definir si esas dos llegan a Avisos de Recepción o quedan solo en la bandeja del dashboard. | ⚠️ Definir |
| Copy de los programas | La bajada de cada ítem (`PlanDefinition.description`, en `src/config/programas.ts`) es la referencia del brief §6.10 y está **pendiente de validación del Director Médico**, igual que el resto del copy clínico. | ⚠️ Dr. D'Alessandro |

## Pagos (Manual v9 / contrato Administración)

- **Multiplaza: ¿piso de facturación de 3 personas, o USD 80 desde uno?**
  ⚠️ **Andrés** — comercial. `src/lib/pricing.ts` cobra
  `precioUSD * max(ocupantes, 3)`, así que una persona sola paga USD 240;
  `src/motor-agenda/comercial/precios.ts` documenta "USD 80 por persona desde
  uno, sin piso de sesión". **Ya salió con plata real** (2026-09-11: seña de
  $174.000 por una reserva de UNA persona) y el portal, en esa misma pantalla,
  muestra "Valor de referencia: USD 80" — la paciente ve 80 y le cobran sobre
  240. Ojo con el matiz: el mínimo de 3 de la agenda es **operativo**
  (`validarMinimoGrupal` advierte, no bloquea), no un piso de cobro; hoy el
  código trata lo mismo de dos maneras. Si gana el piso, el portal tiene que
  decirlo ANTES de reservar. Ver [`mercadopago.md`](mercadopago.md) y
  [`motor-agenda-fhir.md`](motor-agenda-fhir.md) §713.
- **Descuento a la carte de miembros (Std 10% / Int 15%) vs FM 20%**: implementado
  PROVISORIO como "se aplica el MAYOR, no acumulan" (`src/lib/pricing.ts`).
  ⚠️ Confirmar con Andrés si acumulan o se aplica el mayor.
- **Handoff Manual v9**: ✅ APLICADO (2026-07-12) contra el PDF del Manual v9:
  catálogo TB al día, IHHT única 45/90, combos y membresías recalculados,
  paquetes Starter/Core/Pro con nombre comercial, Puesto IV 2 en agenda.
  Queda la prioridad de reserva Pareja (ver Catálogo v9: preguntar a Andrés).
  **Después de deployar: correr `npm run seed` para actualizar el catálogo en
  Medplum** (el seed crea `IHHT` y los paquetes `PAQ_IHHT_X*`).
  - Los códigos `IHHT_EXPRESS`/`IHHT_PREMIUM` viejos quedaban **huérfanos**:
    ✅ RESUELTO (2026-09-11). Sacarlos del archivo no alcanzaba —el seed hace
    upsert y no borra—, así que siguieron `active` en Medplum **dos meses**: el
    portal los ofrecía y al elegirlos devolvía "Servicio desconocido". Ahora
    están en `SERVICIOS_RETIRADOS` y el seed los publica con `status:
    'retired'`. **Requiere `npm run seed`** para que el servidor se entere, y
    que el portal filtre por status (handoff-portal-catalogo-familias.md).
- **PB100D · cobro del programa premium** (handoff 2026-09-06, aplicado el seed y
  la policy el 2026-09-08): el catálogo ya publica `PB100D_PREMIUM_MENSUAL` (USD
  100/mes) y `PB100D_PREMIUM_100D` (USD 300 por única vez), pero **el cobro no
  está implementado en ninguna de las dos modalidades**:
  - *Mensual*: el handoff pide "suscripción de Mercado Pago cada 30 días,
    cancelable". `bw-cobro-membresias` cobra **por ciclo de mes calendario los
    días 1-5** y filtra `tipo === 'membresia'` — un programa no entra, y su
    período es de 30 días corridos desde el alta, no del 1 al 30. Hay que
    decidir si el programa se suma a ese cron (con ciclo propio) o si va por
    suscripción real de MP (que hoy no existe: ver tokenización, abajo).
  - *Pago único*: necesita `Invoice` + link, como la seña. `bw-asignar-plan` hoy
    solo sabe de membresías y paquetes.
  - No hay bot de **alta de programa**: el `Coverage` con `tipo-cobertura =
    programa` se crea a mano hasta que exista.
- **PB100D · desbloqueo del piloto**: la AccessPolicy del portal ya tiene `Goal`,
  `NutritionOrder`, `Task` escribible (acotada al CodeSystem `biowellness-plan`),
  `ValueSet` y `CodeSystem`. ⚠️ **El portal tiene que actualizar su espejo**
  (`docs/medplum/access-policy-paciente-portal.json`) y correr
  `npm run verificar:policy`, o su chequeo va a marcar diferencia contra el
  servidor. Y cuando entre la pantalla nueva (Hito 5), `CarePlan` pasa a
  `readonly: true` en esta policy.
- **PB100D · lo que NO es de este repo**: `bw-web-push` (título del tipo
  `plan-listo`) **no existe acá** — vive en el repo del portal/dashboard, igual
  que el CodeSystem `biowellness-plan` y los bots que crean las tareas de la
  bandeja. Este repo solo referencia el system para acotar el permiso.
- **Tokenización MP para cobro recurrente**: el cron cobra con tarjeta guardada si
  el Coverage tiene `mp-customer-id`/`mp-card-id`. Falta el flujo de captura de la
  tarjeta (checkout de suscripción / Customers API) para poblar esas extensiones.
