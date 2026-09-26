import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('./LessonPedagogicalSummary', () => ({ default: () => null }));
vi.mock('./StudentHandover', () => ({ default: () => null }));
vi.mock('./LessonRecordingTeacherCard', () => ({ default: () => null }));

import LessonSessionsPanel from './LessonSessionsPanel';

const session = {
  id: 'session-1', student_id: 'student-1', student_name: 'Aluna Fixture', teacher_name: 'Professora Fixture',
  scheduled_start_at: '2026-09-28T13:00:00Z', scheduled_end_at: '2026-09-28T13:30:00Z', class_date: '2026-09-28',
  status: 'SCHEDULED', documentation_consent: false,
};

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation((name: string) => Promise.resolve(name === 'get_lesson_sessions'
    ? { data: { ok: true, sessions: [session] }, error: null }
    : { data: null, error: { message: 'termo_recusado_ou_revogado_pelo_aluno' } }));
});
afterEach(() => vi.restoreAllMocks());

describe('Marcação manual de documentação: só a direção, com motivo, sem passar por cima de revogação', () => {
  it('coordenação vê a sessão, mas não o botão de autorização', async () => {
    render(<LessonSessionsPanel manager canMarkDocumentation={false} />);
    await screen.findByText('Aluna Fixture');
    expect(screen.queryByRole('button', { name: 'Registrar autorização' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Registrar ocorrência' })).toBeTruthy();
  });

  it('direção sem motivo não chama o servidor; com motivo, a recusa do aluno aparece em texto claro', async () => {
    const prompt = vi.spyOn(window, 'prompt');
    render(<LessonSessionsPanel manager canMarkDocumentation />);
    const button = await screen.findByRole('button', { name: 'Registrar autorização' });
    prompt.mockReturnValueOnce('curto');
    fireEvent.click(button);
    await screen.findByText(/pelo menos 10 caracteres/);
    expect(rpc).not.toHaveBeenCalledWith('set_lesson_documentation_consent', expect.anything());
    prompt.mockReturnValueOnce('Autorização assinada em papel, arquivo da secretaria');
    fireEvent.click(button);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_lesson_documentation_consent', {
      p_session_id: 'session-1', p_allowed: true, p_reason: 'Autorização assinada em papel, arquivo da secretaria',
    }));
    await screen.findByText(/recusou ou revogou o registro das aulas/);
  });
});
