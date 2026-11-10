// Baixa manual de aulas (migration 20261110140000). A conta do valor e as
// travas ficam no servidor; aqui só os rótulos, a validação do formulário e a
// tradução dos erros.

export type ManualLessonKind = 'EXPERIMENTAL' | 'TESTE_ORAL' | 'REPOSICAO' | 'OUTRO';

export const MANUAL_LESSON_KINDS: { value: ManualLessonKind; label: string }[] = [
  { value: 'TESTE_ORAL', label: 'Teste oral' },
  { value: 'EXPERIMENTAL', label: 'Aula experimental' },
  { value: 'REPOSICAO', label: 'Reposição' },
  { value: 'OUTRO', label: 'Outra aula' },
];

export const kindLabel = (kind: string): string =>
  MANUAL_LESSON_KINDS.find(item => item.value === kind)?.label ?? kind;

export interface ManualLessonEntry {
  id: string;
  kind: ManualLessonKind;
  teacher_id: string;
  teacher_name: string;
  student_id: string | null;
  student_name: string | null;
  guest_name: string | null;
  class_date: string;
  start_time: string;
  units: number;
  reason: string;
  rate_override: number | null;
  created_by_name: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancelled_by_name: string | null;
  cancel_reason: string | null;
  month_closed: boolean;
  valor: number;
}

export interface ManualLessonDraft {
  teacherId: string;
  kind: ManualLessonKind | '';
  date: string;
  time: string;
  units: number;
  personMode: 'student' | 'guest';
  studentId: string;
  guestName: string;
  reason: string;
  rate: string;
}

export const MIN_REASON = 10;

/** Primeiro problema do formulário, ou null quando pode enviar. */
export function draftProblem(draft: ManualLessonDraft, now: Date = new Date()): string | null {
  if (!draft.teacherId) return 'Escolha o professor.';
  if (!draft.kind) return 'Escolha o tipo da aula.';
  if (!draft.date || !/^\d{2}:\d{2}$/.test(draft.time)) return 'Informe a data e o horário.';
  if (!/:(00|30)$/.test(draft.time)) return 'O horário é de meia em meia hora.';
  if (draft.personMode === 'student' && !draft.studentId) return 'Escolha o aluno.';
  if (draft.personMode === 'guest' && draft.guestName.trim().length < 2) return 'Escreva o nome de quem fez a aula.';
  if (draft.reason.trim().length < MIN_REASON) return `Escreva o motivo (pelo menos ${MIN_REASON} letras).`;
  if (draft.rate.trim()) {
    const value = Number(draft.rate.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > 200) return 'Valor por 30 min inválido.';
  }
  const end = new Date(`${draft.date}T${draft.time}:00-03:00`);
  end.setMinutes(end.getMinutes() + 30 * draft.units);
  if (end.getTime() > now.getTime()) return 'A aula ainda não terminou. A baixa é feita depois da aula.';
  return null;
}

/** Valor por 30 min digitado, ou null para usar a tarifa normal do professor. */
export const parseRate = (rate: string): number | null =>
  rate.trim() ? Number(rate.replace(',', '.')) : null;

const ERRORS: Record<string, string> = {
  sem_permissao: 'Só a direção e a coordenação da escola fazem baixa manual.',
  tipo_invalido: 'Escolha o tipo da aula.',
  motivo_obrigatorio: `Escreva o motivo (pelo menos ${MIN_REASON} letras).`,
  duracao_invalida: 'Duração inválida.',
  data_ou_horario_invalido: 'Data ou horário inválido. O horário é de meia em meia hora.',
  data_muito_antiga: 'A aula é de mais de 120 dias atrás. Use um ajuste no repasse.',
  aula_ainda_nao_terminou: 'A aula ainda não terminou. A baixa é feita depois da aula.',
  aluno_ou_nome: 'Escolha um aluno ou escreva o nome, não os dois.',
  nome_muito_longo: 'Nome muito longo.',
  valor_invalido: 'Valor por 30 min inválido.',
  professor_nao_encontrado: 'Professor não encontrado ou inativo.',
  aluno_nao_encontrado: 'Aluno não encontrado.',
  aluno_nao_faturavel: 'Esse cadastro não gera pagamento (conta de teste ou treinamento).',
  mes_fechado: 'O fechamento desse mês já foi feito para esse professor. Use um ajuste no mês aberto.',
  professor_ja_tem_aula_no_horario: 'O professor já tem uma aula lançada nesse horário.',
  aluno_ja_tem_aula_no_horario: 'O aluno já tem uma aula lançada nesse horário.',
  mesmo_dia_ja_lancado: 'Já existe aula lançada desse professor com esse aluno no dia, e a folha não pagaria a baixa. Confira com a direção.',
  ja_lancado_para_esta_pessoa: 'Já existe baixa desse tipo para essa pessoa nesse dia.',
  baixa_nao_encontrada: 'Baixa não encontrada.',
  mes_invalido: 'Mês inválido.',
};

export function manualLessonErrorMessage(raw: string | null | undefined): string {
  if (!raw) return 'Não foi possível concluir. Tente de novo.';
  const key = Object.keys(ERRORS).find(code => raw.includes(code));
  return key ? ERRORS[key] : 'Não foi possível concluir. Tente de novo.';
}

export const money = (value: number): string =>
  (value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
