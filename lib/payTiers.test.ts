import { describe, it, expect } from 'vitest';
import { payTierRanges, describePayTiers, baseRate } from './payTiers';

// A tabela REAL da escola em 13/08/2026 — a que motivou este módulo.
const WISE_WOLF = [
    { min_students: 1, rate: 8.0 },
    { min_students: 10, rate: 10.5 },
];

describe('payTiers', () => {
    it('descreve a tabela real sem inventar a faixa de R$ 9,50', () => {
        const texto = describePayTiers(WISE_WOLF);
        expect(texto).toBe('10º em diante: R$ 10,50 (os demais seguem R$ 8,00)');
        expect(texto).not.toContain('9,50');
    });

    it('fecha o intervalo quando a escola tem faixa intermediária', () => {
        const ranges = payTierRanges([
            { min_students: 1, rate: 8.0 },
            { min_students: 5, rate: 9.5 },
            { min_students: 10, rate: 10.5 },
        ]);
        expect(ranges.map(r => r.label)).toEqual(['5º ao 9º', '10º em diante']);
        expect(ranges[0].to).toBe(9);
        expect(ranges[1].to).toBeNull();
    });

    it('tarifa única não promete progressão nenhuma', () => {
        expect(payTierRanges([{ min_students: 1, rate: 8.0 }])).toEqual([]);
        expect(describePayTiers([{ min_students: 1, rate: 8.0 }])).toBeNull();
    });

    it('sem tabela (RPC antiga, erro de rede) a tela não fala em valor', () => {
        expect(describePayTiers(undefined)).toBeNull();
        expect(describePayTiers([])).toBeNull();
        expect(baseRate(undefined)).toBeNull();
    });

    it('ordena faixas fora de ordem e descarta lixo', () => {
        const ranges = payTierRanges([
            { min_students: 10, rate: 10.5 },
            { min_students: 1, rate: 8.0 },
            { min_students: NaN as unknown as number, rate: 99 },
        ]);
        expect(ranges).toHaveLength(1);
        expect(ranges[0].from).toBe(10);
        expect(baseRate([{ min_students: 10, rate: 10.5 }, { min_students: 1, rate: 8.0 }])).toBe(8);
    });

    it('faixa de uma posição só não vira intervalo aberto', () => {
        const ranges = payTierRanges([
            { min_students: 1, rate: 8.0 },
            { min_students: 5, rate: 9.5 },
            { min_students: 6, rate: 10.5 },
        ]);
        expect(ranges[0].label).toBe('5º');
        expect(ranges[1].label).toBe('6º em diante');
    });
});
