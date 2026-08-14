/**
 * Búsqueda de pacientes en el mostrador — lógica pura.
 *
 * El problema que resuelve (recorrido del walk-in, caso 2): el buscador de
 * Atender decidía por una sola regla —`/^\d+$/` → buscar por DNI, si no por
 * nombre— y con eso **era imposible encontrar a alguien por su teléfono**. Un
 * "1169315830" salía a buscar DNI; un "+54 9 11 6931-5830" salía a buscar
 * NOMBRE. Los dos devolvían vacío.
 *
 * Justo la ficha que crea Recepción desde un aviso de WhatsApp tiene teléfono y
 * casi nada más (el alta desde el aviso precarga el teléfono, y el DNI recién
 * aparece cuando la persona viene con el documento). Entonces: la recepcionista
 * buscaba por lo único que tenía, no encontraba nada, y creaba una ficha nueva.
 * Duplicado que ni `bw-alta-paciente` ni `bw-dedup-paciente` pueden ver, porque
 * las dos fichas no comparten DNI, ni email, ni teléfono.
 *
 * Acá se decide QUÉ búsquedas lanzar. Es pura para poder testear la
 * clasificación sin servidor: es la que evita el duplicado.
 */
import { soloDigitos, variantesDni } from './dedup.js';
import { variantesTelefono } from './telefono.js';

export type TipoBusqueda = 'nombre' | 'dni' | 'telefono';

export interface BusquedaPaciente {
  tipo: TipoBusqueda;
  /** Valores a probar por igualdad exacta (FHIR no normaliza en token search). */
  valores: string[];
}

/** Un DNI argentino tiene 7 u 8 dígitos; un móvil, 10 o más. */
const DNI_MIN = 7;
const DNI_MAX = 8;

/**
 * Qué búsquedas lanzar para lo que tipeó la recepcionista, en orden de
 * probabilidad. El llamador las corre y junta los resultados sin repetir.
 *
 * - Con alguna letra → es un nombre.
 * - 7-8 dígitos → DNI (y **también** teléfono: hay fijos cortos y gente que
 *   tipea el móvil sin característica).
 * - 9 dígitos o más → teléfono (y también DNI, por si cargaron el documento con
 *   algún dígito de más; probar de menos nunca ayuda a encontrar).
 *
 * La regla de fondo: ante la duda **buscar de más**. Un resultado extra lo
 * descarta la recepcionista de un vistazo; un resultado faltante termina en una
 * ficha duplicada que después hay que fusionar a mano.
 */
export function busquedasPara(query: string): BusquedaPaciente[] {
  const texto = query.trim();
  if (!texto) {
    return [];
  }
  if (/\p{L}/u.test(texto)) {
    return [{ tipo: 'nombre', valores: [texto] }];
  }

  const digitos = soloDigitos(texto);
  const dni: BusquedaPaciente = { tipo: 'dni', valores: variantesDni(texto) };
  const telefono: BusquedaPaciente = { tipo: 'telefono', valores: variantesTelefono(texto) };

  const esRangoDni = digitos.length >= DNI_MIN && digitos.length <= DNI_MAX;
  const orden = esRangoDni ? [dni, telefono] : [telefono, dni];
  return orden.filter((b) => b.valores.length > 0);
}

/**
 * ¿Lo que se está por cargar en el alta puede ser alguien que YA existe?
 *
 * Se usa antes de crear la ficha, con los candidatos que devolvió la búsqueda.
 * **Nunca bloquea**: en Argentina es común que madre e hijo, o una pareja,
 * compartan teléfono, y negar el alta por eso sería peor que el duplicado. Solo
 * avisa, para que la recepcionista mire y decida — que es lo único que puede
 * distinguir un familiar de la misma persona.
 */
export function hayPosibleDuplicado(candidatos: readonly { id?: string }[]): boolean {
  return candidatos.some((c) => Boolean(c.id));
}
