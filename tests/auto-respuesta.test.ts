import { describe, expect, it } from 'vitest';
import {
  armarAutoRespuesta,
  detectarIntencion,
  estaAbierto,
  partesArgentina,
  textoHorarioSemanal,
  textoProximaApertura,
  textoRestante,
  ventana24h,
} from '../src/lib/auto-respuesta.js';

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

  it('a un número desconocido le pide nombre y email para poder asesorarlo', () => {
    const r = armarAutoRespuesta({ ...base, esConocido: false, nombre: undefined, texto: 'hola' });
    expect(r?.texto).toContain('Nombre y Apellido:');
    expect(r?.texto).toContain('Email:');
    // El bloque va con los renglones en blanco tal cual los definió Andrés.
    expect(r?.texto).toContain('compartinos por favor:\n\nNombre y Apellido:\nEmail:');
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
  const aDesconocido = (ahora: Date): string =>
    armarAutoRespuesta({ ...base, ahora, esConocido: false, nombre: undefined, texto: 'hola' })
      ?.texto ?? '';

  it('con el centro abierto, al desconocido no se le habla de horarios', () => {
    const r = aDesconocido(viernes('15:00'));
    expect(r).toContain('Para poder asesorarte');
    expect(r).not.toContain('estamos cerrados');
    expect(r).not.toContain('Horario:');
  });

  it('el domingo avisa que está cerrado, cuándo se responde y el horario', () => {
    const r = aDesconocido(domingo('11:00'));
    expect(r).toContain('Ahora estamos cerrados');
    expect(r).toContain('te respondemos mañana a las 08:00');
    expect(r).toContain('Horario: lunes a viernes de 08:00 a 22:00');
    expect(r).toContain('domingo cerrado');
  });

  it('el sábado a la noche NO promete "mañana": el domingo no abre', () => {
    const r = aDesconocido(sabado('21:00'));
    expect(r).toContain('te respondemos el lunes a las 08:00');
    expect(r).not.toContain('mañana');
  });

  it('la firma lleva el 🧬 al final', () => {
    for (const ahora of [viernes('15:00'), domingo('11:00')]) {
      expect(aDesconocido(ahora)).toContain('Optimización Biológica. 🧬');
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

  it('los links van repartidos: web y mapa en uno, app e info en el otro', () => {
    const [segundo, tercero] = armarAutoRespuesta({
      ...base,
      esConocido: false,
      nombre: undefined,
      texto: 'hola',
    })?.mensajesSiguientes as [string, string];

    expect(segundo).toContain('Web: https://www.biowellness.ar');
    expect(segundo).toContain('Mapa: ');
    expect(segundo).not.toContain('app.biowellness.ar');

    // Cada link con su título, para que se entienda a qué entra cada uno.
    expect(tercero).toContain('Autogestión y App del usuario\nApp: https://app.biowellness.ar');
    expect(tercero).toContain('Información sobre nuestros servicios\nInfo: https://info.biowellness.ar');
    // Instagram con la palabra, no un emoji: con "📷 biowellness.ar" no se
    // entendía que era la cuenta de IG (Andrés, 2026-08-23).
    expect(tercero).toContain('Instagram: @biowellness.ar');
    expect(tercero).toContain('Email: info@biowellness.ar');
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
    for (const texto of ['precios', 'camara hiperbarica', 'informacion']) {
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
