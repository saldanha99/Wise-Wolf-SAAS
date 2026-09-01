import { describe, expect, it } from 'vitest';
import {
    calculateEnrollmentProRataPreview,
    defaultBillingStartMonthInSaoPaulo,
    enrollmentOfferErrorMessage,
    normalizeEnrollmentTime,
    resolveEnrollmentOfferVendorId,
    weekdayIndex,
} from './enrollmentOffer';

describe('mês inicial padrão da mensalidade', () => {
    it('avança 31 de agosto somente para setembro, sem overflow para outubro', () => {
        expect(defaultBillingStartMonthInSaoPaulo(
            new Date('2026-08-31T12:00:00-03:00'),
        )).toBe('2026-09');
    });

    it('vira dezembro para janeiro do ano seguinte', () => {
        expect(defaultBillingStartMonthInSaoPaulo(
            new Date('2026-12-31T12:00:00-03:00'),
        )).toBe('2027-01');
    });
});

describe('matrícula autoritativa', () => {
    it('calcula o pró-rata entre o início e o primeiro vencimento, não até o fim do mês atual', () => {
        const quote = calculateEnrollmentProRataPreview({
            enabled: true,
            monthlyFee: 160,
            classesPerWeek: 2,
            dueDay: 10,
            billingStartMonth: '2026-09',
            startDate: '2026-08-28',
            schedule: [
                { day: 'Monday', time: '19:00' },
                { day: 'Wednesday', time: '19:00' },
            ],
            now: new Date('2026-08-28T15:00:00-03:00'),
        });

        expect(quote.firstBillingDate).toBe('2026-09-10');
        expect(quote.classCount).toBe(4);
        expect(quote.pricePerClass).toBe(20);
        expect(quote.value).toBe(80);
    });

    it('mantém o primeiro vencimento, mas zera a prévia quando o pró-rata está desativado', () => {
        const quote = calculateEnrollmentProRataPreview({
            enabled: false,
            monthlyFee: 160,
            classesPerWeek: 2,
            dueDay: 10,
            billingStartMonth: '2026-09',
            startDate: '2026-08-28',
            schedule: [
                { day: 'Monday', time: '19:00' },
                { day: 'Wednesday', time: '19:00' },
            ],
            now: new Date('2026-08-28T15:00:00-03:00'),
        });

        expect(quote).toEqual({
            firstBillingDate: '2026-09-10',
            classCount: 0,
            pricePerClass: 0,
            value: 0,
        });
    });

    it('conta duas aulas no mesmo dia quando os horários são distintos', () => {
        const quote = calculateEnrollmentProRataPreview({
            enabled: true,
            monthlyFee: 240,
            classesPerWeek: 3,
            dueDay: 8,
            billingStartMonth: '2026-09',
            startDate: '2026-08-31',
            schedule: [
                { day: 'Segunda', time: '18:00' },
                { day: 'Monday', time: '19:00' },
                { day: 'Quarta', time: '19:00' },
            ],
            now: new Date('2026-08-28T15:00:00-03:00'),
        });

        expect(quote.classCount).toBe(5);
        expect(quote.value).toBe(100);
    });

    it('não cobra proporcional quando o serviço começa no primeiro vencimento', () => {
        const quote = calculateEnrollmentProRataPreview({
            enabled: true,
            monthlyFee: 200,
            classesPerWeek: 2,
            dueDay: 10,
            billingStartMonth: '2026-09',
            startDate: '2026-09-10',
            schedule: [{ day: 'Thursday', time: '10:00' }],
            now: new Date('2026-08-28T15:00:00-03:00'),
        });
        expect(quote.classCount).toBe(0);
        expect(quote.value).toBe(0);
    });

    it('normaliza vencimento 31 para o último dia de fevereiro sem perder aulas', () => {
        const quote = calculateEnrollmentProRataPreview({
            enabled: true,
            monthlyFee: 160,
            classesPerWeek: 1,
            dueDay: 31,
            billingStartMonth: '2027-02',
            startDate: '2027-02-01',
            schedule: [{ day: 'Monday', time: '19:00' }],
            now: new Date('2027-01-20T12:00:00-03:00'),
        });

        expect(quote.firstBillingDate).toBe('2027-02-28');
        expect(quote.classCount).toBe(4);
        expect(quote.value).toBe(160);
    });

    it('avança para o mês seguinte quando o vencimento escolhido já passou', () => {
        const quote = calculateEnrollmentProRataPreview({
            enabled: true,
            monthlyFee: 200,
            classesPerWeek: 2,
            dueDay: 10,
            billingStartMonth: '2026-08',
            startDate: '2026-08-28',
            schedule: [
                { day: 'Monday', time: '19:00' },
                { day: 'Wednesday', time: '19:00' },
            ],
            now: new Date('2026-08-28T12:00:00-03:00'),
        });

        expect(quote.firstBillingDate).toBe('2026-09-10');
        expect(quote.classCount).toBe(4);
        expect(quote.value).toBe(100);
    });

    it('usa no total o mesmo valor por aula arredondado que a tela informa', () => {
        const quote = calculateEnrollmentProRataPreview({
            enabled: true,
            monthlyFee: 100,
            classesPerWeek: 3,
            dueDay: 6,
            billingStartMonth: '2026-09',
            startDate: '2026-08-24',
            schedule: [
                { day: 'Monday', time: '18:00' },
                { day: 'Wednesday', time: '18:00' },
                { day: 'Friday', time: '18:00' },
            ],
            now: new Date('2026-08-20T12:00:00-03:00'),
        });

        expect(quote.classCount).toBe(6);
        expect(quote.pricePerClass).toBe(8.33);
        expect(quote.value).toBe(49.98);
    });

    it('normaliza dias e horários usados pela grade', () => {
        expect(weekdayIndex('Terça-feira')).toBe(2);
        expect(weekdayIndex('Saturday')).toBe(6);
        expect(normalizeEnrollmentTime('9:05:00')).toBe('09:05');
        expect(normalizeEnrollmentTime('25:00')).toBeNull();
    });

    it('explica o bloqueio jurídico em vez de mostrar Object', () => {
        expect(enrollmentOfferErrorMessage({ message: 'tenant_legal_identity_incomplete' }))
            .toContain('assinatura do representante');
        expect(enrollmentOfferErrorMessage({ message: 'dependent_guardian_contact_invalid' }))
            .toContain('responsável financeiro');
    });

    it('vincula comissão somente quando quem gera a oferta é vendedor', () => {
        expect(resolveEnrollmentOfferVendorId({ id: ' vendor-id ', role: 'SALESPERSON' }))
            .toBe('vendor-id');
        expect(resolveEnrollmentOfferVendorId({ id: 'director-id', role: 'SCHOOL_ADMIN' }))
            .toBeUndefined();
        expect(resolveEnrollmentOfferVendorId({ id: 'superadmin-id', role: 'SUPER_ADMIN' }))
            .toBeUndefined();
        expect(resolveEnrollmentOfferVendorId({ id: 'coordinator-id', role: 'COORDINATOR' }))
            .toBeUndefined();
        expect(resolveEnrollmentOfferVendorId({ id: 'teacher-id', role: 'TEACHER' }))
            .toBeUndefined();
        expect(resolveEnrollmentOfferVendorId({ id: '   ', role: 'SALESPERSON' }))
            .toBeUndefined();
    });

    it('traduz falha interna de permissão sem culpar o perfil do diretor', () => {
        expect(enrollmentOfferErrorMessage({
            code: '42501',
            message: 'permission denied for table enrollment_offer_command_receipts',
        })).toContain('temporariamente indisponível');
    });

    it('distingue os bloqueios de sessão, tenant e autoridade da oferta', () => {
        expect(enrollmentOfferErrorMessage({ message: 'authentication_required' }))
            .toContain('sessão expirou');
        expect(enrollmentOfferErrorMessage({ message: 'cross_tenant_enrollment_denied' }))
            .toContain('unidade ativa');
        expect(enrollmentOfferErrorMessage({ message: 'inactive_enrollment_actor' }))
            .toContain('professor ou vendedor');
        expect(enrollmentOfferErrorMessage({ message: 'permission_denied' }))
            .toContain('não possui autorização');
        expect(enrollmentOfferErrorMessage({ code: '42501', message: 'unexpected privilege error' }))
            .toContain('confirmar sua autorização');
    });
});
