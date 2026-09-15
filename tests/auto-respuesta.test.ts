import { describe, expect, it } from 'vitest';
import {
  APP_URL,
  BIENVENIDA_SALUDO,
  CENTRO_COMO_LLEGAR,
  CENTRO_DIRECCION,
  CENTRO_MAPA,
  CTA_APP,
  PEDIDO_DATOS,
} from '../src/config/auto-respuesta.js';
import {
  armarAutoRespuesta,
  detectarIntencion,
  estaAbierto,
  llevaCtaApp,
  partesArgentina,
  textoHorarioSemanal,
  textoProximaApertura,
  textoRestante,
  ventana24h,
} from '../src/lib/auto-respuesta.js';
import { PORTAL_URL } from '../src/lib/onboarding.js';

// Fechas en UTC, que es como corre el bot. 2026-08-21 es VIERNES.
const viernes = (hhmmArg: string): Date => {
  const [h, m] = hhmmArg.split(':').map(Number);
  // Argentina = UTC-3: las 22:30 del viernes son las 01:30 UTC del sábado.
  return new Date(Date.UTC(2026, 7, 21, (h as number) + 3, m as number));
};

describe('horario del centro — en hora de Argentina, no en UTC', () => {
  it('el viernes 22:30 el centro está CERRADO (en UTC ya sería sábado)', () => {
    const d = viernes('22:30');
    expect(d.toISOString()).toBe('2026-08-22T01:30:00.000Z'); // en UTC es sábado
    expect(partesArgentina(d).dia).toBe(5); // pero en Argentina sigue siendo viernes
    expect(estaAbierto(d)).toBe(false); // viernes cierra 22:00
  });

  it('el viernes a las 15:00 está abierto; a las 07:00 todavía no', () => {
    expect(estaAbierto(viernes('15:00'))).toBe(true);
    expect(estaAbierto(viernes('07:00'))).toBe(false);
  });

  it('el domingo está cerrado a cualquier hora', () => {
    const domingo = new Date(Date.UTC(2026, 7, 23, 15 + 3, 0));
    expect(partesArgentina(domingo).dia).toBe(0);
    expect(estaAbierto(domingo)).toBe(false);
  });

  it('la próxima apertura se dice en palabras y salta el domingo', () => {
    expect(textoProximaApertura(viernes('07:00'))).toBe('hoy a las 08:00');
    expect(textoProximaApertura(viernes('22:30'))).toBe('mañana a las 08:00');
    // Sábado 21:00 (ya cerró): el domingo no abre → lunes.
    const sabadoTarde = new Date(Date.UTC(2026, 7, 22, 21 + 3, 0));
    expect(textoProximaApertura(sabadoTarde)).toBe('el lunes a las 08:00');
  });

  it('el horario semanal se agrupa en vez de listar siete días', () => {
    expect(textoHorarioSemanal()).toBe(
      'lunes a viernes de 08:00 a 22:00; sábado de 08:00 a 20:00; domingo cerrado',
    );
  });
});

describe('ventana de 24 h de Meta', () => {
  const ahora = new Date('2026-08-21T15:00:00Z');

  it('sin mensajes del paciente la ventana nunca se abrió', () => {
    expect(ventana24h(undefined, ahora)).toEqual({ abierta: false, restanteMin: 0 });
  });

  it('cuenta desde el último entrante y se cierra a las 24 h', () => {
    expect(ventana24h('2026-08-21T14:00:00Z', ahora)).toEqual({ abierta: true, restanteMin: 23 * 60 });
    expect(ventana24h('2026-08-20T16:00:00Z', ahora).restanteMin).toBe(60);
    expect(ventana24h('2026-08-20T14:59:00Z', ahora)).toEqual({ abierta: false, restanteMin: 0 });
  });

  it('el restante se muestra legible', () => {
    expect(textoRestante(200)).toBe('3 h 20 m');
    expect(textoRestante(45)).toBe('45 m');
  });
});

describe('detección de intención', () => {
  it('reconoce las cuatro intenciones', () => {
    expect(detectarIntencion('Hola, ya hice el pago, adjunto comprobante')).toBe('comprobante-pago');
    expect(detectarIntencion('quiero un turno para cámara')).toBe('turno-pedido');
    expect(detectarIntencion('¿Cuánto sale la sesión de HBOT?')).toBe('precios');
    expect(detectarIntencion('¿qué horarios tienen?')).toBe('horario-ubicacion');
    expect(detectarIntencion('¿dónde están ubicados?')).toBe('horario-ubicacion');
  });

  it('un adjunto alcanza como pista de pago; sin él hace falta algo explícito', () => {
    expect(detectarIntencion('pago', { conAdjunto: true })).toBe('comprobante-pago');
    // Sin adjunto y sin "ya/adjunto/mando", una pregunta sobre pagos NO es un aviso de pago.
    expect(detectarIntencion('¿cómo puedo pagar?')).toBe('generico');
  });

  it('distingue pedir un turno de preguntar por el turno', () => {
    expect(detectarIntencion('necesito sacar turno')).toBe('turno-pedido');
    expect(detectarIntencion('¿a qué hora era mi turno?')).toBe('turno-consulta');
  });

  it('el pedido de turno gana sobre el precio si están en el mismo mensaje', () => {
    expect(detectarIntencion('quiero un turno, ¿cuánto sale?')).toBe('turno-pedido');
  });

  it('ignora acentos y mayúsculas', () => {
    expect(detectarIntencion('CUÁNTO CUESTA?')).toBe('precios');
  });

  it('HUMANO apaga el bot solo si viene sola, no mencionada al pasar', () => {
    expect(detectarIntencion('HUMANO')).toBe('humano');
    expect(detectarIntencion('humano.')).toBe('humano');
    expect(detectarIntencion('el trato humano es excelente')).not.toBe('humano');
  });

  it('lo que no entiende cae en genérico en vez de adivinar', () => {
    expect(detectarIntencion('buenas, una consulta')).toBe('generico');
  });
});

