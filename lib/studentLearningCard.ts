/**
 * Cartão do aluno — preenchido pelo professor, sem IA.
 *
 * Fonte: `public.student_learning_cards` (migration 20260926220000). A tela lê
 * pelo dossiê (`get_student_handover` → `learning_card`) e grava por
 * `save_student_learning_card`. O servidor é quem decide: limites de tamanho,
 * regra de menor de idade e quem pode editar. Aqui só se espelha para avisar
 * antes do clique — nunca para deixar passar o que o banco recusaria.
 */

export type CorrectionStyle = 'immediate' | 'end' | 'selective' | 'examiner';

export const CORRECTION_STYLE_OPTIONS: ReadonlyArray<{ value: CorrectionStyle; label: string; hint: string }> = [
  { value: 'immediate', label: 'Na hora', hint: 'Corrige logo o erro que atrapalha e pede nova tentativa.' },
  { value: 'end', label: 'No fim', hint: 'Deixa a conversa fluir e corrige depois, com resumo.' },
  { value: 'selective', label: 'Só o foco da aula', hint: 'Corrige o que é do objetivo; ignora deslize que não atrapalha.' },
  { value: 'examiner', label: 'Modo prova', hint: 'Não ajuda durante a fala; feedback só no final.' },
];

export interface LearningCardLimits {
  real_goal: number;
  topic: number;
  engaging_topics: number;
  avoid_topics: number;
  notes: number;
}

/** Os mesmos de `private.student_learning_card_limits()`; o servidor manda os dele junto. */
export const DEFAULT_LEARNING_CARD_LIMITS: LearningCardLimits = {
  real_goal: 300,
  topic: 60,
  engaging_topics: 8,
  avoid_topics: 6,
  notes: 400,
};

/**
 * Por que o cartão guarda só objetivo e temas (`minor_reason`, decidido no
 * servidor): turma infantil, menor pela data de nascimento, responsável
 * cadastrado ou idade ainda não comprovada pela escola (régua do termo de
 * registro das aulas).
 */
export type LearningCardMinorReason = 'KIDS' | 'MINOR' | 'GUARDIAN' | 'AGE_UNKNOWN';

const MINOR_REASONS: ReadonlyArray<LearningCardMinorReason> = ['KIDS', 'MINOR', 'GUARDIAN', 'AGE_UNKNOWN'];

export interface LearningCardHistoryEntry {
  created_at: string;
  actor_name: string | null;
  actor_role: string | null;
  changed_fields: string[];
  version: number;
}

export interface StudentLearningCard {
  exists: boolean;
  is_minor: boolean;
  minor_reason: LearningCardMinorReason | null;
  can_edit: boolean;
  real_goal: string;
  engaging_topics: string[];
  correction_style: CorrectionStyle | null;
  avoid_topics: string[];
  notes: string;
  hidden_for_minor: boolean;
  version: number;
  updated_at: string | null;
  updated_by_name: string | null;
  limits: LearningCardLimits;
  history: LearningCardHistoryEntry[];
}

