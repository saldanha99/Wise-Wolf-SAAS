// Regras da grade semanal do Explorador de Agenda.
//
// Vive fora do componente porque errar aqui vaza a agenda de um professor para
// outro — e vazou: a reposição da aluna Dâmaris (professor Flávio) aparecia na
// grade de TODOS os professores, escondendo o aluno real daquele horário.
// Regra testável = regressão barata.
//
// ⚠️ A GRADE TEM SEMANA. Antes não tinha: as colunas eram só "Segunda..Sábado"
// e a reposição era casada pelo DIA DA SEMANA da data dela. Uma reposição
// marcada para quinta 20/08 pintava a célula "Quinta" em TODA semana até a data
// passar — indistinguível de uma aula fixa, e por isso lida como "chumbada".
// O paliativo anterior (só mostrar data >= hoje) escondia o sintoma no passado
// e deixava o futuro intacto. Agora cada coluna tem uma DATA concreta, e a
// reposição só aparece na semana em que ela realmente acontece.

import { Reschedule } from '../types';
import { localYMD, parseLocalDate } from './dateUtils';

// Colunas da grade: 0 = Segunda … 5 = Sábado (domingo não tem coluna).
export const dayIndexFromDate = (date: Date): number => {
    const weekday = date.getDay(); // 0 = Domingo
    return weekday === 0 ? -1 : weekday - 1;
};

// Segunda-feira da semana de `date`, à meia-noite local. Domingo pertence à
// semana que ACABA nele (o domingo de 09/08 volta para a segunda 03/08), senão
// quem abre a tela num domingo veria a semana seguinte e acharia que perdeu as
// aulas da semana corrente.
export const weekStartOf = (date: Date = new Date()): Date => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const shift = d.getDay() === 0 ? 6 : d.getDay() - 1;
    d.setDate(d.getDate() - shift);
    return d;
};

// Data (YYYY-MM-DD) da coluna `dayIdx` na semana que começa em `weekStart`.
export const dateForDayIndex = (weekStart: Date, dayIdx: number): string => {
    const d = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
    d.setDate(d.getDate() + dayIdx);
    return localYMD(d);
};

// Rótulo curto da coluna ("Segunda 11/08") — é o que deixa explícito, na tela,
// que a grade é de uma semana concreta e não de um molde perpétuo.
export const dayLabelWithDate = (weekStart: Date, dayIdx: number, dayName: string): string => {
    const ymd = dateForDayIndex(weekStart, dayIdx);
    const [, mm, dd] = ymd.split('-');
    return `${dayName} ${dd}/${mm}`;
};

const weekBounds = (weekStart: Date): { first: string; last: string } => ({
    first: dateForDayIndex(weekStart, 0), // Segunda
    last: dateForDayIndex(weekStart, 5),  // Sábado
});

// Quais reposições ocupam a grade DESTE professor NESTA semana.
//
// 1. `teacherId` — a lista recebida traz todas as reposições da escola (o diretor
//    enxerga o tenant inteiro). Sem o filtro, a reposição de um professor era
//    pintada na agenda dos outros.
// 2. A data tem de cair DENTRO da semana exibida. É o que impede a reposição de
//    virar ocupação permanente daquele horário.
// 3. 'Pendente' (sem data) sai: não ocupa horário nenhum.
export const reschedulesForTeacherGrid = (
    reschedules: Reschedule[] | undefined,
    teacherId: string | undefined | null,
    weekStart: Date = weekStartOf(),
): Reschedule[] => {
    if (!teacherId) return [];
    const { first, last } = weekBounds(weekStart);

    return (reschedules || []).filter(r => {
        if (String(r.teacherId) !== String(teacherId)) return false;
        const dateObj = parseLocalDate(r.date);
        if (!dateObj) return false;
        const ymd = localYMD(dateObj);
        return ymd >= first && ymd <= last;
    });
};

// Reposição que cai nesta célula (coluna do dia + horário 'HH:MM').
// Casa pela DATA da coluna, não pelo dia da semana solto: é a diferença entre
// "acontece nesta quinta" e "acontece toda quinta".
// Sem horário definido não ocupa célula — antes havia um `hour === 14` aqui que
// nunca era verdade (`hour` é string), ou seja: fallback morto.
export const findRescheduleForSlot = (
    reschedules: Reschedule[],
    dayIdx: number,
    time: string,
    weekStart: Date = weekStartOf(),
): Reschedule | null => {
    const slot = time.substring(0, 5);
    const cellDate = dateForDayIndex(weekStart, dayIdx);

    return reschedules.find(r => {
        const dateObj = parseLocalDate(r.date);
        if (!dateObj || localYMD(dateObj) !== cellDate) return false;
        return r.time ? r.time.startsWith(slot) : false;
    }) || null;
};

// ── Aula experimental ────────────────────────────────────────────────────────
//
// ⚠️ O bloco da experimental no Explorador lia `t.date` e `t.time`, mas a tabela
// `appointments` não tem nenhuma das duas: o horário vive em `start_time`
// (timestamptz). `new Date(undefined).getDay()` é NaN, o índice da coluna dava
// NaN, e o `if (dIdx >= 0)` era sempre falso — a experimental NUNCA foi
// desenhada na grade. Era código morto que parecia funcionalidade, e virou a
// referência de "temporário" que a reposição deveria seguir.
export interface GridTrial {
    id: string;
    start_time: string;      // timestamptz
    student_name?: string | null;
    status?: string | null;
}

export interface GridTrialSlot {
    id: string;
    studentName: string;
    date: string;            // YYYY-MM-DD
    time: string;            // HH:MM
}

// Converte o timestamptz para data/hora LOCAIS. `toISOString()` aqui jogaria a
// aula das 21h para o dia seguinte (mesma armadilha de dateUtils.ts).
const trialSlotOf = (t: GridTrial): GridTrialSlot | null => {
    const d = new Date(t.start_time);
    if (Number.isNaN(d.getTime())) return null;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return {
        id: String(t.id),
        studentName: (t.student_name || '').trim() || 'Aula Experimental',
        date: localYMD(d),
        time: `${hh}:${mm}`,
    };
};

// Experimentais desta semana. Cancelada não ocupa horário.
export const trialsForGrid = (
    trials: GridTrial[] | undefined,
    weekStart: Date = weekStartOf(),
): GridTrialSlot[] => {
    const { first, last } = weekBounds(weekStart);
    return (trials || [])
        .filter(t => !['cancelled', 'canceled', 'no_show'].includes(String(t.status || '').toLowerCase()))
        .map(trialSlotOf)
        .filter((s): s is GridTrialSlot => !!s && s.date >= first && s.date <= last);
};

export const findTrialForSlot = (
    trials: GridTrialSlot[],
    dayIdx: number,
    time: string,
    weekStart: Date = weekStartOf(),
): GridTrialSlot | null => {
    const slot = time.substring(0, 5);
    const cellDate = dateForDayIndex(weekStart, dayIdx);
    return trials.find(t => t.date === cellDate && t.time === slot) || null;
};