describe('armado de la respuesta', () => {
  const base = { ahora: viernes('15:00'), esConocido: true, nombre: 'Ana' };

  it('el acuse saluda, avisa que responde una persona y suma el turno próximo', () => {
    const r = armarAutoRespuesta({ ...base, texto: 'hola', proximoTurno: 'el jueves a las 15:00' });
    expect(r?.intencion).toBe('generico');
    expect(r?.texto).toContain('¡Hola Ana!');
    expect(r?.texto).toContain('Enseguida te contacta alguien del equipo.');
    expect(r?.texto).toContain('el jueves a las 15:00');
  });

  it('fuera de horario dice cuándo abre en vez de prometer una respuesta ya', () => {
    const r = armarAutoRespuesta({ ...base, ahora: viernes('22:30'), texto: 'hola' });
    expect(r?.texto).toContain('abrimos mañana a las 08:00');
  });

  it('a un número desconocido le pide nombre, email y DNI opcional, en el ÚLTIMO globo', () => {
    const r = armarAutoRespuesta({ ...base, esConocido: false, nombre: undefined, texto: 'hola' });
    const ultimo = r?.mensajesSiguientes?.at(-1) ?? '';
    expect(ultimo).toContain('Nombre y Apellido:');
    expect(ultimo).toContain('Email:');
    expect(ultimo).toContain('DNI (opcional):');
    // El bloque va con los renglones en blanco tal cual lo definió Andrés.
    expect(ultimo).toContain(`compartinos por favor:\n\n${PEDIDO_DATOS}`);
    // Y la pregunta va SOLO ahí: si estuviera antes, lo que conteste la
    // persona podría llegar entre nuestros globos (2026-09-14).
    expect(r?.texto).not.toContain('Nombre y Apellido');
    expect(r?.mensajesSiguientes?.[0]).not.toContain('Nombre y Apellido');
  });

  // 2026-08-22 es SÁBADO y 2026-08-23 DOMINGO (Argentina = UTC-3).
  const sabado = (hhmmArg: string): Date => {
    const [h, m] = hhmmArg.split(':').map(Number);
    return new Date(Date.UTC(2026, 7, 22, (h as number) + 3, m as number));
  };
  const domingo = (hhmmArg: string): Date => {
    const [h, m] = hhmmArg.split(':').map(Number);
    return new Date(Date.UTC(2026, 7, 23, (h as number) + 3, m as number));
  };
  /** Los tres globos de la bienvenida, en el orden en que salen. */
  const secuencia = (ahora: Date): string[] => {
    const r = armarAutoRespuesta({ ...base, ahora, esConocido: false, nombre: undefined, texto: 'hola' });
    return [r?.texto ?? '', ...(r?.mensajesSiguientes ?? [])];
  };
  const todo = (ahora: Date): string => secuencia(ahora).join('\n');
  const ultimo = (ahora: Date): string => secuencia(ahora).at(-1) ?? '';

  it('con el centro abierto, al desconocido no se le habla de horarios', () => {
    expect(ultimo(viernes('15:00'))).toContain('Para poder asesorarte');
    expect(ultimo(viernes('15:00'))).toContain('Enseguida te contacta alguien del equipo.');
    expect(todo(viernes('15:00'))).not.toContain('estamos cerrados');
    expect(todo(viernes('15:00'))).not.toContain('Horario:');
  });

  it('el domingo avisa que está cerrado, cuándo se responde y el horario — en el globo de la pregunta', () => {
    const r = ultimo(domingo('11:00'));
    expect(r).toContain('Ahora estamos cerrados');
    expect(r).toContain('te respondemos mañana a las 08:00');
    expect(r).toContain('Horario: lunes a viernes de 08:00 a 22:00');
    expect(r).toContain('domingo cerrado');
    // Cerrado o abierto, el saludo es el mismo: lo que cambia es el cierre.
    expect(secuencia(domingo('11:00'))[0]).toBe(secuencia(viernes('15:00'))[0]);
  });

  it('el sábado a la noche NO promete "mañana": el domingo no abre', () => {
    expect(ultimo(sabado('21:00'))).toContain('te respondemos el lunes a las 08:00');
    expect(todo(sabado('21:00'))).not.toContain('mañana');
  });

  it('la bajada de marca va en el saludo, con el 🧬', () => {
    for (const ahora of [viernes('15:00'), domingo('11:00')]) {
      expect(secuencia(ahora)[0]).toContain('Optimización Biológica. 🧬');
    }
  });

  it('al desconocido le siguen dos mensajes de presentación, al conocido ninguno', () => {
    const desconocido = armarAutoRespuesta({ ...base, esConocido: false, nombre: undefined, texto: 'hola' });
    expect(desconocido?.mensajesSiguientes).toHaveLength(2);
    // El que ya está en la base no necesita que le presenten el centro.
    const conocido = armarAutoRespuesta({ ...base, texto: 'hola' });
    expect(conocido?.mensajesSiguientes).toBeUndefined();
  });

  it('la bajada de marca va SOLO en el saludo, no repetida tres segundos después', () => {
    const r = armarAutoRespuesta({ ...base, esConocido: false, nombre: undefined, texto: 'hola' });
    expect(r?.texto).toContain('Longevidad Saludable');
    for (const m of r?.mensajesSiguientes ?? []) {
      expect(m).not.toContain('Longevidad Saludable');
    }
  });

  it('los tres globos, en orden: saludo con Web e Info → la App → la pregunta', () => {
    const r = armarAutoRespuesta({ ...base, esConocido: false, nombre: undefined, texto: 'hola' });
    const [segundo, tercero] = r?.mensajesSiguientes as [string, string];

    expect(r?.texto).toBe(BIENVENIDA_SALUDO);
    expect(segundo).toBe(CTA_APP);
    expect(tercero.startsWith('Para poder asesorarte')).toBe(true);
  });

  it('jerarquía: Web, Info y App con título en negrita y link en su renglón; mapa e Instagram planos', () => {
    const saludo = BIENVENIDA_SALUDO;
    // Destacados: emoji + *título* en un renglón, link SOLO en el siguiente.
    expect(saludo).toContain('🌐 *Conocé Biowellness*\nhttps://www.biowellness.ar');
    expect(saludo).toContain('ℹ️ *Servicios e información*\nhttps://info.biowellness.ar');
    expect(CTA_APP).toMatch(/^📱 \*[^*\n]+\*\n/);
    // Segundo plano: una línea plana cada uno, sin negrita.
    expect(saludo).toContain('\n📍 Mapa: https://maps.app.goo.gl/');
    expect(saludo).not.toMatch(/\*[^*\n]*Mapa/);
    // Instagram con la palabra, no un emoji solo: con "📷 biowellness.ar" no se
    // entendía que era la cuenta de IG (Andrés, 2026-08-23).
    expect(saludo).toContain('Instagram: @biowellness.ar');
    // El email salió a propósito (menos texto; quien escribe por WhatsApp ya nos tiene).
    expect(saludo).not.toContain('info@biowellness.ar');
    // La App NO va en el saludo: tiene su propio globo (y su propia tarjeta).
    expect(saludo).not.toContain('app.biowellness.ar');
  });

  it('la tarjeta de vista previa de cada globo: la Web en el saludo, la App en el segundo', () => {
    const primerLink = (t: string) => t.split('\n').find((l) => l.startsWith('https://'));
    expect(primerLink(BIENVENIDA_SALUDO)).toBe('https://www.biowellness.ar');
    expect(primerLink(CTA_APP)).toBe(APP_URL);
  });

  it('ningún globo se pasa del límite de un mensaje de WhatsApp', () => {
    const r = armarAutoRespuesta({ ...base, esConocido: false, nombre: undefined, texto: 'hola' });
    for (const m of [r?.texto ?? '', ...(r?.mensajesSiguientes ?? [])]) {
      expect(m.length).toBeLessThan(1600);
    }
  });

  it('el comprobante deja aviso a Recepción además de acusar recibo', () => {
    const r = armarAutoRespuesta({ ...base, texto: 'ya pagué, te mando el comprobante', conAdjunto: true });
    expect(r?.intencion).toBe('comprobante-pago');
    expect(r?.texto).toContain('comprobante');
    expect(r?.aviso?.titulo).toContain('Comprobante');
  });

  it('el pedido de turno de un paciente conocido crea la solicitud; el de un desconocido, un aviso', () => {
    const conocido = armarAutoRespuesta({ ...base, texto: 'quiero un turno' });
    expect(conocido?.crearSolicitudTurno).toBe(true);
    expect(conocido?.aviso).toBeUndefined();

    const desconocido = armarAutoRespuesta({ ...base, esConocido: false, texto: 'quiero un turno' });
    expect(desconocido?.crearSolicitudTurno).toBe(false);
    expect(desconocido?.aviso?.titulo).toContain('desconocido');
  });

  it('precios responde con los links publicados y NO cotiza un número', () => {
    const r = armarAutoRespuesta({ ...base, texto: '¿cuánto sale?' });
    expect(r?.texto).toContain('info.biowellness.ar');
    expect(r?.texto).not.toMatch(/\$\s*\d/);
  });

  it('horario y ubicación salen del horario real configurado', () => {
    const r = armarAutoRespuesta({ ...base, texto: '¿dónde quedan?' });
    expect(r?.intencion).toBe('horario-ubicacion');
    expect(r?.texto).toContain('Roque Sáenz Peña 530');
    expect(r?.texto).toContain('lunes a viernes de 08:00 a 22:00');
  });

  it('no repite la MISMA intención dentro de la ventana, pero sí contesta otra distinta', () => {
    const hace10min = new Date(base.ahora.getTime() - 10 * 60_000).toISOString();
    const repetido = armarAutoRespuesta({
      ...base,
      texto: 'hola de nuevo',
      ultima: { intencion: 'generico', cuandoISO: hace10min },
    });
    expect(repetido).toBeUndefined();

    const otra = armarAutoRespuesta({
      ...base,
      texto: 'ya pagué, adjunto comprobante',
      ultima: { intencion: 'generico', cuandoISO: hace10min },
    });
    expect(otra?.intencion).toBe('comprobante-pago');
  });

  it('pasada la ventana anti-repetición vuelve a contestar lo mismo', () => {
    const hace4horas = new Date(base.ahora.getTime() - 4 * 60 * 60_000).toISOString();
    const r = armarAutoRespuesta({
      ...base,
      texto: 'hola',
      ultima: { intencion: 'generico', cuandoISO: hace4horas },
    });
    expect(r?.intencion).toBe('generico');
  });

  it('HUMANO apaga todo lo automático y avisa a Recepción', () => {
    const r = armarAutoRespuesta({ ...base, texto: 'HUMANO' });
    expect(r?.activarSilencio).toBe(true);
    expect(r?.aviso?.titulo).toContain('persona');
  });

  it('con el silencio activo no se manda NADA, ni siquiera el acuse', () => {
    const hace1hora = new Date(base.ahora.getTime() - 60 * 60_000).toISOString();
    expect(armarAutoRespuesta({ ...base, texto: 'hola', silencioDesdeISO: hace1hora })).toBeUndefined();
    expect(
      armarAutoRespuesta({ ...base, texto: 'ya pagué, adjunto comprobante', silencioDesdeISO: hace1hora }),
    ).toBeUndefined();
    // Salvo que insista con la palabra: se le confirma que sigue apagado.
    expect(armarAutoRespuesta({ ...base, texto: 'HUMANO', silencioDesdeISO: hace1hora })?.intencion).toBe('humano');
  });

  it('vencido el silencio, el bot vuelve a responder', () => {
    const hace13horas = new Date(base.ahora.getTime() - 13 * 60 * 60_000).toISOString();
    expect(armarAutoRespuesta({ ...base, texto: 'hola', silencioDesdeISO: hace13horas })?.intencion).toBe('generico');
  });
});

