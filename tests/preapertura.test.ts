import { describe, expect, it } from 'vitest';
import { PREAPERTURA, SERVICIOS, SERVICIOS_POR_CODIGO, SERVICIOS_RETIRADOS } from '../src/config/catalogo.js';
import { calcularCobro, calcularSenaARS, fraccionAnticipada } from '../src/lib/pricing.js';
import { buildActivityDefinition, buildSeed } from '../src/seed/builders.js';

/**
 * Los dos servicios de TEST (Andrés): Multiplaza y teleconsulta al **99,9 %
 * off**, para probar el circuito completo de turnos y cobros con plata real
 * pero despreciable. 90 % y 98 % el 2026-09-20; 99,9 % y renombrados a TEST el
 * 2026-09-21.
 *
 * Los CÓDIGOS siguen diciendo `PREAPERTURA` aunque el nombre visible diga TEST:
 * hay turnos y cobros que ya los referencian y renombrarlos los dejaría sin
 * servicio que resolver.
 *
 * Lo que fijan estos casos no es el precio, que va a cambiar: son las dos
 * decisiones que se tomaron a conciencia y que a alguien le va a parecer un
 * error si las mira sin contexto.
 */

const TC = 1450;
const MULTIPLAZA = 'HBOT_MULTIPLAZA_PREAPERTURA';
const TELECONSULTA = 'TELECONSULTA_PREAPERTURA_MED_DALESSANDRO';

describe('preapertura · los dos servicios existen y son promocionales', () => {
  it('están en el catálogo con el 99,9 % aplicado sobre el precio de lista', () => {
    // 0,08 = el 0,1 % de los 80 del Multiplaza; 150 = el 0,1 % de los 150.000
    // de la teleconsulta de cardiología.
    expect(SERVICIOS_POR_CODIGO.get(MULTIPLAZA)?.precioUSD).toBe(0.08);
    expect(SERVICIOS_POR_CODIGO.get(TELECONSULTA)?.precioARS).toBe(150);
  });

  it('ninguno acumula el descuento de Founding Member', () => {
    // Un 20 % encima de un 99,9 % ya aplicado no es una promoción, es un error
    // de cálculo.
    expect(SERVICIOS_POR_CODIGO.get(MULTIPLAZA)?.fmAplica).toBe(false);
    expect(SERVICIOS_POR_CODIGO.get(TELECONSULTA)?.fmAplica).toBe(false);
  });

  it('son códigos PROPIOS, no un precio bajado sobre los de siempre', () => {
    // Administración los cuenta separados del ingreso a precio lleno: si se
    // hubiera bajado el precio del servicio real, la promo se mezclaría con la
    // venta normal y al terminar nadie sabría cuánto fue cada cosa.
    expect(SERVICIOS_POR_CODIGO.get('HBOT_MULTIPLAZA')?.precioUSD).toBe(80);
    expect(SERVICIOS_POR_CODIGO.get('TELECONSULTA_MED_DALESSANDRO')?.precioARS).toBe(150_000);
  });

  it('"TEST" va en mayúsculas en los dos nombres, y sigue siendo texto', () => {
    // Andrés pidió que se distinga (2026-09-20). El título es un `string` de
    // FHIR, así que no hay negrita: la mayúscula es lo que se distingue en el
    // portal, en Recepción y en los WhatsApp sin dejar de ser buscable. Si
    // alguien lo pasa a Unicode "negrita" (𝗣𝗿𝗲𝗮𝗽𝗲𝗿𝘁𝘂𝗿𝗮), el buscador del modal
    // de reserva deja de encontrarlo por esa palabra.
    for (const codigo of [MULTIPLAZA, TELECONSULTA]) {
      const nombre = SERVICIOS_POR_CODIGO.get(codigo)?.nombre ?? '';
      expect(nombre).toContain('TEST');
      expect(nombre.toLowerCase()).toContain('test'); // ASCII, buscable
      // Y el CÓDIGO no cambió: los turnos y cobros que ya lo referencian
      // tienen que seguir resolviendo (regla de oro del catálogo).
      expect(codigo).toContain('PREAPERTURA');
    }
  });
});

