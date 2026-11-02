import { describe, it, expect } from 'vitest';
import {
    affiliateInviteErrorMessage,
    affiliateShareMessage,
    formatDayMonth,
    isValidAffiliateCode,
    normalizeAffiliateCode,
    referralStageDetail,
    resolveAffiliateLookup,
    type AffiliateMatch,
    type AffiliateReferral,
} from './affiliateProgram';

const referral = (overrides: Partial<AffiliateReferral>): AffiliateReferral => ({
    id: 'c1',
    stage: 'AGUARDANDO_PAGAMENTO',
    status: 'PENDING',
    amount_cents: 4900,
    student_display: 'Maria S.',
    referred_at: '2026-09-25T13:00:00Z',
    confirmed_at: null,
    paid_at: null,
    attribution: 'COUPON_STAFF',
    coupon_code: 'AFILIADA10',
    first_payment: null,
    withdrawal: null,
    ...overrides,
});

const match = (overrides: Partial<AffiliateMatch>): AffiliateMatch => ({
    vendor_id: 'v1',
    full_name: 'Gabriela Souza',
    affiliate_code: 'AFILIADA10',
    commission_cents: 4900,
    match: 'NAME',
    ...overrides,
});

describe('cupom de afiliado', () => {
    it('normaliza como o banco: sem espaço, sem símbolo, maiúsculo', () => {
        expect(normalizeAffiliateCode(' afiliada 10 ')).toBe('AFILIADA10');
        expect(normalizeAffiliateCode('gabi-20!')).toBe('GABI-20');
    });

    it('aceita 4 a 32 caracteres começando por letra ou número', () => {
        expect(isValidAffiliateCode('afiliada10')).toBe(true);
        expect(isValidAffiliateCode('ab1')).toBe(false);
        expect(isValidAffiliateCode('-ABCD')).toBe(false);
    });
});

describe('quem indicou: cupom ou nome', () => {
    it('cupom exato resolve mesmo com outros nomes parecidos', () => {
        const result = resolveAffiliateLookup([
            match({ match: 'CODE' }),
            match({ vendor_id: 'v2', full_name: 'Gabriela Lima', affiliate_code: 'GABI20' }),
        ]);
        expect(result).toEqual({ kind: 'single', affiliate: expect.objectContaining({ vendor_id: 'v1' }) });
    });

    it('nome resolve quando só existe uma Gabriela', () => {
        expect(resolveAffiliateLookup([match({})]).kind).toBe('single');
    });

    it('duas Gabrielas: precisa escolher pelo cupom', () => {
        const result = resolveAffiliateLookup([
            match({}),
            match({ vendor_id: 'v2', full_name: 'Gabriela Lima', affiliate_code: 'GABI20' }),
        ]);
        expect(result.kind).toBe('ambiguous');
    });

    it('ninguém encontrado', () => {
        expect(resolveAffiliateLookup([]).kind).toBe('none');
    });
});

describe('etapa da indicação', () => {
    it('cartão aprovado mostra a data prevista de liberação', () => {
        const text = referralStageDetail(referral({
            stage: 'EM_LIQUIDACAO',
            first_payment: {
                billing_type: 'CREDIT_CARD', status: 'CONFIRMED', due_date: '2026-10-10',
                paid_on: '2026-09-25', estimated_credit_on: '2026-10-27', credited_at: null,
            },
        }));
        expect(text).toBe('Cartão aprovado — libera por volta de 27/10.');
    });

    it('cartão sem data prevista cai no prazo de até 30 dias', () => {
        const text = referralStageDetail(referral({
            stage: 'EM_LIQUIDACAO',
            first_payment: {
                billing_type: 'CREDIT_CARD', status: 'CONFIRMED', due_date: null,
                paid_on: null, estimated_credit_on: null, credited_at: null,
            },
        }));
        expect(text).toContain('até ~30 dias');
    });

    it('boleto pago espera a compensação', () => {
        const text = referralStageDetail(referral({
            stage: 'EM_LIQUIDACAO',
            first_payment: {
                billing_type: 'BOLETO', status: 'RECEIVED', due_date: '2026-10-10',
                paid_on: '2026-10-09', estimated_credit_on: null, credited_at: null,
            },
        }));
        expect(text).toContain('compensação');
    });

    it('mensalidade vencida aparece como vencida', () => {
        const text = referralStageDetail(referral({
            first_payment: {
                billing_type: 'PIX', status: 'OVERDUE', due_date: '2026-10-10',
                paid_on: null, estimated_credit_on: null, credited_at: null,
            },
        }));
        expect(text).toBe('1ª mensalidade vencida desde 10/10.');
    });

    it('saque aprovado explica que o PIX está a caminho', () => {
        const text = referralStageDetail(referral({
            stage: 'EM_SAQUE',
            status: 'CONFIRMED',
            withdrawal: { id: 'w1', status: 'APPROVED', requested_at: '2026-10-01T12:00:00Z' },
        }));
        expect(text).toContain('PIX');
    });
});

describe('textos', () => {
    it('data pura não volta um dia em Brasília', () => {
        expect(formatDayMonth('2026-10-01')).toBe('01/10');
    });

    it('mensagem de divulgação leva o cupom e a isenção', () => {
        const text = affiliateShareMessage('AFILIADA10', 'Wise Wolf');
        expect(text).toContain('*AFILIADA10*');
        expect(text).toContain('isento da taxa de matrícula');
        expect(text).toContain('a Wise Wolf');
    });

    it('cupom já usado vira mensagem clara no convite', () => {
        expect(affiliateInviteErrorMessage({ message: 'affiliate_code_in_use', code: '23505' }))
            .toContain('já é de outro afiliado');
    });
});
