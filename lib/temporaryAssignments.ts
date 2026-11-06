/**
 * Atribuição temporária: um professor assume reposições de um aluno por um período,
 * sem mexer na grade fixa. Quem decide é o servidor (`preview_temporary_assignment`,
 * `create_temporary_assignment`); aqui só o que a tela precisa para falar a mesma
 * língua. Aula = 30 min: 1 hora são 2 aulas, como em todo o resto do sistema.
 */

export interface AssignmentSlot {
  day_of_week: number;
  start: string;
  end: string;
}

export type PlanStatus = 'OK' | 'FERIADO' | 'PROFESSOR_OCUPADO' | 'ALUNO_OCUPADO' | 'LIMITE' | 'PASSADO';

export interface PlanOccurrence {
  date: string;
  time: string;
  status: PlanStatus;
  detail: string | null;
}

export interface AssignmentCounts {
  total: number;
  agendadas: number;
  a_lancar: number;
  sem_data: number;
  realizadas: number;
  aluno_faltou: number;
  professor_faltou: number;
  canceladas: number;
}

export interface AssignmentPool extends AssignmentCounts {
  owed: number;
  distribuidas: number;
  pendentes: number;
  sem_professor: number;
}

export interface AssignmentPreview {
  occurrences: PlanOccurrence[];
  generated: number;
  owed: number;
  limit: number;
  pool: AssignmentPool;
  open_credits: number;
  open_credits_teacher_fault: number;
  term_pending: boolean;
  slots_text: string;
}

export type OccurrenceState = 'agendada' | 'a_lancar' | 'sem_data' | 'realizada' | 'aluno_faltou' | 'professor_faltou';

export interface AssignmentOccurrence {
  id: string;
  date: string;
  time: string;
  state: OccurrenceState;
}

export interface TemporaryAssignment {
  id: string;
  status: 'ACTIVE' | 'ENDED';
  student_id: string;
  student_name: string;
  original_teacher_name: string;
  temporary_teacher_name: string;
  slots_text: string;
  starts_on: string;
  ends_on: string;
  lessons_owed: number;
  reason: string;
  created_by_name: string | null;
  ended_at: string | null;
  ended_by_name: string | null;
  end_reason: string | null;
  ended_automatically: boolean;
  participants_active: boolean;
  counts: AssignmentCounts;
  pool: AssignmentPool;
  occurrences: AssignmentOccurrence[];
}

/** Na ordem da semana de quem marca aula: segunda primeiro, domingo por último. */
export const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'Segunda' },
  { value: 2, label: 'Terça' },
  { value: 3, label: 'Quarta' },
  { value: 4, label: 'Quinta' },
  { value: 5, label: 'Sexta' },
  { value: 6, label: 'Sábado' },
  { value: 0, label: 'Domingo' },
];

/** O servidor só aceita meia em meia hora: é a unidade de aula e de disponibilidade. */
export const HALF_HOUR_OPTIONS: string[] = Array.from({ length: 48 }, (_, index) => {
  const hours = String(Math.floor(index / 2)).padStart(2, '0');
  return `${hours}:${index % 2 === 0 ? '00' : '30'}`;
});

const toMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

/** Quantas aulas de 30 min cabem no horário. Inválido vale 0. */
export const lessonsInSlot = (slot: Pick<AssignmentSlot, 'start' | 'end'>): number => {
  const span = toMinutes(slot.end) - toMinutes(slot.start);
  return span > 0 ? Math.floor(span / 30) : 0;
};

/** Aviso antes de chamar o servidor; quem recusa de verdade é ele. */
export const slotsProblem = (slots: AssignmentSlot[]): string | null => {
  if (slots.length === 0) return 'Inclua pelo menos um horário.';
  if (slots.some(slot => lessonsInSlot(slot) === 0)) return 'O fim do horário precisa ser depois do início.';
  if (slots.some(slot => lessonsInSlot(slot) > 8)) return 'Cada horário pode ter no máximo 4 horas.';
  const clash = slots.some((a, i) => slots.some((b, j) =>
    i < j && a.day_of_week === b.day_of_week
    && toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end)));
  return clash ? 'Dois horários se sobrepõem no mesmo dia.' : null;
};

