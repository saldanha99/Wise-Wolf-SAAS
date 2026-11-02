import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, invoke } = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, functions: { invoke } } }));

import StudentCardSuggestions from './StudentCardSuggestions';

const view = (overrides: Record<string, unknown> = {}) => ({
  ok: true, is_minor: false,
  allowed_fields: ['real_goal', 'engaging_topics', 'correction_style', 'avoid_topics'],
  can_request: false, request_reason: 'ja_sugerido', request_class_date: null, budget_reached: false,
  suggestions: [
    { id: 'sug-goal', field: 'real_goal', value: 'Apresentar resultados em reuniões',
      quote: 'I want to present my results in meetings.', class_date: '2026-09-26',
      teacher_name: 'Professora Cartao', already_in_card: false },
    { id: 'sug-style', field: 'correction_style', value: 'end',
      quote: 'Please correct me only at the end.', class_date: '2026-09-26',
      teacher_name: 'Professora Cartao', already_in_card: false },
  ],
  ...overrides,
});

beforeEach(() => { rpc.mockReset(); invoke.mockReset(); });

describe('Sugestões da IA no dossiê', () => {
  it('cada sugestão mostra a frase da aula, a data e quem deu a aula', async () => {
    rpc.mockResolvedValue({ data: view(), error: null });
    render(<StudentCardSuggestions studentId="aluno-1" cardVersion={2} onCardSaved={() => undefined} />);
    await screen.findByText('Apresentar resultados em reuniões');
    expect(screen.getByText('“I want to present my results in meetings.”')).toBeTruthy();
    expect(screen.getAllByText(/Frase da aula de 26\/09 com Professora Cartao/)).toHaveLength(2);
    expect(screen.getByText(/^No fim — /)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('get_student_card_suggestions', { p_student_id: 'aluno-1' });
    expect(screen.getByText(/já foram lidas/)).toBeTruthy();
  });

  it('aceitar grava pelo servidor com a versão do cartão e devolve o cartão novo ao dossiê', async () => {
    const savedCard = { exists: true, version: 3, real_goal: 'Apresentar resultados em reuniões' };
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'decide_student_card_suggestion'
      ? { data: { ok: true, status: 'ACCEPTED', learning_card: savedCard }, error: null }
      : { data: view(), error: null }));
    const onCardSaved = vi.fn();
    render(<StudentCardSuggestions studentId="aluno-1" cardVersion={2} onCardSaved={onCardSaved} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Aceitar: Apresentar resultados em reuniões' }));
    await waitFor(() => expect(onCardSaved).toHaveBeenCalledWith(savedCard));
    expect(rpc).toHaveBeenCalledWith('decide_student_card_suggestion', {
      p_suggestion_id: 'sug-goal', p_accept: true, p_expected_version: 2,
    });
    await screen.findByText('Sugestão aceita: já está no cartão.');
  });

  it('descartar não mexe no cartão; conflito de versão relê o cartão e a lista (não fica preso)', async () => {
    rpc.mockImplementation((name: string, args?: Record<string, unknown>) => Promise.resolve(
      name !== 'decide_student_card_suggestion' ? { data: view(), error: null }
        : args?.p_accept ? { data: null, error: { message: 'cartao_alterado_por_outra_pessoa' } }
        : { data: { ok: true, status: 'DISCARDED', learning_card: null }, error: null }));
    const onCardSaved = vi.fn();
    const onReload = vi.fn();
    render(<StudentCardSuggestions studentId="aluno-1" cardVersion={2} onCardSaved={onCardSaved} onReload={onReload} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Descartar: No fim/ }));
    await screen.findByText(/Sugestão descartada\. A IA não volta a sugeri-la nos próximos 90 dias/);
    expect(onCardSaved).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
    const listed = rpc.mock.calls.filter(call => call[0] === 'get_student_card_suggestions').length;
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar: Apresentar resultados em reuniões' }));
    await screen.findByText(/Outra pessoa salvou este cartão enquanto o dossiê estava aberto/);
    // O dossiê relê o cartão (versão nova) e a lista é relida: o próximo
    // "Aceitar" sai com a versão atual, em vez de falhar igual para sempre.
    expect(onReload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(rpc.mock.calls.filter(call => call[0] === 'get_student_card_suggestions').length)
      .toBe(listed + 1));
    expect(onCardSaved).not.toHaveBeenCalled();
  });

  it('com a versão nova do dossiê, o aceite seguinte usa a versão atual', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'decide_student_card_suggestion'
      ? { data: { ok: true, status: 'ACCEPTED', learning_card: { exists: true, version: 4 } }, error: null }
      : { data: view(), error: null }));
    const { rerender } = render(<StudentCardSuggestions studentId="aluno-1" cardVersion={2} onCardSaved={() => undefined} />);
    await screen.findByText('Apresentar resultados em reuniões');
    rerender(<StudentCardSuggestions studentId="aluno-1" cardVersion={3} onCardSaved={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar: Apresentar resultados em reuniões' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('decide_student_card_suggestion', {
      p_suggestion_id: 'sug-goal', p_accept: true, p_expected_version: 3,
    }));
  });

  it('sugestões de aula dada por outro professor: só a contagem, sem a frase', async () => {
    rpc.mockResolvedValue({ data: view({ suggestions: [], other_lessons_pending: 3,
      request_reason: 'aula_de_outro_professor' }), error: null });
    render(<StudentCardSuggestions studentId="aluno-1" cardVersion={0} onCardSaved={() => undefined} />);
    await screen.findByText(/3 sugestões de aula dada por outro professor/);
    expect(screen.getByText(/quem lê a aula para sugerir é quem a deu/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sugerir/ })).toBeNull();
  });

  it('IA desligada na instalação: o botão não aparece, só o motivo', async () => {
    rpc.mockResolvedValue({ data: view({ suggestions: [], can_request: false,
      request_reason: 'card_suggestions_not_configured' }), error: null });
    render(<StudentCardSuggestions studentId="aluno-1" cardVersion={0} onCardSaved={() => undefined} />);
    await screen.findByText('A sugestão por IA não está ligada nesta instalação.');
    expect(screen.queryByRole('button', { name: /Sugerir/ })).toBeNull();
  });

  it('o botão pede à edge a aula aprovada mais recente e relê a lista', async () => {
    rpc.mockResolvedValue({ data: view({ suggestions: [], can_request: true, request_reason: null,
      request_class_date: '2026-09-20' }), error: null });
    invoke.mockResolvedValue({ data: { ok: true, status: 'SUCCEEDED', saved: 2, dropped: 1 }, error: null });
    render(<StudentCardSuggestions studentId="aluno-1" cardVersion={0} onCardSaved={() => undefined} />);
    await screen.findByText('Nenhuma sugestão esperando você.');
    fireEvent.click(screen.getByRole('button', { name: 'Sugerir a partir da aula de 20/09' }));
    await screen.findByText('2 sugestões novas, com a frase da aula.');
    expect(invoke).toHaveBeenCalledWith('student-card-suggestions', {
      body: { action: 'generate', student_id: 'aluno-1' },
    });
    expect(rpc.mock.calls.filter(call => call[0] === 'get_student_card_suggestions')).toHaveLength(2);
  });

  it('sem aceite do termo v3 ou com o teto atingido, não há botão', async () => {
    rpc.mockResolvedValue({ data: view({ suggestions: [], request_reason: 'sem_aceite_da_ia' }), error: null });
    const first = render(<StudentCardSuggestions studentId="aluno-1" cardVersion={0} onCardSaved={() => undefined} />);
    await screen.findByText(/termo que declara a IA — a versão 3/);
    expect(screen.queryByRole('button', { name: /Sugerir/ })).toBeNull();
    first.unmount();
    rpc.mockResolvedValue({ data: view({ suggestions: [], can_request: true, budget_reached: true }), error: null });
    render(<StudentCardSuggestions studentId="aluno-1" cardVersion={0} onCardSaved={() => undefined} />);
    await screen.findByText(/teto mensal de IA da escola foi atingido/);
    expect(screen.queryByRole('button', { name: /Sugerir/ })).toBeNull();
  });

  it('menor: aviso de só objetivo e temas', async () => {
    rpc.mockResolvedValue({ data: view({ is_minor: true, allowed_fields: ['real_goal', 'engaging_topics'] }), error: null });
    render(<StudentCardSuggestions studentId="aluno-1" cardVersion={0} onCardSaved={() => undefined} />);
    await screen.findByText(/a IA só sugere objetivo e temas/);
    expect(screen.queryByText(/^No fim — /)).toBeNull();
  });

  it('quem não edita o cartão não vê o painel', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'sem_permissao' } });
    const { container } = render(<StudentCardSuggestions studentId="aluno-1" cardVersion={0} onCardSaved={() => undefined} />);
    await waitFor(() => expect(container.querySelector('[data-tour="learning-card-suggestions"]')).toBeNull());
  });
});