/**
 * Links de catálogo e información (Andrés, 2026-09-14, con la captura del
 * teléfono). Tres cosas que el código tiene que sostener:
 *
 *  - el ORDEN de precios es la escalera comercial (sesión suelta 0 % · paquete
 *    5-15 % · combo 20-22 % · membresía 20-30 % ADEMÁS del combo). No es
 *    cosmético: es lo que la paciente lee como "de lo más caro a lo más
 *    conveniente", y además WhatsApp arma la vista previa con el PRIMER link;
 *  - el formato pone título y link en renglones distintos, porque en el
 *    teléfono la URL larga se parte sola y el renglón queda cortado al medio;
 *  - una pregunta CLÍNICA sobre HBOT no recibe folleto: va a una persona.
 */
describe('auto-respuesta · catálogo, HBOT e información', () => {
  const base = { ahora: viernes('15:00'), esConocido: true, nombre: 'Ana' };
  const lineas = (texto: string) => texto.split('\n');

  it('precios: la escalera va de lista a más conveniente', () => {
    const t = armarAutoRespuesta({ ...base, texto: 'precios' })?.texto ?? '';
    const orden = ['Sesiones:', 'Paquetes de sesiones:', 'Combos:', 'Membresías:', 'Todo el catálogo:'];
    expect(orden.map((o) => t.indexOf(o))).toEqual([...orden.map((o) => t.indexOf(o))].sort((a, b) => a - b));
    expect(orden.every((o) => t.includes(o))).toBe(true);
  });

  it('precios: Sesiones va PRIMERO (es la vista previa que arma WhatsApp)', () => {
    const t = armarAutoRespuesta({ ...base, texto: 'precios' })?.texto ?? '';
    const primerLink = lineas(t).find((l) => l.startsWith('https://'));
    expect(primerLink).toBe('https://info.biowellness.ar/sesiones-m3a5.html');
  });

  it('el link va SOLO en su renglón, nunca pegado al título', () => {
    for (const texto of ['precios', 'camara hiperbarica', 'ihht', 'red light', 'recovery', 'informacion']) {
      const t = armarAutoRespuesta({ ...base, texto })?.texto ?? '';
      for (const l of lineas(t).filter((x) => x.includes('https://'))) {
        expect(l.trim()).toMatch(/^https:\/\/\S+$/);
      }
    }
  });

  it('HBOT manda las tres páginas publicadas', () => {
    const t = armarAutoRespuesta({ ...base, texto: '¿tienen cámara hiperbárica?' })?.texto ?? '';
    expect(t).toContain('https://info.biowellness.ar/hbot.html');
    expect(t).toContain('https://info.biowellness.ar/como-funciona.html');
    expect(t).toContain('https://info.biowellness.ar/guia/hbot/');
  });

  it('una pregunta CLÍNICA sobre HBOT va a una persona, no al folleto', () => {
    // Límite 1 de docs/whatsapp-auto-respuestas.md: lo clínico lo contesta el
    // Director Médico. El bot enlaza material publicado; no responde.
    for (const t of [
      'puedo hacer camara hiperbarica si tengo un stent?',
      'tengo marcapasos, puedo hacer hbot?',
      'es seguro el oxigeno hiperbarico en el embarazo?',
      'hbot con epoc tiene riesgo?',
    ]) {
      expect(detectarIntencion(t)).toBe('generico');
    }
  });

  it('pedir turno de HBOT sigue siendo un pedido de turno, no un folleto', () => {
    // Mismo criterio que `turno-pedido` sobre `precios`: mandar el material
    // perdería la intención de reservar.
    expect(detectarIntencion('quiero un turno de cámara hiperbárica')).toBe('turno-pedido');
    expect(detectarIntencion('cuánto sale la cámara hiperbárica')).toBe('precios');
  });

  it('"información" a secas responde con el índice', () => {
    const r = armarAutoRespuesta({ ...base, texto: 'Información' });
    expect(r?.intencion).toBe('informacion');
    expect(r?.texto).toContain('https://info.biowellness.ar/');
  });
});

