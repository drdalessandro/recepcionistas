/**
 * Capa comercial del motor de agenda: Founding Member (R-09), cotización contra
 * listas versionadas (R-04, R-06) y ciclo de vida de la membresía (vencimiento,
 * saldo, pausa y cancelación).
 *
 * Se lee como especificación: cada `describe` es una regla del Manual y cada
 * `it` un caso que la regla tiene que cumplir. Si alguno se cae, lo que está mal
 * es el motor, no el test.
 */

import { describe, expect, it } from 'vitest';
import {
  compilarConfig,
  configSanIsidro,
  cotizarMembresia,
  cotizarServicio,
  diasPausadosEnAnio,
  evaluarCancelacion,
  evaluarFoundingMember,
  explicarFmCaduco,
  finDeCiclo,
  fmVigente,
  instanteLocal,
  LISTA_2026_08,
  puedeConsumirSesion,
  resolverLista,
  saldoDeSesiones,
  sumarMinutos,
  versionVigente,
  type Cliente,
  type FuerzaMayorMedica,
  type MotivoFmCaduco,
  type MotorCompilado,
  type PausaMembresia,
  type VersionListaPrecios,
} from '../../src/motor-agenda/index.js';
import { clientePublico, codigosDeRechazo, lunes, motorDePrueba, RELOJ, titularidadActiva } from './ayudas.js';

const MOTOR = motorDePrueba();

/** Un instante cualquiera dentro de la vigencia de la lista de agosto de 2026. */
const AHORA = lunes(8);

/** Copia una versión de lista cambiando sólo su identidad y su vigencia. */
function listaClonada(
  version: string,
  vigenteDesde: Date,
  vigenteHasta?: Date,
  extra: Partial<VersionListaPrecios> = {},
): VersionListaPrecios {
  return {
    ...LISTA_2026_08,
    version,
    vigenteDesde,
    ...(vigenteHasta ? { vigenteHasta } : {}),
    ...extra,
  };
}

/** Motor real del centro, pero con las listas de precios que pida el test. */
function motorConListas(...listas: readonly VersionListaPrecios[]): MotorCompilado {
  return compilarConfig({ ...configSanIsidro(), listasPrecios: listas });
}

