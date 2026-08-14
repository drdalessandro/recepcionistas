/**
 * Armado del documento firmado del Consentimiento Informado — lógica pura.
 *
 * Es la EVIDENCIA: el texto exacto que la persona leyó y firmó, con su nombre,
 * DNI y timestamp. Va como adjunto del `DocumentReference` y es lo que se
 * presenta ante un reclamo.
 *
 * Vive acá —y no en cada app— porque el documento tiene que salir **idéntico**
 * por los dos canales: el portal (el paciente desde su casa) y el kiosco del
 * mostrador (el paciente en la tablet de Recepción). Dos armadores distintos
 * producirían dos documentos distintos para el mismo consentimiento, y la
 * diferencia recién se descubriría en un juicio.
 *
 * La firma es el **nombre tipeado** por el paciente, igual que en el portal
 * (decisión 2026-08-14): una sola clase de evidencia por los dos caminos.
 */
import {
  VERSION_CONSENTIMIENTO,
  consentFooter,
  consentSections,
  consentSubtitle,
  consentTitle,
  type ConsentBlock,
} from '../config/consentimiento-texto.js';

/** Cláusula de uso secundario de datos (Ley 25.326). Opt-in separado y revocable. */
export const USO_DATOS_VERSION = 'v1';
export const USO_DATOS_TITULO = 'Autorización para uso secundario de datos (opcional)';
export const USO_DATOS_CLAUSULA =
  'Además de la atención de mi salud, autorizo de forma voluntaria a Biowellness (Shanti Om SRL) a utilizar mis ' +
  'datos clínicos y biomarcadores en forma disociada de mi identidad para: (a) mejorar y estandarizar sus ' +
  'protocolos de tratamiento; (b) elaborar estadísticas y estudios agregados; (c) desarrollar y mejorar su sistema ' +
  'de gestión y sus herramientas de soporte a la decisión clínica. Entiendo que estos usos no reemplazan el ' +
  'criterio médico, que ninguna decisión sobre mi salud se toma de forma automatizada, y que puedo revocar esta ' +
  'autorización en cualquier momento sin que ello afecte mi atención. Mis datos no serán vendidos ni cedidos a ' +
  'terceros con fines comerciales sin mi consentimiento expreso adicional.';

/** Por dónde se firmó. Queda en el documento: es parte de la evidencia. */
export type CanalFirma = 'portal' | 'mostrador';

export interface DatosFirma {
  /** Nombre completo tal como lo tipeó el paciente. */
  nombre: string;
  dni: string;
  email: string;
  /** Fecha de nacimiento del paciente (o '—'). */
  fechaNacimiento: string;
  /** ISO del momento de la firma. */
  timestamp: string;
  usoDatosAceptado: boolean;
  canal: CanalFirma;
}

function bloqueATexto(block: ConsentBlock): string {
  switch (block.type) {
    case 'p':
    case 'sub':
      return block.text;
    case 'ul':
      return block.items.map((i) => `• ${i}`).join('\n');
    default:
      return '';
  }
}

/**
 * El documento completo, en texto plano. Mismo orden y mismos títulos que ve el
 * paciente en pantalla: lo que firma es lo que leyó.
 */
export function armarDocumentoConsentimiento(firma: DatosFirma): string {
  const lineas: string[] = [
    consentTitle.toUpperCase(),
    consentSubtitle,
    '',
    '1. DATOS DEL CLIENTE',
    `Apellido y nombre completo: ${firma.nombre}`,
    `Fecha de nacimiento: ${firma.fechaNacimiento}`,
    `DNI / Pasaporte N°: ${firma.dni}`,
    `Correo electrónico: ${firma.email}`,
    `Fecha de aceptación: ${firma.timestamp}`,
    '',
  ];
  for (const seccion of consentSections) {
    lineas.push(seccion.heading.toUpperCase());
    for (const bloque of seccion.blocks) {
      lineas.push(bloqueATexto(bloque));
    }
    lineas.push('');
  }
  lineas.push(
    `${USO_DATOS_TITULO.toUpperCase()} — LEY 25.326`,
    USO_DATOS_CLAUSULA,
    `Decisión del cliente: ${firma.usoDatosAceptado ? 'ACEPTA' : 'NO ACEPTA'} el uso secundario descrito (texto ${USO_DATOS_VERSION}). ` +
      'Esta autorización es opcional, no condiciona la atención y es revocable en cualquier momento desde el portal.',
    '',
    'FIRMA ELECTRÓNICA',
    `Firmado por: ${firma.nombre}`,
    `DNI: ${firma.dni}`,
    `Fecha y hora: ${firma.timestamp}`,
    // Dónde se firmó: en el mostrador el paciente estuvo presente y firmó en el
    // dispositivo del centro. Es parte de la evidencia, no un detalle técnico.
    `Lugar: ${firma.canal === 'mostrador' ? 'San Isidro, Buenos Aires — presencial en el centro' : 'San Isidro, Buenos Aires'}`,
    `Texto: ${VERSION_CONSENTIMIENTO}`,
    '',
    consentFooter,
  );
  return lineas.join('\n');
}
