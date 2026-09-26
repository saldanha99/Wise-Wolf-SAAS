import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LessonRecordingConsentPage from './LessonRecordingConsentPage';

const { rpc, invoke } = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: { rpc, functions: { invoke } },
}));

const TOKEN = 'a'.repeat(64);
const page = (overrides: Record<string, unknown> = {}) => ({
  found: true,
  school_name: 'Escola Fixture',
  student_first_name: 'Pedro',
  requires_guardian: true,
  guardian_reason: 'AGE_UNKNOWN',
  student_phone_masked: '(11) •••••-0002',
  guardian_phone_masked: '(11) •••••-0001',
  term_version: 'v2',
  term_body: 'Texto do termo de registro das aulas. '.repeat(10),
  current_decision: 'NONE',
  ...overrides,
});

beforeEach(() => {
  rpc.mockReset();
  invoke.mockReset();
  window.history.replaceState({}, '', `/registro-das-aulas?token=${TOKEN}`);
});

describe('<LessonRecordingConsentPage />', () => {
  it('idade não cadastrada: responde o responsável e o código vai para o telefone dele', async () => {
    rpc.mockResolvedValueOnce({ data: page(), error: null });
    render(<LessonRecordingConsentPage />);

    expect(await screen.findByText(/ainda não cadastrou a data de nascimento de Pedro/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /sou o aluno/i })).not.toBeInTheDocument();
    expect(screen.getByText('(11) •••••-0001')).toBeInTheDocument();
    // Sem código, não há como decidir.
    expect(screen.getByRole('button', { name: /^autorizo$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /não autorizo/i })).toBeDisabled();
  });

  it('só grava a decisão com o código, e mostra as tentativas restantes', async () => {
    rpc.mockResolvedValueOnce({ data: page(), error: null });
    invoke.mockResolvedValueOnce({ data: { ok: true, sent_to: '(11) •••••-0001', expires_at: '2026-09-26T20:10:00Z' }, error: null });
    render(<LessonRecordingConsentPage />);

    fireEvent.change(await screen.findByRole('textbox', { name: /seu nome completo/i }), { target: { value: 'Maria Responsavel' } });
    fireEvent.click(screen.getByRole('button', { name: /enviar código pelo whatsapp/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('lesson-recording-code', { body: { token: TOKEN, relation: 'GUARDIAN' } }));
    expect(await screen.findByText(/Código enviado para \(11\) •••••-0001/)).toBeInTheDocument();

    const codeInput = screen.getByLabelText('Código recebido');
    fireEvent.change(codeInput, { target: { value: '12a34567' } });
    expect((codeInput as HTMLInputElement).value).toBe('123456');

    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'codigo_incorreto', attempts_left: 4 }, error: null });
    fireEvent.click(screen.getByRole('button', { name: /^autorizo$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Restam 4 tentativas');
    expect(rpc).toHaveBeenLastCalledWith('decide_lesson_recording_consent_public', {
      p_token: TOKEN,
      p_signer_name: 'Maria Responsavel',
      p_relation: 'GUARDIAN',
      p_accept: true,
      p_code: '123456',
    });
    expect(screen.queryByText('Autorização registrada')).not.toBeInTheDocument();

    rpc.mockResolvedValueOnce({ data: { ok: true, decision: 'ACCEPTED', verified_phone: '(11) •••••-0001' }, error: null });
    fireEvent.click(screen.getByRole('button', { name: /^autorizo$/i }));
    expect(await screen.findByText('Autorização registrada')).toBeInTheDocument();
    expect(screen.getByText(/Confirmado pelo WhatsApp \(11\) •••••-0001/)).toBeInTheDocument();
  });

  it('limite de envios aparece com a espera, sem campo de código', async () => {
    rpc.mockResolvedValueOnce({ data: page({ requires_guardian: false, guardian_reason: null }), error: null });
    invoke.mockResolvedValueOnce({
      data: null,
      error: { context: { json: async () => ({ error: 'limite_de_envios', retry_after_seconds: 1200 }) } },
    });
    render(<LessonRecordingConsentPage />);

    fireEvent.click(await screen.findByRole('radio', { name: /sou o aluno/i }));
    expect(screen.getByText('(11) •••••-0002')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /enviar código pelo whatsapp/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tente em 20 minutos');
    expect(screen.queryByLabelText('Código recebido')).not.toBeInTheDocument();
  });

  it('sem WhatsApp no cadastro, não oferece envio de código', async () => {
    rpc.mockResolvedValueOnce({ data: page({ guardian_phone_masked: null }), error: null });
    render(<LessonRecordingConsentPage />);

    expect(await screen.findByText(/não tem o WhatsApp do responsável no cadastro/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enviar código/i })).not.toBeInTheDocument();
  });
});
