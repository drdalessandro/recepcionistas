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
  { name: 'bw-cobro-membresias', source: 'src/bots/cobro-membresias.ts', dist: 'dist/bots/cobro-membresias.js', description: 'Cron días 1-5: renueva membresías (reset de sesiones + cobro mensual).' },
  { name: 'bw-recordatorios', source: 'src/bots/recordatorios.ts', dist: 'dist/bots/recordatorios.js', description: 'Cron: envía recordatorios de turnos confirmados a 48 h y 2 h (WhatsApp).' },
  { name: 'bw-alta-paciente', source: 'src/bots/alta-paciente.ts', dist: 'dist/bots/alta-paciente.js', description: 'Alta de paciente (Patient) con dedupe por DNI/email/teléfono.' },
  { name: 'bw-invitar-paciente', source: 'src/bots/invitar-paciente.ts', dist: 'dist/bots/invitar-paciente.js', description: 'Invita al paciente al portal (invite Medplum) y entrega el link por WhatsApp/email/QR. Requiere admin.' },
  { name: 'bw-limpiar-demo', source: 'src/bots/limpiar-demo.ts', dist: 'dist/bots/limpiar-demo.js', description: 'Cron: borra los datos demo (tag demo) con más de 48 h.' },
  { name: 'bw-enviar-whatsapp', source: 'src/bots/enviar-whatsapp.ts', dist: 'dist/bots/enviar-whatsapp.js', description: 'Envía WhatsApp (Twilio) y registra Communication.' },
  { name: 'bw-solicitar-turno', source: 'src/bots/solicitar-turno.ts', dist: 'dist/bots/solicitar-turno.js', description: 'Crea una solicitud de turno (Task) desde el portal del paciente y avisa a Recepción por WhatsApp.' },
];
