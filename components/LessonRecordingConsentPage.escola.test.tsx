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

  it('link revogado, vencido ou bloqueado no modo da escola: fala com a escola, não pede link novo', async () => {
    // A direção registra o pedido pela revogação, que revoga o link; no modo da
    // escola não se gera link novo (create_lesson_recording_consent_link recusa).
    rpc.mockResolvedValueOnce({ data: { found: false, expired: true, authorization_mode: 'SCHOOL_DEFAULT' }, error: null });
    const { unmount } = render(<LessonRecordingConsentPage />);
    expect(await screen.findByText(/fale com a escola pelo WhatsApp/)).toBeInTheDocument();
    expect(screen.queryByText(/Peça um novo/)).not.toBeInTheDocument();
    unmount();

    rpc.mockResolvedValueOnce({ data: { found: false, expired: true, blocked: true, authorization_mode: 'SCHOOL_DEFAULT' }, error: null });
    render(<LessonRecordingConsentPage />);
    expect(await screen.findByText('Link bloqueado')).toBeInTheDocument();
    expect(screen.getByText(/fale com a escola pelo WhatsApp/)).toBeInTheDocument();
    expect(screen.queryByText(/Peça um novo/)).not.toBeInTheDocument();
  });

  it('sem o WhatsApp no cadastro ou link bloqueado no meio: nada de "link novo" no modo da escola', async () => {
    rpc.mockResolvedValueOnce({ data: page({ student_phone_masked: null }), error: null });
    render(<LessonRecordingConsentPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /sou o aluno/i }));
    expect(screen.getByText(/A escola não tem o WhatsApp do aluno no cadastro\. Para pedir que as aulas não sejam registradas, fale com a escola pelo WhatsApp/))
      .toBeInTheDocument();
    expect(screen.queryByText(/link novo/)).not.toBeInTheDocument();
  });

  it('código pedido por link que o servidor bloqueou: a mensagem do modo da escola', async () => {
    rpc.mockResolvedValueOnce({ data: page(), error: null });
    invoke.mockResolvedValueOnce({ data: { ok: false, error: 'link_bloqueado' }, error: null });
    render(<LessonRecordingConsentPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /sou o aluno/i }));
    fireEvent.click(screen.getByRole('button', { name: /enviar código pelo whatsapp/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/fale com a escola pelo WhatsApp/);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/link novo/);
  });

  it('menor: o pedido é do responsável', async () => {
    rpc.mockResolvedValueOnce({ data: page({ requires_guardian: true, guardian_reason: 'KIDS', guardian_phone_masked: '(11) •••••-0001' }), error: null });
    render(<LessonRecordingConsentPage />);
    expect(await screen.findByText(/o pedido para não registrar é feito pelo responsável legal/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /sou o aluno/i })).not.toBeInTheDocument();
  });
});