/** Founding Member con membresía activa: el tag vigente de verdad. */
function fundador(parcial: Partial<Cliente> = {}): Cliente {
  return clientePublico({
    id: 'fundador',
    categoria: 'miembro-standard',
    tagFoundingMember: true,
    fmVersionListaPrecios: '2026-08',
    titularidad: titularidadActiva(),
    ...parcial,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
describe('R-09 · el tag Founding Member exige membresía vigente y sin mora', () => {
  it('un cliente sin el tag no es Founding Member: motivo "sin-tag"', () => {
    const estado = evaluarFoundingMember(clientePublico({ titularidad: titularidadActiva() }));
    expect(estado.vigente).toBe(false);
    expect(estado.motivo).toBe('sin-tag');
  });

  it('con el tag y la membresía activa, el beneficio está vigente y no hay motivo de caducidad', () => {
    const estado = evaluarFoundingMember(fundador());
    expect(estado.vigente).toBe(true);
    expect(estado.motivo).toBeUndefined();
  });

  it('el cliente en mora pierde el beneficio aunque la membresía figure activa', () => {
    const estado = evaluarFoundingMember(fundador({ enMora: true }));
    expect(estado.vigente).toBe(false);
    expect(estado.motivo).toBe('en-mora');
  });

  it('sin ninguna membresía, el tag caduca por "sin-membresia"', () => {
    const estado = evaluarFoundingMember(fundador({ titularidad: undefined }));
    expect(estado.vigente).toBe(false);
    expect(estado.motivo).toBe('sin-membresia');
  });

  it('con la membresía vencida, el tag caduca por "membresia-vencida"', () => {
    const estado = evaluarFoundingMember(
      fundador({ titularidad: titularidadActiva({ estado: 'vencida' }) }),
    );
    expect(estado.vigente).toBe(false);
    expect(estado.motivo).toBe('membresia-vencida');
  });

  it('con la membresía en mora, el motivo es "en-mora" aunque el cliente no esté marcado en mora', () => {
    // La mora puede estar registrada en el cliente o en su titularidad; el
    // motivo que ve recepción es el mismo, para que el mensaje sea uno solo.
    const estado = evaluarFoundingMember(
      fundador({ enMora: false, titularidad: titularidadActiva({ estado: 'en-mora' }) }),
    );
    expect(estado.vigente).toBe(false);
    expect(estado.motivo).toBe('en-mora');
  });

  it('una membresía PAUSADA mantiene el tag vigente: la pausa es un derecho, no una baja', () => {
    const estado = evaluarFoundingMember(
      fundador({ titularidad: titularidadActiva({ estado: 'pausada' }) }),
    );
    expect(estado.vigente).toBe(true);
    expect(estado.motivo).toBeUndefined();
  });

  it('el socio pausado conserva el tag pero no puede consumir sesiones: son dos preguntas distintas', () => {
    const pausada = titularidadActiva({ estado: 'pausada' });
    expect(fmVigente(fundador({ titularidad: pausada }))).toBe(true);
    expect(puedeConsumirSesion(pausada, lunes(10)).puede).toBe(false);
  });

  it('el FM cambia de tier sin perder el tag: R-09 mira la membresía, no cuál es', () => {
    for (const membresia of ['FOCUS', 'PRIME', 'HEALTHSPAN']) {
      const cliente = fundador({ titularidad: titularidadActiva({ membresia }) });
      expect(fmVigente(cliente)).toBe(true);
    }
  });

  it('fmVigente es el atajo de evaluarFoundingMember().vigente, nunca el tag suelto', () => {
    const caduco = fundador({ titularidad: undefined });
    expect(caduco.tagFoundingMember).toBe(true);
    expect(fmVigente(caduco)).toBe(false);
    expect(fmVigente(fundador())).toBe(true);
  });

  it('cada motivo de caducidad tiene un texto para recepción', () => {
    const motivos: MotivoFmCaduco[] = ['sin-tag', 'en-mora', 'sin-membresia', 'membresia-vencida'];
    for (const motivo of motivos) {
      expect(explicarFmCaduco(motivo).length).toBeGreaterThan(0);
    }
    expect(explicarFmCaduco('en-mora')).toMatch(/mora/i);
    expect(explicarFmCaduco('membresia-vencida')).toMatch(/venció/i);
    expect(explicarFmCaduco('sin-membresia')).toMatch(/membresía/i);
    expect(explicarFmCaduco('sin-tag')).toMatch(/no es Founding Member/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('R-04 · la biplaza cuesta USD 100 por persona con dos y USD 165 con una', () => {
  function cotizarBiplaza(ocupantes: number) {
    return cotizarServicio({
      motor: MOTOR,
      servicio: 'HBOT_BIPLAZA',
      ocupantes,
      cliente: clientePublico(),
      ahora: AHORA,
    });
  }

  it('con 1 ocupante paga el precio monoplaza: USD 165, y el total es 165', () => {
    const cotizacion = cotizarBiplaza(1);
    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.porPersonaUsd).toBe(165);
    expect(cotizacion.valor.totalUsd).toBe(165);
    expect(cotizacion.valor.ocupantes).toBe(1);
  });

  it('con 2 ocupantes son USD 100 por persona y USD 200 en total', () => {
    const cotizacion = cotizarBiplaza(2);
    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.porPersonaUsd).toBe(100);
    expect(cotizacion.valor.totalUsd).toBe(200);
    expect(cotizacion.valor.ocupantes).toBe(2);
  });

  it('el segundo ocupante abarata la sesión pero encarece el total: no es un descuento sobre 165', () => {
    const solo = cotizarBiplaza(1);
    const acompanado = cotizarBiplaza(2);
    expect(solo.ok && acompanado.ok).toBe(true);
    if (!solo.ok || !acompanado.ok) return;
    expect(acompanado.valor.porPersonaUsd).toBeLessThan(solo.valor.porPersonaUsd);
    expect(acompanado.valor.totalUsd).toBeGreaterThan(solo.valor.totalUsd);
  });

  it('con 3 ocupantes no hay precio tabulado y no se inventa uno', () => {
    // La biplaza no admite tres personas; lo importante es que la cotización no
    // caiga a un "precio por persona" genérico que la biplaza no tiene.
    const cotizacion = cotizarBiplaza(3);
    expect(cotizacion.ok).toBe(false);
    expect(codigosDeRechazo(cotizacion)).toContain('PRECIO_NO_DEFINIDO');
  });

  it('la cotización dice contra qué versión de lista se calculó', () => {
    const cotizacion = cotizarBiplaza(2);
    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.versionLista).toBe('2026-08');
    expect(cotizacion.valor.motivoVersion).toBe('vigente');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('R-06 · la multiplaza cuesta USD 80 por persona desde 1 ocupante, sin piso de sesión', () => {
  function cotizarMultiplaza(ocupantes: number) {
    return cotizarServicio({
      motor: MOTOR,
      servicio: 'HBOT_MULTIPLAZA',
      ocupantes,
      cliente: clientePublico(),
      ahora: AHORA,
    });
  }

  for (const ocupantes of [1, 2, 3, 4, 5, 6]) {
    it(`con ${ocupantes} ocupante(s): USD 80 por persona y USD ${80 * ocupantes} de total`, () => {
      const cotizacion = cotizarMultiplaza(ocupantes);
      expect(cotizacion.ok).toBe(true);
      if (!cotizacion.ok) return;
      expect(cotizacion.valor.porPersonaUsd).toBe(80);
      expect(cotizacion.valor.totalUsd).toBe(80 * ocupantes);
      expect(cotizacion.valor.ocupantes).toBe(ocupantes);
    });
  }

  it('el precio por persona no cambia con la cantidad: no hay recargo por venir solo', () => {
    const porPersona = [1, 2, 3, 4, 5, 6].map((n) => {
      const c = cotizarMultiplaza(n);
      return c.ok ? c.valor.porPersonaUsd : undefined;
    });
    expect(porPersona).toEqual([80, 80, 80, 80, 80, 80]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Un servicio sin precio cargado devuelve PRECIO_NO_DEFINIDO, nunca 0 ni un default', () => {
  // Sólo R-04 y R-06 están ratificados. El resto del catálogo no tiene precio a
  // propósito: inventarlo sería peor que no cobrarlo.
  const SIN_PRECIO = ['HBOT_MONOPLAZA', 'IHHT', 'RED_LIGHT', 'RECOVERY_PRO', 'COMPRESION', 'CRIOTERAPIA'];

  for (const servicio of SIN_PRECIO) {
    it(`${servicio} no se cotiza: PRECIO_NO_DEFINIDO`, () => {
      const cotizacion = cotizarServicio({
        motor: MOTOR,
        servicio,
        ocupantes: 1,
        cliente: clientePublico(),
        ahora: AHORA,
      });
      expect(cotizacion.ok).toBe(false);
      expect(codigosDeRechazo(cotizacion)).toEqual(['PRECIO_NO_DEFINIDO']);
      // Y no hay ningún número escondido en el resultado: ni 0, ni un default.
      expect((cotizacion as { valor?: unknown }).valor).toBeUndefined();
    });
  }

  it('el rechazo dice qué servicio, cuántos ocupantes y contra qué versión faltó el precio', () => {
    const cotizacion = cotizarServicio({
      motor: MOTOR,
      servicio: 'RED_LIGHT',
      ocupantes: 2,
      cliente: clientePublico(),
      ahora: AHORA,
    });
    expect(cotizacion.ok).toBe(false);
    if (cotizacion.ok) return;
    expect(cotizacion.rechazos[0]?.detalle).toMatchObject({
      servicio: 'RED_LIGHT',
      ocupantes: 2,
      version: '2026-08',
    });
    expect(cotizacion.rechazos[0]?.mensaje).toMatch(/no se inventa un número/i);
  });

  it('un servicio que no existe en el catálogo es SERVICIO_DESCONOCIDO, no un precio faltante', () => {
    const cotizacion = cotizarServicio({
      motor: MOTOR,
      servicio: 'CAMARA_DE_ANTIMATERIA',
      ocupantes: 1,
      cliente: clientePublico(),
      ahora: AHORA,
    });
    expect(cotizacion.ok).toBe(false);
    expect(codigosDeRechazo(cotizacion)).toEqual(['SERVICIO_DESCONOCIDO']);
  });

  // ── BUG: cotizar 0 ocupantes devuelve una cotización válida de USD 0 ────────
  // `expandir` rechaza con OCUPANTES_INVALIDOS cualquier cantidad menor a 1,
  // pero `cotizarServicio` es API pública y no valida nada: multiplica el precio
  // por persona por la cantidad pedida. Con 0 devuelve ok con totalUsd 0, que es
  // exactamente el "número inventado" que el módulo promete no producir.
  it.fails('BUG · cotizar con 0 ocupantes debería rechazar por OCUPANTES_INVALIDOS y hoy devuelve USD 0', () => {
    const cotizacion = cotizarServicio({
      motor: MOTOR,
      servicio: 'HBOT_MULTIPLAZA',
      ocupantes: 0,
      cliente: clientePublico(),
      ahora: AHORA,
    });
    expect(cotizacion.ok).toBe(false);
    expect(codigosDeRechazo(cotizacion)).toContain('OCUPANTES_INVALIDOS');
  });

  it.fails('BUG · cotizar con ocupantes negativos debería rechazar y hoy devuelve un total negativo', () => {
    const cotizacion = cotizarServicio({
      motor: MOTOR,
      servicio: 'HBOT_MULTIPLAZA',
      ocupantes: -1,
      cliente: clientePublico(),
      ahora: AHORA,
    });
    expect(cotizacion.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Cotización de membresías: el plazo mensual lleva recargo, el trimestral no', () => {
  function cotizar(
    parcial: {
      membresia?: string;
      modalidad?: 'standard' | 'intensivo';
      formato?: 'individual' | 'pareja';
      plazo?: 'mensual' | 'trimestral';
      cliente?: Cliente;
      motor?: MotorCompilado;
      ahora?: Date;
    } = {},
  ) {
    return cotizarMembresia({
      motor: parcial.motor ?? MOTOR,
      membresia: parcial.membresia ?? 'FOCUS',
      modalidad: parcial.modalidad ?? 'standard',
      formato: parcial.formato ?? 'individual',
      plazo: parcial.plazo ?? 'trimestral',
      cliente: parcial.cliente ?? clientePublico(),
      ahora: parcial.ahora ?? AHORA,
    });
  }

  it('el recargo del plazo mensual es +20% y vive en la versión de la lista, no en el código', () => {
    expect(LISTA_2026_08.recargoPlazoMensual).toBe(0.2);
  });

  it('FOCUS standard individual trimestral cuesta el precio base: USD 1200', () => {
    const cotizacion = cotizar({ plazo: 'trimestral' });
    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.totalUsd).toBe(1200);
    expect(cotizacion.valor.porPersonaUsd).toBe(1200);
    expect(cotizacion.valor.ocupantes).toBe(1);
  });

  it('la misma membresía mensual cuesta USD 1440: el sin compromiso paga +20%', () => {
    const cotizacion = cotizar({ plazo: 'mensual' });
    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.totalUsd).toBe(1440);
    expect(cotizacion.valor.porPersonaUsd).toBe(1440);
  });

  it('el recargo se aplica a todos los tiers y modalidades, siempre sobre el precio base', () => {
    const combinaciones: { membresia: string; modalidad: 'standard' | 'intensivo'; base: number }[] = [
      { membresia: 'FOCUS', modalidad: 'intensivo', base: 1680 },
      { membresia: 'PRIME', modalidad: 'standard', base: 1752 },
      { membresia: 'HEALTHSPAN', modalidad: 'standard', base: 2184 },
    ];
    for (const { membresia, modalidad, base } of combinaciones) {
      const trimestral = cotizar({ membresia, modalidad, plazo: 'trimestral' });
      const mensual = cotizar({ membresia, modalidad, plazo: 'mensual' });
      expect(trimestral.ok && mensual.ok).toBe(true);
      if (!trimestral.ok || !mensual.ok) return;
      expect(trimestral.valor.totalUsd).toBe(base);
      expect(mensual.valor.totalUsd).toBe(Math.round(base * 1.2 * 100) / 100);
    }
  });

  it('el formato pareja reparte el total entre 2: FOCUS standard pareja sale 1800, o sea 900 por cabeza', () => {
    const cotizacion = cotizar({ formato: 'pareja' });
    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.totalUsd).toBe(1800);
    expect(cotizacion.valor.porPersonaUsd).toBe(900);
    expect(cotizacion.valor.ocupantes).toBe(2);
  });

  it('la pareja mensual también reparte después del recargo: 1800 +20% = 2160, o 1080 por cabeza', () => {
    const cotizacion = cotizar({ formato: 'pareja', plazo: 'mensual' });
    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.totalUsd).toBe(2160);
    expect(cotizacion.valor.porPersonaUsd).toBe(1080);
  });

  it('el formato individual no reparte nada: porPersona y total coinciden', () => {
    const cotizacion = cotizar({ formato: 'individual' });
    expect(cotizacion.ok).toBe(true);
    if (!cotizacion.ok) return;
    expect(cotizacion.valor.porPersonaUsd).toBe(cotizacion.valor.totalUsd);
  });

  it('una membresía que no existe es PRODUCTO_DESCONOCIDO', () => {
    const cotizacion = cotizar({ membresia: 'INMORTALIDAD' });
    expect(cotizacion.ok).toBe(false);
    expect(codigosDeRechazo(cotizacion)).toEqual(['PRODUCTO_DESCONOCIDO']);
  });

  it('una combinación sin precio en la lista devuelve PRECIO_NO_DEFINIDO', () => {
    // Lista incompleta a propósito: sólo tiene FOCUS standard individual.
    const incompleta = listaClonada('2026-09', instanteLocal(2026, 9, 1, 0, 0, RELOJ), undefined, {
      membresias: [
        { membresia: 'FOCUS', modalidad: 'standard', formato: 'individual', precioBaseUsd: 1200 },
      ],
    });
    const motor = motorConListas(incompleta);
    const cotizacion = cotizar({
      motor,
      formato: 'pareja',
      ahora: instanteLocal(2026, 9, 15, 10, 0, RELOJ),
    });
    expect(cotizacion.ok).toBe(false);
    expect(codigosDeRechazo(cotizacion)).toEqual(['PRECIO_NO_DEFINIDO']);
    expect((cotizacion as { valor?: unknown }).valor).toBeUndefined();
  });

  it('el FM paga el recargo mensual de SU lista congelada, no el que rija hoy', () => {
    // El recargo también es parte de la lista: si mañana sube al 50 %, el
    // fundador de agosto de 2026 sigue pagando el 20 % de su versión.
    const desde2028 = instanteLocal(2028, 1, 1, 0, 0, RELOJ);
    const motor = motorConListas(
      { ...LISTA_2026_08, vigenteHasta: desde2028 },
      listaClonada('2028-01', desde2028, undefined, { recargoPlazoMensual: 0.5 }),
    );
    const en2028 = instanteLocal(2028, 6, 15, 10, 0, RELOJ);

    const delFundador = cotizarMembresia({
      motor,
      membresia: 'FOCUS',
      modalidad: 'standard',
      formato: 'individual',
      plazo: 'mensual',
      cliente: fundador(),
      ahora: en2028,
    });
    const delPublico = cotizarMembresia({
      motor,
      membresia: 'FOCUS',
      modalidad: 'standard',
      formato: 'individual',
      plazo: 'mensual',
      cliente: clientePublico(),
      ahora: en2028,
    });

    expect(delFundador.ok && delPublico.ok).toBe(true);
    if (!delFundador.ok || !delPublico.ok) return;
    expect(delFundador.valor.totalUsd).toBe(1440);
    expect(delFundador.valor.motivoVersion).toBe('lista-congelada-fm');
    expect(delPublico.valor.totalUsd).toBe(1800);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('resolverLista · una versión desconocida es rechazo, nunca fallback a la vigente', () => {
  it('al público general le corresponde la lista vigente', () => {
    const aplicable = resolverLista(MOTOR, clientePublico(), AHORA);
    expect(aplicable.ok).toBe(true);
    if (!aplicable.ok) return;
    expect(aplicable.valor.motivo).toBe('vigente');
    expect(aplicable.valor.lista.version).toBe('2026-08');
  });

  it('al FM vigente le corresponde su lista congelada', () => {
    const aplicable = resolverLista(MOTOR, fundador(), AHORA);
    expect(aplicable.ok).toBe(true);
    if (!aplicable.ok) return;
    expect(aplicable.valor.motivo).toBe('lista-congelada-fm');
    expect(aplicable.valor.lista.version).toBe('2026-08');
  });

  it('un FM con una versión que no existe se rechaza: cotizarlo contra la vigente sería cobrarle de más', () => {
    const perdido = fundador({ fmVersionListaPrecios: '2019-05' });
    const aplicable = resolverLista(MOTOR, perdido, AHORA);

    expect(aplicable.ok).toBe(false);
    expect(codigosDeRechazo(aplicable)).toEqual(['VERSION_LISTA_DESCONOCIDA']);
    if (aplicable.ok) return;
    expect(aplicable.rechazos[0]?.regla).toBe('R-09');
    expect(aplicable.rechazos[0]?.detalle).toMatchObject({ version: '2019-05' });
    expect(aplicable.rechazos[0]?.mensaje).toMatch(/no se cotiza contra la lista vigente/i);
  });

  it('el rechazo se propaga a la cotización de servicios: no hay precio de consuelo', () => {
    const perdido = fundador({ fmVersionListaPrecios: '2019-05' });
    const cotizacion = cotizarServicio({
      motor: MOTOR,
      servicio: 'HBOT_BIPLAZA',
      ocupantes: 2,
      cliente: perdido,
      ahora: AHORA,
    });
    expect(cotizacion.ok).toBe(false);
    expect(codigosDeRechazo(cotizacion)).toEqual(['VERSION_LISTA_DESCONOCIDA']);
    expect((cotizacion as { valor?: unknown }).valor).toBeUndefined();
  });

  it('y a la cotización de membresías, que es donde el fundador más pierde', () => {
    const perdido = fundador({ fmVersionListaPrecios: '2019-05' });
    const cotizacion = cotizarMembresia({
      motor: MOTOR,
      membresia: 'HEALTHSPAN',
      modalidad: 'standard',
      formato: 'individual',
      plazo: 'trimestral',
      cliente: perdido,
      ahora: AHORA,
    });
    expect(cotizacion.ok).toBe(false);
    expect(codigosDeRechazo(cotizacion)).toEqual(['VERSION_LISTA_DESCONOCIDA']);
  });

  it('con el tag caduco, la versión desconocida ya no importa: cotiza como cualquiera', () => {
    // El beneficio no está vigente, así que no hay lista congelada que resolver
    // y la cotización cae —correctamente— en la lista vigente.
    const caduco = fundador({ titularidad: undefined, fmVersionListaPrecios: '2019-05' });
    const aplicable = resolverLista(MOTOR, caduco, AHORA);
    expect(aplicable.ok).toBe(true);
    if (!aplicable.ok) return;
    expect(aplicable.valor.motivo).toBe('vigente');
  });

  it('un FM vigente sin versión congelada registrada también se rechaza', () => {
    // El dato faltante hace exactamente el mismo daño que la versión borrada:
    // cotizar al fundador contra la lista de hoy es cobrarle de más. Todo
    // fundador congela una lista al inscribirse, así que un campo vacío es un
    // dato roto y se corrige antes de vender, no se resuelve con un fallback.
    const sinVersion = fundador({ fmVersionListaPrecios: undefined });
    const aplicable = resolverLista(MOTOR, sinVersion, AHORA);

    expect(aplicable.ok).toBe(false);
    expect(codigosDeRechazo(aplicable)).toEqual(['VERSION_LISTA_DESCONOCIDA']);
    if (aplicable.ok) return;
    expect(aplicable.rechazos[0]?.regla).toBe('R-09');
    expect(aplicable.rechazos[0]?.detalle).toMatchObject({ cliente: 'fundador' });
    expect(aplicable.rechazos[0]?.mensaje).toMatch(/no se cotiza contra la lista vigente/i);
  });

  it('sin ninguna lista vigente en ese instante, tampoco se inventa una', () => {
    const motor = motorConListas(
      listaClonada('2030-01', instanteLocal(2030, 1, 1, 0, 0, RELOJ)),
    );
    const aplicable = resolverLista(motor, clientePublico(), AHORA);
    expect(aplicable.ok).toBe(false);
    expect(codigosDeRechazo(aplicable)).toEqual(['VERSION_LISTA_DESCONOCIDA']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('versionVigente · la más nueva aplicable, respetando vigenteHasta', () => {
  const DESDE_2025 = new Date('2025-01-01T00:00:00.000Z');
  const DESDE_2026 = new Date('2026-01-01T00:00:00.000Z');
  const DESDE_2027 = new Date('2027-01-01T00:00:00.000Z');

  const motor = motorConListas(
    listaClonada('2025-01', DESDE_2025, DESDE_2026),
    listaClonada('2026-01', DESDE_2026, DESDE_2027),
    listaClonada('2027-01', DESDE_2027),
  );

  it('en junio de 2025 rige la lista de 2025', () => {
    expect(versionVigente(motor, new Date('2025-06-15T12:00:00.000Z'))?.version).toBe('2025-01');
  });

  it('en junio de 2027 rige la lista de 2027, que no tiene fecha de fin', () => {
    expect(versionVigente(motor, new Date('2027-06-15T12:00:00.000Z'))?.version).toBe('2027-01');
  });

  it('vigenteDesde es inclusivo: justo en el instante de alta ya rige la nueva', () => {
    expect(versionVigente(motor, DESDE_2026)?.version).toBe('2026-01');
  });

  it('vigenteHasta es exclusivo: un milisegundo antes todavía rige la vieja', () => {
    expect(versionVigente(motor, new Date(DESDE_2026.getTime() - 1))?.version).toBe('2025-01');
  });

  it('antes de la primera lista no hay ninguna vigente', () => {
    expect(versionVigente(motor, new Date('2024-12-31T23:59:59.000Z'))).toBeUndefined();
  });

  it('entre dos listas superpuestas gana la más nueva, no la primera del arreglo', () => {
    // El orden del arreglo es deliberadamente el inverso al cronológico: lo que
    // decide es vigenteDesde.
    const superpuestas = motorConListas(
      listaClonada('2026-06', new Date('2026-06-01T00:00:00.000Z')),
      listaClonada('2026-01', DESDE_2026),
    );
    expect(versionVigente(superpuestas, new Date('2026-08-17T12:00:00.000Z'))?.version).toBe('2026-06');
  });

  it('una lista más nueva pero ya terminada no gana: primero se filtra por vigencia', () => {
    const motorConVencida = motorConListas(
      listaClonada('2026-01', DESDE_2026),
      listaClonada('2026-09', new Date('2026-09-01T00:00:00.000Z'), new Date('2026-10-01T00:00:00.000Z')),
    );
    expect(versionVigente(motorConVencida, new Date('2026-11-15T12:00:00.000Z'))?.version).toBe('2026-01');
    expect(versionVigente(motorConVencida, new Date('2026-09-15T12:00:00.000Z'))?.version).toBe('2026-09');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('finDeCiclo · el último día del mes o los 30 días, lo que ocurra primero', () => {
  const REGLAS = MOTOR.config.membresia;

  it('la regla del ciclo son 30 días', () => {
    expect(REGLAS.diasVigenciaCiclo).toBe(30);
  });

  it('contratar el 5 de agosto vence el 31 de agosto: gana el fin de mes', () => {
    // 5 de agosto + 30 días caería el 4 de septiembre, ya fuera del mes.
    const fin = finDeCiclo(instanteLocal(2026, 8, 5, 10, 0, RELOJ), REGLAS, RELOJ);
    expect(fin).toEqual(instanteLocal(2026, 8, 31, 23, 59, RELOJ));
  });

  it('contratar el 25 de agosto también vence el 31: seis días para ocho sesiones', () => {
    // Contra la intuición de "30 días de contratado": los 30 días caerían el 24
    // de septiembre, así que lo primero sigue siendo el fin de mes. Que las
    // sesiones no sean acumulables se paga acá, y el modelo lo dice en vez de
    // disimularlo.
    const fin = finDeCiclo(instanteLocal(2026, 8, 25, 10, 0, RELOJ), REGLAS, RELOJ);
    expect(fin).toEqual(instanteLocal(2026, 8, 31, 23, 59, RELOJ));
  });

  it('contratar el 1 de agosto a las 09:00 vence el 31 a las 09:00: ahí sí ganan los 30 días', () => {
    // El otro lado de "lo que ocurra primero", y el único caso en que se activa:
    // en un mes de 31 días, contratando el día 1, los 30 días se cumplen antes
    // del 23:59 del día 31.
    const fin = finDeCiclo(instanteLocal(2026, 8, 1, 9, 0, RELOJ), REGLAS, RELOJ);
    expect(fin).toEqual(instanteLocal(2026, 8, 31, 9, 0, RELOJ));
  });

  it('contratar el 2 de agosto ya vuelve a ganar el fin de mes: el cruce está en el día 1', () => {
    const fin = finDeCiclo(instanteLocal(2026, 8, 2, 0, 0, RELOJ), REGLAS, RELOJ);
    expect(fin).toEqual(instanteLocal(2026, 8, 31, 23, 59, RELOJ));
  });

  it('en un mes de 30 días los 30 días nunca ganan: contratar el 1 de septiembre vence el 30', () => {
    const fin = finDeCiclo(instanteLocal(2026, 9, 1, 9, 0, RELOJ), REGLAS, RELOJ);
    expect(fin).toEqual(instanteLocal(2026, 9, 30, 23, 59, RELOJ));
  });

  it('febrero: contratar el 1 vence el 28, no a los 30 días', () => {
    const fin = finDeCiclo(instanteLocal(2027, 2, 1, 9, 0, RELOJ), REGLAS, RELOJ);
    expect(fin).toEqual(instanteLocal(2027, 2, 28, 23, 59, RELOJ));
  });

  it('febrero bisiesto: el ciclo de 2028 llega hasta el 29', () => {
    const fin = finDeCiclo(instanteLocal(2028, 2, 1, 9, 0, RELOJ), REGLAS, RELOJ);
    expect(fin).toEqual(instanteLocal(2028, 2, 29, 23, 59, RELOJ));
  });

  it('febrero: contratar el 20 deja ocho días de ciclo', () => {
    const fin = finDeCiclo(instanteLocal(2027, 2, 20, 15, 0, RELOJ), REGLAS, RELOJ);
    expect(fin).toEqual(instanteLocal(2027, 2, 28, 23, 59, RELOJ));
  });

  it('contratar el último día del mes deja el ciclo en horas, y el modelo lo devuelve igual', () => {
    const fin = finDeCiclo(instanteLocal(2026, 8, 31, 23, 0, RELOJ), REGLAS, RELOJ);
    expect(fin).toEqual(instanteLocal(2026, 8, 31, 23, 59, RELOJ));
  });

  it('enero: contratar el 1 a las 00:00 vence el 31 a las 00:00, un día antes que el fin de mes', () => {
    const fin = finDeCiclo(instanteLocal(2027, 1, 1, 0, 0, RELOJ), REGLAS, RELOJ);
    expect(fin).toEqual(instanteLocal(2027, 1, 31, 0, 0, RELOJ));
  });

  it('el fin de mes se calcula en hora local del centro, no en UTC', () => {
    // 23:00 local del 31 de agosto es el 1 de septiembre en UTC: si el corte se
    // hiciera en UTC, el ciclo terminaría un mes más tarde.
    const fin = finDeCiclo(instanteLocal(2026, 8, 31, 23, 0, RELOJ), REGLAS, RELOJ);
    expect(fin.getTime()).toBeLessThan(instanteLocal(2026, 9, 1, 0, 0, RELOJ).getTime());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Saldo de sesiones: no acumulables, nunca negativo', () => {
  it('el saldo es lo asignado menos lo usado', () => {
    expect(saldoDeSesiones(titularidadActiva({ sesionesAsignadas: 8, sesionesUsadas: 3 }))).toBe(5);
  });

  it('con todo consumido el saldo es 0', () => {
    expect(saldoDeSesiones(titularidadActiva({ sesionesAsignadas: 8, sesionesUsadas: 8 }))).toBe(0);
  });

  it('si se registraron más usos que sesiones asignadas, el saldo se planta en 0 y no en negativo', () => {
    // Puede pasar tras una pausa que reduce las sesiones ya consumidas del mes.
    expect(saldoDeSesiones(titularidadActiva({ sesionesAsignadas: 4, sesionesUsadas: 6 }))).toBe(0);
  });

  it('la modalidad intensiva arranca con más sesiones, pero el cálculo es el mismo', () => {
    expect(
      saldoDeSesiones(
        titularidadActiva({ modalidad: 'intensivo', sesionesAsignadas: 12, sesionesUsadas: 5 }),
      ),
    ).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('puedeConsumirSesion · un motivo distinto por cada estado', () => {
  const DENTRO_DEL_CICLO = instanteLocal(2026, 8, 20, 10, 0, RELOJ);
  const FIN_DE_CICLO = instanteLocal(2026, 8, 31, 23, 59, RELOJ);

  it('activa, con saldo y dentro del ciclo: puede, y sin motivo que explicar', () => {
    const evaluacion = puedeConsumirSesion(titularidadActiva(), DENTRO_DEL_CICLO);
    expect(evaluacion.puede).toBe(true);
    expect(evaluacion.motivo).toBeUndefined();
  });

  it('en mora: no puede', () => {
    const evaluacion = puedeConsumirSesion(
      titularidadActiva({ estado: 'en-mora' }),
      DENTRO_DEL_CICLO,
    );
    expect(evaluacion.puede).toBe(false);
    expect(evaluacion.motivo).toMatch(/mora/i);
  });

  it('vencida: no puede', () => {
    const evaluacion = puedeConsumirSesion(
      titularidadActiva({ estado: 'vencida' }),
      DENTRO_DEL_CICLO,
    );
    expect(evaluacion.puede).toBe(false);
    expect(evaluacion.motivo).toMatch(/vencida/i);
  });

  it('pausada: no puede, aunque le queden sesiones', () => {
    const evaluacion = puedeConsumirSesion(
      titularidadActiva({ estado: 'pausada', sesionesAsignadas: 8, sesionesUsadas: 0 }),
      DENTRO_DEL_CICLO,
    );
    expect(evaluacion.puede).toBe(false);
    expect(evaluacion.motivo).toMatch(/pausada/i);
  });

  it('activa pero con el turno después del fin de ciclo: no puede, porque no se acumulan', () => {
    const evaluacion = puedeConsumirSesion(
      titularidadActiva({ finCiclo: FIN_DE_CICLO }),
      instanteLocal(2026, 9, 1, 10, 0, RELOJ),
    );
    expect(evaluacion.puede).toBe(false);
    expect(evaluacion.motivo).toMatch(/no son acumulables/i);
  });

  it('justo en el instante de fin de ciclo todavía puede: el corte es posterior, no inclusivo', () => {
    const evaluacion = puedeConsumirSesion(titularidadActiva({ finCiclo: FIN_DE_CICLO }), FIN_DE_CICLO);
    expect(evaluacion.puede).toBe(true);
  });

  it('activa, dentro del ciclo, pero sin saldo: no puede, y el motivo dice cuántas usó', () => {
    const evaluacion = puedeConsumirSesion(
      titularidadActiva({ sesionesAsignadas: 8, sesionesUsadas: 8 }),
      DENTRO_DEL_CICLO,
    );
    expect(evaluacion.puede).toBe(false);
    expect(evaluacion.motivo).toMatch(/No quedan sesiones/);
    expect(evaluacion.motivo).toContain('8 de 8');
  });

  it('el estado se mira antes que el saldo: una pausada sin saldo se explica por la pausa', () => {
    const evaluacion = puedeConsumirSesion(
      titularidadActiva({ estado: 'pausada', sesionesUsadas: 8 }),
      DENTRO_DEL_CICLO,
    );
    expect(evaluacion.motivo).toMatch(/pausada/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Cancelación · 24 h devuelven la sesión; menos, la consumen', () => {
  const REGLAS = MOTOR.config.cancelacion;
  const TURNO = lunes(10);

  function cancelarA(minutosDeAnticipacion: number, fuerzaMayor?: FuerzaMayorMedica) {
    return evaluarCancelacion({
      inicioDelTurno: TURNO,
      momentoDeCancelacion: sumarMinutos(TURNO, -minutosDeAnticipacion),
      reglas: REGLAS,
      ...(fuerzaMayor ? { fuerzaMayor } : {}),
    });
  }

  const CON_MEDICO: FuerzaMayorMedica = {
    motivoDocumentado: 'Cuadro febril agudo',
    autorizadaPorMedico: 'Dr. Conrado López Alonso',
  };
  // La excepción sin médico que la autorice no es una excepción: es un pedido.
  const SIN_MEDICO: FuerzaMayorMedica = {
    motivoDocumentado: 'Cuadro febril agudo',
    autorizadaPorMedico: '',
  };

  it('la regla del centro son 24 h', () => {
    expect(REGLAS.horasParaDevolverSesion).toBe(24);
  });

  it('exactamente 24 h antes: la sesión vuelve al saldo (el borde entra)', () => {
    const evaluacion = cancelarA(24 * 60);
    expect(evaluacion.devuelveSesionAlSaldo).toBe(true);
    expect(evaluacion.horasDeAnticipacion).toBe(24);
    expect(evaluacion.motivo).toMatch(/vuelve al saldo/i);
  });

  it('con 48 h de anticipación, también vuelve', () => {
    expect(cancelarA(48 * 60).devuelveSesionAlSaldo).toBe(true);
  });

  it('23,9 h antes: la sesión se consume, por seis minutos', () => {
    const evaluacion = cancelarA(23.9 * 60);
    expect(evaluacion.devuelveSesionAlSaldo).toBe(false);
    expect(evaluacion.horasDeAnticipacion).toBeCloseTo(23.9, 5);
    expect(evaluacion.motivo).toMatch(/se consume/i);
  });

  it('dos horas antes, sin excepción: se consume', () => {
    expect(cancelarA(120).devuelveSesionAlSaldo).toBe(false);
  });

  it('fuerza mayor médica autorizada por un médico: devuelve la sesión aun con dos horas', () => {
    const evaluacion = cancelarA(120, CON_MEDICO);
    expect(evaluacion.devuelveSesionAlSaldo).toBe(true);
    expect(evaluacion.motivo).toMatch(/fuerza mayor médica autorizada por Dr\. Conrado López Alonso/);
  });

  it('fuerza mayor SIN médico que la autorice: no devuelve nada', () => {
    const evaluacion = cancelarA(120, SIN_MEDICO);
    expect(evaluacion.devuelveSesionAlSaldo).toBe(false);
    expect(evaluacion.motivo).toMatch(/no la autorizó ningún médico/i);
  });

  it('con 24 h o más, la excepción médica es irrelevante: ya devolvía por anticipación', () => {
    const evaluacion = cancelarA(24 * 60, SIN_MEDICO);
    expect(evaluacion.devuelveSesionAlSaldo).toBe(true);
    expect(evaluacion.motivo).toMatch(/vuelve al saldo/i);
  });

  it('cancelar después de que el turno empezó: anticipación negativa y sesión consumida', () => {
    const evaluacion = cancelarA(-60);
    expect(evaluacion.horasDeAnticipacion).toBe(-1);
    expect(evaluacion.devuelveSesionAlSaldo).toBe(false);
  });

  it('cancelar tarde con excepción médica sigue devolviendo: la excepción no mira el reloj', () => {
    expect(cancelarA(-60, CON_MEDICO).devuelveSesionAlSaldo).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('diasPausadosEnAnio · el cupo se cuenta por el año en que arranca la pausa', () => {
  function pausa(inicio: Date, fin: Date, declaradaEn: Date): PausaMembresia {
    return { inicio, fin, declaradaEn };
  }

  const ENERO_2027 = pausa(
    instanteLocal(2027, 1, 10, 0, 0, RELOJ),
    instanteLocal(2027, 1, 25, 0, 0, RELOJ),
    instanteLocal(2026, 12, 1, 0, 0, RELOJ),
  );
  const JULIO_2027 = pausa(
    instanteLocal(2027, 7, 10, 0, 0, RELOJ),
    instanteLocal(2027, 7, 25, 0, 0, RELOJ),
    instanteLocal(2027, 6, 1, 0, 0, RELOJ),
  );

  it('sin pausas registradas, el año está en cero', () => {
    expect(diasPausadosEnAnio(titularidadActiva(), 2027, RELOJ)).toBe(0);
  });

  it('una pausa de 15 días en enero cuenta 15 días en ese año', () => {
    const titularidad = titularidadActiva({ pausas: [ENERO_2027] });
    expect(diasPausadosEnAnio(titularidad, 2027, RELOJ)).toBe(15);
  });

  it('no se le imputa nada a los años vecinos', () => {
    const titularidad = titularidadActiva({ pausas: [ENERO_2027] });
    expect(diasPausadosEnAnio(titularidad, 2026, RELOJ)).toBe(0);
    expect(diasPausadosEnAnio(titularidad, 2028, RELOJ)).toBe(0);
  });

  it('dos bloques de 15 días en el mismo año suman el cupo completo de 30', () => {
    const titularidad = titularidadActiva({ pausas: [ENERO_2027, JULIO_2027] });
    expect(diasPausadosEnAnio(titularidad, 2027, RELOJ)).toBe(30);
    expect(diasPausadosEnAnio(titularidad, 2027, RELOJ)).toBe(MOTOR.config.pausa.diasPorAnioCalendario);
  });

  it('cada año calendario se cuenta por separado', () => {
    const enero2028 = pausa(
      instanteLocal(2028, 1, 10, 0, 0, RELOJ),
      instanteLocal(2028, 1, 25, 0, 0, RELOJ),
      instanteLocal(2027, 12, 1, 0, 0, RELOJ),
    );
    const titularidad = titularidadActiva({ pausas: [ENERO_2027, JULIO_2027, enero2028] });
    expect(diasPausadosEnAnio(titularidad, 2027, RELOJ)).toBe(30);
    expect(diasPausadosEnAnio(titularidad, 2028, RELOJ)).toBe(15);
  });

  it('una pausa que cruza el año se imputa entera al año en que arrancó', () => {
    // Caso hipotético (diciembre está fuera de las ventanas de enero y julio),
    // pero fija la regla: lo que decide es la fecha de inicio, no el reparto de
    // los días entre los dos años.
    const cruzada = pausa(
      instanteLocal(2027, 12, 20, 0, 0, RELOJ),
      instanteLocal(2028, 1, 4, 0, 0, RELOJ),
      instanteLocal(2027, 11, 1, 0, 0, RELOJ),
    );
    const titularidad = titularidadActiva({ pausas: [cruzada] });
    expect(diasPausadosEnAnio(titularidad, 2027, RELOJ)).toBe(15);
    expect(diasPausadosEnAnio(titularidad, 2028, RELOJ)).toBe(0);
  });

  it('el año se decide en hora local del centro, no en UTC', () => {
    // Las 22:00 del 31 de diciembre son ya el 1 de enero en UTC: contar en UTC
    // le regalaría al socio 15 días del cupo del año siguiente.
    const nocheVieja = pausa(
      instanteLocal(2027, 12, 31, 22, 0, RELOJ),
      instanteLocal(2028, 1, 15, 22, 0, RELOJ),
      instanteLocal(2027, 11, 1, 0, 0, RELOJ),
    );
    const titularidad = titularidadActiva({ pausas: [nocheVieja] });
    expect(diasPausadosEnAnio(titularidad, 2027, RELOJ)).toBe(15);
    expect(diasPausadosEnAnio(titularidad, 2028, RELOJ)).toBe(0);
  });
});
