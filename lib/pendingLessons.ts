// Aulas pendentes de lançamento — REGRA ÚNICA.
//
// Existia em dois lugares com regras diferentes: a tela `PendingLessons` e o
// contador do badge no `App.tsx`. O badge estava errado de três formas e nunca
// zerava (medido em produção, 04/08/2026: badge mostrava 130 para a Debora, 90
// para o Mateus, 55 para o Flávio — e a tela mostrava ZERO para todos):
//
//  1. buscava `class_logs` só dos últimos 3 DIAS, mas checava aulas de 7 a 30 dias
//     atrás. Nenhum log da janela entrava na comparação, então TODA aula contava
//     como pendente, inclusive as já lançadas. O número só crescia.
//  2. comparava `created_at` (quando foi lançada) com a data da AULA — aula lançada
//     com atraso nunca casava. A tela já tinha corrigido isso para `class_date`.
//  3. usava `toISOString()` para a data — depois das 21h no Brasil pula para o dia
//     seguinte (a mesma armadilha documentada em `dateUtils.ts`).
//
// Além disso a tela corta no mês corrente e o badge não cortava: em qualquer dia 1
// a 7 do mês, a janela (7 a 30 dias atrás) cai inteira no mês anterior — badge com
// número e tela vazia. Era exatamente o sintoma relatado.
//
// Agora as duas superfícies chamam esta função. Se a tela mostra 0, o badge é 0.

import { supabase } from './supabase';
import { localMonth, localYMD } from './dateUtils';

const DAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// Janela: aula de até 60 dias atrás, com 7 dias de carência (aula recente não é
// pendência — o professor ainda tem prazo para lançar no "Lançar Aula").
export const PENDING_LOOKBACK_DAYS = 60;
export const PENDING_GRACE_DAYS = 7;

export interface PendingLesson {
    id: string;
    bookingId?: string;
    rescheduleId?: string;
    studentId?: string;
    student: string;
    module: string;
    date: string;      // dd/mm/aaaa (exibição)
    rawDate: string;   // YYYY-MM-DD
    time: string;
    type: 'REGULAR' | 'REPOSIÇÃO';
}

export interface PendingBookingRow {
    id: string;
    time_slot: string | null;
    start_date?: string | null;
    day_of_week?: string | null;
    student?: { id?: string; full_name?: string; module?: string } | null;
}

export interface PendingRescheduleRow {
    id: string;
    date: string;
    time: string | null;
    student?: { id?: string; full_name?: string; module?: string } | null;
}

export interface PendingLogRow {
    booking_id?: string | null;
    reschedule_id?: string | null;
    student_id?: string | null;
    class_date?: string | null;
}

const sameId = (a: unknown, b: unknown): boolean =>
    a != null && b != null && String(a) === String(b);

export const pendingWindow = (today: Date = new Date()) => {
    const start = new Date(today);
    start.setDate(today.getDate() - PENDING_LOOKBACK_DAYS);
    const end = new Date(today);
    end.setDate(today.getDate() - PENDING_GRACE_DAYS);
    return { start, end, startYMD: localYMD(start), endYMD: localYMD(end) };
};