/**
 * IHHT — Hipoxia-Hiperoxia Intermitente (Andrés, 2026-09-15). Mismo circuito
 * que HBOT: tres páginas publicadas, cede ante lo clínico, el turno y el
 * precio, y cierra con la App.
 */
describe('auto-respuesta · IHHT', () => {
  const base = { ahora: viernes('15:00'), esConocido: true, nombre: 'Ana' };
  const links = (texto: string) => texto.split('\n').filter((l) => l.startsWith('https://'));

  it('reconoce cómo lo escribe la gente', () => {
    for (const t of [
      'hacen ihht?',
      'IHHT',
      'me interesa la hipoxia',
      'qué es la hipoxia-hiperoxia intermitente',
      'entrenamiento hipóxico',
      'tienen entrenamiento en altura?',
    ]) {
      expect(detectarIntencion(t), t).toBe('ihht');
    }
  });

  it('"intermitente" sola NO alcanza: es demasiado genérica', () => {
    expect(detectarIntencion('tengo un dolor intermitente')).toBe('generico');
    expect(detectarIntencion('vengo de forma intermitente')).toBe('generico');
  });

  it('manda las tres páginas publicadas, la de IHHT primera (es la tarjeta)', () => {
    const r = armarAutoRespuesta({ ...base, texto: 'hacen ihht?' });
    expect(r?.intencion).toBe('ihht');
    expect(r?.texto).toContain('IHHT (Hipoxia-Hiperoxia Intermitente)');
    expect(links(r?.texto ?? '')).toEqual([
      'https://info.biowellness.ar/ihht.html',
      'https://info.biowellness.ar/como-funciona.html',
      'https://info.biowellness.ar/guia/ihht/',
      APP_URL,
    ]);
  });

  it('cierra con la App, al final y con un renglón en blanco antes', () => {
    const t = armarAutoRespuesta({ ...base, texto: 'ihht' })?.texto ?? '';
    expect(t.endsWith(`\n\n${CTA_APP}`)).toBe(true);
    expect(llevaCtaApp('ihht', false)).toBe(true);
  });

  it('una pregunta CLÍNICA sobre IHHT va a una persona, no al folleto', () => {
    for (const t of [
      'puedo hacer ihht con marcapasos?',
      'la hipoxia es segura si tengo epoc?',
      'tengo presion alta, puedo hacer entrenamiento hipoxico?',
    ]) {
      expect(detectarIntencion(t), t).toBe('generico');
    }
  });

  it('pedir turno o precio de IHHT no es un folleto', () => {
    expect(detectarIntencion('quiero un turno de ihht')).toBe('turno-pedido');
    expect(detectarIntencion('cuánto sale la hipoxia?')).toBe('precios');
  });

  it('si nombra HBOT e IHHT en el mismo mensaje, gana HBOT', () => {
    expect(detectarIntencion('hacen cámara hiperbárica e ihht?')).toBe('hbot');
  });
});