describe('preapertura · Multiplaza: el piso de 3 se mantiene', () => {
  const cobro = (ocupantes: number): number =>
    calcularCobro([{ tipo: 'servicio', codigo: MULTIPLAZA, ocupantes }], { tc: TC }).totalARS;

  it('una persona sola paga como si fueran TRES', () => {
    // Decisión de Andrés (2026-09-20): la promo usa la MISMA regla que el
    // Multiplaza de lista, piso incluido, para que la prueba refleje
    // producción. Es el mismo mecanismo que produjo la seña de $174.000 del
    // 2026-09-11, acá con plata chica y a la vista.
    //
    // Si esto empieza a dar 116 (USD 0,08 × 1), alguien le sacó el piso: eso
    // es una decisión comercial abierta, no un arreglo.
    expect(cobro(1)).toBe(348); // USD 0,08 × 3 × 1450
    expect(cobro(2)).toBe(348);
    expect(cobro(3)).toBe(348);
  });

  it('a partir de tres sí cobra por persona', () => {
    expect(cobro(4)).toBe(464); // USD 0,32
    expect(cobro(6)).toBe(696); // USD 0,48
  });

  it('el precio con decimales no deja centavos sueltos en pesos', () => {
    // USD 0,08 no es entero y 0.08 × 3 en punto flotante da
    // 0.24000000000000002: multiplicado por el TC tiene que salir en pesos
    // enteros igual.
    expect(Number.isInteger(cobro(1))).toBe(true);
    expect(Number.isInteger(cobro(5))).toBe(true);
  });

  it('la seña es la mitad, y queda saldo', () => {
    // Es presencial: 50 % ahora y 50 % el día de la sesión. Este es el camino
    // que la prueba de preapertura existe para ejercitar.
    const { totalARS, senaARS } = calcularSenaARS([{ tipo: 'servicio', codigo: MULTIPLAZA, ocupantes: 1 }], {
      tc: TC,
      fraccion: fraccionAnticipada(SERVICIOS_POR_CODIGO.get(MULTIPLAZA)?.modalidad),
    });
    expect(totalARS).toBe(348);
    expect(senaARS).toBe(174);
    expect(totalARS - senaARS).toBe(174);
  });
});

