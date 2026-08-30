import { describe, expect, it } from 'vitest';
import {
    classifyEnrollmentPaymentOutcome,
    classifyEnrollmentProgressOutcome,
    getEnrollmentConfirmationSource,
    getPendingEnrollmentPaymentKind,
    getPendingEnrollmentPaymentPresentation,
} from './enrollmentPaymentOutcome';

describe('classifyEnrollmentPaymentOutcome', () => {
    it('não conclui a matrícula quando somente a taxa foi recebida', () => {
        expect(classifyEnrollmentPaymentOutcome({
            paid: true,
            status: 'RECEIVED',
            enrollment_complete: false,
        })).toBe('SETTLED_AWAITING_COMPLETION');
    });

    it('falha de forma segura quando o servidor não envia enrollment_complete', () => {
        expect(classifyEnrollmentPaymentOutcome({
            paid: true,
            status: 'CONFIRMED',
        })).toBe('SETTLED_AWAITING_COMPLETION');
    });

    it('libera o sucesso somente com conclusão explícita do servidor', () => {
        expect(classifyEnrollmentPaymentOutcome({
            paid: true,
            status: 'RECEIVED',
            enrollment_complete: true,
        })).toBe('COMPLETE');
    });

    it('mantém a cobrança pendente enquanto o pagamento não estiver liquidado', () => {
        expect(classifyEnrollmentPaymentOutcome({
            paid: false,
            status: 'PENDING',
            enrollment_complete: false,
        })).toBe('PENDING');
    });
});

describe('matrícula recorrente sem taxa', () => {
    it('usa somente o progresso salvo para consultar a primeira mensalidade', () => {
        const kind = getPendingEnrollmentPaymentKind(0, 12);

        expect(kind).toBe('RECURRING_FIRST_PAYMENT');
        expect(getEnrollmentConfirmationSource(kind)).toBe('ENROLLMENT_PROGRESS');
    });

    it('mantém os fluxos de taxa e pagamento avulso no provedor', () => {
        const enrollmentFee = getPendingEnrollmentPaymentKind(50, 12);
        const oneTime = getPendingEnrollmentPaymentKind(0, 0);

        expect(enrollmentFee).toBe('ENROLLMENT_FEE');
        expect(oneTime).toBe('ONE_TIME');
        expect(getEnrollmentConfirmationSource(enrollmentFee)).toBe('PAYMENT_PROVIDER');
        expect(getEnrollmentConfirmationSource(oneTime)).toBe('PAYMENT_PROVIDER');
    });

    it('nunca transforma AWAITING_PAYMENT em sucesso', () => {
        expect(classifyEnrollmentProgressOutcome({
            success: true,
            status: 'AWAITING_PAYMENT',
        })).toBe('AWAITING_PAYMENT');
        expect(classifyEnrollmentProgressOutcome({
            success: true,
            status: 'COMPLETED',
        })).toBe('COMPLETE');
    });

    it('falha de forma segura quando a consulta do progresso é inválida', () => {
        expect(classifyEnrollmentProgressOutcome({
            success: false,
            status: 'COMPLETED',
        })).toBe('UNAVAILABLE');
        expect(classifyEnrollmentProgressOutcome(undefined)).toBe('UNAVAILABLE');
    });

    it('nunca apresenta a pendência recorrente como taxa de matrícula de zero reais', () => {
        const recurring = getPendingEnrollmentPaymentPresentation(
            'RECURRING_FIRST_PAYMENT',
            0,
        );
        const notLoaded = getPendingEnrollmentPaymentPresentation(undefined, 0);

        expect(recurring.title).toBe('Primeira Mensalidade Pendente');
        expect(recurring.title).not.toContain('Taxa de Matrícula');
        expect(recurring.showAmount).toBe(false);
        expect(notLoaded.title).toBe('Confirmação de Pagamento');
        expect(notLoaded.showAmount).toBe(false);
    });
});