/**
 * Red Light — Fotobiomodulación (Andrés, 2026-09-15). Mismo circuito que HBOT
 * e IHHT.
 */
describe('auto-respuesta · Red Light', () => {
  const base = { ahora: viernes('15:00'), esConocido: true, nombre: 'Ana' };
  const links = (texto: string) => texto.split('\n').filter((l) => l.startsWith('https://'));

  it('reconoce cómo lo escribe la gente', () => {
    for (const t of [
      'hacen red light?',
      'Red-Light',
      'redlight',
      'qué es la fotobiomodulación',
      'tienen luz roja?',
      'terapia de luz',
    ]) {
      expect(detectarIntencion(t), t).toBe('red-light');
    }
  });

  it('"infrarrojo" a secas NO es Red Light: "sauna infrarrojo" es el circuito Recovery', () => {
    expect(detectarIntencion('tienen sauna infrarrojo?')).toBe('recovery');
    expect(detectarIntencion('infrarrojo')).toBe('generico');
  });

  it('manda las tres páginas publicadas, la de Red Light primera (es la tarjeta)', () => {
    const r = armarAutoRespuesta({ ...base, texto: 'hacen red light?' });
    expect(r?.intencion).toBe('red-light');
    expect(r?.texto).toContain('Red Light (Fotobiomodulación)');
    expect(links(r?.texto ?? '')).toEqual([
      'https://info.biowellness.ar/red-light.html',
      'https://info.biowellness.ar/como-funciona.html',
      'https://info.biowellness.ar/guia/red-light/',
      APP_URL,
    ]);
  });

  it('cierra con la App, al final', () => {
    const t = armarAutoRespuesta({ ...base, texto: 'luz roja' })?.texto ?? '';
    expect(t.endsWith(`\n\n${CTA_APP}`)).toBe(true);
    expect(llevaCtaApp('red-light', false)).toBe(true);
  });

  it('una pregunta CLÍNICA sobre Red Light va a una persona, no al folleto', () => {
    for (const t of ['puedo hacer red light si tengo cancer?', 'la luz roja tiene riesgo en el embarazo?']) {
      expect(detectarIntencion(t), t).toBe('generico');
    }
  });

  it('pedir turno o precio de Red Light no es un folleto', () => {
    expect(detectarIntencion('quiero un turno de red light')).toBe('turno-pedido');
    expect(detectarIntencion('cuánto sale la fotobiomodulación?')).toBe('precios');
  });

  it('en un empate con HBOT o IHHT, Red Light cede', () => {
    expect(detectarIntencion('hacen hbot y red light?')).toBe('hbot');
    expect(detectarIntencion('ihht o luz roja?')).toBe('ihht');
  });
});

