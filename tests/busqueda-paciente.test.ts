import { describe, it, expect } from 'vitest';
import { busquedasPara, hayPosibleDuplicado } from '../src/lib/busqueda-paciente.js';

// El caso 2 del walk-in: la persona escribió por WhatsApp, Recepción le creó la
// ficha desde el aviso (teléfono precargado, sin DNI) y después vino al local.
// Buscar por su teléfono NO encontraba nada, y esa era la razón por la que se
// terminaba creando una ficha duplicada.

describe('busquedasPara — qué se busca con lo que tipeó la recepcionista', () => {
  it('con letras es un nombre', () => {
    expect(busquedasPara('Julio D\'Alessandro').map((b) => b.tipo)).toEqual(['nombre']);
    expect(busquedasPara('Ana').map((b) => b.tipo)).toEqual(['nombre']);
  });

  it('7-8 dígitos: DNI primero, pero el teléfono TAMBIÉN se busca', () => {
    const tipos = busquedasPara('30111222').map((b) => b.tipo);
    expect(tipos[0]).toBe('dni');
    expect(tipos).toContain('telefono');
  });

  it('un móvil escrito con símbolos ya no se busca como NOMBRE (el bug)', () => {
    // Antes: "+54 9 11 6931-5830" tenía no-dígitos => se buscaba por nombre => vacío.
    const busquedas = busquedasPara('+54 9 11 6931-5830');
    expect(busquedas.map((b) => b.tipo)).not.toContain('nombre');
    expect(busquedas[0]!.tipo).toBe('telefono');
    expect(busquedas[0]!.valores.length).toBeGreaterThan(0);
  });

  it('un móvil escrito solo con dígitos también busca por teléfono', () => {
    const busquedas = busquedasPara('1169315830');
    expect(busquedas[0]!.tipo).toBe('telefono');
  });

  it('el teléfono se busca por VARIANTES: la ficha puede tener otro formato', () => {
    // La ficha de WhatsApp guarda E.164 (+5491169315830) y la recepcionista
    // tipea como lo tiene en el celular. Sin variantes no matchea nunca.
    const valores = busquedasPara('1169315830').find((b) => b.tipo === 'telefono')!.valores;
    expect(valores.length).toBeGreaterThan(1);
    expect(valores.some((v) => v.includes('+549'))).toBe(true);
  });

  it('el DNI se busca con y sin puntos (cada lado lo cargó distinto)', () => {
    const valores = busquedasPara('30111222').find((b) => b.tipo === 'dni')!.valores;
    expect(valores).toContain('30111222');
    expect(valores).toContain('30.111.222');
  });

  it('vacío o basura no dispara búsquedas', () => {
    expect(busquedasPara('')).toEqual([]);
    expect(busquedasPara('   ')).toEqual([]);
    expect(busquedasPara('++')).toEqual([]);
  });
});

describe('hayPosibleDuplicado — avisa, nunca bloquea', () => {
  it('con candidatos avisa', () => {
    expect(hayPosibleDuplicado([{ id: 'p1' }])).toBe(true);
  });

  it('sin candidatos no molesta', () => {
    expect(hayPosibleDuplicado([])).toBe(false);
    expect(hayPosibleDuplicado([{ id: undefined }])).toBe(false);
  });
});
