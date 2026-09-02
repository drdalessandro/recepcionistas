import { describe, expect, it } from 'vitest';
import { SYSTEM } from '../src/fhir/identifiers.js';
import { demoHastaDe, demoVigente, metaDemo } from '../src/lib/demo.js';

describe('vida útil de los datos demo (tag demo-hasta)', () => {
  it('sin fecha, el meta demo es el de siempre: solo el tag demo (48 h)', () => {
    const m = metaDemo();
    expect(m.tag).toEqual([{ system: SYSTEM.demo, code: 'demo' }]);
    expect(demoHastaDe(m)).toBeUndefined();
    expect(demoVigente(m, '2026-09-02')).toBe(false);
  });

  it('con fecha, suma demo-hasta y la limpieza automática lo respeta hasta ese día inclusive', () => {
    const m = metaDemo('2026-09-15');
    expect(demoHastaDe(m)).toBe('2026-09-15');
    expect(demoVigente(m, '2026-09-02')).toBe(true);
    expect(demoVigente(m, '2026-09-15')).toBe(true);
    expect(demoVigente(m, '2026-09-16')).toBe(false);
  });

  it('una fecha mal formada no se acepta (se parsearía mal y la demo viviría para siempre)', () => {
    expect(() => metaDemo('15/09/2026')).toThrow(/YYYY-MM-DD/);
    expect(demoVigente({ tag: [{ system: SYSTEM.demoHasta, code: 'mañana' }] }, '2026-09-02')).toBe(false);
  });
});