/**
 * Recovery Pro — el circuito de sauna infrarrojo, frío y red light (Andrés,
 * 2026-09-15). Mismo circuito de respuesta que HBOT, IHHT y Red Light.
 */
describe('auto-respuesta · Recovery Pro', () => {
  const base = { ahora: viernes('15:00'), esConocido: true, nombre: 'Ana' };
  const links = (texto: string) => texto.split('\n').filter((l) => l.startsWith('https://'));

  it('reconoce cómo lo escribe la gente', () => {
    for (const t of [
      'hacen recovery?',
      'Recovery Pro',
      'tienen sauna?',
      'sauna infrarrojo',
      'baño de hielo',
      'inmersión en frío',
      'terapia de contraste',
      'circuito recovery',
    ]) {
      expect(detectarIntencion(t), t).toBe('recovery');
    }
  });

  it('"frío" y "crio" a secas NO alcanzan: la Crioterapia Localizada es otro servicio', () => {
    expect(detectarIntencion('hacen crioterapia?')).toBe('generico');
    expect(detectarIntencion('tengo frío en el consultorio')).toBe('generico');
  });

  it('manda las tres páginas publicadas, la de Recovery primera (es la tarjeta)', () => {
    const r = armarAutoRespuesta({ ...base, texto: 'hacen recovery?' });
    expect(r?.intencion).toBe('recovery');
    expect(r?.texto).toContain('Recovery Pro (sauna infrarrojo, frío y red light)');
    expect(links(r?.texto ?? '')).toEqual([
      'https://info.biowellness.ar/recovery-pro.html',
      'https://info.biowellness.ar/como-funciona.html',
      'https://info.biowellness.ar/guia/recovery-pro/',
      APP_URL,
    ]);
  });

  it('cierra con la App, al final', () => {
    const t = armarAutoRespuesta({ ...base, texto: 'sauna' })?.texto ?? '';
    expect(t.endsWith(`\n\n${CTA_APP}`)).toBe(true);
    expect(llevaCtaApp('recovery', false)).toBe(true);
  });

  it('una pregunta CLÍNICA sobre Recovery va a una persona, no al folleto', () => {
    for (const t of ['puedo hacer sauna con presion alta?', 'el baño de hielo es seguro en el embarazo?']) {
      expect(detectarIntencion(t), t).toBe('generico');
    }
  });

  it('pedir turno o precio de Recovery no es un folleto', () => {
    expect(detectarIntencion('quiero un turno de recovery')).toBe('turno-pedido');
    expect(detectarIntencion('cuánto sale el sauna?')).toBe('precios');
  });

  it('Recovery incluye red light: "recovery con red light" es Recovery; HBOT e IHHT le ganan', () => {
    expect(detectarIntencion('el recovery pro incluye red light?')).toBe('recovery');
    expect(detectarIntencion('red light')).toBe('red-light');
    expect(detectarIntencion('hbot o recovery?')).toBe('hbot');
    expect(detectarIntencion('ihht y sauna')).toBe('ihht');
  });
});

/**
 * "¿Dónde están?" (Andrés, 2026-09-15): el mapa pasa al link CORTO (el largo
 * de Google ocupaba tres renglones de %20 en el teléfono), el texto va en
 * bloques con aire, y estacionamiento / "en San Isidro" / cómo llegar entran
 * a propósito en vez de por accidente.
 */
