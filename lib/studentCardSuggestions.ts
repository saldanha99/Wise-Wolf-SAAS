/**
 * Sugestões da IA para o cartão do aluno (migration 20260928130000, edge
 * `student-card-suggestions`).
 *
 * A IA lê uma aula cujo resumo o professor aprovou e sugere itens para o
 * cartão, cada um com a frase da aula que o sustenta. Nada entra no cartão
 * sozinho: o professor aceita (grava pela RPC do cartão, com a versão que a
 * tela carregou) ou descarta. O servidor decide tudo — quem vê, o que a IA pode
 * sugerir (menor: só objetivo e temas), a lista de exclusão e o teto de gasto;
 * aqui só se lê e se traduz para a tela.
 */
import { CORRECTION_STYLE_OPTIONS, learningCardSaveErrorMessage } from './studentLearningCard';

export type CardSuggestionField = 'real_goal' | 'engaging_topics' | 'correction_style' | 'avoid_topics';
const FIELDS: ReadonlyArray<CardSuggestionField> = ['real_goal', 'engaging_topics', 'correction_style', 'avoid_topics'];

export interface CardSuggestion {
  id: string;
  field: CardSuggestionField;
  value: string;
  quote: string;
  class_date: string | null;
  teacher_name: string | null;
  already_in_card: boolean;
}

export interface CardSuggestionsView {
  is_minor: boolean;
  allowed_fields: CardSuggestionField[];
  can_request: boolean;
  request_reason: string | null;
  request_class_date: string | null;
  budget_reached: boolean;
  suggestions: CardSuggestion[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isField = (value: unknown): value is CardSuggestionField => FIELDS.some(field => field === value);

/** Lê o retorno de `get_student_card_suggestions` sem confiar no formato. */
export function readCardSuggestions(raw: unknown): CardSuggestionsView | null {
  if (!isRecord(raw) || raw.ok !== true) return null;
  const allowed = Array.isArray(raw.allowed_fields) ? raw.allowed_fields.filter(isField) : [];
  const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : [])
    .filter(isRecord)
    .filter(item => typeof item.id === 'string' && isField(item.field) && text(item.value) && text(item.quote))
    // O servidor já filtra; a tela não mostra campo que o aluno não pode ter.
    .filter(item => allowed.includes(item.field as CardSuggestionField))
    .map(item => ({
      id: item.id as string,
      field: item.field as CardSuggestionField,
      value: text(item.value),
      quote: text(item.quote),
      class_date: typeof item.class_date === 'string' ? item.class_date : null,
      teacher_name: typeof item.teacher_name === 'string' ? item.teacher_name : null,
      already_in_card: item.already_in_card === true,
    }));
  return {
    is_minor: raw.is_minor === true,
    allowed_fields: allowed,
    can_request: raw.can_request === true,
    request_reason: typeof raw.request_reason === 'string' ? raw.request_reason : null,
    request_class_date: typeof raw.request_class_date === 'string' ? raw.request_class_date : null,
    budget_reached: raw.budget_reached === true,
    suggestions,
  };
}

const FIELD_LABELS: Record<CardSuggestionField, string> = {
  real_goal: 'Objetivo real',
  engaging_topics: 'Tema que engaja',
  correction_style: 'Como prefere ser corrigido',
  avoid_topics: 'O que evitar',
};
export const cardSuggestionFieldLabel = (field: CardSuggestionField): string => FIELD_LABELS[field];

/** O que o aceite faz no cartão (objetivo e estilo substituem; listas ganham um item). */
export function cardSuggestionEffect(field: CardSuggestionField): string {
  return field === 'real_goal' || field === 'correction_style'
    ? 'Aceitar substitui o que está no cartão.'
    : 'Aceitar acrescenta à lista do cartão.';
}

/** Valor como a tela mostra (estilo de correção pelo nome, não pelo código). */
export function cardSuggestionValueLabel(suggestion: Pick<CardSuggestion, 'field' | 'value'>): string {
  if (suggestion.field !== 'correction_style') return suggestion.value;
  const option = CORRECTION_STYLE_OPTIONS.find(item => item.value === suggestion.value);
  return option ? `${option.label} — ${option.hint}` : suggestion.value;
}

/** "2026-09-20" → "20/09". */
export function lessonDateLabel(date: string | null): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || '');
  return match ? `${match[3]}/${match[2]}` : '';
}

