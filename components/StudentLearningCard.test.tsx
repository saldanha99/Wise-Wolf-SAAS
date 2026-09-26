import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StudentLearningCard from './StudentLearningCard';
import { readLearningCard } from '../lib/studentLearningCard';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const base = {
  exists: true, is_minor: false, can_edit: true,
  real_goal: 'Apresentar resultados em reuniões', engaging_topics: ['futebol'],
  correction_style: 'selective', avoid_topics: ['spoilers'], notes: 'Rende com roleplay.',
  hidden_for_minor: false, version: 2, updated_at: '2026-09-26T15:00:00Z', updated_by_name: 'Professora Titular',
  limits: { real_goal: 300, topic: 60, engaging_topics: 8, avoid_topics: 6, notes: 400 },
  history: [{ created_at: '2026-09-26T15:00:00Z', actor_name: 'Professora Titular', actor_role: 'TEACHER', changed_fields: ['notes'], version: 2 }],
};

beforeEach(() => { rpc.mockReset(); });

describe('cartão do aluno na continuidade pedagógica', () => {
  it('mostra o cartão e quem mudou por último, sem texto no histórico', () => {
    render(<StudentLearningCard studentId="s1" card={readLearningCard(base)!} onSaved={() => undefined} onReload={() => undefined} />);
    expect(screen.getByText('Apresentar resultados em reuniões')).toBeInTheDocument();
    expect(screen.getByText(/Só o foco da aula/)).toBeInTheDocument();
    expect(screen.getByText(/Atualizado por Professora Titular/)).toBeInTheDocument();
    expect(screen.getByText(/Professora Titular \(professor\) · observações/)).toBeInTheDocument();
  });

  it('o aviso de privacidade fica junto do formulário e salvar envia a versão carregada', async () => {
    rpc.mockResolvedValue({ data: { ...base, notes: 'Nova nota', version: 3 }, error: null });
    const onSaved = vi.fn();
    render(<StudentLearningCard studentId="s1" card={readLearningCard(base)!} onSaved={onSaved} onReload={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    expect(screen.getByRole('note')).toHaveTextContent('saúde, religião, política, família ou dinheiro');
    fireEvent.change(screen.getByLabelText('Observações para quem der a aula'), { target: { value: 'Nova nota' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar cartão' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith('save_student_learning_card', expect.objectContaining({
      p_student_id: 's1', p_notes: 'Nova nota', p_engaging_topics: ['futebol'], p_expected_version: 2,
    }));
  });

  it('menor de idade: só objetivo e temas na tela e no envio', async () => {
    rpc.mockResolvedValue({ data: { ...base, is_minor: true, version: 3 }, error: null });
    const minor = readLearningCard({ ...base, is_minor: true, correction_style: null, avoid_topics: [], notes: '', hidden_for_minor: true })!;
    render(<StudentLearningCard studentId="kid" card={minor} onSaved={() => undefined} onReload={() => undefined} />);
    expect(screen.getByText(/Aluno menor de idade/)).toHaveTextContent('serão apagadas no próximo salvamento');
    expect(screen.queryByText('O que evitar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    expect(screen.queryByLabelText('Observações para quem der a aula')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('O que evitar na aula')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar cartão' }));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_correction_style: null, p_avoid_topics: [], p_notes: '' });
  });

  it('quem não pode editar só lê', () => {
    render(<StudentLearningCard studentId="s1" card={readLearningCard({ ...base, can_edit: false })!} onSaved={() => undefined} onReload={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
  });

  it('versão velha: explica e oferece recarregar em vez de sobrescrever', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'cartao_alterado_por_outra_pessoa' } });
    const onReload = vi.fn();
    render(<StudentLearningCard studentId="s1" card={readLearningCard(base)!} onSaved={() => undefined} onReload={onReload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar cartão' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Outra pessoa atualizou este cartão');
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar' }));
    expect(onReload).toHaveBeenCalled();
  });

  it('texto longo demais é barrado antes de chamar o servidor', async () => {
    render(<StudentLearningCard studentId="s1" card={readLearningCard(base)!} onSaved={() => undefined} onReload={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByLabelText('Objetivo real'), { target: { value: 'a'.repeat(301) } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar cartão' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('300 caracteres');
    expect(rpc).not.toHaveBeenCalled();
  });
});
