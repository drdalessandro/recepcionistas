/** Colores y etiquetas de los estados del turno (Appointment.status). */

const COLOR: Record<string, string> = {
  pending: 'yellow',
  proposed: 'yellow',
  booked: 'bio',
  arrived: 'orange',
  'checked-in': 'teal',
  fulfilled: 'gray',
  noshow: 'red',
  cancelled: 'gray',
};

/**
 * "Falta el pago" y no "falta la seña" (2026-09-20): esta etiqueta también le
 * cae a las teleconsultas, que se cobran enteras por adelantado, y en un turno
 * virtual ningún texto puede decir "seña" (Andrés, 2026-09-16) — prometería un
 * saldo que después no hay dónde cobrar. `labelEstado` se usa en la agenda, los
 * reportes y el timeline, donde la modalidad no está a mano: una palabra que es
 * cierta en los dos casos vale más que dos ramas a medio enchufar. El monto
 * exacto y su nombre están en el modal del turno, que sí sabe la modalidad.
 */
const LABEL: Record<string, string> = {
  pending: 'Tentativo (falta el pago)',
  proposed: 'Tentativo (falta el pago)',
  booked: 'Confirmado',
  arrived: 'Llegó',
  'checked-in': 'En curso',
  fulfilled: 'Completado',
  noshow: 'No vino',
  cancelled: 'Cancelado',
};

export function colorEstado(estado: string): string {
  return COLOR[estado] ?? 'red';
}

export function labelEstado(estado: string): string {
  return LABEL[estado] ?? estado;
}
