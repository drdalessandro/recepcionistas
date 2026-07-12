# Decisiones pendientes

Definiciones que dependen de Andrés u otras fuentes. Las **bloqueantes** frenan
una parte del avance; el resto se resuelve en paralelo.

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
| Prioridad de reserva Pareja | v9: "Miembros PAREJA tienen prioridad de reserva en Membresías Prime y Healthspan". Es cualitativo (sin ventana ni número). ¿Cómo se operativiza? (¿más días de anticipación? ¿prioridad en lista de espera?) | ⚠️ Preguntar a Andrés |
| FM en masajes/osteopatía | ¿El 20% FM aplica a masajes/osteopatía sueltos? Hoy `fmAplica = false` para ellos. | A confirmar |
| Insumos Regenerar (cascada TB) | La cascada de IV/TB (R-08) necesita el costo de insumo por terapia (lista Regenerar) para el neto real de BW. Hoy se pasa como parámetro. | A confirmar |

## Clínico

| Tema | Detalle | Estado |
|---|---|---|
| Tabla de contraindicaciones | Ni v8 ni v9 la incluyen. Se cargó un **borrador estándar HBOT/IHHT** (`src/config/contraindicaciones.ts`, todas `borradorPendienteRevision`). | ⚠️ Validar con Director Médico |
| Rol/alcance Dr. López Alonso | Pendiente de reunión. No frena la recepción. | A confirmar |
| Precio consulta Dr. Conrado (Director) | **PROVISORIO: ARS 150.000** en `src/config/medicos.ts` (`precioProvisorio`). Dalessandro y Dos Santos = ARS 120.000 (confirmados). | ⚠️ Confirmar monto |
| Split / honorario de consultas | Hoy la consulta se cobra entera (split `BW_100`). Falta definir cómo se reparte el honorario del médico. | A definir |

## Gestión de sesiones — CERRADO ✅

El bloque está implementado, testeado y deployado: dashboard "Planes y sesiones"
(saldo en riesgo), pre-agenda de membresías (serie 2x/3x) y recordatorios de turno
(24h/1h) + saldo en riesgo por WhatsApp y email (`bw-recordatorios`, cron horario).
Ver [`docs/app-recepcion.md`](app-recepcion.md) y [`docs/bots.md`](bots.md).

> **Para que los avisos se envíen** (hoy quedan registrados como `Communication` en
> estado `preparation` hasta que estén las cuentas) falta lo de abajo + configurar
> el `cronTimer` del Bot `bw-recordatorios` (`0 * * * *`).

## Integraciones / cuentas (en paralelo)

| Cuenta | Para qué | Estado |
|---|---|---|
| WhatsApp Business (Twilio) | Confirmaciones y recordatorios. **Código listo y deployado**; falta cargar los Project Secrets (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`) y aprobar la plantilla de mensaje. | A gestionar (cuenta) |
| AWS SES | Email transaccional (vía `medplum.sendEmail()`). **Código listo**; falta remitente verificado en SES. | A gestionar (cuenta) |
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
