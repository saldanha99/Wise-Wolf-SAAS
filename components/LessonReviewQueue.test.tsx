import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('./LessonPedagogicalSummary', () => ({
  default: ({ sessionId }: { sessionId: string }) => <p>Detalhe da sessão {sessionId}</p>,
}));

import LessonReviewQueue from './LessonReviewQueue';

const DAY = 86_400_000;
const item = (overrides: Record<string, unknown> = {}) => ({
  session_id: 'session-1', student_id: 'student-1', student_name: 'Aluna Fixture',
  teacher_id: 'teacher-1', teacher_name: 'Professora Fixture', class_date: '2026-09-22',
  scheduled_start_at: '2026-09-22T13:00:00Z', version_id: 'v1', version: 1, origin: 'GEMINI_API',
  draft_created_at: new Date(Date.now() - 4 * DAY).toISOString(),
  pending_since: new Date(Date.now() - 4 * DAY).toISOString(),
  approvable_until: new Date(Date.now() + 3 * DAY).toISOString(),
  stale: true,
  ...overrides,
});

beforeEach(() => rpc.mockReset());

describe('Aulas para revisar', () => {
  it('mostra quem espera, há quanto tempo e até quando dá para aprovar; abre a revisão', async () => {
    rpc.mockResolvedValue({ data: { ok: true, items: [item(), item({ session_id: 'session-2', student_name: 'Aluno Novo', origin: 'GOOGLE_SMART_NOTES', stale: false,
      pending_since: new Date().toISOString(), approvable_until: new Date(Date.now() + 80 * DAY).toISOString() })] }, error: null });
    render(<LessonReviewQueue />);
    await screen.findByText('Aluna Fixture');
    expect(rpc).toHaveBeenCalledWith('get_meet_summary_review_queue');
    expect(screen.getByText(/Aulas para revisar \(2\)/)).toBeTruthy();
    expect(screen.getByText(/Rascunho da IA/)).toBeTruthy();
    expect(screen.getByText('Esperando há 4 dias')).toBeTruthy();
    expect(screen.getByText(/\(faltam 3 dias\)/)).toBeTruthy();
    expect(screen.getByText(/1 está parado há 3 dias ou mais/)).toBeTruthy();
    expect(screen.getByText(/Notas do Gemini/)).toBeTruthy();
    // Professor não vê o nome do professor (são as aulas dele).
    expect(screen.queryByText(/Professora Fixture/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Revisar' })[0]);
    await screen.findByText('Detalhe da sessão session-1');
    // Fechar recarrega a fila (a aula aprovada sai).
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  });

  it('coordenação e direção veem de qual professor é a aula', async () => {
    rpc.mockResolvedValue({ data: { ok: true, items: [item()] }, error: null });
    render(<LessonReviewQueue showTeacher />);
    await screen.findByText(/Professora Fixture/);
  });

  it('fila vazia e erro não quebram a tela de salas', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, items: [] }, error: null });
    const { unmount } = render(<LessonReviewQueue />);
    await screen.findByText('Nenhuma aula esperando revisão.');
    unmount();
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'sem_permissao' } });
    render(<LessonReviewQueue />);
    await screen.findByText(/Não foi possível carregar as aulas para revisar/);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
