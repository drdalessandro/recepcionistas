/**
 * Los once casos que el motor de agenda tiene que cumplir sí o sí.
 *
 * Esto es la especificación ejecutable: cada `describe` es uno de los casos
 * pedidos, con el enunciado textual arriba. Si alguno se cae, el motor está mal,
 * no el test.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENDA_VACIA,
  aplicarPausa,
  conOcupaciones,
  cotizarMembresia,
  cotizarServicio,
  evaluarReserva,
  expandir,
  instanteLocal,
  compilarConfig,
  configSanIsidro,
  LISTA_2026_08,
  minutosEntre,
  type Cliente,
  type VersionListaPrecios,
} from '../../src/motor-agenda/index.js';
import {
  agendaCon,
  clientePublico,
  codigosDeRechazo,
  dosHorasAntes,
  lunes,
  motorDePrueba,
  ocupar,
  RELOJ,
  titularidadActiva,
} from './ayudas.js';

// ═══════════════════════════════════════════════════════════════════════════
describe('Caso 1 — BIO ENERGY de 10:00 a 11:00 impide una Red Light suelta de 10:30 a 11:00', () => {
  // El combo no es un bloque opaco: su segundo tramo ocupa una tumbona de 10:30
  // a 11:00, y esa tumbona tiene que desaparecer del pool en esa ventana.

  it('el tramo de tumbona del combo cae exactamente en 10:30–11:00', () => {
    const motor = motorDePrueba();
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_ENERGY' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const tumbona = plan.valor.tramos.find((t) => t.tipoRecurso === 'tumbona-red-light');
    expect(tumbona).toBeDefined();
    expect(tumbona?.offsetMin).toBe(30);
    expect(tumbona?.inicio).toEqual(lunes(10, 30));
    expect(tumbona?.finRecurso).toEqual(lunes(11, 0));
    // Y ocupa una tumbona concreta, no una idea de tumbona.
    expect(tumbona?.unidades).toHaveLength(1);
  });

  it('con una sola tumbona en el pool, la suelta de 10:30 se rechaza', () => {
    // El pool se achica a una para que la colisión sea inequívoca. La cantidad
    // de unidades es configuración, así que el test la baja sin tocar el motor.
    const motor = motorDePrueba({ tumbonasEnSala: 0, tumbonasStandalone: 1 });

    const combo = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_ENERGY' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(combo.ok).toBe(true);
    if (!combo.ok) return;

    const agenda = conOcupaciones(AGENDA_VACIA, combo.valor.ocupaciones);

    const suelta = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'RED_LIGHT' },
      inicio: lunes(10, 30),
      ocupantes: 1,
      agenda,
    });
    expect(suelta.ok).toBe(false);
    expect(codigosDeRechazo(suelta)).toContain('SIN_TUMBONA_DISPONIBLE');
  });

  it('pero la misma suelta a las 10:00 entra: el combo todavía está en el IHHT', () => {
    // Este es el control que prueba que el rechazo anterior no es «el combo
    // bloquea una hora entera», sino «el tramo de tumbona va de 10:30 a 11:00».
    const motor = motorDePrueba({ tumbonasEnSala: 0, tumbonasStandalone: 1 });

    const combo = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_ENERGY' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(combo.ok).toBe(true);
    if (!combo.ok) return;

    const suelta = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'RED_LIGHT' },
      inicio: lunes(10, 0),
      ocupantes: 1,
      agenda: conOcupaciones(AGENDA_VACIA, combo.valor.ocupaciones),
    });
    expect(suelta.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Caso 2 — Gabinete 1 a las 10:00 y Gabinete 2 a las 10:30, ambos con 2 personas, conviven', () => {
  // R-07 revisada: el desfasaje de 30 minutos no está escrito en ninguna parte.
  // Emerge de que Recovery Pro toma una tumbona del minuto 28 al 48 y de que el
  // sub-pool de la sala tiene dos.

  it('los dos gabinetes con dos personas cada uno no colisionan en el pool', () => {
    const motor = motorDePrueba();

    const primero = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'RECOVERY_PRO' },
      inicio: lunes(10),
      ocupantes: 2,
      agenda: AGENDA_VACIA,
    });
    expect(primero.ok).toBe(true);
    if (!primero.ok) return;

    const segundo = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'RECOVERY_PRO' },
      inicio: lunes(10, 30),
      ocupantes: 2,
      agenda: conOcupaciones(AGENDA_VACIA, primero.valor.ocupaciones),
    });
    expect(segundo.ok).toBe(true);
    if (!segundo.ok) return;

    // Gabinetes distintos.
    expect(primero.valor.tramos[0]?.unidades).not.toEqual(segundo.valor.tramos[0]?.unidades);

    // Y las ventanas de tumbona no se tocan: 10:28–10:48 contra 10:58–11:18.
    const luz = (plan: typeof primero) =>
      plan.ok ? plan.valor.ocupaciones.filter((o) => o.tipoRecurso === 'tumbona-red-light') : [];

    const luzPrimero = luz(primero);
    const luzSegundo = luz(segundo);
    expect(luzPrimero).toHaveLength(2);
    expect(luzSegundo).toHaveLength(2);
    expect(luzPrimero[0]?.inicio).toEqual(lunes(10, 28));
    expect(luzPrimero[0]?.fin).toEqual(lunes(10, 48));
    expect(luzSegundo[0]?.inicio).toEqual(lunes(10, 58));
    expect(luzSegundo[0]?.fin).toEqual(lunes(11, 18));
  });

  it('sin el desfasaje sí colisionan: dos gabinetes con dos personas a la misma hora no entran', () => {
    // La contracara del caso anterior, y la prueba de que el desfasaje no está
    // hardcodeado: si estuviera, esto también pasaría.
    const motor = motorDePrueba();

    const primero = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'RECOVERY_PRO' },
      inicio: lunes(10),
      ocupantes: 2,
      agenda: AGENDA_VACIA,
    });
    expect(primero.ok).toBe(true);
    if (!primero.ok) return;

    const simultaneo = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'RECOVERY_PRO' },
      inicio: lunes(10),
      ocupantes: 2,
      agenda: conOcupaciones(AGENDA_VACIA, primero.valor.ocupaciones),
    });
    expect(simultaneo.ok).toBe(false);
    // Se cae en el pool de tumbonas, no en el gabinete: el gabinete 2 está libre.
    expect(codigosDeRechazo(simultaneo)).toContain('TUMBONA_STANDALONE_PROHIBIDA');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Caso 3 — Recovery Pro nunca recibe la tumbona standalone, ni siendo la única libre', () => {
  it('se rechaza aunque el área común esté disponible', () => {
    const motor = motorDePrueba();

    // Las dos tumbonas de la sala, tomadas justo en la ventana de luz roja del
    // gabinete (10:28–10:48). La standalone queda libre.
    const agenda = agendaCon(
      ocupar('RL-SALA-1', lunes(10, 30), 30),
      ocupar('RL-SALA-2', lunes(10, 30), 30),
    );

    const plan = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'RECOVERY_PRO' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda,
    });

    expect(plan.ok).toBe(false);
    expect(codigosDeRechazo(plan)).toContain('TUMBONA_STANDALONE_PROHIBIDA');
    if (plan.ok) return;
    // El mensaje tiene que explicarle a recepción por qué rechaza algo que
    // desde el mostrador parece disponible.
    expect(plan.rechazos[0]?.mensaje).toMatch(/gabinete privado/i);
  });

  it('con las dos tumbonas de sala libres, el mismo turno entra', () => {
    const motor = motorDePrueba();
    const plan = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'RECOVERY_PRO' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const luz = plan.valor.ocupaciones.find((o) => o.tipoRecurso === 'tumbona-red-light');
    expect(luz?.unidadId).toMatch(/^RL-SALA-/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Caso 4 — BIO ENERGY puede tomar una tumbona de la sala Recovery Pro si está libre', () => {
  it('con la standalone ocupada, el combo usa una de la sala', () => {
    const motor = motorDePrueba();

    // La standalone, tomada durante todo el tramo de tumbona del combo.
    const agenda = agendaCon(ocupar('RL-STANDALONE', lunes(10, 30), 30));

    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_ENERGY' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const tumbona = plan.valor.tramos.find((t) => t.tipoRecurso === 'tumbona-red-light');
    expect(tumbona?.unidades[0]).toMatch(/^RL-SALA-/);
  });

  it('con todo libre prefiere la standalone, para no quitarle a Recovery Pro su única opción', () => {
    const motor = motorDePrueba();
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_ENERGY' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const tumbona = plan.valor.tramos.find((t) => t.tipoRecurso === 'tumbona-red-light');
    expect(tumbona?.unidades[0]).toBe('RL-STANDALONE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Caso 5 — Multiplaza con 1 ocupante habilita, a USD 80', () => {
  it('la reserva se acepta sin piso de sesión', () => {
    const motor = motorDePrueba();
    const plan = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'HBOT_MULTIPLAZA' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // Ocupa una plaza de las seis; las otras cinco quedan disponibles.
    expect(plan.valor.ocupaciones[0]?.plazas).toBe(1);
  });

  it('cotiza USD 80', () => {
    const motor = motorDePrueba();
    const cotizacion = cotizarServicio({
      motor,
      servicio: 'HBOT_MULTIPLAZA',
      ocupantes: 1,
      cliente: clientePublico(),
      ahora: lunes(8),
    });
    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.porPersonaUsd).toBe(80);
    expect(cotizacion.valor.totalUsd).toBe(80);
  });

  it('R-06: otro cliente puede sumarse a la misma tanda hasta el inicio', () => {
    const motor = motorDePrueba();
    const primero = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'HBOT_MULTIPLAZA' },
      inicio: lunes(10),
      ocupantes: 1,
      agenda: AGENDA_VACIA,
    });
    expect(primero.ok).toBe(true);
    if (!primero.ok) return;

    const segundo = expandir({
      motor,
      producto: { tipo: 'suelta', codigo: 'HBOT_MULTIPLAZA' },
      inicio: lunes(10),
      ocupantes: 3,
      agenda: conOcupaciones(AGENDA_VACIA, primero.valor.ocupaciones),
    });
    expect(segundo.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Caso 6 — BIO OXYGEN sobre multiplaza con 4 ocupantes se rechaza por falta de puestos IHHT', () => {
  it('rechaza el encadenamiento y dice cuántos lugares faltan', () => {
    const motor = motorDePrueba();
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10),
      ocupantes: 4,
      agenda: AGENDA_VACIA,
      seleccion: { 1: 'HBOT_MULTIPLAZA' },
    });

    expect(plan.ok).toBe(false);
    expect(codigosDeRechazo(plan)).toContain('ENCADENAMIENTO_SIN_CAPACIDAD');
    if (plan.ok) return;
    expect(plan.rechazos[0]?.detalle).toMatchObject({
      recurso: 'ihht',
      ocupantes: 4,
      lugaresDisponibles: 2,
    });
  });

  it('la combinación que sí encadena es biplaza con 2 personas hacia 2 puestos de IHHT', () => {
    // Y sale sola: nadie le dijo al motor que prefiera la biplaza. Con dos
    // ocupantes, la monoplaza no los admite y la biplaza es la siguiente.
    const motor = motorDePrueba();
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10),
      ocupantes: 2,
      agenda: AGENDA_VACIA,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.valor.tramos[0]?.servicio).toBe('HBOT_BIPLAZA');
    expect(plan.valor.tramos[1]?.unidades).toEqual(['IHHT-1', 'IHHT-2']);
  });

  it('multiplaza con 2 ocupantes sí encadena: la restricción es de capacidad, no de cámara', () => {
    const motor = motorDePrueba();
    const plan = expandir({
      motor,
      producto: { tipo: 'combo', codigo: 'BIO_OXYGEN' },
      inicio: lunes(10),
      ocupantes: 2,
      agenda: AGENDA_VACIA,
      seleccion: { 1: 'HBOT_MULTIPLAZA' },
    });
    expect(plan.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Caso 7 — Un FM que pasa de FOCUS a HEALTHSPAN cotiza contra la lista de su inscripción', () => {
  // La lista de 2028 sube todo. El FM inscripto en agosto de 2026 no la ve.
  const LISTA_2028: VersionListaPrecios = {
    ...LISTA_2026_08,
    version: '2028-01',
    vigenteDesde: instanteLocal(2028, 1, 1, 0, 0, RELOJ),
    membresias: LISTA_2026_08.membresias.map((p) => ({
      ...p,
      precioBaseUsd: p.precioBaseUsd * 2,
    })),
  };

  const motorConDosListas = compilarConfig({
    ...configSanIsidro(),
    listasPrecios: [
      { ...LISTA_2026_08, vigenteHasta: instanteLocal(2028, 1, 1, 0, 0, RELOJ) },
      LISTA_2028,
    ],
  });

  const enDosMilVeintiocho = instanteLocal(2028, 6, 15, 10, 0, RELOJ);

  const fundador: Cliente = clientePublico({
    id: 'fundador-7',
    categoria: 'miembro-standard',
    tagFoundingMember: true,
    fmVersionListaPrecios: '2026-08',
    titularidad: titularidadActiva({ membresia: 'HEALTHSPAN' }),
  });

  it('paga el HEALTHSPAN de agosto de 2026, un producto que ni contrató entonces', () => {
    const cotizacion = cotizarMembresia({
      motor: motorConDosListas,
      membresia: 'HEALTHSPAN',
      modalidad: 'standard',
      formato: 'individual',
      plazo: 'trimestral',
      cliente: fundador,
      ahora: enDosMilVeintiocho,
    });

    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.totalUsd).toBe(2184);
    expect(cotizacion.valor.versionLista).toBe('2026-08');
    expect(cotizacion.valor.motivoVersion).toBe('lista-congelada-fm');
  });

  it('un cliente sin el tag paga la lista vigente de 2028', () => {
    const cotizacion = cotizarMembresia({
      motor: motorConDosListas,
      membresia: 'HEALTHSPAN',
      modalidad: 'standard',
      formato: 'individual',
      plazo: 'trimestral',
      cliente: clientePublico({ categoria: 'miembro-standard' }),
      ahora: enDosMilVeintiocho,
    });

    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.totalUsd).toBe(4368);
    expect(cotizacion.valor.versionLista).toBe('2028-01');
  });

  it('un FM sin membresía vigente pierde el beneficio: R-09 exige membresía', () => {
    const caduco: Cliente = { ...fundador, titularidad: undefined };
    const cotizacion = cotizarMembresia({
      motor: motorConDosListas,
      membresia: 'HEALTHSPAN',
      modalidad: 'standard',
      formato: 'individual',
      plazo: 'trimestral',
      cliente: caduco,
      ahora: enDosMilVeintiocho,
    });

    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.versionLista).toBe('2028-01');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Caso 8 — El miembro Standard no reserva con más de 72 h; el FM llega a 7 días', () => {
  const motor = motorDePrueba();
  const turno = lunes(10);

  function reservar(cliente: Cliente, horasDeAnticipacion: number) {
    return evaluarReserva({
      motor,
      agenda: AGENDA_VACIA,
      solicitud: {
        producto: { tipo: 'suelta', codigo: 'HBOT_MULTIPLAZA' },
        inicio: turno,
        ocupantes: 1,
        cliente,
        ahora: new Date(turno.getTime() - horasDeAnticipacion * 60 * 60_000),
      },
    });
  }

  const standard = clientePublico({
    categoria: 'miembro-standard',
    titularidad: titularidadActiva(),
  });

  it('el Standard entra a 72 h', () => {
    expect(reservar(standard, 72).ok).toBe(true);
  });

  it('el Standard no entra a 73 h', () => {
    const resultado = reservar(standard, 73);
    expect(resultado.ok).toBe(false);
    expect(codigosDeRechazo(resultado)).toContain('VENTANA_RESERVA_EXCEDIDA');
  });

  it('el Founding Member entra a 7 días', () => {
    const fundador = clientePublico({
      categoria: 'miembro-standard',
      tagFoundingMember: true,
      titularidad: titularidadActiva(),
    });
    expect(reservar(fundador, 7 * 24).ok).toBe(true);
  });

  it('el Founding Member tampoco pasa de 7 días', () => {
    const fundador = clientePublico({
      categoria: 'miembro-standard',
      tagFoundingMember: true,
      titularidad: titularidadActiva(),
    });
    const resultado = reservar(fundador, 7 * 24 + 1);
    expect(resultado.ok).toBe(false);
    expect(codigosDeRechazo(resultado)).toContain('VENTANA_RESERVA_EXCEDIDA');
  });

  it('el tag caduco no habilita la ventana de 7 días', () => {
    // R-09 revisada con consecuencias: sin membresía vigente, el fundador
    // reserva como el público general.
    const caduco = clientePublico({ categoria: 'publico', tagFoundingMember: true });
    const resultado = reservar(caduco, 7 * 24);
    expect(resultado.ok).toBe(false);
    expect(codigosDeRechazo(resultado)).toContain('VENTANA_RESERVA_EXCEDIDA');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Caso 9 — Una reserva de IV sin autorización médica activa se rechaza', () => {
  const motor = motorDePrueba();
  // Dentro de la franja clínica, para que el único problema sea la autorización.
  const turno = lunes(14);

  function reservarIv(cliente: Cliente) {
    return evaluarReserva({
      motor,
      agenda: AGENDA_VACIA,
      solicitud: {
        producto: { tipo: 'suelta', codigo: 'IV_THERAPY' },
        inicio: turno,
        ocupantes: 1,
        cliente,
        ahora: dosHorasAntes(turno),
        programa: 'clinico',
      },
    });
  }

  it('sin ninguna autorización registrada', () => {
    const resultado = reservarIv(clientePublico());
    expect(resultado.ok).toBe(false);
    expect(codigosDeRechazo(resultado)).toContain('SIN_AUTORIZACION_MEDICA');
  });

  it('con la autorización vencida antes del turno', () => {
    const conVencida = clientePublico({
      autorizaciones: [
        {
          servicio: 'IV_THERAPY',
          vigenteDesde: instanteLocal(2026, 1, 1, 0, 0, RELOJ),
          vigenteHasta: instanteLocal(2026, 8, 1, 0, 0, RELOJ),
          autorizadaPor: 'Dr. López Alonso',
        },
      ],
    });
    const resultado = reservarIv(conVencida);
    expect(resultado.ok).toBe(false);
    expect(codigosDeRechazo(resultado)).toContain('SIN_AUTORIZACION_MEDICA');
    if (resultado.ok) return;
    const rechazo = resultado.rechazos.find((r) => r.codigo === 'SIN_AUTORIZACION_MEDICA');
    expect(rechazo?.mensaje).toMatch(/venció/i);
    expect(rechazo?.regla).toBe('R-03');
  });

  it('con autorización vigente ya no se rechaza por R-03', () => {
    const autorizado = clientePublico({
      autorizaciones: [
        {
          servicio: 'IV_THERAPY',
          vigenteDesde: instanteLocal(2026, 1, 1, 0, 0, RELOJ),
          vigenteHasta: instanteLocal(2027, 1, 1, 0, 0, RELOJ),
          autorizadaPor: 'Dr. López Alonso',
        },
      ],
    });
    // Sigue sin poder agendarse, pero por otro motivo: el puesto IV todavía no
    // tiene tiempos medidos. Es exactamente lo que tiene que pasar — no hay
    // default silencioso.
    const resultado = reservarIv(autorizado);
    expect(codigosDeRechazo(resultado)).not.toContain('SIN_AUTORIZACION_MEDICA');
    expect(codigosDeRechazo(resultado)).toContain('RECURSO_SIN_TIEMPOS');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Caso 10 — Una reserva clínica a las 18:00 se rechaza por estar fuera de la franja', () => {
  const motor = motorDePrueba();

  it('un turno del programa clínico a las 18:00 cae fuera', () => {
    const turno = lunes(18);
    const resultado = evaluarReserva({
      motor,
      agenda: AGENDA_VACIA,
      solicitud: {
        producto: { tipo: 'suelta', codigo: 'HBOT_MULTIPLAZA' },
        inicio: turno,
        ocupantes: 1,
        cliente: clientePublico(),
        ahora: dosHorasAntes(turno),
        programa: 'clinico',
      },
    });

    expect(resultado.ok).toBe(false);
    expect(codigosDeRechazo(resultado)).toContain('FUERA_DE_FRANJA_CLINICA');
  });

  it('el mismo turno a las 14:00 entra', () => {
    const turno = lunes(14);
    const resultado = evaluarReserva({
      motor,
      agenda: AGENDA_VACIA,
      solicitud: {
        producto: { tipo: 'suelta', codigo: 'HBOT_MULTIPLAZA' },
        inicio: turno,
        ocupantes: 1,
        cliente: clientePublico(),
        ahora: dosHorasAntes(turno),
        programa: 'clinico',
      },
    });
    expect(resultado.ok).toBe(true);
  });

  it('el último turno arranca 16:00 y termina 17:00; a las 16:30 ya no entra', () => {
    const turno = lunes(16, 30);
    const resultado = evaluarReserva({
      motor,
      agenda: AGENDA_VACIA,
      solicitud: {
        producto: { tipo: 'suelta', codigo: 'HBOT_MULTIPLAZA' },
        inicio: turno,
        ocupantes: 1,
        cliente: clientePublico(),
        ahora: dosHorasAntes(turno),
        programa: 'clinico',
      },
    });
    expect(resultado.ok).toBe(false);
    expect(codigosDeRechazo(resultado)).toContain('FUERA_DE_FRANJA_CLINICA');
  });

  it('la franja no restringe qué cámara se usa: la multiplaza entra igual', () => {
    // Explícito porque el enunciado lo aclara: el equipo hiperbárico elige.
    const turno = lunes(13);
    for (const camara of ['HBOT_MONOPLAZA', 'HBOT_BIPLAZA', 'HBOT_MULTIPLAZA']) {
      const resultado = evaluarReserva({
        motor,
        agenda: AGENDA_VACIA,
        solicitud: {
          producto: { tipo: 'suelta', codigo: camara },
          inicio: turno,
          ocupantes: 1,
          cliente: clientePublico(),
          ahora: dosHorasAntes(turno),
          programa: 'clinico',
        },
      });
      expect(codigosDeRechazo(resultado)).not.toContain('FUERA_DE_FRANJA_CLINICA');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Caso 11 — Una pausa de 15 días baja las sesiones de 8 a 4 y corre la renovación 15 días', () => {
  const motor = motorDePrueba();

  it('el efecto es proporcional en las dos puntas', () => {
    const titularidad = titularidadActiva({
      sesionesAsignadas: 8,
      finCiclo: instanteLocal(2027, 1, 31, 23, 59, RELOJ),
    });

    const resultado = aplicarPausa(
      titularidad,
      {
        inicio: instanteLocal(2027, 1, 10, 0, 0, RELOJ),
        fin: instanteLocal(2027, 1, 25, 0, 0, RELOJ),
        declaradaEn: instanteLocal(2026, 12, 1, 0, 0, RELOJ),
      },
      motor.config.pausa,
      RELOJ,
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.valor.sesionesAsignadas).toBe(4);
    expect(resultado.valor.estado).toBe('pausada');
    expect(minutosEntre(titularidad.finCiclo, resultado.valor.finCiclo) / (60 * 24)).toBe(15);
  });

  it('un bloque de 10 días no llega al mínimo de 15', () => {
    const resultado = aplicarPausa(
      titularidadActiva(),
      {
        inicio: instanteLocal(2027, 1, 10, 0, 0, RELOJ),
        fin: instanteLocal(2027, 1, 20, 0, 0, RELOJ),
        declaradaEn: instanteLocal(2026, 12, 1, 0, 0, RELOJ),
      },
      motor.config.pausa,
      RELOJ,
    );
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.rechazos[0]?.mensaje).toMatch(/bloque mínimo/i);
  });

  it('marzo está fuera de las ventanas de enero y julio', () => {
    const resultado = aplicarPausa(
      titularidadActiva(),
      {
        inicio: instanteLocal(2027, 3, 1, 0, 0, RELOJ),
        fin: instanteLocal(2027, 3, 16, 0, 0, RELOJ),
        declaradaEn: instanteLocal(2027, 1, 1, 0, 0, RELOJ),
      },
      motor.config.pausa,
      RELOJ,
    );
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.rechazos[0]?.mensaje).toMatch(/ventanas de los meses/i);
  });

  it('declararla con 5 días de anticipación no alcanza: hacen falta 30', () => {
    const resultado = aplicarPausa(
      titularidadActiva(),
      {
        inicio: instanteLocal(2027, 1, 10, 0, 0, RELOJ),
        fin: instanteLocal(2027, 1, 25, 0, 0, RELOJ),
        declaradaEn: instanteLocal(2027, 1, 5, 0, 0, RELOJ),
      },
      motor.config.pausa,
      RELOJ,
    );
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.rechazos[0]?.mensaje).toMatch(/anticipación/i);
  });

  it('dos bloques de 15 días entran en el año; un tercero no', () => {
    const enero = {
      inicio: instanteLocal(2027, 1, 10, 0, 0, RELOJ),
      fin: instanteLocal(2027, 1, 25, 0, 0, RELOJ),
      declaradaEn: instanteLocal(2026, 12, 1, 0, 0, RELOJ),
    };
    const julio = {
      inicio: instanteLocal(2027, 7, 10, 0, 0, RELOJ),
      fin: instanteLocal(2027, 7, 25, 0, 0, RELOJ),
      declaradaEn: instanteLocal(2027, 6, 1, 0, 0, RELOJ),
    };

    const primera = aplicarPausa(titularidadActiva(), enero, motor.config.pausa, RELOJ);
    expect(primera.ok).toBe(true);
    if (!primera.ok) return;

    const segunda = aplicarPausa(
      { ...primera.valor, estado: 'activa' },
      julio,
      motor.config.pausa,
      RELOJ,
    );
    expect(segunda.ok).toBe(true);
    if (!segunda.ok) return;

    const tercera = aplicarPausa(
      { ...segunda.valor, estado: 'activa' },
      {
        inicio: instanteLocal(2027, 7, 26, 0, 0, RELOJ),
        fin: instanteLocal(2027, 8, 10, 0, 0, RELOJ),
        declaradaEn: instanteLocal(2027, 6, 1, 0, 0, RELOJ),
      },
      motor.config.pausa,
      RELOJ,
    );
    expect(tercera.ok).toBe(false);
    if (tercera.ok) return;
    expect(tercera.rechazos.some((r) => /cupo anual/i.test(r.mensaje))).toBe(true);
  });
});
