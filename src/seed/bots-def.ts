/**
 * Definición canónica de los Bots del repo (nombre, source, dist, descripción).
 * La usan deploy-bots (crear+deployar) y diagnostico-bots (verificar contra el
 * servidor). Módulo puro: importarlo NO conecta a ningún lado.
 */
export interface DefBot {
  name: string;
  source: string;
  dist: string;
  description: string;
  /**
   * Horario del bot (`cronString` del recurso `Bot`), para los que corren solos.
   *
   * Está acá y no en un instructivo a propósito: el horario es una **decisión de
   * negocio** —cada cuánto se libera un lugar, cuándo se cobra— y como tal se
   * revisa en un PR como cualquier otra regla. Antes vivía como un snippet para
   * copiar y pegar en `docs/puesta-en-produccion.md`, donde nada lo validaba y
   * nadie sabía si el servidor coincidía.
   *
   * Lo aplica y lo verifica `npm run bots:cron`. Sin este campo, el bot no se
   * programa: se ejecuta por pedido.
   */
  cron?: string;
}

export const BOTS: DefBot[] = [
  { name: 'bw-calcular-cobro', source: 'src/bots/calcular-cobro.ts', dist: 'dist/bots/calcular-cobro.js', description: 'Calcula el cobro (USD→ARS, splits) y emite Invoice.' },
  { name: 'bw-registrar-cobro', source: 'src/bots/registrar-cobro.ts', dist: 'dist/bots/registrar-cobro.js', description: 'Registra un cobro presencial: ChargeItems + un Invoice balanced por medio (contrato Administración).' },
  { name: 'bw-cobrar-pendiente', source: 'src/bots/cobrar-pendiente.ts', dist: 'dist/bots/cobrar-pendiente.js', description: 'Cobra en recepción un Invoice issued de plan: balanced + ChargeItem + levanta bloqueo R-11.' },
  { name: 'bw-validar-turno', source: 'src/bots/validar-turno.ts', dist: 'dist/bots/validar-turno.js', description: 'Valida un turno (orden HBOT, contraindicaciones, recursos, ventana, saldo).' },
  { name: 'bw-reservar-turno', source: 'src/bots/reservar-turno.ts', dist: 'dist/bots/reservar-turno.js', description: 'Valida y crea un turno (Appointment + Slot ocupado).' },
  { name: 'bw-reservar-combo', source: 'src/bots/reservar-combo.ts', dist: 'dist/bots/reservar-combo.js', description: 'Reserva un combo: agenda los componentes en secuencia (HBOT primero).' },
  { name: 'bw-estado-turno', source: 'src/bots/estado-turno.ts', dist: 'dist/bots/estado-turno.js', description: 'Cambia el estado del turno (check-in/out), gestiona Encounter y libera la sala.' },
  { name: 'bw-pagar-sena', source: 'src/bots/pagar-sena.ts', dist: 'dist/bots/pagar-sena.js', description: 'Registra la seña (50%), confirma el turno y envía WhatsApp.' },
  { name: 'bw-link-mercadopago', source: 'src/bots/link-mercadopago.ts', dist: 'dist/bots/link-mercadopago.js', description: 'Genera link de MercadoPago para pagar la seña.' },
  { name: 'bw-webhook-mercadopago', source: 'src/bots/webhook-mercadopago.ts', dist: 'dist/bots/webhook-mercadopago.js', description: 'Webhook de MercadoPago: confirma el turno al acreditarse el pago.' },
  { name: 'bw-asignar-plan', source: 'src/bots/asignar-plan.ts', dist: 'dist/bots/asignar-plan.js', description: 'Asigna una membresía/paquete (Coverage), emite el cobro inicial y avisa por WhatsApp.' },
  { name: 'bw-cobro-membresias', source: 'src/bots/cobro-membresias.ts', dist: 'dist/bots/cobro-membresias.js', description: 'Cron días 1-5: renueva membresías (reset de sesiones + cobro mensual).' , cron: '0 9 * * *' /* Solo actúa los días 1-5 y por ciclo no facturado; correrlo a diario es seguro. */ },
  { name: 'bw-recordatorios', source: 'src/bots/recordatorios.ts', dist: 'dist/bots/recordatorios.js', description: 'Cron: envía recordatorios de turnos confirmados a 48 h y 2 h (WhatsApp).' , cron: '*/30 * * * *' /* 48 h y 2 h: cuanto más seguido, más cerca de la hora exacta. Idempotente por Communication. */ },
  { name: 'bw-vencer-tentativas', source: 'src/bots/vencer-tentativas.ts', dist: 'dist/bots/vencer-tentativas.js', description: 'Cron R-19: recordatorio de seña impaga y liberación del lugar al vencer la tentativa.' , cron: '*/10 * * * *' /* R-19: la seña vence a las 2 h; cada 10 min el lugar liberado sale con poco retraso. */ },
  { name: 'bw-alta-paciente', source: 'src/bots/alta-paciente.ts', dist: 'dist/bots/alta-paciente.js', description: 'Alta de paciente (Patient) con dedupe por DNI/email/teléfono.' },
  { name: 'bw-invitar-paciente', source: 'src/bots/invitar-paciente.ts', dist: 'dist/bots/invitar-paciente.js', description: 'Invita al paciente al portal (invite Medplum) y entrega el link por WhatsApp/email/QR. Requiere admin.' },
  { name: 'bw-reset-password', source: 'src/bots/reset-password.ts', dist: 'dist/bots/reset-password.js', description: 'Reset de contraseña del portal: link sobre PORTAL_BASE_URL + email propio en castellano (endpoint público vía nginx). Requiere admin.' },
  { name: 'bw-limpiar-demo', source: 'src/bots/limpiar-demo.ts', dist: 'dist/bots/limpiar-demo.js', description: 'Cron: borra los datos demo (tag demo) con más de 48 h.' , cron: '0 * * * *' /* Borra los datos demo de más de 48 h. */ },
  { name: 'bw-enviar-whatsapp', source: 'src/bots/enviar-whatsapp.ts', dist: 'dist/bots/enviar-whatsapp.js', description: 'Envía WhatsApp (Twilio) y registra Communication.' },
  { name: 'bw-solicitar-turno', source: 'src/bots/solicitar-turno.ts', dist: 'dist/bots/solicitar-turno.js', description: 'Crea una solicitud de turno (Task) desde el portal del paciente y avisa a Recepción por WhatsApp.' },
  { name: 'bw-disponibilidad', source: 'src/bots/disponibilidad.ts', dist: 'dist/bots/disponibilidad.js', description: 'Solo lectura: horarios reservables para el paciente (portal) según su ventana R-13, capacidad R-07 y desfasaje Recovery.' },
  { name: 'bw-estado-consentimiento', source: 'src/bots/estado-consentimiento.ts', dist: 'dist/bots/estado-consentimiento.js', description: 'Solo lectura: ¿el paciente firmó el consentimiento en el portal? Devuelve la señal binaria (firmado / no-registrado / no-verificable), nunca el documento.' },
  { name: 'bw-ingreso-presencial', source: 'src/bots/ingreso-presencial.ts', dist: 'dist/bots/ingreso-presencial.js', description: 'Kiosco del mostrador: registra consentimiento firmado (Consent + DocumentReference) y cuestionario de ingreso del paciente, sin depender del portal ni del email.' },
  { name: 'bw-estado-seguridad', source: 'src/bots/estado-seguridad.ts', dist: 'dist/bots/estado-seguridad.js', description: 'Solo lectura: banner de seguridad de Recepción (contraindicado / apto / sin-screening / no-verificable), nunca el detalle clínico.' },
  { name: 'bw-dedup-paciente', source: 'src/bots/dedup-paciente.ts', dist: 'dist/bots/dedup-paciente.js', description: 'Detecta fichas duplicadas (email/DNI/teléfono) y abre tarea de revisión.' },
  { name: 'bw-fusionar-paciente', source: 'src/bots/fusionar-paciente.ts', dist: 'dist/bots/fusionar-paciente.js', description: 'Fusiona un duplicado en la ficha canónica (login, datos, recursos). Requiere admin.' },
  { name: 'bw-whatsapp-entrante', source: 'src/bots/whatsapp-entrante.ts', dist: 'dist/bots/whatsapp-entrante.js', description: 'Webhook de Twilio: WhatsApp del paciente → su hilo en Mensajes (por teléfono; desconocidos → alerta).' },
  { name: 'bw-borrador-respuesta', source: 'src/bots/borrador-respuesta.ts', dist: 'dist/bots/borrador-respuesta.js', description: 'Solo lectura: redacta el BORRADOR de la respuesta de Recepción en Mensajes (la envía una persona, nunca el bot). Requiere ANTHROPIC_API_KEY.' },
  { name: 'bw-proponer-reserva', source: 'src/bots/proponer-reserva.ts', dist: 'dist/bots/proponer-reserva.js', description: 'Solo lectura: para una solicitud del portal, PROPONE la reserva concreta (servicio, sala, horario) eligiendo entre los horarios reales; Recepción confirma con un botón y reserva bw-reservar-turno. Requiere ANTHROPIC_API_KEY.' },
  { name: 'bw-cancelar-turno', source: 'src/bots/cancelar-turno.ts', dist: 'dist/bots/cancelar-turno.js', description: 'Portal: el paciente cancela SU turno. Aplica R-14 (devuelve la sesión si avisó a tiempo), libera la sala y avisa a la lista de espera.' },
  { name: 'bw-mover-turno', source: 'src/bots/mover-turno.ts', dist: 'dist/bots/mover-turno.js', description: 'Portal: el paciente mueve SU turno en una sola operación (toma el lugar nuevo antes de soltar el viejo). Revalida la ventana R-13 y topea en 3 movimientos.' },
  { name: 'bw-federador', source: 'src/bots/federador.ts', dist: 'dist/bots/federador.js', description: 'Solo lectura: busca a la persona por DNI en el Federador del Ministerio (Bus Auth v2) y devuelve lo que el alta puede completar. Sin credenciales no hace nada: el alta sigue igual.' },
  { name: 'bw-preferencia-semanal', source: 'src/bots/preferencia-semanal.ts', dist: 'dist/bots/preferencia-semanal.js', description: 'Guarda la preferencia semanal de la membresía (días + hora) y prende/apaga la asignación automática (R-21).' },
  { name: 'bw-agenda-semanal', source: 'src/bots/agenda-semanal.ts', dist: 'dist/bots/agenda-semanal.js', description: 'Cron R-21: reserva las sesiones de la semana de cada membresía apenas se abre su ventana R-13 (FM antes que Intensivo antes que Standard, solo).' , cron: '5 * * * *' /* Cada hora (min 5, corrido de bw-limpiar-demo): idempotente — lo asignado se saltea y lo que no entró en la ventana espera la corrida siguiente. */ },
];
