import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('./LessonPedagogicalSummary', () => ({ default: () => null }));
vi.mock('./LessonRecordingTeacherCard', () => ({ default: () => null }));
vi.mock('./LessonReviewQueue', () => ({ default: () => null }));
vi.mock('./StudentLearningCard', () => ({ default: () => null }));

import LessonSessionsPanel from './LessonSessionsPanel';
import { DOSSIER_LINK_DENIED } from '../lib/studentDossierLink';

const STUDENT = '00000000-0000-4000-8000-000000009e11';

function answer(handover: { data: unknown; error: unknown }) {
  rpc.mockImplementation((name: string) => Promise.resolve(
    name === 'get_lesson_sessions'
      ? { data: { ok: true, sessions: [] }, error: null }
      : name === 'get_student_handover'
        ? handover
        : { data: null, error: { message: 'inesperado' } },
  ));
}

beforeEach(() => rpc.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('Dossiê aberto pelo link com login (substituto e novo titular)', () => {
  it('abre o dossiê do aluno do link, uma vez, e explica o prazo do acesso', async () => {
    answer({
      data: {
        ok: true, student_name: 'Ana Coberta', learning_card: null, logs: [],
        memories: [{ id: 'm1', occurred_at: '2026-09-25T13:00:00Z', lesson_objective: 'Objetivo aprovado', recommended_next_step: 'Próximo passo aprovado' }],
      },
      error: null,
    });
    const consumed = vi.fn();
    render(<LessonSessionsPanel focusStudentId={STUDENT} onFocusConsumed={consumed} />);
    await screen.findByText('Próximo passo aprovado');
    expect(rpc).toHaveBeenCalledWith('get_student_handover', { p_student_id: STUDENT, p_acknowledge: false });
    expect(screen.getByRole('note').textContent).toMatch(/dia anterior ao dia seguinte da aula/);
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('fora da janela, a recusa do servidor diz o prazo em vez de "vinculação"', async () => {
    answer({ data: null, error: { message: 'sem_permissao' } });
    render(<LessonSessionsPanel focusStudentId={STUDENT} />);
    await screen.findByText(DOSSIER_LINK_DENIED);
  });

  it('sem link, o painel não abre dossiê nenhum', async () => {
    answer({ data: null, error: { message: 'sem_permissao' } });
    render(<LessonSessionsPanel />);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_lesson_sessions', { p_student_id: null }));
    expect(rpc).not.toHaveBeenCalledWith('get_student_handover', expect.anything());
    expect(screen.queryByRole('note')).toBeNull();
  });
});
