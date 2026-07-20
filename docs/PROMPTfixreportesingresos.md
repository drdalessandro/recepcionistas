# Fix: Reportes suma facturas pendientes/anuladas como ingresos

> Prompt autocontenido para una sesión de Claude en el repo `biowellness/recepcionistas`.

## Bug (verificado en producción, 2026-07-20)

La pestaña **Reportes** de la app de recepción mostró "Ingresos hoy $ 14.282.500 ·
5 cobros" un día en el que NO se recibió ningún pago. La causa está en
`app/src/lib/reportes.ts`, función `cargarReportes()`: las búsquedas de Invoice
filtran solo por fecha, **sin filtrar por `status`**:

```ts
const invHoy = await safe(() =>
  medplum.searchResources('Invoice', { date: `ge${inicioHoy.toISOString()}`, _count: 1000 }),
);
```

El contrato de pagos con Administración (docs/bots.md, sección "Contrato de pagos
— INAMOVIBLE") define: `balanced` = cobrado · `issued` = pendiente · `cancelled` =
fallido/anulado. El reporte suma los tres estados, así que cada Invoice `issued`
que emiten los bots (el saldo restante que crea `bw-pagar-sena`, el alta de plan
por MercadoPago antes de acreditarse, cobros pendientes en general) infla
"Ingresos hoy" e "Ingresos del mes" con plata que todavía no entró — y una
factura anulada también sumaría.

## Fix obligatorio

En `cargarReportes()`, agregar `status: 'balanced'` a las DOS búsquedas de
Invoice (la de hoy y la del mes):

```ts
const invHoy = await safe(() =>
  medplum.searchResources('Invoice', {
    date: `ge${inicioHoy.toISOString()}`,
    status: 'balanced', // solo cobros ACREDITADOS son ingresos (contrato de pagos)
    _count: 1000,
  }),
);
// ... ídem invMes:
const invMes = await safe(() =>
  medplum.searchResources('Invoice', {
    date: `ge${inicioMes.toISOString()}`,
    status: 'balanced',
    _count: 2000,
  }),
);
```

Con esto, "Ingresos hoy", "cobros", "señas" e "Ingresos del mes" pasan a contar
solo facturas cobradas. Verificación: en un día sin pagos reales, Reportes debe
mostrar $ 0 · 0 cobros aunque haya Invoices `issued` del día (esas se siguen
viendo donde corresponde: Atender → Pagos pendientes).

## Mejora opcional (si suma valor, en el mismo PR)

Tarjeta "A cobrar" en Reportes: la MISMA búsqueda del día/mes con
`status: 'issued'`, mostrada por separado ("A cobrar hoy: $X · N facturas").
Le da a Recepción el dato accionable (perseguir cobros) sin mezclarlo con los
ingresos reales. Requiere tocar `Reportes.tsx` además de `reportes.ts`.

## Checklist

1. `app/src/lib/reportes.ts`: `status: 'balanced'` en `invHoy` e `invMes`.
2. (Opcional) tarjeta "A cobrar" con `status: 'issued'`.
3. Si hay tests del módulo, agregar el caso: Invoice `issued`/`cancelled` del día
   NO suma en `ingresosARS` ni en `cobros`.
4. Build + deploy del front (`npm run build:app`; nginx sirve el dist nuevo al
   instante).
5. Verificar en producción: Reportes de hoy debe quedar en $ 0 hasta que se
   acredite un pago real.