export interface LearningCardDraft {
  real_goal: string;
  engaging_topics: string;
  correction_style: CorrectionStyle | '';
  avoid_topics: string;
  notes: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const textList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

const isCorrectionStyle = (value: unknown): value is CorrectionStyle =>
  CORRECTION_STYLE_OPTIONS.some(option => option.value === value);

/** Lê o `learning_card` do dossiê sem confiar no formato. */
export function readLearningCard(raw: unknown): StudentLearningCard | null {
  if (!isRecord(raw)) return null;
  const limits = isRecord(raw.limits) ? raw.limits : {};
  const history = Array.isArray(raw.history) ? raw.history.filter(isRecord) : [];
  return {
    exists: raw.exists === true,
    is_minor: raw.is_minor === true,
    minor_reason: MINOR_REASONS.find(reason => reason === raw.minor_reason) ?? null,
    can_edit: raw.can_edit === true,
    real_goal: text(raw.real_goal),
    engaging_topics: textList(raw.engaging_topics),
    correction_style: isCorrectionStyle(raw.correction_style) ? raw.correction_style : null,
    avoid_topics: textList(raw.avoid_topics),
    notes: text(raw.notes),
    hidden_for_minor: raw.hidden_for_minor === true,
    version: typeof raw.version === 'number' ? raw.version : 0,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
    updated_by_name: typeof raw.updated_by_name === 'string' ? raw.updated_by_name : null,
    limits: {
      real_goal: positive(limits.real_goal, DEFAULT_LEARNING_CARD_LIMITS.real_goal),
      topic: positive(limits.topic, DEFAULT_LEARNING_CARD_LIMITS.topic),
      engaging_topics: positive(limits.engaging_topics, DEFAULT_LEARNING_CARD_LIMITS.engaging_topics),
      avoid_topics: positive(limits.avoid_topics, DEFAULT_LEARNING_CARD_LIMITS.avoid_topics),
      notes: positive(limits.notes, DEFAULT_LEARNING_CARD_LIMITS.notes),
    },
    history: history.map(entry => ({
      created_at: text(entry.created_at),
      actor_name: typeof entry.actor_name === 'string' ? entry.actor_name : null,
      actor_role: typeof entry.actor_role === 'string' ? entry.actor_role : null,
      changed_fields: textList(entry.changed_fields),
      version: typeof entry.version === 'number' ? entry.version : 0,
    })),
  };
}

/** Temas digitados separados por vírgula, ponto e vírgula ou linha; sem vazio nem repetido. */
export function parseTopicList(input: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const piece of input.split(/[,;\n]/)) {
    const item = piece.replace(/\s+/g, ' ').trim();
    const key = item.toLocaleLowerCase('pt-BR');
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function draftFromCard(card: StudentLearningCard): LearningCardDraft {
  return {
    real_goal: card.real_goal,
    engaging_topics: card.engaging_topics.join(', '),
    correction_style: card.correction_style ?? '',
    avoid_topics: card.avoid_topics.join(', '),
    notes: card.notes,
  };
}

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * O rascunho tem texto que o servidor ainda não tem? Compara como o servidor
 * gravaria (espaços colapsados, temas separados), para não chamar de "edição"
 * um espaço a mais.
 */
export function draftHasChanges(draft: LearningCardDraft, card: StudentLearningCard): boolean {
  const saved = draftFromCard(card);
  return collapse(draft.real_goal) !== collapse(saved.real_goal)
    || parseTopicList(draft.engaging_topics).join('\n') !== parseTopicList(saved.engaging_topics).join('\n')
    || draft.correction_style !== saved.correction_style
    || parseTopicList(draft.avoid_topics).join('\n') !== parseTopicList(saved.avoid_topics).join('\n')
    || collapse(draft.notes) !== collapse(saved.notes);
}

/**
 * Conferência antes do clique, com as mesmas regras do servidor. Devolve a
 * primeira mensagem de problema, ou null quando pode salvar.
 */
export function validateLearningCardDraft(
  draft: LearningCardDraft,
  limits: LearningCardLimits,
  isMinor: boolean,
): string | null {
  if (collapse(draft.real_goal).length > limits.real_goal) {
    return `O objetivo passa de ${limits.real_goal} caracteres. Resuma em uma frase.`;
  }
  const topics = parseTopicList(draft.engaging_topics);
  if (topics.length > limits.engaging_topics) return `Use no máximo ${limits.engaging_topics} temas.`;
  if (topics.some(topic => topic.length > limits.topic)) {
    return `Cada tema pode ter até ${limits.topic} caracteres — use palavras-chave, não frases.`;
  }
  // Menor: os campos pessoais nem saem da tela (learningCardSaveArgs os zera).
  if (isMinor) return null;
  const avoid = parseTopicList(draft.avoid_topics);
  if (avoid.length > limits.avoid_topics) return `Use no máximo ${limits.avoid_topics} itens em "o que evitar".`;
  if (avoid.some(item => item.length > limits.topic)) {
    return `Cada item de "o que evitar" pode ter até ${limits.topic} caracteres.`;
  }
  if (collapse(draft.notes).length > limits.notes) {
    return `As observações passam de ${limits.notes} caracteres. Guarde só o que ajuda a dar aula.`;
  }
  return null;
}

/** Argumentos da RPC `save_student_learning_card`. Menor nunca envia campo pessoal. */
export function learningCardSaveArgs(
  studentId: string,
  draft: LearningCardDraft,
  isMinor: boolean,
  expectedVersion: number,
) {
  return {
    p_student_id: studentId,
    p_real_goal: draft.real_goal,
    p_engaging_topics: parseTopicList(draft.engaging_topics),
    p_correction_style: isMinor || !draft.correction_style ? null : draft.correction_style,
    p_avoid_topics: isMinor ? [] : parseTopicList(draft.avoid_topics),
    p_notes: isMinor ? '' : draft.notes,
    p_expected_version: expectedVersion,
  };
}

/** Aviso ao lado do cartão para quem guarda só objetivo e temas. */
export function learningCardMinorMessage(reason: LearningCardMinorReason | null): string {
  const tail = 'o cartão guarda só o objetivo e os temas que engajam.';
  switch (reason) {
    case 'KIDS': return `Aluno da turma infantil: ${tail}`;
    case 'GUARDIAN': return `Aluno com responsável cadastrado: ${tail}`;
    case 'AGE_UNKNOWN':
      return `Idade ainda não comprovada pela escola: ${tail} Quando a escola registrar a data de nascimento na ficha, os outros campos voltam.`;
    default: return `Aluno menor de idade: ${tail}`;
  }
}

const HISTORY_ROLE_LABEL: Record<string, string> = {
  TEACHER: 'professor',
  COORDINATOR: 'coordenação',
  SCHOOL_ADMIN: 'direção',
};

/** Quem aparece no histórico. A limpeza automática de menor não tem autor. */
export function learningCardHistoryActor(entry: LearningCardHistoryEntry): string {
  if (entry.actor_role === 'SYSTEM_MINOR_RULE') return 'Limpeza automática (regra de menor de idade)';
  const role = entry.actor_role ? HISTORY_ROLE_LABEL[entry.actor_role] : undefined;
  return `${entry.actor_name || 'Pessoa removida'}${role ? ` (${role})` : ''}`;
}

const FIELD_LABELS: Record<string, string> = {
  real_goal: 'objetivo',
  engaging_topics: 'temas',
  correction_style: 'estilo de correção',
  avoid_topics: 'o que evitar',
  notes: 'observações',
};

export const learningCardFieldLabel = (field: string): string => FIELD_LABELS[field] ?? field;

/** Traduz o erro do servidor para a tela. */
export function learningCardSaveErrorMessage(message: string | undefined | null): string {
  const raw = message ?? '';
  const field = learningCardFieldLabel(raw.split(':')[1] ?? '');
  if (raw.includes('sem_permissao')) return 'Você não pode editar o cartão deste aluno.';
  if (raw.includes('cartao_alterado_por_outra_pessoa')) {
    return 'Outra pessoa atualizou este cartão enquanto você editava. Recarregue para ver a versão nova — o que você escreveu continua aqui.';
  }
  if (raw.startsWith('cartao_texto_longo')) return `Texto longo demais em "${field}". Resuma.`;
  if (raw.startsWith('cartao_itens_demais')) return `Itens demais em "${field}".`;
  if (raw.startsWith('cartao_campo_de_menor')) {
    return 'Para este aluno o cartão guarda só objetivo e temas (menor de idade, responsável cadastrado ou idade não comprovada).';
  }
  if (raw.includes('cartao_estilo_invalido')) return 'Escolha um dos estilos de correção da lista.';
  return 'Não foi possível salvar o cartão. Tente de novo.';
}