const PLAN_LABELS: Record<PlanStatus, string> = {
  OK: 'Vai para a agenda',
  FERIADO: 'Feriado nacional, sem aula',
  PROFESSOR_OCUPADO: 'Professor ocupado',
  ALUNO_OCUPADO: 'Aluno ocupado',
  LIMITE: 'Passa do saldo informado',
  PASSADO: 'Horário já passou',
};

/** Rótulo de uma ocorrência do plano, com o motivo concreto quando há. */
export const planLabel = (occurrence: Pick<PlanOccurrence, 'status' | 'detail'>): string => {
  if (occurrence.status === 'OK') {
    return occurrence.detail === 'fora_da_grade'
      ? 'Vai para a agenda (fora da grade declarada)'
      : PLAN_LABELS.OK;
  }
  if (occurrence.status === 'FERIADO') return PLAN_LABELS.FERIADO;
  return occurrence.detail ? `${PLAN_LABELS[occurrence.status]}: ${occurrence.detail}` : PLAN_LABELS[occurrence.status];
};

export const STATE_LABELS: Record<OccurrenceState, string> = {
  agendada: 'Agendada',
  a_lancar: 'A lançar',
  sem_data: 'Sem data',
  realizada: 'Realizada',
  aluno_faltou: 'Aluno faltou',
  professor_faltou: 'Professor faltou',
};

/** Resumo do plano para o botão de confirmar: o que entra e o que fica de fora. */
export const planSummary = (occurrences: PlanOccurrence[]): { entram: number; foraDaGrade: number; foraDoPlano: number } => ({
  entram: occurrences.filter(o => o.status === 'OK').length,
  foraDaGrade: occurrences.filter(o => o.status === 'OK' && o.detail === 'fora_da_grade').length,
  foraDoPlano: occurrences.filter(o => o.status !== 'OK').length,
});

const ERROR_MESSAGES: Record<string, string> = {
  sem_permissao: 'Só a direção e a coordenação da escola podem fazer isso.',
  horarios_invalidos: 'Confira os horários: use meia em meia hora e no máximo 4 horas por horário.',
  horarios_sobrepostos: 'Dois horários se sobrepõem no mesmo dia.',
  periodo_invalido: 'Confira o período: o início não pode estar no passado e o período vai até 1 ano.',
  periodo_sem_aula: 'Nenhum dos dias escolhidos cai dentro do período.',
  periodo_grande_demais: 'Esse período gera mais de 200 aulas. Divida em duas atribuições.',
  saldo_invalido: 'O total de aulas pendentes precisa ficar entre 1 e 500.',
  professores_iguais: 'Escolha um professor temporário diferente do professor original.',
  aluno_inativo: 'Este aluno não está ativo na escola.',
  professor_temporario_inativo: 'O professor temporário precisa estar ativo na escola.',
  professor_original_invalido: 'O professor original não é desta escola.',
  motivo_obrigatorio: 'Escreva o motivo (mínimo 3 letras).',
  pedido_invalido: 'Não foi possível identificar o pedido. Atualize a tela e tente de novo.',
  saldo_ja_distribuido: 'Todo o saldo já foi distribuído. Aumente o total de aulas pendentes para gerar mais.',
  nenhuma_aula_disponivel: 'Nenhum horário ficou livre nesse período. Confira a lista e escolha outro horário.',
  atribuicao_nao_encontrada: 'Esta atribuição não foi encontrada. Atualize a tela.',
};

export const assignmentErrorMessage = (message: string | null | undefined): string => {
  if (!message) return 'Não foi possível concluir. Tente de novo.';
  return ERROR_MESSAGES[message] ?? message;
};