describe('auto-respuesta · dónde están (horario-ubicacion)', () => {
  const base = { ahora: viernes('15:00'), esConocido: true, nombre: 'Ana' };
  const links = (texto: string) => texto.split('\n').filter((l) => l.startsWith('https://'));

  it('dirección + mapa CORTO en su renglón, y el horario en su propio bloque', () => {
    const t = armarAutoRespuesta({ ...base, texto: '¿dónde están?' })?.texto ?? '';
    expect(t).toContain(`📍 ${CENTRO_DIRECCION}\n${CENTRO_MAPA}\n\n🕒 Horario: lunes a viernes de 08:00 a 22:00`);
    expect(t).toContain('Ahora estamos abiertos, te esperamos 👋');
    expect(t).not.toContain('maps.google.com');
    expect(t).not.toContain('%20');
  });

  it('el link del mapa es el corto de Google Maps y es el MISMO que el de la bienvenida', () => {
    expect(CENTRO_MAPA).toMatch(/^https:\/\/maps\.app\.goo\.gl\/[A-Za-z0-9]+$/);
    expect(BIENVENIDA_SALUDO).toContain(`📍 Mapa: ${CENTRO_MAPA}`);
  });

  it('la tarjeta de vista previa es el mapa (primer link); la App cierra', () => {
    const l = links(armarAutoRespuesta({ ...base, texto: 'dirección?' })?.texto ?? '');
    expect(l[0]).toBe(CENTRO_MAPA);
    expect(l.at(-1)).toBe(APP_URL);
  });

  it('cerrado, dice cuándo abre debajo del horario', () => {
    const t = armarAutoRespuesta({ ...base, ahora: viernes('22:30'), texto: 'cómo llego' })?.texto ?? '';
    expect(t).toContain('domingo cerrado.\nAbrimos mañana a las 08:00.');
    expect(t).not.toContain('te esperamos');
  });

  it('estacionamiento, "en San Isidro" y cómo llegar disparan la misma respuesta, a propósito', () => {
    for (const t of [
      '¿dónde estacionar?',
      'tienen estacionamiento?',
      'cerca de la estación?',
      'están en san isidro?',
      'cómo llegar en tren?',
      'se puede ir en colectivo?',
      'dónde está el centro',
    ]) {
      expect(detectarIntencion(t), t).toBe('horario-ubicacion');
    }
  });

  it('"cómo llegar" sale SOLO si hay texto cargado (hoy no hay: lo tiene que dar Andrés)', () => {
    const t = armarAutoRespuesta({ ...base, texto: '¿dónde están?' })?.texto ?? '';
    if (CENTRO_COMO_LLEGAR.length === 0) {
      expect(t).not.toContain('Cómo llegar');
    } else {
      expect(t).toContain(`\n\n🚗 Cómo llegar:\n${CENTRO_COMO_LLEGAR.join('\n')}`);
    }
  });
});

/**
 * La frase "cuándo te responden" dentro de una oración, con el centro cerrado
 * (captura de producción, 2026-09-15: "…ahora estamos cerrados: abrimos mañana
 * a las 08:00 y te respondemos. por favor, dejanos tu nombre y apellido para
 * contactarte" — a una paciente saludada por su nombre, y con minúscula
 * después del punto).
 */
describe('auto-respuesta · "estamos cerrados" dentro de una frase', () => {
  const cerrado = { ahora: viernes('22:30'), nombre: 'Ana' };

  it('a la paciente conocida NO se le piden nombre y apellido: la saludamos por su nombre', () => {
    for (const texto of ['hacen ihht?', 'precios', 'red light']) {
      const t = armarAutoRespuesta({ ...cerrado, esConocido: true, texto })?.texto ?? '';
      // La frase va después de una coma ("…en particular, ahora…" / "…a medida,
      // ahora…"): primera letra en minúscula, y termina en punto.
      expect(t, texto).toContain(', ahora estamos cerrados: abrimos mañana a las 08:00 y te respondemos.');
      expect(t, texto).not.toContain('dejanos tu nombre');
    }
  });

  it('al desconocido sí, con mayúscula después del punto y punto final', () => {
    const t = armarAutoRespuesta({ ...cerrado, esConocido: false, nombre: undefined, texto: 'hacen ihht?' })?.texto ?? '';
    expect(t).toContain('y te respondemos. Por favor, dejanos tu nombre y apellido para contactarte.');
    // Ninguna minúscula después de un punto y un espacio, en todo el mensaje.
    expect(t).not.toMatch(/\. [a-záéíóú]/);
  });

  it('abierto, la frase sigue igual que siempre', () => {
    const t = armarAutoRespuesta({ ahora: viernes('15:00'), esConocido: true, nombre: 'Ana', texto: 'precios' })?.texto ?? '';
    expect(t).toContain('a medida, enseguida te contacta alguien del equipo.');
  });
});

