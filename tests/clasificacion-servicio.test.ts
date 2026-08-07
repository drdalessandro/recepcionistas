/**
 * Contrato con el Panel Bio (dashboard clínico): el turno tiene que decir en
 * campos FHIR nativos QUÉ terapia se administra, para que el acumulado de
 * sesiones del paciente se pueda contar. Ver docs/handoff-panel-bio.md.
 */
import { describe, expect, it } from 'vitest';
import { clasificacionDeServicio } from '../src/fhir/appointment.js';
import { SERVICIOS } from '../src/config/catalogo.js';
import { COMBOS } from '../src/config/combos.js';
import { EXT } from '../src/fhir/identifiers.js';

describe('clasificacionDeServicio', () => {
  it('usa los sistemas publicados de servicio y de categoría', () => {
    const { serviceType, serviceCategory } = clasificacionDeServicio('HBOT_MONO');
    expect(serviceType[0]?.coding?.[0]).toMatchObject({
      system: 'https://biowellness.ar/fhir/CodeSystem/servicio',
      code: 'HBOT_MONO',
    });
    expect(serviceCategory[0]?.coding?.[0]).toMatchObject({
      system: 'https://biowellness.ar/fhir/CodeSystem/categoria-servicio',
      code: 'HBOT',
    });
  });

  it('las tres cámaras son la MISMA exposición (misma categoría, distinto código)', () => {
    const camaras = ['HBOT_MONO', 'HBOT_BIPLAZA', 'HBOT_MULTIPLAZA'];
    const categorias = new Set(camaras.map((c) => clasificacionDeServicio(c).serviceCategory[0]?.coding?.[0]?.code));
    const codigos = new Set(camaras.map((c) => clasificacionDeServicio(c).serviceType[0]?.coding?.[0]?.code));
    expect(categorias).toEqual(new Set(['HBOT']));
    expect(codigos.size).toBe(3);
  });

  it('todo servicio del catálogo se clasifica (nadie cae en "código desconocido")', () => {
    for (const s of SERVICIOS) {
      const { serviceType, serviceCategory } = clasificacionDeServicio(s.codigo);
      expect(serviceType[0]?.coding?.[0]?.code).toBe(s.codigo);
      expect(serviceCategory[0]?.coding?.[0]?.code).toBe(s.categoria);
      expect(serviceCategory[0]?.coding?.[0]?.display).toBeTruthy();
    }
  });

  it('los componentes de todo combo se clasifican por servicio, no por combo', () => {
    for (const combo of COMBOS) {
      for (const comp of combo.componentes) {
        const { serviceType } = clasificacionDeServicio(comp.servicioCodigo);
        expect(serviceType[0]?.coding?.[0]?.code).toBe(comp.servicioCodigo);
        expect(serviceType[0]?.coding?.[0]?.code).not.toBe(combo.codigo);
      }
    }
  });

  it('la URL de la extensión item-codigo es kebab-case (no camelCase)', () => {
    // El Panel Bio sondeaba una extensión terminada en "/itemCodigo": no existe
    // ni existió. La convención del repo es kebab-case (ver CLAUDE.md).
    expect(EXT.itemCodigo).toBe('https://biowellness.ar/fhir/StructureDefinition/item-codigo');
    expect(EXT.itemCodigo.endsWith('/itemCodigo')).toBe(false);
  });
});
