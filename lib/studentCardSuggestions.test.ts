import { describe, expect, it } from 'vitest';
import {
  cardSuggestionDecideErrorMessage,
  cardSuggestionEffect,
  cardSuggestionGenerateMessage,
  cardSuggestionReasonText,
  cardSuggestionValueLabel,
  lessonDateLabel,
  readCardSuggestions,
} from './studentCardSuggestions';

const serverView = {
  ok: true,
  is_minor: false,
  allowed_fields: ['real_goal', 'engaging_topics', 'correction_style', 'avoid_topics'],
  can_request: true,
  request_reason: null,
  request_class_date: '2026-09-06',
  budget_reached: false,
  suggestions: [
    { id: 's1', field: 'real_goal', value: 'Apresentar resultados em reuniões', quote: 'I want to present my results.',
      class_date: '2026-09-26', teacher_name: 'Professora Cartao', already_in_card: false },
    { id: 's2', field: 'correction_style', value: 'end', quote: 'Please correct me only at the end.',
      class_date: '2026-09-26', teacher_name: null, already_in_card: true },
  ],
};

describe('sugestões da IA para o cartão — leitura do servidor', () => {
  it('lê as sugestões com a frase da aula e a data', () => {
    const view = readCardSuggestions(serverView)!;
    expect(view.can_request).toBe(true);
    expect(view.request_class_date).toBe('2026-09-06');
    expect(view.suggestions.map(item => [item.id, item.field, item.quote])).toEqual([
      ['s1', 'real_goal', 'I want to present my results.'],
      ['s2', 'correction_style', 'Please correct me only at the end.'],
    ]);
    expect(view.suggestions[1].already_in_card).toBe(true);
    expect(view.other_lessons_pending).toBe(0);
    expect(readCardSuggestions({ ...serverView, other_lessons_pending: 2 })!.other_lessons_pending).toBe(2);
    expect(readCardSuggestions({ ...serverView, other_lessons_pending: 'x' })!.other_lessons_pending).toBe(0);
  });

  it('não confia no formato: resposta sem ok, sugestão sem frase ou campo desconhecido ficam de fora', () => {
    expect(readCardSuggestions(null)).toBeNull();
    expect(readCardSuggestions({ suggestions: [] })).toBeNull();
    const view = readCardSuggestions({
      ...serverView,
      suggestions: [
        { id: 'a', field: 'notes', value: 'x', quote: 'frase da aula' },
        { id: 'b', field: 'real_goal', value: 'Objetivo', quote: '' },
        { id: 'c', field: 'real_goal', value: 'Objetivo', quote: 'frase da aula' },
      ],
    })!;
    expect(view.suggestions.map(item => item.id)).toEqual(['c']);
  });

  it('menor: campo pessoal que chegasse não aparece na tela', () => {
    const view = readCardSuggestions({
      ...serverView,
      is_minor: true,
      allowed_fields: ['real_goal', 'engaging_topics'],
    })!;
    expect(view.is_minor).toBe(true);
    expect(view.suggestions.map(item => item.field)).toEqual(['real_goal']);
  });
});

describe('sugestões da IA para o cartão — textos', () => {
  it('estilo de correção pelo nome e o efeito do aceite', () => {
    expect(cardSuggestionValueLabel({ field: 'correction_style', value: 'end' })).toMatch(/^No fim — /);
    expect(cardSuggestionValueLabel({ field: 'engaging_topics', value: 'futebol' })).toBe('futebol');
    expect(cardSuggestionEffect('real_goal')).toMatch(/substitui/);
    expect(cardSuggestionEffect('avoid_topics')).toMatch(/acrescenta/);
    expect(lessonDateLabel('2026-09-26')).toBe('26/09');
    expect(lessonDateLabel(null)).toBe('');
  });

  it('motivos do servidor viram frase: aceite do termo v3, teto, já lida', () => {
    expect(cardSuggestionReasonText('sem_aceite_da_ia')).toMatch(/versão 3/);
    expect(cardSuggestionReasonText('teto_atingido')).toMatch(/teto mensal/);
    expect(cardSuggestionReasonText('ja_sugerido')).toMatch(/já foram lidas/);
    expect(cardSuggestionReasonText('aula_de_outro_professor')).toMatch(/outro professor/);
    expect(cardSuggestionReasonText('card_suggestions_provider_credits')).toMatch(/sem créditos/);
    expect(cardSuggestionReasonText('qualquer_coisa')).toMatch(/Tente de novo/);
  });

  it('resultado do botão nunca depende de texto da aula na resposta', () => {
    expect(cardSuggestionGenerateMessage({ ok: true, status: 'SUCCEEDED', saved: 3, dropped: 1 }))
      .toEqual({ ok: true, text: '3 sugestões novas, com a frase da aula.' });
    expect(cardSuggestionGenerateMessage({ ok: true, status: 'SUCCEEDED', saved: 0, dropped: 4 }).text)
      .toMatch(/nada novo/);
    expect(cardSuggestionGenerateMessage({ ok: false, status: 'SKIPPED', reason: 'sem_aceite_da_ia' }))
      .toEqual({ ok: false, text: cardSuggestionReasonText('sem_aceite_da_ia') });
    expect(cardSuggestionGenerateMessage({ error: 'sem_permissao' }).text).toMatch(/não pode/);
  });

  it('erros de aceitar: versão do cartão, lista cheia, já decidida', () => {
    expect(cardSuggestionDecideErrorMessage('cartao_alterado_por_outra_pessoa')).toMatch(/Outra pessoa salvou/);
    expect(cardSuggestionDecideErrorMessage('cartao_alterado_por_outra_pessoa')).not.toMatch(/o que você escreveu/);
    expect(cardSuggestionDecideErrorMessage('cartao_itens_demais:engaging_topics')).toMatch(/cheia/);
    expect(cardSuggestionDecideErrorMessage('cartao_campo_de_menor:avoid_topics')).toMatch(/só objetivo e temas/);
    expect(cardSuggestionDecideErrorMessage('sugestao_ja_decidida')).toMatch(/já foi decidida/);
    expect(cardSuggestionDecideErrorMessage(undefined)).toMatch(/Tente de novo/);
  });
});
