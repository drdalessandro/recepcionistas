/**
 * Expresiones cron de los bots — lógica pura.
 *
 * Existe por un motivo concreto: **un cron mal escrito no da error**. Medplum
 * acepta el string y el bot simplemente no corre nunca, igual que pasó con el
 * campo `cronTimer` (que no existe) hasta que alguien lo miró. Un horario que
 * falla en silencio es peor que uno que falla fuerte, porque el que lo configuró
 * se va convencido de que quedó andando.
 *
 * Acá se valida la forma y se traduce a castellano, para que quien lo configura
 * lea lo que va a pasar en vez de interpretar cinco campos de memoria.
 */

/** Los cinco campos de un cron, en orden, con su rango válido. */
const CAMPOS = [
  { nombre: 'minuto', min: 0, max: 59 },
  { nombre: 'hora', min: 0, max: 23 },
  { nombre: 'día del mes', min: 1, max: 31 },
  { nombre: 'mes', min: 1, max: 12 },
  // 0 y 7 son los dos domingo, según la convención de cron.
  { nombre: 'día de la semana', min: 0, max: 7 },
] as const;

export interface ResultadoValidacion {
  ok: boolean;
  /** Qué está mal, en castellano y apuntando al campo. */
  error?: string;
}

/**
 * ¿Es un cron de cinco campos con valores en rango?
 *
 * No pretende cubrir todo el dialecto (no acepta `@daily` ni `L`/`W`, que Medplum
 * tampoco documenta). Lo que sí garantiza es atajar los errores que se cometen de
 * verdad: cuatro campos en vez de cinco, un minuto 60, un mes 0.
 */
export function validarCron(expresion: string | undefined): ResultadoValidacion {
  const limpia = (expresion ?? '').trim();
  if (!limpia) {
    return { ok: false, error: 'está vacío' };
  }
  const campos = limpia.split(/\s+/);
  if (campos.length !== 5) {
    return {
      ok: false,
      error: `tiene ${campos.length} campo${campos.length === 1 ? '' : 's'} y un cron lleva 5 (minuto hora día-del-mes mes día-de-semana)`,
    };
  }
  for (let i = 0; i < CAMPOS.length; i++) {
    const campo = CAMPOS[i]!;
    const error = validarCampo(campos[i]!, campo.min, campo.max);
    if (error) {
      return { ok: false, error: `el campo "${campo.nombre}" (${campos[i]}) ${error}` };
    }
  }
  return { ok: true };
}

/**
 * Un campo suelto: un asterisco, un asterisco con paso, un número, un rango, un
 * rango con paso, o una lista de esos separada por comas.
 *
 * (Los ejemplos van en prosa a propósito: escribir un asterisco seguido de barra
 * dentro de un comentario de bloque **lo cierra** y rompe el archivo entero. Ya
 * pasó una vez con el cron de `vencer-tentativas.ts`.)
 */
function validarCampo(campo: string, min: number, max: number): string | undefined {
  for (const parte of campo.split(',')) {
    if (parte === '') {
      return 'tiene una coma de más';
    }
    const [rango, paso] = parte.split('/');
    if (paso !== undefined) {
      const n = Number(paso);
      if (!/^\d+$/.test(paso) || n < 1 || n > max) {
        return `tiene un paso inválido (/${paso})`;
      }
    }
    if (rango === '*' || rango === undefined) {
      continue;
    }
    for (const valor of rango.split('-')) {
      if (!/^\d+$/.test(valor)) {
        return 'no es un número, un rango ni un asterisco';
      }
      const n = Number(valor);
      if (n < min || n > max) {
        return `usa ${n}, fuera del rango ${min}-${max}`;
      }
    }
    const extremos = rango.split('-');
    if (extremos.length > 2) {
      return 'tiene más de un guion';
    }
    if (extremos.length === 2 && Number(extremos[0]) > Number(extremos[1])) {
      return `tiene el rango al revés (${rango})`;
    }
  }
  return undefined;
}

/**
 * El cron en castellano.
 *
 * Cubre las formas que usamos y devuelve la expresión cruda para cualquier otra:
 * inventar una traducción de un cron arbitrario sería adivinar, y acá el punto es
 * que el operador entienda lo que está por guardar, no que quede bonito.
 */
export function describirCron(expresion: string): string {
  const campos = expresion.trim().split(/\s+/);
  if (campos.length !== 5) {
    return expresion;
  }
  const [minuto, hora, diaMes, mes, diaSemana] = campos as [string, string, string, string, string];
  const todosLosDias = diaMes === '*' && mes === '*' && diaSemana === '*';

  if (todosLosDias) {
    const cadaNMin = /^\*\/(\d+)$/.exec(minuto);
    if (cadaNMin && hora === '*') {
      const n = Number(cadaNMin[1]);
      return n === 1 ? 'cada minuto' : `cada ${n} minutos`;
    }
    if (minuto === '*' && hora === '*') {
      return 'cada minuto';
    }
    if (/^\d+$/.test(minuto) && hora === '*') {
      return `cada hora, al minuto ${minuto}`;
    }
    const cadaNHoras = /^\*\/(\d+)$/.exec(hora);
    if (cadaNHoras && /^\d+$/.test(minuto)) {
      const n = Number(cadaNHoras[1]);
      return n === 1 ? `cada hora, al minuto ${minuto}` : `cada ${n} horas, al minuto ${minuto}`;
    }
    if (/^\d+$/.test(minuto) && /^\d+$/.test(hora)) {
      return `todos los días a las ${hora.padStart(2, '0')}:${minuto.padStart(2, '0')}`;
    }
  }
  return expresion;
}

/**
 * ¿Cuántas veces por día dispara? Aproximado, y solo para las formas que usamos.
 *
 * Sirve para una sola cosa: avisar si alguien programa algo absurdo, tipo cada
 * minuto un bot que cobra plata. `undefined` = no se sabe, y entonces no se opina.
 */
export function corridasPorDia(expresion: string): number | undefined {
  const campos = expresion.trim().split(/\s+/);
  if (campos.length !== 5) {
    return undefined;
  }
  const [minuto, hora, diaMes, mes, diaSemana] = campos as [string, string, string, string, string];
  if (diaMes !== '*' || mes !== '*' || diaSemana !== '*') {
    return undefined;
  }
  const porHora = /^\*\/(\d+)$/.exec(minuto)
    ? Math.floor(60 / Number(/^\*\/(\d+)$/.exec(minuto)![1]))
    : minuto === '*'
      ? 60
      : /^\d+$/.test(minuto)
        ? 1
        : undefined;
  if (porHora === undefined) {
    return undefined;
  }
  const horas = hora === '*'
    ? 24
    : /^\*\/(\d+)$/.test(hora)
      ? Math.floor(24 / Number(/^\*\/(\d+)$/.exec(hora)![1]))
      : /^\d+$/.test(hora)
        ? 1
        : undefined;
  return horas === undefined ? undefined : porHora * horas;
}
