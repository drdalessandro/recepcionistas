# Reglas de negocio (motor de reglas)

Reglas R-xx del Documento de Requerimientos v4 (§7). Cada una indica dónde está
implementada y su caso de aceptación (AC) cuando aplica. Fuente de precios: Manual v9.

## Agenda / turnos

| Regla | Descripción | Implementación | AC |
|---|---|---|---|
| **R-01** | HBOT siempre primero en la secuencia. En combos es obligatorio; previo a IV/TB es recomendado (no obligatorio, según Manual). | `validarOrdenHBOT`, `recomendarHbotPrevio` | AC-02 |
| **R-02** | Contraindicación absoluta activa no se confirma sin autorización médica; relativa advierte. La recepción solo ve el banner verde/rojo. | `validarContraindicaciones`, `bannerSeguridad` | — |
| **R-03** | IV Therapy y Terapias Biológicas requieren prescripción activa (Dalessandro / Dos Santos). | `validarPrescripcion` | — |
| **R-07** | Recursos que comparten equipo no se superponen. Los gabinetes Recovery Pro comparten 2 tumbonas Red Light → **desfasaje ≥ 30 min** (no basta con no solaparse). Capacidad por PERSONAS (`ocupantes`): Multiplaza suma hasta 6 con **mínimo operativo 3 (advertencia, no bloqueo)**; Biplaza y gabinetes Recovery son de **reserva exclusiva** (una reserva toma el recurso completo, 1 o 2 personas juntas). | `validarDesfasajeRecovery`, `validarCapacidadRecurso`, `validarMinimoGrupal` | AC-05 |
| **R-10** | Bloquear reserva al agotar el saldo mensual de la membresía (no acumulable). | `validarSaldoMembresia` | AC-09 |
| **R-13** | Ventana de reserva: 48 h público · 72 h Standard · 96 h Intensivo · 7 días FM. | `validarVentanaReserva` | — |
| **R-14** | Cancelación: < 24 h = sesión consumida (salvo fuerza mayor médica); ≥ 24 h devuelve saldo. | `evaluarCancelacion` | — |
| **R-19** | Seña autoservicio: la tentativa nace con link de pago automático (monto + vencimiento en el WhatsApp). La seña vence a las **2 h** de reservar (nunca después del inicio del turno); 60 min antes de vencer, si no pagó, sale un último recordatorio con el mismo link; al vencer, el lugar **se libera solo** (turnos cancelados, salas libres, aviso al paciente). Un pago que llega tarde NO confirma: alerta a Recepción para devolver o reagendar. | `vencimientoSena`, `estadoSenaPendiente`; bots `bw-reservar-turno`/`bw-reservar-combo` (link + vencimiento), `bw-vencer-tentativas` (cron), `confirmarReserva` (guard de pago tardío) | — |

## Pricing / cobros

| Regla | Descripción | Implementación | AC |
|---|---|---|---|
| **R-04..R-06** | Cálculo del monto según tipo de cliente y reglas de recurso (HBOT por ocupación, Recovery Pro indivisible, etc.). | `precioSueltoUSD`, `calcularCobro` | AC-06 |
| **R-08** | Splits: HBOT/IHHT/Recovery/Red Light/Compresión/Cryo = 100% BW; IV+TB = 85% BW / 15% médicos (cascada con costo fiscal 25% − insumo − USD 15 enfermería, piso 25% margen); Masajes/Osteopatía = 50/50. | `calcularSplit`, `cascadaTB` | AC-08 |
| **R-15** | Combos: 20% off lista. | `src/config/combos.ts` | — |
| **R-16** | Paquetes 5/10/20 → 5/10/15% off; vigencias 15/30/60 días; FM +20% adicional. | `src/config/paquetes.ts` | — |
| **R-17** | Precios de lista en USD; cobro en ARS al TC vigente (default 1.450, configurable por admin). | `usdAArs`, `resolverTC` | AC-13 |

## Membresías / Founding Members

| Regla | Descripción | Implementación |
|---|---|---|
| **R-09** | Founding Members — programa FM-100 en dos cohortes (Andrés, 2026-08-09): números 1–50 el 1 a 1 personal, 51–100 la Web (founding.html). 20% off lifetime en sueltas y paquetes (no combos/membresías/TB), precio bloqueado en USD, ventana 7 días. El cupo AVISA (alerta desde el 40, aviso de cohorte al 51, programa completo al 101) y nunca bloquea. La marca se pone en la ficha (extensión `tag-fm` + identifier `SYSTEM.fm` con el número). | `src/config/reglas.ts` (`FM`), `src/lib/fm.ts`, `src/fhir/founding.ts`, `precioSueltoUSD` (flag `fm`) |
| **R-11** | Cobro adelantado de membresías días 1-5 (MercadoPago); si falla, alerta + bloqueo de reservas. | `src/config/reglas.ts` (`MEMBRESIA`); bot de cobro recurrente (próximo) |
| **R-12** | Compromiso mínimo 3 meses; renovación automática; baja avisando 15 días antes; 1 pausa de 30 días/año. | `src/config/reglas.ts` (`MEMBRESIA`) |

## Reglas fuera del alcance del Bloque 0 (referencia)

- **R-18** — Facturación AFIP (WSFE): para IV+TB se factura el 50%; alícuotas a
  confirmar con contador. (Slice posterior.)
