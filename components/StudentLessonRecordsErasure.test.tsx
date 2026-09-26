import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

import StudentLessonRecordsErasure from './StudentLessonRecordsErasure';

const preview = {
  ok: true, sessions: 4, raw_copies: 3, attendance_reports: 2, drafts: 2, approved_summaries: 1,
  memories: 1, card: true, originals_pending: 5, originals_done: 0, rooms_to_discover: 0,
  rooms_beyond_window: 0, drive_delete_ready: true, last_erasure_at: null,
};
const erased = {
  ok: true, sessions: 4, raw_copies_deleted: 3, attendance_reports_deleted: 2, summary_versions_deleted: 3,
  memories_deleted: 1, card_deleted: true, originals_queued: 5, sessions_to_discover: 0,
};

beforeEach(() => rpc.mockReset());

describe('Apagar registros das aulas (direção)', () => {
  it('mostra o que será apagado ANTES e só apaga na confirmação', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'get_student_lesson_records_erasure_preview'
      ? { data: preview, error: null }
      : { data: erased, error: null }));
    const onErased = vi.fn();
    render(<StudentLessonRecordsErasure studentId="aluno-1" onErased={onErased} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apagar registros das aulas deste aluno' }));
    await screen.findByTestId('erasure-preview');
    expect(rpc).toHaveBeenCalledWith('get_student_lesson_records_erasure_preview', { p_student_id: 'aluno-1' });
    expect(rpc).not.toHaveBeenCalledWith('erase_student_lesson_records', expect.anything());
    expect(screen.getByText('3 cópias da transcrição e das anotações guardadas no sistema')).toBeTruthy();
    expect(screen.getByText('o cartão do aluno (objetivo, temas e preferências)')).toBeTruthy();
    expect(screen.getByText(/5 originais vão para a lixeira do Google Drive da escola/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e apagar' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('erase_student_lesson_records', { p_student_id: 'aluno-1' }));
    await screen.findByRole('status');
    expect(screen.getByRole('status').textContent).toContain('3 rascunho(s)/resumo(s)');
    expect(screen.getByRole('status').textContent).toContain('Essas aulas não voltam a ser importadas.');
    expect(onErased).toHaveBeenCalledTimes(1);
  });

  it('cancelar não apaga nada', async () => {
    rpc.mockResolvedValue({ data: preview, error: null });
    render(<StudentLessonRecordsErasure studentId="aluno-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Apagar registros das aulas deste aluno' }));
    await screen.findByTestId('erasure-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByTestId('erasure-preview')).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('recusa do servidor aparece em português', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'sem_permissao' } });
    render(<StudentLessonRecordsErasure studentId="aluno-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Apagar registros das aulas deste aluno' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Você não tem permissão para esta ação.');
    expect(screen.queryByTestId('erasure-preview')).toBeNull();
  });
});
