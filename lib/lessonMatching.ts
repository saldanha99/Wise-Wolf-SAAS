// Aula do dia JÁ FOI LANÇADA? — regra única do "Lançar Aula".
//
// O `LessonLauncher` casava a aula esperada com o lançamento SÓ por `booking_id`.
// Quando o aluno troca de horário, a escola cria um agendamento novo e o antigo
// costuma ser apagado; o `class_logs` daquele dia continua apontando para o
// agendamento que não existe mais. Para a tela, aquela aula "nunca foi lançada" —
// e ela voltava para a lista, dias ou semanas depois.
//
// Medido na conta do Flávio em 13/08/2026: 12 aulas de julho já lançadas
// reaparecendo como pendentes. Relançar não é inofensivo: a trava do servidor é
// `(booking_id, class_date)` e NÃO barra agendamentos diferentes — de propósito,
// porque aula de 1h partida em 16:30 + 17:00 são dois agendamentos legítimos que
// pagam os dois. Ou seja: a tela deixava a mesma aula ser paga duas vezes.
//
// A regra abaixo consome os lançamentos do dia em duas passadas. O que sobra de
// agendamento sem lançamento é o que o professor realmente precisa lançar — e o
// Victor Hugo (16:30 lançada, 17:00 não) continua vendo a que falta.

export interface MatchBooking {
    id: string;
    studentId?: string | null;
}

export interface MatchLog {
    booking_id?: string | null;
    reschedule_id?: string | null;
    appointment_id?: string | null;
    student_id?: string | null;
}

/**
 * Recebe os agendamentos candidatos do dia (já filtrados por cobertura, horário e
 * duplicidade de slot) e os lançamentos daquele MESMO dia. Devolve, na ordem de
 * entrada, só os agendamentos que ainda não têm lançamento.
 */
export const bookingsAindaNaoLancados = <T extends MatchBooking>(
    candidatos: T[],
    logsDoDia: MatchLog[],
): T[] => {
    // Só lançamento de aula REGULAR entra na conta: reposição e experimental do
    // mesmo aluno no mesmo dia são OUTRA aula, não a mesma — consumi-las aqui
    // esconderia a aula fixa e o professor deixaria de receber por ela.
    const disponiveis = logsDoDia.filter(l => !l.reschedule_id && !l.appointment_id);
    const consumidos = new Set<MatchLog>();

    // 1ª passada — casamento exato pelo agendamento.
    const pendentes: T[] = [];
    for (const b of candidatos) {
        const exato = disponiveis.find(l => !consumidos.has(l) && l.booking_id && l.booking_id === b.id);
        if (exato) { consumidos.add(exato); continue; }
        pendentes.push(b);
    }

    // 2ª passada — pelo aluno: cobre o agendamento trocado/recriado. Consome um
    // lançamento por agendamento, então quem tem 2 aulas no dia e lançou 1
    // continua com 1 para lançar.
    const faltando: T[] = [];
    for (const b of pendentes) {
        const doAluno = disponiveis.find(
            l => !consumidos.has(l) && !!l.student_id && !!b.studentId && l.student_id === b.studentId,
        );
        if (doAluno) { consumidos.add(doAluno); continue; }
        faltando.push(b);
    }

    return faltando;
};
