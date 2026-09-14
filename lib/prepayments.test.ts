import { describe, expect, it } from 'vitest';
import { prepaymentCents, prepaymentPreview, prepaymentToday, validPrepaymentReceiptDate, isPrepaymentContext } from './prepayments';

describe('prévia de pagamento completo', () => {
    it.each([['1.234,56', 123456], ['1234.56', 123456], ['10,5', 1050], [0.01, 1]])('lê %s em centavos sem arredondar', (input, expected) => {
        expect(prepaymentCents(input)).toBe(expected);
    });
    it.each(['', '0', '-12', '10.001', '1e3', '12reais', '12,345', 'NaN', Infinity])('rejeita valor inválido %s', input => {
        expect(prepaymentCents(input)).toBeNull();
    });
    it('distribui centavos restantes nas primeiras parcelas e preserva o total', () => {
        const rows = prepaymentPreview(10001, '2026-12', 3);
        expect(rows).toEqual([
            { competencia: '2026-12', cents: 3334 },
            { competencia: '2027-01', cents: 3334 },
            { competencia: '2027-02', cents: 3333 },
        ]);
        expect(rows.reduce((sum, row) => sum + row.cents, 0)).toBe(10001);
    });
    it('aceita até 24 meses e não cria parcelas de zero centavos', () => {
        expect(prepaymentPreview(2400, '2026-01', 24)).toHaveLength(24);
        for (const months of [1, 25, 2.5, NaN]) expect(prepaymentPreview(2400, '2026-01', months)).toEqual([]);
        expect(prepaymentPreview(2, '2026-01', 3)).toEqual([]);
        expect(prepaymentPreview(2400, '2026-13', 3)).toEqual([]);
    });
    it('mantém o calendário da escola na virada UTC e valida datas reais', () => {
        expect(prepaymentToday(new Date('2026-10-01T01:00:00Z'))).toBe('2026-09-30');
        expect(validPrepaymentReceiptDate('2026-09-30', '2026-09-30')).toBe(true);
        expect(validPrepaymentReceiptDate('2026-10-01', '2026-09-30')).toBe(false);
        expect(validPrepaymentReceiptDate('2026-02-30', '2026-09-30')).toBe(false);
    });
    it('não aceita autorização textual ou contexto incompleto', () => {
        const context = { ok: true, can_write: true, students: [], payments: [], allocations: [], history: [] };
        expect(isPrepaymentContext(context)).toBe(true);
        expect(isPrepaymentContext({ ...context, ok: 'true' })).toBe(false);
        expect(isPrepaymentContext({ ...context, can_write: 'false' })).toBe(false);
        expect(isPrepaymentContext({ ...context, history: null })).toBe(false);
    });
});