describe('auto-respuesta · el cierre con la App (autogestión)', () => {
  const base = { ahora: viernes('15:00'), esConocido: true, nombre: 'Ana' };
  const links = (texto: string) => texto.split('\n').filter((l) => l.startsWith('https://'));

  // Una frase por intención, sacadas de los tests de detección de arriba.
  const unaPorIntencion: Array<[string, string]> = [
    ['comprobante-pago', 'Hola, ya hice el pago, adjunto comprobante'],
    ['turno-pedido', 'quiero un turno para cámara'],
    ['turno-consulta', '¿a qué hora era mi turno?'],
    ['precios', '¿Cuánto sale la sesión de HBOT?'],
    ['hbot', '¿tienen cámara hiperbárica?'],
    ['ihht', '¿hacen IHHT?'],
    ['red-light', '¿hacen Red Light?'],
    ['recovery', '¿hacen Recovery?'],
    ['informacion', 'Información'],
    ['horario-ubicacion', '¿qué horarios tienen?'],
    ['generico', 'buenas, una consulta'],
  ];

  it('cierra TODAS las respuestas a un conocido (once intenciones), al final y con un renglón en blanco antes', () => {
    for (const [intencion, texto] of unaPorIntencion) {
      const r = armarAutoRespuesta({ ...base, texto });
      expect(r?.intencion, texto).toBe(intencion);
      expect(r?.texto.endsWith(`\n\n${CTA_APP}`), texto).toBe(true);
      // "Uno o dos espacios": un renglón en blanco, nunca dos (Andrés, 2026-09-14).
      expect(r?.texto, texto).not.toContain('\n\n\n');
    }
  });

  it('la App es el ÚLTIMO link: no le roba la tarjeta de vista previa a Sesiones ni a HBOT', () => {
    for (const texto of ['precios', 'camara hiperbarica', 'informacion', 'horarios']) {
      const l = links(armarAutoRespuesta({ ...base, texto })?.texto ?? '');
      expect(l.length, texto).toBeGreaterThan(1);
      expect(l.at(-1), texto).toBe(APP_URL);
      expect(l[0], texto).not.toBe(APP_URL);
    }
  });

  it('en las respuestas sin links, la App queda como único link (y se lleva la tarjeta)', () => {
    for (const texto of ['buenas, una consulta', 'quiero un turno para cámara', 'ya hice el pago, adjunto comprobante']) {
      expect(links(armarAutoRespuesta({ ...base, texto })?.texto ?? ''), texto).toEqual([APP_URL]);
    }
  });

  it('a quien escribió HUMANO no se le vende nada', () => {
    const r = armarAutoRespuesta({ ...base, texto: 'HUMANO' });
    expect(r?.intencion).toBe('humano');
    expect(r?.activarSilencio).toBe(true);
    expect(r?.texto).not.toContain(APP_URL);
  });

  it('al número desconocido la App le llega UNA vez: en la bienvenida, no en el saludo', () => {
    const r = armarAutoRespuesta({ ...base, esConocido: false, nombre: undefined, texto: 'hola' });
    expect(r?.intencion).toBe('generico');
    expect(r?.texto).not.toContain(CTA_APP);
    const todo = [r?.texto ?? '', ...(r?.mensajesSiguientes ?? [])].join('\n');
    expect(todo.split(APP_URL).length - 1).toBe(1);
  });

  it('un pedido de turno de un número desconocido SÍ lleva la App: ahí no hay bienvenida', () => {
    const r = armarAutoRespuesta({ ...base, esConocido: false, nombre: undefined, texto: 'necesito sacar turno' });
    expect(r?.intencion).toBe('turno-pedido');
    expect(r?.mensajesSiguientes).toBeUndefined();
    expect(r?.texto.endsWith(CTA_APP)).toBe(true);
  });

  it('la regla, explícita: solo HUMANO y el genérico a desconocido quedan afuera', () => {
    expect(llevaCtaApp('humano', true)).toBe(false);
    expect(llevaCtaApp('humano', false)).toBe(false);
    expect(llevaCtaApp('generico', false)).toBe(false);
    expect(llevaCtaApp('generico', true)).toBe(true);
    expect(llevaCtaApp('precios', false)).toBe(true);
    expect(llevaCtaApp('turno-pedido', false)).toBe(true);
  });

  it('el cierre nombra la autogestión: título en negrita, imperativos, link solo abajo (misma URL que el portal)', () => {
    const renglones = CTA_APP.split('\n');
    expect(renglones).toHaveLength(3);
    expect(renglones[0]).toMatch(/^📱 \*Autogestión[^*]*\*$/);
    expect(renglones[1]).toMatch(/^Pedí .*escribinos/);
    expect(renglones[2]).toBe(APP_URL);
    expect(APP_URL).toBe(PORTAL_URL);
  });

  it('el silencio pedido y la anti-repetición siguen mandando: sin respuesta no hay cierre', () => {
    const enSilencio = armarAutoRespuesta({ ...base, texto: 'precios', silencioDesdeISO: base.ahora.toISOString() });
    expect(enSilencio).toBeUndefined();
    const repetida = armarAutoRespuesta({
      ...base,
      texto: 'precios',
      ultima: { intencion: 'precios', cuandoISO: base.ahora.toISOString() },
    });
    expect(repetida).toBeUndefined();
  });
});