/** Por que o botão não lê aula agora (motivo do servidor ou da edge). */
export function cardSuggestionReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'ja_sugerido':
      return 'As aulas aprovadas deste aluno já foram lidas pela IA. Aprove o resumo da próxima aula para ganhar sugestões novas.';
    case 'sem_aula_aprovada':
    case 'sem_fonte':
      return 'Ainda não há aula aprovada com a transcrição guardada. Aprove o resumo de uma aula deste aluno para a IA sugerir.';
    case 'sem_aceite_da_ia':
      return 'A IA só lê a aula quando o aluno (ou o responsável) e o professor da aula aceitaram o termo que declara a IA — a versão 3.';
    case 'em_andamento':
      return 'Já há uma leitura em andamento para este aluno. Recarregue em um minuto.';
    case 'aguarde_um_minuto':
      return 'A IA acabou de ler uma aula deste aluno. Espere um minuto antes de pedir de novo.';
    case 'teto_atingido':
      return 'O teto mensal de IA da escola foi atingido. A direção pode aumentar em "Conta central Google".';
    case 'card_suggestions_not_configured':
      return 'A sugestão por IA não está ligada nesta instalação.';
    case 'card_suggestions_pricing_required':
      return 'Falta cadastrar o preço do modelo de IA. Avise a direção.';
    case 'aluno_fora_da_escola':
      return 'O aluno não está mais na escola.';
    default:
      return 'A IA não pôde ler a aula agora. Tente de novo mais tarde.';
  }
}

/** Resultado do botão "Sugerir" (a resposta da edge nunca traz texto da aula). */
export function cardSuggestionGenerateMessage(payload: unknown): { ok: boolean; text: string } {
  if (!isRecord(payload)) return { ok: false, text: cardSuggestionReasonText(null) };
  if (payload.status === 'SUCCEEDED') {
    const saved = typeof payload.saved === 'number' ? payload.saved : 0;
    return saved > 0
      ? { ok: true, text: saved === 1 ? '1 sugestão nova, com a frase da aula.' : `${saved} sugestões novas, com a frase da aula.` }
      : { ok: true, text: 'A IA leu a aula e não encontrou nada novo (ou seguro) para o cartão.' };
  }
  if (typeof payload.reason === 'string') return { ok: false, text: cardSuggestionReasonText(payload.reason) };
  if (payload.error === 'sem_permissao') return { ok: false, text: 'Você não pode mexer no cartão deste aluno.' };
  return { ok: false, text: 'A IA não conseguiu ler a aula agora. Nada foi gravado; tente de novo mais tarde.' };
}

/** Erro de aceitar/descartar traduzido (os do cartão vêm da RPC do cartão). */
export function cardSuggestionDecideErrorMessage(message: string | null | undefined): string {
  const raw = message ?? '';
  if (raw.includes('sugestao_ja_decidida')) return 'Essa sugestão já foi decidida. A lista foi atualizada.';
  if (raw.includes('sugestao_sem_aula_aprovada')) {
    return 'A aula dessa sugestão deixou de estar aprovada (ou a frase passou do prazo de 90 dias). A lista foi atualizada.';
  }
  if (raw.includes('sem_permissao')) return 'Você não pode mexer no cartão deste aluno.';
  if (raw.startsWith('cartao_itens_demais')) {
    return 'A lista do cartão já está cheia. Tire um item no cartão e aceite de novo.';
  }
  if (raw.startsWith('cartao_')) return learningCardSaveErrorMessage(raw);
  return 'Não foi possível decidir a sugestão. Tente de novo.';
}
