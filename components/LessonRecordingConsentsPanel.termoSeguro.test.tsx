import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LessonRecordingConsentsPanel from './LessonRecordingConsentsPanel';

// Painel da escola, lado do termo seguro (migration 20260926200000): telefone
// do responsável sem confirmação da escola, número igual ao do aluno e link
// fechado por excesso de códigos.
// O painel carrega em paralelo a lista do termo e a do envio em lote
// (20260926210000): o mock responde pelo NOME da RPC, não pela ordem.

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const student = (overrides: Record<string, unknown> = {}) => ({
  student_id: 'aluno-1',
  name: 'Pedro Fixture',
  requires_guardian: true,
  guardian_reason: 'AGE_UNKNOWN',
  school_birth_date: null,
  guardian_name: 'Maria Fixture',
  contact_phone: null,
  decision: 'NONE',
  effective: false,
  decided_at: null,
  signer_name: null,
  signer_relation: null,
  verification: null,
  verified_phone: null,
  link_expires_at: null,
  link_code_phone_masked: null,
  guardian_phone_unconfirmed: false,
  guardian_phone_same_as_student: false,
  link_blocked_reason: null,
  ...overrides,
});

function overview(students: unknown[]) {
  return { data: { ok: true, google_connected: true, students, teachers: [] }, error: null };
}

// Envio em lote sem ninguém: a seção existe, mas não muda o que se testa aqui.
const emptySending = {
  data: { ok: true, can_send: true, portal_ok: true, term_version: 'v2', students: [] },
  error: null,
};

// Respostas de list_lesson_recording_consents em ordem; a última se repete.
let overviews: unknown[] = [];
let linkResult: unknown = null;

beforeEach(() => {
  overviews = [];
  linkResult = null;
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'list_lesson_recording_consents') return overviews.length > 1 ? overviews.shift() : overviews[0];
    if (name === 'list_lesson_recording_consent_requests') return emptySending;
    if (name === 'create_lesson_recording_consent_link') return linkResult;
    return { data: null, error: { message: 'inesperado' } };
  });
});

describe('<LessonRecordingConsentsPanel /> — termo seguro', () => {
  it('telefone do responsável sem confirmação da escola: diz onde confirmar', async () => {
    overviews = [overview([student({ guardian_phone_unconfirmed: true })])];
    render(<LessonRecordingConsentsPanel schoolName="Escola Fixture" />);

    expect(await screen.findByText(/não foi confirmado pela escola, então o código não sai/)).toBeInTheDocument();
    expect(screen.getByText(/Contatos verificados/)).toBeInTheDocument();
  });

  it('responsável com o mesmo número do aluno pede conferência', async () => {
    overviews = [overview([student({ contact_phone: '5511900000005', guardian_phone_same_as_student: true })])];
    render(<LessonRecordingConsentsPanel />);

    expect(await screen.findByText(/é o mesmo do aluno/)).toBeInTheDocument();
  });

  it('link bloqueado por tentativas aparece com o motivo, e some ao gerar outro', async () => {
    overviews = [
      overview([student({ link_blocked_reason: 'CODE_ATTEMPTS' })]),
      overview([student({ link_blocked_reason: null, guardian_phone_unconfirmed: true })]),
    ];
    render(<LessonRecordingConsentsPanel />);

    expect(await screen.findByText(/muitos códigos digitados errado/)).toBeInTheDocument();

    linkResult = {
      data: {
        ok: true,
        token: 'b'.repeat(64),
        guardian_reason: 'AGE_UNKNOWN',
        guardian_phone_masked: null,
        student_phone_masked: null,
        guardian_phone_unconfirmed: true,
      },
      error: null,
    };
    fireEvent.click(screen.getByRole('button', { name: 'Gerar link' }));

    expect(await screen.findByText(/b{64}/)).toBeInTheDocument();
    expect(screen.queryByText(/muitos códigos digitados errado/)).not.toBeInTheDocument();
    // Link novo sem telefone confirmado: o aviso diz o que fazer.
    expect(screen.getAllByText(/não foi confirmado pela escola/).length).toBeGreaterThan(0);
  });
});