describe('preapertura · teleconsulta: el 100 % por adelantado, sin saldo', () => {
  it('es virtual, así que NO lleva seña del 50 %', () => {
    // Andrés, 2026-09-16: no hay mostrador donde cobrar el resto, y perseguir
    // un saldo a distancia es trabajo de Recepción que el sistema puede
    // evitar. Comunicado al Portal el 2026-09-17: en ningún texto de un turno
    // virtual puede decir "seña".
    const servicio = SERVICIOS_POR_CODIGO.get(TELECONSULTA);
    expect(servicio?.modalidad).toBe('virtual');

    const { totalARS, senaARS } = calcularSenaARS([{ tipo: 'servicio', codigo: TELECONSULTA }], {
      tc: TC,
      fraccion: fraccionAnticipada(servicio?.modalidad),
    });
    expect(totalARS).toBe(150);
    expect(senaARS).toBe(150);
    // Lo que importa: no queda nada pendiente, así que no se emite Invoice de
    // saldo y el link de saldo no aplica.
    expect(totalARS - senaARS).toBe(0);
  });

  it('el precio va en pesos: no se mueve con el tipo de cambio', () => {
    const conOtroTC = calcularCobro([{ tipo: 'servicio', codigo: TELECONSULTA }], { tc: 3000 }).totalARS;
    expect(conOtroTC).toBe(150);
  });

  it('dura 20 minutos, y la de lista sigue durando 60', () => {
    // Andrés, 2026-09-20. La agenda del médico sigue publicada en bloques de
    // 60: la reserva se valida por el inicio del Slot, no por la duración, así
    // que un turno de 20 toma un bloque entero igual. Ver la nota del servicio.
    expect(SERVICIOS_POR_CODIGO.get(TELECONSULTA)?.duracionMin).toBe(20);
    expect(SERVICIOS_POR_CODIGO.get('TELECONSULTA_MED_DALESSANDRO')?.duracionMin).toBe(60);
  });

  it('en la góndola queda SOLA: las teleconsultas de lista se publican ocultas', () => {
    // Andrés, 2026-09-20: "que sólo quede Teleconsulta Preapertura, las otras
    // quitarlas, para no confundir". La de cardiología a $150.000 aparecía
    // pegada a la de prueba.
    //
    // Este test es de la ETAPA: cuando se abra el centro y `PREAPERTURA` pase
    // a false, la primera aserción es la que tiene que cambiar (y la de abajo
    // sobre `active` se invierte). No es un bug que falle ese día: es el
    // recordatorio.
    expect(PREAPERTURA).toBe(true);

    const deLista = ['TELECONSULTA_MED_DALESSANDRO', 'TELECONSULTA_MED_ALBARELLOS'];
    for (const codigo of deLista) {
      const s = SERVICIOS_POR_CODIGO.get(codigo);
      expect(s?.ocultoEnPortal, codigo).toBe(true);
      // `draft`, no `retired`: es temporal, y el portal ya filtra por
      // `status=active` (handoff-portal-catalogo-familias.md §1).
      expect(buildActivityDefinition(s!).status, codigo).toBe('draft');
      // Fuera de la VIDRIERA, no del catálogo: Recepción la sigue reservando.
      expect(SERVICIOS.some((x) => x.codigo === codigo), codigo).toBe(true);
      expect(SERVICIOS_RETIRADOS.some((x) => x.codigo === codigo), codigo).toBe(false);
    }
    // La de preapertura sí se ofrece.
    expect(buildActivityDefinition(SERVICIOS_POR_CODIGO.get(TELECONSULTA)!).status).toBe('active');
  });

  it('la marca esconde SOLO teleconsultas: las consultas presenciales no se tocan', () => {
    // Nadie pidió esconder las presenciales, y con el centro cerrado no hay
    // con qué confundirlas. Si esto falla, `ocultoEnPortal` se coló donde no
    // iba.
    const ocultos = SERVICIOS.filter((s) => s.ocultoEnPortal).map((s) => s.codigo);
    expect(ocultos.sort()).toEqual(['TELECONSULTA_MED_ALBARELLOS', 'TELECONSULTA_MED_DALESSANDRO']);
    for (const s of SERVICIOS.filter((x) => x.categoria === 'CONSULTA' && x.modalidad !== 'virtual')) {
      expect(s.ocultoEnPortal, s.codigo).toBeUndefined();
    }
  });

  it('el seed publica los ocultos en `draft`, aparte de los `retired`', () => {
    // Que un oculto no se cuente como retirado: son dos cosas distintas y el
    // número de retirados lo fija `seed.test.ts`.
    const ads = buildSeed().activityDefinitions;
    expect(ads.filter((a) => a.status === 'draft').map((a) => a.name).sort()).toEqual([
      'TELECONSULTA_MED_ALBARELLOS',
      'TELECONSULTA_MED_DALESSANDRO',
    ]);
    expect(ads.filter((a) => a.status === 'retired')).toHaveLength(6);
    expect(ads.filter((a) => a.status === 'active')).toHaveLength(42 - 6 - 2);
  });

  it("la atiende el Dr. D'Alessandro y se busca por su apellido", () => {
    // El buscador del modal de reserva filtra por el NOMBRE del servicio: con
    // un nombre sin apellido, la recepcionista que tipea "D'Alessandro" no
    // encuentra nada y el botón de reservar queda gris (reportado 2026-09-17).
    const servicio = SERVICIOS_POR_CODIGO.get(TELECONSULTA);
    expect(servicio?.practitionerCodigo).toBe('MED_DALESSANDRO');
    expect(servicio?.nombre).toContain('Teleconsulta');
    // Apóstrofo RECTO, el mismo que usa `src/config/medicos.ts`: con el
    // tipográfico el buscador no encontraría el servicio por el apellido.
    expect(servicio?.nombre).toContain("D'Alessandro");
  });
});
