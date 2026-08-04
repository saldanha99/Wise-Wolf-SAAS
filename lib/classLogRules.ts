// ─────────────────────────────────────────────────────────────────────────────
// LANÇAMENTO DE AULA — tipos e regras PURAS (sem I/O)
//
// Separado de `classLogging.ts` de propósito: aquele importa o cliente Supabase,
// que exige `VITE_SUPABASE_URL` no build. Deixar o que é puro aqui permite
// testar a tela de recompensa sem levantar meio aplicativo junto.
//
// ⚠️ NADA neste arquivo calcula valor de aula. O valor varia por posição de
// antiguidade do aluno na carteira e pelo estado do turbo — quem sabe é a view
// `v_payable_class_logs`, e a RPC devolve o número dela. Estimar aqui reproduz
// a divergência que já gerou contestação em série no painel Financeiro.
// ─────────────────────────────────────────────────────────────────────────────

export type ClassLogPresence =
    | 'COMPLETED'
    | 'STUDENT_ABSENCE'
    | 'TEACHER_ABSENCE'
    | 'Falta Justificada';

export interface ClassLogEntryInput {
    /** Id do item na tela — devolvido no resultado para casar linha com retorno. */
    ref: string;
    bookingId?: string | null;
    rescheduleId?: string | null;
    appointmentId?: string | null;
    classDate: string; // YYYY-MM-DD
    presence: ClassLogPresence;
    /** Motivo da falta (Doença/Trabalho/Viagem/Outros) — só quando houve falta. */
    absenceReason?: string | null;
    contentCovered?: string | null;
    observations?: string | null;
    assessmentLevel?: string | null;
    psychologicalProfile?: string | null;
    teacherVerdict?: string | null;
}

export interface ClassLogEntryResult {
    ref: string | null;
    id: string | null;
    status: 'lancada' | 'ignorada';
    /** Por que foi ignorada (só quando status = 'ignorada'). */
    reason: string | null;
    kind: 'REGULAR' | 'REPOSICAO' | 'TRIAL' | 'TRAINING' | null;
    subtype: string | null;
    /** Valor autoritativo que esta aula somou ao caixa. 0 quando não entra na folha. */
    amount: number;
    paid: boolean;
    /** Por que não entrou na folha (só quando paid = false). */
    unpaidReason: string | null;
}

export interface ClassLogResult {
    inserted: number;
    skipped: number;
    reschedulesCreated: number;
    /** Quanto ESTE lançamento somou ao caixa do professor. */
    deltaAmount: number;
    deltaLessons: number;
    /** Total do mês já lançado, pela mesma fonte que paga. */
    monthAmount: number;
    monthLessons: number;
    turboActive: boolean;
    entries: ClassLogEntryResult[];
}

/** Motivos de "ignorada" em português — o professor precisa entender o que houve. */
const SKIP_MESSAGES: Record<string, string> = {
    ja_lancada: 'já estava lançada',
    aluno_ja_tem_aula_nesta_data: 'este aluno já tem aula lançada nesta data',
    aula_no_futuro: 'a aula ainda não aconteceu',
    fora_da_janela: 'passou do prazo de lançamento (120 dias)',
    data_invalida: 'data inválida',
    presenca_invalida: 'tipo de presença inválido',
    sem_origem: 'sem agendamento de origem',
    reposicao_inexistente: 'a reposição não existe mais',
    agendamento_inexistente: 'o agendamento não existe mais',
};

/** Motivos de "não entrou na folha" — dito na cara, sem fingir festa. */
const UNPAID_MESSAGES: Record<string, string> = {
    falta_professor: 'Falta do professor não é remunerada. Quando você repuser esta aula, a reposição entra no caixa.',
    reposicao_falta_aluno: 'Reposição de falta do aluno não é remunerada — a aula de origem já foi paga.',
    teste_oral: 'Teste oral não conta como hora-aula regular.',
    em_conferencia: 'Aula em conferência de presença. Entra no caixa assim que a coordenação resolver.',
    aluno_nao_faturavel: 'Este aluno não é faturável.',
    fora_da_folha: 'Esta aula não entra no cálculo da folha.',
};

export const describeSkip = (reason: string | null): string =>
    (reason && SKIP_MESSAGES[reason]) || 'não pôde ser lançada';

export const describeUnpaid = (reason: string | null): string =>
    (reason && UNPAID_MESSAGES[reason]) || UNPAID_MESSAGES.fora_da_folha;

// ─────────────────────────────────────────────────────────────────────────────
// XP — camada arcade
//
// O XP NÃO representa dinheiro, e é por isso que ele pode ser calculado aqui:
// não existe risco de divergir da folha. Ele premia o COMPORTAMENTO que o
// negócio precisa — lançar no mesmo dia e lançar tudo de uma vez — porque aula
// não lançada trava o fechamento e a confirmação de presença do aluno.
// O progresso que persiste é o R$ do mês, que vem do servidor.
// ─────────────────────────────────────────────────────────────────────────────

export const XP_POR_AULA = 10;
export const XP_BONUS_EM_DIA = 5;

export interface XpBreakdown {
    total: number;
    base: number;
    bonusEmDia: number;
    /** Multiplicador por lançar várias de uma vez (1, 1.5 ou 2). */
    combo: number;
    aulas: number;
    aulasEmDia: number;
}

/** `lateFlags[i] = true` quando a aula é de um dia anterior (lançamento atrasado). */
export function calcularXp(lateFlags: boolean[]): XpBreakdown {
    const aulas = lateFlags.length;
    if (aulas === 0) {
        return { total: 0, base: 0, bonusEmDia: 0, combo: 1, aulas: 0, aulasEmDia: 0 };
    }
    const aulasEmDia = lateFlags.filter(l => !l).length;
    const base = aulas * XP_POR_AULA;
    const bonusEmDia = aulasEmDia * XP_BONUS_EM_DIA;
    const combo = aulas >= 5 ? 2 : aulas >= 3 ? 1.5 : 1;
    return {
        total: Math.round((base + bonusEmDia) * combo),
        base,
        bonusEmDia,
        combo,
        aulas,
        aulasEmDia,
    };
}
