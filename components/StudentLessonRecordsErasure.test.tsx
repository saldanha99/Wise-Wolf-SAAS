import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc, functions: { invoke } } }));

import StudentLessonRecordsErasure from './StudentLessonRecordsErasure';

const preview = {
  ok: true, sessions: 4, raw_copies: 3, attendance_reports: 2, drafts: 2, approved_summaries: 1,
  memories: 1, card: true, originals_pending: 5, originals_other_account: 0, originals_done: 0, rooms_to_discover: 0,
  rooms_other_account: 0, rooms_beyond_window: 0, rooms_attendance_unregistered: 0, discovery_deadline: null,
  connection_status: 'CONNECTED', drive_delete_ready: true, last_erasure_at: null,
};
const erased = {
  ok: true, sessions: 4, raw_copies_deleted: 3, attendance_reports_deleted: 2, summary_versions_deleted: 3,
  memories_deleted: 1, card_deleted: true, originals_queued: 5, sessions_to_discover: 0, originals_other_account: 0,
  rooms_other_account: 0, rooms_beyond_window: 0, rooms_attendance_unregistered: 0, discovery_deadline: null,
  connection_status: 'CONNECTED',
};
// Status da edge google-meet: lixeira ligada e autorizada, presença ligada.
const edgeStatus = (overrides: Record<string, unknown> = {}) => ({
  data: { drive_delete_enabled: true, drive_delete_granted: true, attendance_report_enabled: true, ...overrides },
  error: null,
});

beforeEach(() => { rpc.mockReset(); invoke.mockReset(); });

describe('Apagar registros das aulas (direção)', () => {
  it('mostra o que será apagado ANTES e só apaga na confirmação', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'get_student_lesson_records_erasure_preview'
      ? { data: preview, error: null }
      : { data: erased, error: null }));
    invoke.mockResolvedValue(edgeStatus());
    const onErased = vi.fn();
    render(<StudentLessonRecordsErasure studentId="aluno-1" onErased={onErased} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apagar registros das aulas deste aluno' }));
    await screen.findByTestId('erasure-preview');
    expect(rpc).toHaveBeenCalledWith('get_student_lesson_records_erasure_preview', { p_student_id: 'aluno-1' });
    expect(invoke).toHaveBeenCalledWith('google-meet', { body: { action: 'status' } });
    expect(rpc).not.toHaveBeenCalledWith('erase_student_lesson_records', expect.anything());
    expect(screen.getByText('3 cópias da transcrição e das anotações guardadas no sistema')).toBeTruthy();
    expect(screen.getByText('o cartão do aluno (objetivo, temas e preferências)')).toBeTruthy();
    expect(screen.getByTestId('erasure-originals').textContent).toContain('5 originais registrados vão para a lixeira do Google Drive da escola');

    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e apagar' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('erase_student_lesson_records', { p_student_id: 'aluno-1' }));
    await screen.findByRole('status');
    expect(screen.getByRole('status').textContent).toContain('3 rascunho(s)/resumo(s)');
    expect(screen.getByRole('status').textContent).toContain('Essas aulas não voltam a ser importadas.');
    expect(screen.getByRole('status').textContent).toContain('Os 5 originais registrados entraram na fila da lixeira');
    expect(onErased).toHaveBeenCalledTimes(1);
  });

  it('lixeira desligada na instalação: não promete a lixeira, nem na prévia nem no resultado', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'get_student_lesson_records_erasure_preview'
      ? { data: preview, error: null }
      : { data: erased, error: null }));
    invoke.mockResolvedValue(edgeStatus({ drive_delete_enabled: false }));
    render(<StudentLessonRecordsErasure studentId="aluno-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Apagar registros das aulas deste aluno' }));
    const originals = await screen.findByTestId('erasure-originals');
    expect(originals.textContent).toContain('a lixeira automática não está ligada nesta instalação');
    expect(originals.textContent).not.toContain('vão para a lixeira');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e apagar' }));
    const status = await screen.findByRole('status');
    expect(status.textContent).not.toContain('entraram na fila da lixeira');
    expect(status.textContent).toContain('só vão para ela quando for ligada');
  });

  it('status da edge fora do ar: a prévia sai, sem prometer a lixeira', async () => {
    rpc.mockResolvedValue({ data: preview, error: null });
    invoke.mockRejectedValue(new Error('rede'));
    render(<StudentLessonRecordsErasure studentId="aluno-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Apagar registros das aulas deste aluno' }));
    const originals = await screen.findByTestId('erasure-originals');
    expect(originals.textContent).toContain('não deu para confirmar se a lixeira automática está ligada');
  });

  it('cancelar não apaga nada', async () => {
    rpc.mockResolvedValue({ data: preview, error: null });
    invoke.mockResolvedValue(edgeStatus());
    render(<StudentLessonRecordsErasure studentId="aluno-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Apagar registros das aulas deste aluno' }));
    await screen.findByTestId('erasure-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByTestId('erasure-preview')).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('recusa do servidor aparece em português', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'sem_permissao' } });
    invoke.mockResolvedValue(edgeStatus());
    render(<StudentLessonRecordsErasure studentId="aluno-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Apagar registros das aulas deste aluno' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Você não tem permissão para esta ação.');
    expect(screen.queryByTestId('erasure-preview')).toBeNull();
  });
});
