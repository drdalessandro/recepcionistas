# Bloque 0 — Cimientos (versión técnica)

Versión técnica equivalente al resumen para Andrés. El Bloque 0 es la base
bloqueante: va **primero y solo** (Documento de Requerimientos v4, §8). Fuente de
verdad del catálogo y precios: **Manual de Protocolos v9** (changelog aplicado
sobre v8). Si algo difiere, **gana el Manual**.

## Qué construye el Bloque 0

1. **Servidor + Medplum + CI/CD.** Arrancamos en Medplum Cloud (managed),
   diseñado para migrar a self-hosted sin acoplarnos a features propietarias.
   CI con GitHub Actions; ramas `main` y `staging`.
2. **Perfiles FHIR y extensiones custom** (`src/fhir/extensions.ts`).
3. **Auth / roles / AccessPolicies** (`src/fhir/access-policies.ts`). Pieza
   central: la recepcionista con acceso *Operativo*, con privacidad por diseño.
4. **Seed del catálogo desde el Manual v9** (`src/seed/`): servicios
   (`ActivityDefinition`), combos/membresías/paquetes (`PlanDefinition`),
   contraindicaciones (`CodeSystem`), TC (`Basic`), recursos (`Location` +
   `Schedule`).
5. **Los primeros Bots** (`src/bots/`): calcular cobro, validar turno, enviar
   WhatsApp.
6. **Harness de tests end-to-end** (`tests/`) con los casos AC del Anexo A.

## Arquitectura del código

La **lógica de negocio vive en funciones puras** (`src/lib/`) sin dependencias de
FHIR ni de red, lo que permite testearla de punta a punta sin servidor. Los
**Bots** (`src/bots/`) son finas envolturas que conectan esa lógica con Medplum y
las integraciones (Twilio, etc.). El **seed** traduce el catálogo de dominio
(`src/config/`) a recursos FHIR.

```
config (datos Manual v9)  ─►  lib (lógica pura)  ─►  bots (FHIR + integraciones)
                          └►  seed/builders (FHIR)  ─►  Medplum
```

## Definition of Done del Bloque 0

Del brief: **"stack verde, seed cargado, tests base en verde"**, y que una
secretaria pueda, en el entorno de prueba:

- [x] ver la agenda del día con las salas y sus estados — motor de **Slots**
      (`generarSlots`) y **semáforo** verde/amarillo/rojo (`estadoRecurso`) listos;
      horario (L-V 08-22, Sáb 08-20) y las 13 salas confirmados → la agenda real
      se carga con `npm run seed -- --with-slots`;
- [x] **agendas de médicos publicadas al portal** (`agenda` en
      `src/config/medicos.ts` → Schedule + Slots libres de 60 min): D'Alessandro
      martes y jueves 16-20 + miércoles 8-12, Dos Santos miércoles 17-20,
      Conrado viernes 17-20. Al cambiar una franja, el seed **reconcilia**:
      borra los slots libres que ya no corresponden (nunca los reservados) para
      que el portal no siga ofreciendo un horario viejo. Hay un solo
      consultorio: si dos agendas se pisan, el seed y `agenda:check` lo avisan;
- [x] ver el **banner de contraindicaciones** verde/rojo sin acceder a la historia
      clínica (`bannerSeguridad`, AccessPolicy de recepción);
- [x] que el sistema **calcule el monto a cobrar** incluido USD→ARS
      (`calcularCobro`, bot `calcular-cobro`);
- [x] que la agenda respete que **dos salas que comparten equipos no se
      superpongan** (`validarDesfasajeRecovery` / `validarCapacidadRecurso`, R-07);
- [x] enviar un **WhatsApp de confirmación** que quede registrado en la ficha
      (bot `enviar-whatsapp` → `Communication`).

Lo que falta para cerrar el primer punto está bloqueado por dos definiciones de
Andrés (horario de atención y lista definitiva de salas). Ver
[`decisiones-pendientes.md`](decisiones-pendientes.md).

## Cómo verificar

```bash
npm run verify                          # typecheck + 62 tests (casos AC del Anexo A)
npm run seed -- --dry-run               # construye 131 recursos FHIR sin Medplum
npm run seed -- --dry-run --with-slots  # + cuenta los Slot de la agenda (7 días)
npm run agenda:check                    # estado real: Schedules, slots y agendas médicas
```
