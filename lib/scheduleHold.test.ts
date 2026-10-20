import { describe, expect, it } from 'vitest';
import { formatHoldDay, holdAllowedForStart, parseHoldAmount, parseHoldSlots } from './scheduleHold';

describe('valor da reserva de agenda', () => {
    it('aceita o jeito que a direção digita', () => {
        expect(parseHoldAmount('30')).toBe(30);
        expect(parseHoldAmount('30,5')).toBe(30.5);
        expect(parseHoldAmount('R$ 37,90')).toBe(37.9);
        expect(parseHoldAmount('1.000,00')).toBe(1000);
        expect(parseHoldAmount('30.5')).toBe(30.5);
    });

    it('recusa vazio, zero, negativo, texto e acima do teto', () => {
        expect(parseHoldAmount('')).toBeNull();
        expect(parseHoldAmount('0')).toBeNull();
        expect(parseHoldAmount('-30')).toBeNull();
        expect(parseHoldAmount('trinta')).toBeNull();
        expect(parseHoldAmount('30,555')).toBeNull();
        expect(parseHoldAmount('1.000,01')).toBeNull();
    });
});

describe('quando a reserva se aplica', () => {
    it('só para início depois de hoje', () => {
        expect(holdAllowedForStart('2026-11-05', '2026-10-20')).toBe(true);
        expect(holdAllowedForStart('2026-10-20', '2026-10-20')).toBe(false);
        expect(holdAllowedForStart('', '2026-10-20')).toBe(false);
    });

    it('mostra o dia do início no formato curto', () => {
        expect(formatHoldDay('2026-11-05')).toBe('05/11');
    });
});

describe('leitura das reservas do banco', () => {
    it('descarta o que não tem forma de reserva', () => {
        const valid = {
            hold_id: 'h1', offer_id: 'o1', teacher_id: 't1', teacher_name: 'Mateus',
            student_label: 'Well', day_of_week: 1, class_time: '20:30', hold_until: '2026-11-05',
            amount: 30, month_year: '2026-10', status: 'ACTIVE', blocking: true,
        };
        expect(parseHoldSlots([valid, { hold_id: 'x' }, null])).toEqual([valid]);
        expect(parseHoldSlots(null)).toEqual([]);
    });
});
