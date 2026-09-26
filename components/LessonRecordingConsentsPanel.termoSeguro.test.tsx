import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LessonRecordingConsentsPanel from './LessonRecordingConsentsPanel';

// Painel da escola, lado do termo seguro (migration 20260926200000): telefone
// do responsável sem confirmação da escola, número igual ao do aluno e link
// fechado por excesso de códigos.

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

beforeEach(() => {
  rpc.mockReset();
});

describe('<LessonRecordingConsentsPanel /> — termo seguro', () => {
  it('telefone do responsável sem confirmação da escola: diz onde confirmar', async () => {
    rpc.mockResolvedValueOnce(overview([student({ guardian_phone_unconfirmed: true })]));
    render(<LessonRecordingConsentsPanel schoolName="Escola Fixture" />);

    expect(await screen.findByText(/não foi confirmado pela escola, então o código não sai/)).toBeInTheDocument();
    expect(screen.getByText(/Contatos verificados/)).toBeInTheDocument();
  });

  it('responsável com o mesmo número do aluno pede conferência', async () => {
    rpc.mockResolvedValueOnce(overview([student({ contact_phone: '5511900000005', guardian_phone_same_as_student: true })]));
    render(<LessonRecordingConsentsPanel />);

    expect(await screen.findByText(/é o mesmo do aluno/)).toBeInTheDocument();
  });

  it('link bloqueado por tentativas aparece com o motivo, e some ao gerar outro', async () => {
    rpc.mockResolvedValueOnce(overview([student({ link_blocked_reason: 'CODE_ATTEMPTS' })]));
    render(<LessonRecordingConsentsPanel />);

    expect(await screen.findByText(/muitos códigos digitados errado/)).toBeInTheDocument();

    rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        token: 'b'.repeat(64),
        guardian_reason: 'AGE_UNKNOWN',
        guardian_phone_masked: null,
        student_phone_masked: null,
        guardian_phone_unconfirmed: true,
      },
      error: null,
    });
    rpc.mockResolvedValueOnce(overview([student({ link_blocked_reason: null, guardian_phone_unconfirmed: true })]));
    fireEvent.click(screen.getByRole('button', { name: 'Gerar link' }));

    expect(await screen.findByText(/b{64}/)).toBeInTheDocument();
    expect(screen.queryByText(/muitos códigos digitados errado/)).not.toBeInTheDocument();
    // Link novo sem telefone confirmado: o aviso diz o que fazer.
    expect(screen.getAllByText(/não foi confirmado pela escola/).length).toBeGreaterThan(0);
  });
});
