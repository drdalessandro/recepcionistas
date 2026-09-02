# Agente de Solicitudes — Nivel 4, primera rebanada

> **Estado:** implementado 2026-09-02 (bot `bw-proponer-reserva` + botón
> **Proponer** en Solicitudes), por decisión del PO y en paralelo a la métrica
> del Nivel 3. Registro de la decisión y del alcance; lo que queda afuera está
> al final.

## En una frase

**El agente propone, Recepción confirma, los bots ejecutan.** No es un agente
que "maneja la agenda": es una interfaz en lenguaje natural sobre las
herramientas que ya existen (`bw-disponibilidad`, `bw-reservar-turno`). Por
eso hereda cada regla —R-01 a R-22— sin escribir ninguna de nuevo, y por eso
el HBOT de las 16:30 (R-22) no puede volver a pasar por acá: un horario que el
portal no ofrecería, el agente no lo puede proponer.

## Qué cambia para Recepción

Antes: llega la solicitud, Recepción lee qué pidió ("HBOT, jueves a la tarde,
con mi marido"), va a Atender, mira la agenda, elige sala y hora a mano,
reserva; si un bloqueo salta, vuelve a elegir.

Ahora: en la card hay un botón **Proponer**. El asistente devuelve la reserva
concreta —*Biplaza · jueves 03/09 · 16:00 · 2 personas*— y por qué. Recepción
toca **Reservar** (o **Otra opción**, o **Lo hago a mano**). Los pasos del
medio se vuelven uno.

## Cómo funciona por dentro

```
Solicitud (Task solicitud-turno)
   └─► bw-proponer-reserva (solo lectura)
         ├─ lee la ficha resumida (la misma del borrador: sin nada clínico)
         ├─ lee los horarios reales del paciente (disponibilidadDePaciente:
         │  ventana R-13, capacidad y desfasaje R-07, grilla R-22)
         ├─ una llamada al modelo con salida estructurada (JSON Schema):
         │  elige ENTRE esos horarios; no los inventa
         ├─ valida la respuesta contra la oferta (validarSalida): servicio
         │  ofrecido, inicio en la lista, personas dentro de la capacidad;
         │  si no, "resolvela a mano" — falla cerrado
         └─ elige la sala con el mismo criterio con que se ofreció el
            horario (salaLibrePara)
   └─► Recepción: [Reservar] → bw-reservar-turno (valida R-01…R-22, crea el
       Appointment, completa la solicitud) · [Otra opción] → vuelve a pedir
       excluyendo lo descartado · [Lo hago a mano] → Atender prellenado
```

Dos cosas importan. El agente **nunca escribe** en la agenda: produce una
propuesta y nada más. Y la reserva pasa por **el mismo bot que usa el
mostrador**: si la propuesta viola una regla, el bot la rechaza con su mensaje
y la card lo muestra.

Código: lógica pura en `src/lib/propuesta.ts` (prompt, esquema, validación,
con tests en `tests/propuesta.test.ts`); el bot en
`src/bots/proponer-reserva.ts`; `salaLibrePara` en `src/lib/disponibilidad.ts`;
la ficha resumida compartida con el borrador en `contextoPacienteResumido`
(`src/bots/_shared.ts`); la card en `app/src/pages/Solicitudes.tsx`.

## Los límites (son los del repo)

- **Nada clínico.** El agente ve la señal binaria del consentimiento, nunca
  contraindicaciones, screening ni documentos (CLAUDE.md, principio 3). Igual
  que el borrador. Si la solicitud menciona un tema de salud, el prompt le
  pide `sin_propuesta`.
- **Ningún precio inventado.** No habla de plata; los precios viven en el
  catálogo. Verificado por tests del prompt.
- **Los bloqueos no se negocian.** La autorización médica y cualquier override
  siguen siendo un tilde humano en Atender.
- **No edita reglas ni configuración.** Las reglas cambian en código, con su
  R-xx y sus tests. El agente las aplica y las explica.
- **No le habla al paciente.** La confirmación por WhatsApp la manda
  `bw-reservar-turno` como siempre; el texto del agente lo lee Recepción.
- **Sin propuesta si no está claro.** Ambigüedad, tema delicado, nada
  disponible con sentido → `sin_propuesta` y la card dice "mejor resolvela
  vos".

## Qué se mide

Cada propuesta deja en la solicitud (`Task`) la extensión
`propuesta-resultado`: **`confirmada`** (Reservar tal cual), **`alternativa`**
(Reservar después de "Otra opción") o **`descartada`** ("Lo hago a mano").
Gemela de `borrador-usado`: en un mes se responde con datos qué porcentaje de
solicitudes podría resolverse sola. Sin ese número no se automatiza nada más.

## Alcance de esta rebanada

Propone **sesiones sueltas** (HBOT mono/biplaza/multiplaza, IHHT, Red Light,
Recovery Pro, botas, crio, masajes…). Manda a Atender, con motivo explícito:
consultas médicas (agenda del profesional), servicios con prescripción (IV/TB,
R-03) y combos. Todo eso es la rebanada siguiente, con los mismos límites.

Modelo y esfuerzo: los del borrador (`claude-opus-5`, `effort: low`) — elegir
entre una lista no necesita más. Secret: `ANTHROPIC_API_KEY`, el mismo. Sin
él, el botón avisa y Recepción sigue como siempre.

## Qué queda afuera (todavía)

Mover o cancelar turnos por lenguaje natural. Un chat libre "preguntale al
agente". Cualquier respuesta automática al paciente. Cambios de reglas o de
catálogo. Se deciden después, con la métrica en la mano.
