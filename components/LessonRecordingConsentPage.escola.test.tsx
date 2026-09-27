import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LessonRecordingConsentPage from './LessonRecordingConsentPage';

// Página pública com o registro AUTORIZADO PELA ESCOLA (migration
// 20260929100000): mostra o AVISO e só a opção de pedir para não registrar —
// sem "Autorizo" —, com o mesmo código do WhatsApp.

const { rpc, invoke } = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, functions: { invoke } } }));

const TOKEN = 'b'.repeat(64);
const page = (overrides: Record<string, unknown> = {}) => ({
  found: true,
  authorization_mode: 'SCHOOL_DEFAULT',
  school_name: 'Escola Fixture',
  student_first_name: 'Ana',
  requires_guardian: false,
  guardian_reason: null,
  student_phone_masked: '(11) •••••-0002',
  guardian_phone_masked: null,
  term_version: 'v4',
  term_body: 'Aviso sobre o registro das aulas. '.repeat(10),
  current_decision: 'NONE',
  current_effective: true,
  ...overrides,
});

beforeEach(() => {
  rpc.mockReset();
  invoke.mockReset();
  window.history.replaceState({}, '', `/registro-das-aulas?token=${TOKEN}`);
});

describe('<LessonRecordingConsentPage /> — registro autorizado pela escola', () => {
  it('mostra o aviso e só o pedido para não registrar, gravado com o código', async () => {
    rpc.mockResolvedValueOnce({ data: page(), error: null });
    invoke.mockResolvedValueOnce({ data: { ok: true, sent_to: '(11) •••••-0002' }, error: null });
    render(<LessonRecordingConsentPage />);

    expect(await screen.findByText(/aviso v4/)).toBeInTheDocument();
    expect(screen.getByText(/são registradas pela escola/)).toBeInTheDocument();
    expect(screen.getByText('Situação atual: registro autorizado pela escola.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^autorizo$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /não autorizo/i })).not.toBeInTheDocument();
    const object = screen.getByRole('button', { name: /não quero que as aulas sejam registradas/i });
    expect(object).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /sou o aluno/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /seu nome completo/i }), { target: { value: 'Ana Fixture Silva' } });
    fireEvent.click(screen.getByRole('button', { name: /enviar código pelo whatsapp/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('lesson-recording-code', { body: { token: TOKEN, relation: 'SELF' } }));
    fireEvent.change(await screen.findByLabelText('Código recebido'), { target: { value: '123456' } });

    rpc.mockResolvedValueOnce({ data: { ok: true, decision: 'REFUSED', verified_phone: '(11) •••••-0002', term_version: 'v4' }, error: null });
    fireEvent.click(screen.getByRole('button', { name: /não quero que as aulas sejam registradas/i }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('decide_lesson_recording_consent_public', {
      p_token: TOKEN, p_signer_name: 'Ana Fixture Silva', p_relation: 'SELF', p_accept: false, p_code: '123456', p_term_version: 'v4',
    }));
    expect(await screen.findByText('Pedido registrado')).toBeInTheDocument();
    expect(screen.getByText(/sem transcrição/)).toBeInTheDocument();
  });

  it('quem já pediu vê o pedido e não recebe o formulário de novo', async () => {
    rpc.mockResolvedValueOnce({ data: page({ current_decision: 'REFUSED', current_effective: false }), error: null });
    render(<LessonRecordingConsentPage />);
    expect(await screen.findByText(/já existe o pedido para não registrar as aulas/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /seu nome completo/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /não quero que as aulas sejam registradas/i })).not.toBeInTheDocument();
  });

  it('menor: o pedido é do responsável', async () => {
    rpc.mockResolvedValueOnce({ data: page({ requires_guardian: true, guardian_reason: 'KIDS', guardian_phone_masked: '(11) •••••-0001' }), error: null });
    render(<LessonRecordingConsentPage />);
    expect(await screen.findByText(/o pedido para não registrar é feito pelo responsável legal/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /sou o aluno/i })).not.toBeInTheDocument();
  });
});
