import { describe, expect, it } from 'vitest';
import {
    calculateEnrollmentProRataPreview,
    enrollmentOfferErrorMessage,
    normalizeEnrollmentTime,
    weekdayIndex,
} from './enrollmentOffer';

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
});
