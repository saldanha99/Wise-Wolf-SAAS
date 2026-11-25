import { describe, expect, it } from 'vitest';
import { breakEvenStudents, minimumPrice, simulatePrice } from './financePricing';

const plano2x = { repasse: 62.52, ia: 0.41, asaas: 1.99, impostoPct: 0, dasRateado: 0 };

describe('precificação', () => {
  it('margem = preço − repasse − IA − Asaas sem imposto (bate com o SQL: 12m-2x de out/26)', () => {
    const s = simulatePrice(169, plano2x);
    expect(s.margem).toBe(104.08);
    expect(s.margemPct).toBe(61.6);
    expect(s.status).toBe('lucro');
    expect(s.precoMinimo).toBe(64.92);
  });

  it('imposto sobre a receita divide, não soma (divisor de markup)', () => {
    const c = { ...plano2x, impostoPct: 6 };
    const min = minimumPrice(c);
    expect(min).toBe(69.06);
    // No preço mínimo a margem é zero.
    expect(simulatePrice(min, c).status).toBe('empate');
  });

  it('DAS fixo rateado entra no custo e no preço mínimo', () => {
    const c = { ...plano2x, dasRateado: 1.6 };
    expect(simulatePrice(169, c).margem).toBe(102.48);
    expect(minimumPrice(c)).toBe(66.52);
  });

  it('preço abaixo do custo é prejuízo', () => {
    expect(simulatePrice(50, plano2x).status).toBe('prejuizo');
  });

  it('entrada inválida vira zero, não NaN', () => {
    const s = simulatePrice(Number('abc'), { ...plano2x, ia: Number.NaN });
    expect(s.preco).toBe(0);
    expect(Number.isFinite(s.margem)).toBe(true);
    expect(s.margemPct).toBeNull();
  });

  it('ponto de equilíbrio arredonda para cima e recusa contribuição ≤ 0', () => {
    expect(breakEvenStudents(827, 156.92)).toBe(6);
    expect(breakEvenStudents(1000, 0)).toBeNull();
    expect(breakEvenStudents(1000, -5)).toBeNull();
  });
});
