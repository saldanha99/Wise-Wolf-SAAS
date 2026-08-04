// Regras da grade semanal do Explorador de Agenda.
//
// Vive fora do componente porque errar aqui vaza a agenda de um professor para
// outro — e vazou: a reposição da aluna Dâmaris (professor Flávio) aparecia na
// grade de TODOS os professores, escondendo o aluno real daquele horário.
// Regra testável = regressão barata.

import { Reschedule } from '../types';
import { localYMD, parseLocalDate } from './dateUtils';

// Colunas da grade: 0 = Segunda … 5 = Sábado (domingo não tem coluna).
export const dayIndexFromDate = (date: Date): number => {
    const weekday = date.getDay(); // 0 = Domingo
    return weekday === 0 ? -1 : weekday - 1;
};

// Quais reposições ocupam a grade DESTE professor.
//
// 1. `teacherId` — a lista recebida traz todas as reposições da escola (o diretor
//    enxerga o tenant inteiro). Sem o filtro, a reposição de um professor era
//    pintada na agenda dos outros.
// 2. Data no passado sai: a lista só traz `used_at is null`, então data vencida é
//    pendência de agendamento, não aula marcada. A grade é um molde SEMANAL e a
//    reposição é evento de um dia — sem o corte, uma reposição de junho bloqueava
//    aquele horário para sempre.
// 3. 'Pendente' (sem data) também sai: não ocupa horário nenhum.
export const reschedulesForTeacherGrid = (
    reschedules: Reschedule[] | undefined,
    teacherId: string | undefined | null,
    today: Date = new Date(),
): Reschedule[] => {
    if (!teacherId) return [];
    const todayYMD = localYMD(today);

    return (reschedules || []).filter(r => {
        if (String(r.teacherId) !== String(teacherId)) return false;
        const dateObj = parseLocalDate(r.date);
        return dateObj ? localYMD(dateObj) >= todayYMD : false;
    });
};

// Reposição que cai nesta célula (coluna do dia + horário 'HH:MM').
// Sem horário definido não ocupa célula — antes havia um `hour === 14` aqui que
// nunca era verdade (`hour` é string), ou seja: fallback morto.
export const findRescheduleForSlot = (
    reschedules: Reschedule[],
    dayIdx: number,
    time: string,
): Reschedule | null => {
    const slot = time.substring(0, 5);

    return reschedules.find(r => {
        const dateObj = parseLocalDate(r.date);
        if (!dateObj) return false;
        if (dayIndexFromDate(dateObj) !== dayIdx) return false;
        return r.time ? r.time.startsWith(slot) : false;
    }) || null;
};