// Parte pura: dados na mão → lista de pendências. É aqui que a regra mora.
export const computePendingLessons = (input: {
    bookings: PendingBookingRow[];
    reschedules: PendingRescheduleRow[];
    logs: PendingLogRow[];
    today?: Date;
}): PendingLesson[] => {
    const today = input.today || new Date();
    const { start, end } = pendingWindow(today);
    const currentMonth = localMonth(today);

    const expected: PendingLesson[] = [];

    for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
        const dayName = DAY_NAMES[cursor.getDay()];
        if (dayName === 'Domingo') continue;

        const rawDate = localYMD(cursor);
        const label = cursor.toLocaleDateString('pt-BR');

        for (const b of input.bookings) {
            if (b.day_of_week !== dayName) continue;
            if (b.start_date && rawDate < b.start_date) continue; // aluno ainda não tinha começado
            expected.push({
                id: `book-${b.id}-${rawDate}`,
                bookingId: b.id,
                studentId: b.student?.id,
                student: b.student?.full_name || 'Aluno',
                module: b.student?.module || 'N/A',
                date: label,
                rawDate,
                time: b.time_slot || '',
                type: 'REGULAR',
            });
        }

        for (const r of input.reschedules) {
            if (r.date !== rawDate) continue;
            expected.push({
                id: `repo-${r.id}`,
                rescheduleId: r.id,
                studentId: r.student?.id,
                student: r.student?.full_name || 'Aluno',
                module: r.student?.module || 'N/A',
                date: label,
                rawDate,
                time: r.time || '',
                type: 'REPOSIÇÃO',
            });
        }
    }

    // Corte no mês corrente: aula de mês fechado não se regulariza por aqui
    // (vai para o próximo fechamento aberto via `closing_carryovers`). Sem o
    // corte, uma agenda antiga que ficou SCHEDULED vira dezenas de aulas
    // "lançáveis" que nunca aconteceram — dinheiro saindo por engano.
    const noMes = expected.filter(exp => exp.rawDate.substring(0, 7) >= currentMonth);

    // Cada lançamento cobre UMA aula — o `some()` de antes não consumia nada, e a
    // rede por aluno+data escondia as duas metades de uma aula de 1h partida
    // (16:30 + 17:00, dois agendamentos legítimos) quando só uma tinha sido
    // lançada. O professor deixava de lançar — e de receber — a outra metade.
    const consumidos = new Set<PendingLogRow>();
    const cobre = (exp: PendingLesson, log: PendingLogRow): boolean => {
        if (consumidos.has(log)) return false;
        if (exp.type === 'REGULAR' && sameId(log.booking_id, exp.bookingId)) {
            return log.class_date === exp.rawDate;
        }
        if (exp.type === 'REPOSIÇÃO' && sameId(log.reschedule_id, exp.rescheduleId)) {
            return true; // reposição é lançada uma vez só, a data pode divergir
        }
        return false;
    };

    // 1ª passada — casamento pela ORIGEM (agendamento ou reposição).
    const semOrigem = noMes.filter(exp => {
        const log = input.logs.find(l => cobre(exp, l));
        if (log) { consumidos.add(log); return false; }
        return true;
    });

    // 2ª passada — mesmo aluno, mesma data, outra origem: cobre o agendamento
    // trocado (log preso no booking antigo, que pode nem existir mais).
    // `sameId` exige os DOIS lados preenchidos: sem isso, um log de aula
    // experimental (student_id nulo) casava com qualquer pendência de aluno
    // nulo e escondia a pendência de verdade.
    return semOrigem.filter(exp => {
        const log = input.logs.find(l =>
            !consumidos.has(l) && sameId(l.student_id, exp.studentId) && l.class_date === exp.rawDate,
        );
        if (log) { consumidos.add(log); return false; }
        return true;
    });
};

// Busca em LOTE (3 consultas). A tela fazia 2 consultas POR DIA — com 60 dias de
// janela eram ~106 idas ao banco toda vez que a aba abria, e o badge repetia o
// mesmo padrão dentro do carregamento inicial do app.
export const fetchPendingLessons = async (params: {
    teacherId: string;
    tenantId: string;
    today?: Date;
}): Promise<PendingLesson[]> => {
    const today = params.today || new Date();
    const { startYMD, endYMD } = pendingWindow(today);

    const [bookingsRes, reschedulesRes, logsRes] = await Promise.all([
        supabase
            .from('bookings')
            .select('id, time_slot, start_date, day_of_week, student:student_id(id, full_name, module)')
            .eq('teacher_id', params.teacherId)
            .eq('tenant_id', params.tenantId)
            .eq('status', 'SCHEDULED')
            .not('day_of_week', 'is', null),
        supabase
            .from('reschedules')
            .select('id, date, time, student:student_id(id, full_name, module)')
            .eq('teacher_id', params.teacherId)
            .eq('tenant_id', params.tenantId)
            .gte('date', startYMD)
            .lte('date', endYMD),
        supabase
            .from('class_logs')
            .select('booking_id, reschedule_id, student_id, class_date')
            .eq('teacher_id', params.teacherId)
            .eq('tenant_id', params.tenantId)
            .gte('class_date', startYMD)
            .lte('class_date', endYMD),
    ]);

    return computePendingLessons({
        bookings: (bookingsRes.data as unknown as PendingBookingRow[]) || [],
        reschedules: (reschedulesRes.data as unknown as PendingRescheduleRow[]) || [],
        logs: (logsRes.data as unknown as PendingLogRow[]) || [],
        today,
    });
};
