import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LessonRecordingConsentsPanel from './LessonRecordingConsentsPanel';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

// 28/09/2026 é segunda; 17:05Z = 14:05 em Brasília.
const PREVIEW = {
  ok: true, to_send: 3, to_guardians: 1, term_updated: 0, no_contact: 1, left_for_next_batch: 0,
  first_at: '2026-09-28T17:05:00Z', last_at: '2026-09-28T17:11:00Z', student_notifications_enabled: true,
};

let canSend = true;
let enqueueResult: { data: unknown; error: { message: string } | null };

function requests() {
  return {
    ok: true, can_send: canSend, term_version: 'v2',
    students: [
      { student_id: 's1', name: 'Ana Adulta', decision: 'NONE', decided_at: null, eligible: true, recipient: 'STUDENT',
        contact_last4: '0001', missing_reason: null, request: null, resend_available_at: '2026-01-01T00:00:00Z' },
      { student_id: 's2', name: 'Caio Crianca', decision: 'NONE', decided_at: null, eligible: true, recipient: 'GUARDIAN',
        contact_last4: '0003', missing_reason: null, resend_available_at: '2099-01-01T12:00:00Z',
        request: { attempt: 1, requested_at: '2026-09-26T12:00:00Z', scheduled_for: '2026-09-26T12:03:00Z', recipient: 'GUARDIAN',
          contact_last4: '0003', state: 'SENT', sent_at: '2026-09-26T12:03:10Z', read_at: null, not_sent_reason: null,
          opened_at: '2026-09-26T13:00:00Z', answered_after: false } },
      { student_id: 's3', name: 'Eva Semidade', decision: 'NONE', decided_at: null, eligible: true, recipient: 'GUARDIAN',
        contact_last4: null, missing_reason: 'idade_nao_cadastrada', request: null, resend_available_at: null },
      { student_id: 's4', name: 'Gabi Recusou', decision: 'REFUSED', decided_at: '2026-09-20T12:00:00Z', eligible: false,
        recipient: 'STUDENT', contact_last4: '0009', missing_reason: null, request: null, resend_available_at: null },
    ],
  };
}

beforeEach(() => {
  canSend = true;
  enqueueResult = { data: { ok: true, queued: 3, first_at: PREVIEW.first_at, last_at: PREVIEW.last_at }, error: null };
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'list_lesson_recording_consents') return { data: { ok: true, google_connected: true, students: [], teachers: [] }, error: null };
    if (name === 'list_lesson_recording_consent_requests') return { data: requests(), error: null };
    if (name === 'preview_lesson_recording_consent_batch') return { data: PREVIEW, error: null };
    if (name === 'enqueue_lesson_recording_consent_batch') return enqueueResult;
    return { data: null, error: { message: 'inesperado' } };
  });
});

describe('envio do termo em lote', () => {
  it('só enfileira depois da confirmação que mostra quantas mensagens e quando saem', async () => {
    render(<LessonRecordingConsentsPanel schoolName="Escola Fixture" />);
    fireEvent.click(await screen.findByRole('button', { name: /Enviar termo aos alunos pendentes/ }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Enviar 3 mensagens pelo WhatsApp da escola?');
    expect(dialog).toHaveTextContent('1 vai para o responsável');
    expect(dialog).toHaveTextContent('Uma a cada 3 minutos, seg 28/09, das 14:05 às 14:11');
    expect(dialog).toHaveTextContent('1 fica de fora por falta de contato');
    expect(rpc.mock.calls.some(([name]) => name === 'enqueue_lesson_recording_consent_batch')).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar envio de 3' }));
    await screen.findByRole('status');
    expect(rpc).toHaveBeenCalledWith('enqueue_lesson_recording_consent_batch', { p_expected_count: 3 });
    expect(screen.getByRole('status')).toHaveTextContent('3 mensagens entraram na fila da escola');
  });

  it('cancelar não envia nada', async () => {
    render(<LessonRecordingConsentsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Enviar termo aos alunos pendentes/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(rpc.mock.calls.some(([name]) => name === 'enqueue_lesson_recording_consent_batch')).toBe(false);
  });

  it('lista mostra envio, abertura, reenvio bloqueado por 3 dias e sem contato', async () => {
    render(<LessonRecordingConsentsPanel />);
    expect(await screen.findByText('Ana Adulta')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeInTheDocument();
    expect(screen.getByText(/Enviado sáb 26\/09 às 09:03/)).toBeInTheDocument();
    expect(screen.getByText(/Abriu o link em 26\/09\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/Reenvio liberado/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reenviar' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sem contato' }));
    expect(await screen.findByText(/Cadastre a data de nascimento/)).toBeInTheDocument();
    expect(screen.queryByText('Ana Adulta')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Responderam' }));
    expect(await screen.findByText('Gabi Recusou')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reenviar' })).not.toBeInTheDocument();
  });

  it('coordenação vê a lista mas não tem botão de envio', async () => {
    canSend = false;
    render(<LessonRecordingConsentsPanel />);
    expect(await screen.findByText('Ana Adulta')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enviar termo aos alunos pendentes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar' })).not.toBeInTheDocument();
  });

  it('contagem mudou entre a conferência e o clique: refaz a conferência', async () => {
    enqueueResult = { data: null, error: { message: 'contagem_mudou' } };
    render(<LessonRecordingConsentsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Enviar termo aos alunos pendentes/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Confirmar envio de 3' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confira de novo');
    await waitFor(() => expect(rpc.mock.calls.filter(([name]) => name === 'preview_lesson_recording_consent_batch')).toHaveLength(2));
  });
});
