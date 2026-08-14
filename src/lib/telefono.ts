/**
 * Normalización de teléfonos argentinos — lógica pura, sin dependencias de Node.
 *
 * Vivía dentro de `whatsapp.ts`, pero ese módulo importa `node:crypto` para
 * validar la firma de Twilio y por eso NO se puede bundlear para el navegador.
 * El buscador del mostrador necesita estas funciones (encontrar a alguien por su
 * teléfono), así que viven acá: puras, testeables y seguras en el browser.
 *
 * `whatsapp.ts` las re-exporta para no romper a quien ya las importaba de ahí.
 */

/**
 * Variantes de un teléfono para buscar la ficha por igualdad exacta en telecom
 * (la búsqueda FHIR no normaliza). Acepta el "From" de Twilio ("whatsapp:+549…").
 * Para móviles argentinos (+54 9 …) genera las formas habituales de carga:
 * con/sin "+", con/sin el 9, y el área+línea pelado (10 dígitos).
 */
export function variantesTelefono(valor?: string): string[] {
  const crudo = (valor ?? '').replace(/^whatsapp:/i, '').trim();
  const digitos = crudo.replace(/\D/g, '');
  if (digitos.length < 8) {
    return [];
  }
  const set = new Set<string>();
  if (crudo) {
    set.add(crudo);
  }
  set.add(`+${digitos}`);
  set.add(digitos);
  if (digitos.startsWith('549') && digitos.length === 13) {
    const diez = digitos.slice(3); // área + línea (ej. 1169315830)
    set.add(diez);
    set.add(`9${diez}`);
    set.add(`54${diez}`);
    set.add(`+54${diez}`);
  }
  set.add(digitos.slice(-10));
  // …y al revés: de un número LOCAL a las formas internacionales. Hace falta
  // para buscar desde el mostrador: la ficha creada por WhatsApp guarda E.164
  // (`+5491169315830`, normalizado por `aE164Argentino`) y la recepcionista
  // tipea el número como lo tiene en el celular (`1169315830`). Sin estas
  // variantes esa búsqueda no matchea nunca y termina en una ficha duplicada.
  const diezFinales = digitos.slice(-10);
  if (diezFinales.length === 10 && !digitos.startsWith('54')) {
    set.add(`549${diezFinales}`);
    set.add(`+549${diezFinales}`);
    set.add(`54${diezFinales}`);
    set.add(`+54${diezFinales}`);
  }
  return [...set].filter(Boolean);
}

/**
 * Normaliza un teléfono de la ficha al E.164 que exige Twilio para ENVIAR
 * ("whatsapp:+549..."). Es el espejo de `variantesTelefono`: para entrar
 * probamos todas las formas; para salir hay que mandar UNA, la canónica.
 * Heurística para móviles argentinos; los internacionales con "+" pasan tal cual.
 * Devuelve undefined si el valor no alcanza para armar un número válido.
 */
export function aE164Argentino(valor?: string): string | undefined {
  const crudo = (valor ?? '').replace(/^whatsapp:/i, '').trim();
  if (!crudo) {
    return undefined;
  }
  let d = crudo.replace(/\D/g, '');
  if (d.startsWith('00')) {
    d = d.slice(2);
  }
  if (d.length < 8) {
    return undefined;
  }
  if (d.startsWith('549') && d.length === 13) {
    return `+${d}`;
  }
  if (d.startsWith('54') && d.length === 12) {
    return `+549${d.slice(2)}`; // móvil cargado sin el 9
  }
  if (d.startsWith('9') && d.length === 11) {
    return `+54${d}`;
  }
  if (d.startsWith('0') && d.length === 11) {
    return `+549${d.slice(1)}`; // "011 6931-5830"
  }
  if (d.length === 10) {
    return `+549${d}`; // área + línea pelado ("1169315830")
  }
  if (crudo.startsWith('+') || d.length >= 11) {
    return `+${d}`; // internacional
  }
  return undefined;
}
