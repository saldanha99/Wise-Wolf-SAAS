import { describe, it, expect } from 'vitest';
import { bookingsAindaNaoLancados, uniqueBookingsById } from './lessonMatching';

const VICTOR = 'dd5486b9-victor';
const MARIANA = '983e716a-mariana';

describe('bookingsAindaNaoLancados', () => {
    it('mantém agendamentos diferentes que compartilham o mesmo horário', () => {
        const unicos = uniqueBookingsById([
            { id: 'treinamento-antigo', studentId: null, timeSlot: '16:30' },
            { id: 'victor-1630', studentId: VICTOR, timeSlot: '16:30' },
            { id: 'victor-1700', studentId: VICTOR, timeSlot: '17:00' },
        ]);

        expect(unicos.map((booking) => booking.id)).toEqual([
            'treinamento-antigo',
            'victor-1630',
            'victor-1700',
        ]);
    });

    it('remove somente a repetição do mesmo booking', () => {
        const unicos = uniqueBookingsById([
            { id: 'victor-1630', studentId: VICTOR, timeSlot: '16:30' },
            { id: 'victor-1630', studentId: VICTOR, timeSlot: '16:30' },
        ]);

        expect(unicos).toHaveLength(1);
    });

    it('esconde a aula lançada pelo próprio agendamento', () => {
        const restou = bookingsAindaNaoLancados(
            [{ id: 'b1', studentId: MARIANA }],
            [{ booking_id: 'b1', student_id: MARIANA }],
        );
        expect(restou).toEqual([]);
    });

    it('REGRESSÃO (Flávio, 13/08/2026): agendamento trocado não faz a aula voltar', () => {
        // O log de julho aponta para o agendamento antigo, que foi apagado.
        const restou = bookingsAindaNaoLancados(
            [{ id: 'booking-novo', studentId: MARIANA }],
            [{ booking_id: 'booking-antigo-apagado', student_id: MARIANA }],
        );
        expect(restou).toEqual([]);
    });

    it('aula de 1h partida: lançou 16:30, ainda precisa lançar 17:00', () => {
        const restou = bookingsAindaNaoLancados(
            [{ id: 'b-1630', studentId: VICTOR }, { id: 'b-1700', studentId: VICTOR }],
            [{ booking_id: 'b-1630', student_id: VICTOR }],
        );
        expect(restou.map(b => b.id)).toEqual(['b-1700']);
    });

    it('agendamento trocado com horário alterado continua sendo considerado lançado', () => {
        const restou = bookingsAindaNaoLancados(
            [{ id: 'booking-novo', studentId: VICTOR, timeSlot: '17:00' }],
            [{ booking_id: 'booking-antigo', student_id: VICTOR, start_time: '16:30:00' }],
        );
        expect(restou).toEqual([]);
    });

    it('aula de 1h partida com os dois horários lançados some inteira', () => {
        const restou = bookingsAindaNaoLancados(
            [{ id: 'b-1630', studentId: VICTOR }, { id: 'b-1700', studentId: VICTOR }],
            [{ booking_id: 'b-1630', student_id: VICTOR }, { booking_id: 'b-1700', student_id: VICTOR }],
        );
        expect(restou).toEqual([]);
    });

    it('nada lançado: os dois continuam a lançar', () => {
        const restou = bookingsAindaNaoLancados(
            [{ id: 'b-1630', studentId: VICTOR }, { id: 'b-1700', studentId: VICTOR }],
            [],
        );
        expect(restou.map(b => b.id)).toEqual(['b-1630', 'b-1700']);
    });

    it('reposição do mesmo aluno no dia NÃO cobre a aula fixa', () => {
        // Se cobrisse, a aula fixa sumiria da tela e o professor não receberia por ela.
        const restou = bookingsAindaNaoLancados(
            [{ id: 'b1', studentId: MARIANA }],
            [{ reschedule_id: 'r1', student_id: MARIANA }],
        );
        expect(restou.map(b => b.id)).toEqual(['b1']);
    });

    it('experimental do dia não cobre aula de aluno matriculado', () => {
        const restou = bookingsAindaNaoLancados(
            [{ id: 'b1', studentId: MARIANA }],
            [{ appointment_id: 'a1', student_id: null }],
        );
        expect(restou.map(b => b.id)).toEqual(['b1']);
    });

    it('lançamento de OUTRO aluno não esconde a aula de ninguém', () => {
        const restou = bookingsAindaNaoLancados(
            [{ id: 'b1', studentId: MARIANA }],
            [{ booking_id: 'b-outro', student_id: VICTOR }],
        );
        expect(restou.map(b => b.id)).toEqual(['b1']);
    });

    it('agendamento sem aluno não casa com log de aluno nulo', () => {
        // `sameId` frouxo já escondeu pendência de verdade em pendingLessons.ts.
        const restou = bookingsAindaNaoLancados(
            [{ id: 'b1', studentId: null }],
            [{ booking_id: 'b-outro', student_id: null }],
        );
        expect(restou.map(b => b.id)).toEqual(['b1']);
    });

    it('um log não é consumido por dois agendamentos de alunos diferentes', () => {
        const restou = bookingsAindaNaoLancados(
            [{ id: 'b1', studentId: MARIANA }, { id: 'b2', studentId: MARIANA }],
            [{ booking_id: 'apagado', student_id: MARIANA }],
        );
        expect(restou.map(b => b.id)).toEqual(['b2']);
    });

    it('mantém duas aulas pendentes se só houver um log antigo sem horário para o aluno no dia', () => {
        const restou = bookingsAindaNaoLancados(
            [{ id: 'b-1630', studentId: VICTOR }, { id: 'b-1700', studentId: VICTOR }],
            [{ student_id: VICTOR }],
        );
        expect(restou.map(b => b.id)).toEqual(['b-1700']);
    });

    it('esconde todas as aulas pendentes quando há dois logs sem horário do mesmo aluno no dia', () => {
        const restou = bookingsAindaNaoLancados(
            [{ id: 'b-1630', studentId: VICTOR }, { id: 'b-1700', studentId: VICTOR }],
            [{ student_id: VICTOR }, { student_id: VICTOR }],
        );
        expect(restou).toEqual([]);
    });
});
