import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEARNING_CARD_LIMITS,
  draftFromCard,
  draftHasChanges,
  learningCardHistoryActor,
  learningCardMinorMessage,
  learningCardSaveArgs,
  learningCardSaveErrorMessage,
  parseTopicList,
  readLearningCard,
  validateLearningCardDraft,
  type LearningCardDraft,
} from './studentLearningCard';

const serverCard = {
  exists: true,
  is_minor: false,
  can_edit: true,
  real_goal: 'Apresentar resultados em reuniões',
  engaging_topics: ['futebol', 'séries'],
  correction_style: 'selective',
  avoid_topics: ['spoilers'],
  notes: 'Rende mais com roleplay.',
  hidden_for_minor: false,
  version: 3,
  updated_at: '2026-09-26T15:00:00Z',
  updated_by_name: 'Professora Titular',
  limits: { real_goal: 300, topic: 60, engaging_topics: 8, avoid_topics: 6, notes: 400 },
  history: [{ created_at: '2026-09-26T15:00:00Z', actor_name: 'Professora Titular', actor_role: 'TEACHER', changed_fields: ['notes'], version: 3 }],
};

const emptyDraft: LearningCardDraft = { real_goal: '', engaging_topics: '', correction_style: '', avoid_topics: '', notes: '' };

describe('cartão do aluno — leitura do servidor', () => {
  it('lê o cartão do dossiê e monta o rascunho de edição', () => {
    const card = readLearningCard(serverCard);
    expect(card?.correction_style).toBe('selective');
    expect(card?.history[0].changed_fields).toEqual(['notes']);
    expect(draftFromCard(card!)).toEqual({
      real_goal: 'Apresentar resultados em reuniões',
      engaging_topics: 'futebol, séries',
      correction_style: 'selective',
      avoid_topics: 'spoilers',
      notes: 'Rende mais com roleplay.',
    });
  });

  it('formato inesperado não quebra a tela', () => {
    expect(readLearningCard(null)).toBeNull();
    expect(readLearningCard('x')).toBeNull();
    const card = readLearningCard({ correction_style: 'gentle', engaging_topics: [1, 'ok'], limits: { notes: -1 } });
    expect(card?.correction_style).toBeNull();
    expect(card?.engaging_topics).toEqual(['ok']);
    expect(card?.can_edit).toBe(false);
    expect(card?.limits).toEqual(DEFAULT_LEARNING_CARD_LIMITS);
  });
});

describe('cartão do aluno — antes do clique', () => {
  it('temas: vírgula, ponto e vírgula e linha; sem vazio nem repetido', () => {
    expect(parseTopicList(' futebol, Futebol ;séries  de ficção\n\n, ')).toEqual(['futebol', 'séries de ficção']);
  });

  it('recusa texto longo e itens demais, com os limites do servidor', () => {
    const limits = DEFAULT_LEARNING_CARD_LIMITS;
    expect(validateLearningCardDraft({ ...emptyDraft, real_goal: 'a'.repeat(301) }, limits, false)).toMatch(/300/);
    expect(validateLearningCardDraft({ ...emptyDraft, real_goal: 'a'.repeat(300) }, limits, false)).toBeNull();
    expect(validateLearningCardDraft({ ...emptyDraft, engaging_topics: 'a,b,c,d,e,f,g,h,i' }, limits, false)).toMatch(/8 temas/);
    expect(validateLearningCardDraft({ ...emptyDraft, engaging_topics: 't'.repeat(61) }, limits, false)).toMatch(/60/);
    expect(validateLearningCardDraft({ ...emptyDraft, avoid_topics: 'a,b,c,d,e,f,g' }, limits, false)).toMatch(/6 itens/);
    expect(validateLearningCardDraft({ ...emptyDraft, notes: 'n'.repeat(401) }, limits, false)).toMatch(/400/);
  });

  it('menor de idade nunca envia estilo, "o que evitar" nem observações', () => {
    const draft: LearningCardDraft = {
      real_goal: 'Ler histórias', engaging_topics: 'dinossauros', correction_style: 'end', avoid_topics: 'escola', notes: 'nota',
    };
    expect(validateLearningCardDraft(draft, DEFAULT_LEARNING_CARD_LIMITS, true)).toBeNull();
    expect(learningCardSaveArgs('aluno-1', draft, true, 2)).toEqual({
      p_student_id: 'aluno-1',
      p_real_goal: 'Ler histórias',
      p_engaging_topics: ['dinossauros'],
      p_correction_style: null,
      p_avoid_topics: [],
      p_notes: '',
      p_expected_version: 2,
    });
  });

  it('adulto envia tudo, com a versão que a tela carregou', () => {
    const args = learningCardSaveArgs('aluno-2', { ...emptyDraft, correction_style: 'end', avoid_topics: 'a, b' }, false, 0);
    expect(args.p_correction_style).toBe('end');
    expect(args.p_avoid_topics).toEqual(['a', 'b']);
    expect(args.p_expected_version).toBe(0);
  });
});

describe('cartão do aluno — erro do servidor em português', () => {
  it.each([
    ['sem_permissao', /não pode editar/],
    ['cartao_alterado_por_outra_pessoa', /Outra pessoa/],
    ['cartao_texto_longo:notes', /observações/],
    ['cartao_itens_demais:engaging_topics', /temas/],
    ['cartao_campo_de_menor:notes', /só objetivo e temas/],
    ['cartao_estilo_invalido', /estilos/],
    ['erro qualquer', /Não foi possível/],
  ])('%s', (message, expected) => {
    expect(learningCardSaveErrorMessage(message)).toMatch(expected);
  });
});

describe('cartão do aluno — menor, rascunho e histórico', () => {
  it('lê o motivo de menor do servidor e ignora valor inventado', () => {
    expect(readLearningCard({ ...serverCard, is_minor: true, minor_reason: 'GUARDIAN' })?.minor_reason).toBe('GUARDIAN');
    expect(readLearningCard({ ...serverCard, minor_reason: 'OUTRO' })?.minor_reason).toBeNull();
    expect(learningCardMinorMessage('AGE_UNKNOWN')).toMatch(/data de nascimento/);
    expect(learningCardMinorMessage('KIDS')).toMatch(/turma infantil/);
    expect(learningCardMinorMessage(null)).toMatch(/menor de idade/);
  });

  it('rascunho só "mudou" quando o servidor gravaria algo diferente', () => {
    const card = readLearningCard(serverCard)!;
    const draft = draftFromCard(card);
    expect(draftHasChanges(draft, card)).toBe(false);
    expect(draftHasChanges({ ...draft, notes: '  Rende mais   com roleplay. ' }, card)).toBe(false);
    expect(draftHasChanges({ ...draft, engaging_topics: 'futebol,séries,' }, card)).toBe(false);
    expect(draftHasChanges({ ...draft, notes: 'Outra coisa' }, card)).toBe(true);
    expect(draftHasChanges({ ...draft, correction_style: 'end' }, card)).toBe(true);
  });

  it('histórico: papel em português e limpeza automática sem autor', () => {
    const entry = { created_at: '', actor_name: 'Professora Titular', actor_role: 'TEACHER', changed_fields: [], version: 1 };
    expect(learningCardHistoryActor(entry)).toBe('Professora Titular (professor)');
    expect(learningCardHistoryActor({ ...entry, actor_name: null, actor_role: 'SYSTEM_MINOR_RULE' }))
      .toBe('Limpeza automática (regra de menor de idade)');
    expect(learningCardHistoryActor({ ...entry, actor_name: null, actor_role: null })).toBe('Pessoa removida');
  });
});
