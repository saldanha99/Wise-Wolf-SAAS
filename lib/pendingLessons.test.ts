import { describe, expect, it } from 'vitest';
import { computePendingLessons, PendingBookingRow, PendingLogRow } from './pendingLessons';

// Quinta, 20/08/2026 → janela 21/06 a 13/08, mês corrente 2026-08.
// As segundas elegíveis são 03/08 e 10/08.
const HOJE = new Date(2026, 7, 20);

const aluno = { id: 'aluno-1', full_name: 'Victor Hugo', module: 'A2' };

const bookingSegunda: PendingBookingRow = {
    id: 'book-seg',
    time_slot: '19:00',
    day_of_week: 'Segunda',
    start_date: null,
    student: aluno,
};

const semLogs: PendingLogRow[] = [];

// Aula de 1h partida em dois slots de 30 min: dois agendamentos legítimos no
// mesmo dia, e a folha paga os dois (Victor Hugo, 16:30 + 17:00).
const bookingSegunda1630: PendingBookingRow = {
    id: 'book-seg-1630', time_slot: '16:30', day_of_week: 'Segunda', start_date: null, student: aluno,
};
const bookingSegunda1700: PendingBookingRow = {
    id: 'book-seg-1700', time_slot: '17:00', day_of_week: 'Segunda', start_date: null, student: aluno,
};

describe('computePendingLessons — o badge tem de bater com a tela', () => {
    it('aula de 1h partida: metade lançada deixa a OUTRA metade pendente', () => {
        // A rede por aluno+data usava `some()`, que não consome o lançamento: um
        // único log escondia os dois agendamentos e o professor perdia 30 min.
        const logs: PendingLogRow[] = [
            { booking_id: 'book-seg-1630', reschedule_id: null, class_date: '2026-08-10', student_id: 'aluno-1' },
            { booking_id: 'book-seg-1630', reschedule_id: null, class_date: '2026-08-03', student_id: 'aluno-1' },
            { booking_id: 'book-seg-1700', reschedule_id: null, class_date: '2026-08-03', student_id: 'aluno-1' },
        ];
        const r = computePendingLessons({
            bookings: [bookingSegunda1630, bookingSegunda1700], reschedules: [], logs, today: HOJE,
        });
        expect(r.map(p => `${p.rawDate} ${p.time}`)).toEqual(['2026-08-10 17:00']);
    });

    it('agendamento trocado: aula já lançada não volta a ser pendência', () => {
        // O log aponta para o agendamento antigo (apagado quando o aluno mudou de
        // horário). Sem a 2ª passada, a aula lançada reaparecia para lançar.
        const logs: PendingLogRow[] = [
            { booking_id: 'book-antigo-apagado', reschedule_id: null, class_date: '2026-08-03', student_id: 'aluno-1' },
            { booking_id: 'book-antigo-apagado', reschedule_id: null, class_date: '2026-08-10', student_id: 'aluno-1' },
        ];
        const r = computePendingLessons({ bookings: [bookingSegunda], reschedules: [], logs, today: HOJE });
        expect(r).toEqual([]);
    });

    it('conta as aulas não lançadas da janela', () => {
        const r = computePendingLessons({ bookings: [bookingSegunda], reschedules: [], logs: semLogs, today: HOJE });
        expect(r.map(p => p.rawDate)).toEqual(['2026-08-03', '2026-08-10']);
    });

    it('NÃO conta a aula já lançada — o log é procurado pela data da AULA', () => {
        // O contador antigo buscava logs só dos últimos 3 dias e comparava
        // `created_at`: aula lançada com atraso nunca casava e seguia contando.
        // Era isso que fazia o badge mostrar 130 para quem tinha zero.
        const logs: PendingLogRow[] = [
            { booking_id: 'book-seg', class_date: '2026-08-03', reschedule_id: null, student_id: 'aluno-1' },
        ];
        const r = computePendingLessons({ bookings: [bookingSegunda], reschedules: [], logs, today: HOJE });
        expect(r.map(p => p.rawDate)).toEqual(['2026-08-10']);
    });

    it('aula recente (dentro dos 7 dias de carência) ainda não é pendência', () => {
        // 17/08 é segunda, mas está a 3 dias — o professor ainda tem prazo.
        const r = computePendingLessons({ bookings: [bookingSegunda], reschedules: [], logs: semLogs, today: HOJE });
        expect(r.some(p => p.rawDate === '2026-08-17')).toBe(false);
    });

    it('não conta aula de mês fechado, mesmo dentro da janela de 60 dias', () => {
        const r = computePendingLessons({ bookings: [bookingSegunda], reschedules: [], logs: semLogs, today: HOJE });
        expect(r.some(p => p.rawDate.startsWith('2026-07'))).toBe(false);
    });

    it('respeita start_date: aluno que ainda não tinha começado não gera pendência', () => {
        const futuro: PendingBookingRow = { ...bookingSegunda, start_date: '2026-08-05' };
        const r = computePendingLessons({ bookings: [futuro], reschedules: [], logs: semLogs, today: HOJE });
        expect(r.map(p => p.rawDate)).toEqual(['2026-08-10']);
    });

    it('reposição na janela conta, e some quando lançada', () => {
        const reschedules = [{ id: 'rep-1', date: '2026-08-05', time: '08:00', student: aluno }];
        expect(computePendingLessons({ bookings: [], reschedules, logs: semLogs, today: HOJE })).toHaveLength(1);

        const logs: PendingLogRow[] = [
            { reschedule_id: 'rep-1', booking_id: null, class_date: '2026-08-05', student_id: 'aluno-1' },
        ];
        expect(computePendingLessons({ bookings: [], reschedules, logs, today: HOJE })).toEqual([]);
    });

    it('log sem aluno (aula experimental) não apaga a pendência de um aluno', () => {
        // Regressão: `String(null) === String(null)` é TRUE. Dois nulos casavam e a
        // pendência sumia em silêncio — professor deixava de ver aula a lançar.
        const semAluno: PendingBookingRow = { ...bookingSegunda, student: { full_name: 'Aluno' } };
        const logs: PendingLogRow[] = [
            { booking_id: null, reschedule_id: null, student_id: null, class_date: '2026-08-03' },
        ];
        expect(computePendingLessons({ bookings: [semAluno], reschedules: [], logs, today: HOJE })).toHaveLength(2);
    });

    it('domingo nunca vira pendência', () => {
        const domingo: PendingBookingRow = { ...bookingSegunda, day_of_week: 'Domingo' };
        expect(computePendingLessons({ bookings: [domingo], reschedules: [], logs: semLogs, today: HOJE })).toEqual([]);
    });

    it('sem agenda e sem reposição o resultado é ZERO — o badge não inventa número', () => {
        expect(computePendingLessons({ bookings: [], reschedules: [], logs: semLogs, today: HOJE })).toEqual([]);
    });

    it('ZONA CEGA CONHECIDA: nos 7 primeiros dias do mês nada é pendência', () => {
        // A janela termina em D-7 e o corte descarta mês fechado: em 04/08 a janela
        // (05/06 a 28/07) não tem NENHUM dia de agosto. Tela e badge dão zero, o que
        // hoje é coerente entre si — mas esconde pendência real de julho.
        // Fixado em teste porque é decisão de negócio, não acidente: mudar o corte
        // libera lançamento retroativo e mexe em folha.
        const diaQuatro = new Date(2026, 7, 4);
        expect(computePendingLessons({ bookings: [bookingSegunda], reschedules: [], logs: semLogs, today: diaQuatro })).toEqual([]);
    });
});
