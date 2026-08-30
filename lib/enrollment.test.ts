import { describe, expect, it } from 'vitest';
import {
    calculateEnrollmentQuote,
    normalizeEnrollmentProRataTerms,
} from './enrollment';

const recurringOffer = {
    planDuration: 12,
    value: 169,
    requiresEnrollment: true,
    enrollmentFee: 49,
    firstBillingDate: '2026-09-10',
};

describe('pró-rata da matrícula', () => {
    it('zera um valor residual quando a opção está desativada', () => {
        const terms = normalizeEnrollmentProRataTerms({
            ...recurringOffer,
            enableProRata: false,
            proRataValue: 84.52,
        });
        const quote = calculateEnrollmentQuote({
            ...recurringOffer,
            enableProRata: false,
            proRataValue: 84.52,
        });

        expect(terms).toEqual({ enabled: false, value: 0 });
        expect(quote.proRataValue).toBe(0);
        expect(quote.dueToday).toBe(49);
        expect(quote.total).toBe(2077);
    });

    it('não habilita valor legado quando a flag está ausente', () => {
        expect(normalizeEnrollmentProRataTerms({
            ...recurringOffer,
            proRataValue: 84.52,
        })).toEqual({ enabled: false, value: 0 });
    });

    it('soma o valor proporcional somente quando a opção está ativa', () => {
        const quote = calculateEnrollmentQuote({
            ...recurringOffer,
            enableProRata: true,
            proRataValue: 84.52,
        });

        expect(quote.proRataValue).toBe(84.52);
        expect(quote.dueToday).toBe(133.52);
        expect(quote.total).toBe(2161.52);
    });
});
