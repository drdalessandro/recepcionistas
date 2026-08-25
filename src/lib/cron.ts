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
    const pedazos = parte.split('/');
    if (pedazos.length > 2) {
      // `*/2/3` parseaba como paso 2 y descartaba el 3 en silencio — justo la
      // clase de error que este módulo existe para no dejar pasar.
      return `tiene más de una barra (${parte})`;
    }
    const [rango, paso] = pedazos;
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
    // "cada N minutos" solo es verdad si N divide a 60: `*/45` dispara a :00 y
    // :45 (con un salto de 15 al dar la vuelta). Antes que traducir mintiendo,
    // se devuelve la expresión cruda.
    if (cadaNMin && hora === '*' && 60 % Number(cadaNMin[1]) === 0) {
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
    if (cadaNHoras && /^\d+$/.test(minuto) && 24 % Number(cadaNHoras[1]) === 0) {
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
 * Lo único que hace falta saber de un Bot para decidir su horario.
 *
 * Se declara la forma mínima en vez de importar el tipo `Bot` de FHIR para que
 * esta decisión sea comprobable con objetos literales: es la que determina si se
 * le escribe algo al bot que cobra plata, y tiene que poder testearse sin
 * levantar medio Medplum.
 */
export interface BotProgramable {
  id?: string;
  cronString?: string;
  cronTiming?: unknown;
  /** Attachment de Medplum: solo importa si trae contenido de verdad. */
  executableCode?: { url?: string; data?: string };
}

/** Qué hay que hacer con un bot. */
export type AccionCron =
  | 'ya-esta'
  | 'poner'
  | 'cambiar'
  | 'desprogramar'
  | 'sin-codigo'
  | 'duplicado'
  | 'falta'
  | 'cron-invalido';

export interface CasoCron {
  accion: AccionCron;
  /** Vacío en `desprogramar`: el repo dice que este bot no corre solo. */
  deseado: string;
  actual?: string;
  detalle?: string;
  /** El bot arrastra un `cronTiming` (resto de configuración vieja por UI). */
  conTiming?: boolean;
}

/**
 * ¿Tiene código deployado?
 *
 * La misma pregunta que hace `bots:check`, y a propósito: un `executableCode`
 * que quedó como Attachment vacío tras un `$deploy` a medias es truthy pero no
 * es código. Si las dos herramientas no coinciden, una dice "OK" y la otra
 * programa un bot que tiquea al vacío.
 */
export function tieneCodigo(bot: BotProgramable): boolean {
  return Boolean(bot.executableCode?.url ?? bot.executableCode?.data);
}

/**
 * Qué hacer con un bot que el repo declara que corre solo.
 *
 * Todas las guardias que el runbook prometía y nada garantizaba viven acá:
 * no se programa un cron inválido, ni un bot sin código, ni uno duplicado.
 */
export function decidirCron(deseado: string, candidatos: readonly BotProgramable[]): CasoCron {
  const validacion = validarCron(deseado);
  if (!validacion.ok) {
    // Mandarlo sería programar un bot que no va a correr nunca, en silencio.
    return { accion: 'cron-invalido', deseado, detalle: validacion.error };
  }
  if (candidatos.length === 0) {
    return { accion: 'falta', deseado };
  }
  if (candidatos.length > 1) {
    return {
      accion: 'duplicado',
      deseado,
      detalle: candidatos.map((b) => `Bot/${b.id}`).join(', '),
    };
  }
  const bot = candidatos[0] as BotProgramable;
  if (!tieneCodigo(bot)) {
    return { accion: 'sin-codigo', deseado };
  }
  const actual = bot.cronString;
  const conTiming = Boolean(bot.cronTiming);
  if (actual === deseado && !conTiming) {
    return { accion: 'ya-esta', deseado, actual };
  }
  if (actual === deseado && conTiming) {
    // El horario coincide, pero el recurso arrastra un `cronTiming` de la época
    // de configuración por UI. Los dos campos conviven y Medplum no documenta
    // cuál gana: dejarlo es dejar el estado ambiguo sobre un bot que corre solo.
    return { accion: 'cambiar', deseado, actual, conTiming, detalle: 'borrar el cronTiming' };
  }
  return { accion: actual ? 'cambiar' : 'poner', deseado, actual, conTiming };
}

/**
 * El caso inverso: un bot del repo SIN `cron` declarado que en el servidor quedó
 * programado.
 *
 * Sacarle el `cron` a un bot en el repo tiene que **desprogramarlo de verdad**.
 * Si no, se frena el cobro automático en un PR, el PR se mergea, y el bot sigue
 * cobrando igual.
 */
export function decidirDesprogramar(candidatos: readonly BotProgramable[]): CasoCron | undefined {
  if (candidatos.length !== 1) {
    return undefined;
  }
  const bot = candidatos[0] as BotProgramable;
  if (!bot.cronString && !bot.cronTiming) {
    return undefined;
  }
  return { accion: 'desprogramar', deseado: '', actual: bot.cronString, conTiming: Boolean(bot.cronTiming) };
}

/** Las acciones que implican escribir en el servidor. */
export function hayQueEscribir(accion: AccionCron): boolean {
  return accion === 'poner' || accion === 'cambiar' || accion === 'desprogramar';
}

/** Las que no se pueden resolver solas y necesitan que alguien haga algo. */
export function estaBloqueado(accion: AccionCron): boolean {
  return accion === 'sin-codigo' || accion === 'duplicado' || accion === 'falta' || accion === 'cron-invalido';
}

/**
 * Expande un campo al conjunto de valores en los que dispara.
 *
 * `undefined` = no se puede saber con certeza (paso 0, forma ambigua como un
 * paso sobre un valor suelto, que cada implementación de cron interpreta a su
 * manera). Ante la duda no se cuenta, porque el número alimenta un aviso de
 * seguridad y una cuenta optimista lo desactiva en silencio.
 */
function expandirCampo(campo: string, min: number, max: number): Set<number> | undefined {
  const valores = new Set<number>();
  for (const parte of campo.split(',')) {
    const pedazos = parte.split('/');
    if (pedazos.length > 2) {
      return undefined;
    }
    const [rango, paso] = pedazos;
    const salto = paso === undefined ? 1 : Number(paso);
    if (!Number.isInteger(salto) || salto < 1) {
      return undefined;
    }
    let desde: number;
    let hasta: number;
    if (rango === '*') {
      desde = min;
      hasta = max;
    } else {
      const extremos = (rango ?? '').split('-');
      if (extremos.length > 2 || extremos.some((e) => !/^\d+$/.test(e))) {
        return undefined;
      }
      if (extremos.length === 1) {
        // Un paso sobre un valor suelto ("5/2") significa cosas distintas según
        // la implementación: no se opina.
        if (paso !== undefined) {
          return undefined;
        }
        desde = hasta = Number(extremos[0]);
      } else {
        desde = Number(extremos[0]);
        hasta = Number(extremos[1]);
      }
    }
    if (desde > hasta || desde < min || hasta > max) {
      return undefined;
    }
    for (let v = desde; v <= hasta; v += salto) {
      valores.add(v);
    }
  }
  return valores;
}

/**
 * ¿Cuántas veces por día dispara? Exacto para todo lo que pasa `validarCron`
 * con los tres campos de fecha en `*`; `undefined` cuando no se puede saber.
 *
 * Sirve para una sola cosa: avisar si alguien programa algo absurdo, tipo cada
 * minuto un bot que cobra plata. Se calcula **expandiendo** los campos y no con
 * aritmética: `Math.floor(60/9)` dice 6, pero un paso de 9 en los minutos
 * dispara 7 veces por hora (0, 9, …, 54) — la cuenta optimista subestimaba
 * justo lo que el aviso existe para atajar.
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
  const minutos = expandirCampo(minuto, 0, 59);
  const horas = expandirCampo(hora, 0, 23);
  if (!minutos || !horas || minutos.size === 0 || horas.size === 0) {
    return undefined;
  }
  return minutos.size * horas.size;
}
