import { describe, expect, it } from 'vitest';
import { buildReservedCells, formatHoldDay, holdAllowedForStart, parseHoldAmount, parseHoldSlots, parseTermReservedSlots, reservedCellKey, termReservedCaption } from './scheduleHold';

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

describe('horário à espera do termo', () => {
    const slot = {
        slot_id: 's1', teacher_id: 't1', student_label: 'Aluno Fixture', day_of_week: 3, class_time: '12:30',
        starts_on: '2026-11-04', waiting_school: true, waiting_teacher: false, waiting_family: true,
    };

    it('descarta linhas incompletas', () => {
        expect(parseTermReservedSlots([slot, { slot_id: 'x' }, null])).toEqual([slot]);
        expect(parseTermReservedSlots(null)).toEqual([]);
    });

    it('diz só o que ainda falta', () => {
        expect(termReservedCaption(slot)).toBe('Reservado para Aluno Fixture. A aula entra na agenda quando o termo for concluído. Falta: assinatura da escola, confirmação da família.');
        expect(termReservedCaption({ ...slot, waiting_school: false, waiting_family: false })).not.toContain('Falta');
    });

    it('converte o dia do banco para a célula da grade', () => {
        expect(reservedCellKey(1, '08:00:00')).toBe('0-08:00');
        expect(reservedCellKey(6, '12:30')).toBe('5-12:30');
        expect(reservedCellKey(0, '12:30')).toBeNull();
    });

    it('monta as células do mapa, com a data ou com a espera do termo', () => {
        const hold = {
            hold_id: 'h1', offer_id: 'o1', teacher_id: 't1', teacher_name: null, student_label: 'Aluno Futuro', day_of_week: 1,
            class_time: '20:30', hold_until: '2026-11-05', amount: 30, month_year: '2026-10', status: 'ACTIVE' as const, blocking: true,
        };
        const cells = buildReservedCells([hold], [slot]);
        expect(cells['0-20:30'].label).toBe('Começa 05/11');
        expect(cells['2-12:30']).toMatchObject({ student: 'Aluno Fixture', label: 'Aguardando termo' });
    });
});
