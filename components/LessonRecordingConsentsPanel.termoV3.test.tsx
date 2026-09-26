import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LessonRecordingConsentsPanel from './LessonRecordingConsentsPanel';

// Painel da escola, termo v3 (migration 20260927100000): como a escola aparece
// no termo (e o que falta completar) e o aceite de versão anterior, que não
// vale — nem do aluno, nem do professor.

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const student = {
  student_id: 'aluno-1',
  name: 'Pedro Fixture',
  requires_guardian: true,
  guardian_reason: 'AGE_UNKNOWN',
  school_birth_date: null,
  guardian_name: 'Maria Fixture',
  contact_phone: '5511900000001',
  decision: 'ACCEPTED',
  effective: false,
  term_updated: true,
  decided_term_version: 'v2',
  decided_at: '2026-09-26T12:00:00Z',
  signer_name: 'Maria Fixture',
  signer_relation: 'GUARDIAN',
  verification: 'WHATSAPP_CODE',
  verified_phone: '(11) •••••-0001',
  link_expires_at: null,
  link_code_phone_masked: null,
  guardian_phone_unconfirmed: false,
  guardian_phone_same_as_student: false,
  link_blocked_reason: null,
};

let overview: Record<string, unknown>;

beforeEach(() => {
  overview = {
    ok: true,
    google_connected: true,
    term_identity: {
      escola_nome: 'Escola Fixture',
      escola_documento: 'CNPJ 11.222.333/0001-81',
      escola_contato_privacidade: 'a direção da escola, pelo WhatsApp da escola',
      missing: ['razao_social', 'contato_privacidade'],
    },
    term_versions: { STUDENT: 'v3', TEACHER: 'v3' },
    students: [student],
    teachers: [
      { teacher_id: 'prof-1', name: 'Professora Antiga', decision: 'ACCEPTED', decided_at: '2026-09-26T12:00:00Z',
        effective: false, term_updated: true, decided_term_version: 'v2' },
      { teacher_id: 'prof-2', name: 'Professora Nova', decision: 'ACCEPTED', decided_at: '2026-09-27T12:00:00Z',
        effective: true, term_updated: false, decided_term_version: 'v3' },
    ],
  };
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'list_lesson_recording_consents') return { data: overview, error: null };
    if (name === 'list_lesson_recording_consent_requests') {
      return { data: { ok: true, can_send: true, portal_ok: true, term_version: 'v3', students: [] }, error: null };
    }
    return { data: null, error: { message: 'inesperado' } };
  });
});

describe('<LessonRecordingConsentsPanel /> — termo v3', () => {
  it('mostra como a escola aparece no termo e o que falta completar', async () => {
    render(<LessonRecordingConsentsPanel schoolName="Escola Fixture" />);

    const block = await screen.findByRole('region', { name: 'A escola no termo' });
    expect(block).toHaveTextContent('quem responde pelos dados é a escola: Escola Fixture, CNPJ 11.222.333/0001-81.');
    expect(block).toHaveTextContent('Falta razão social, contato de privacidade (LGPD): complete em Configurações → Escola e legal');
    expect(block).toHaveTextContent('Termo vigente: aluno v3 · professor v3.');
  });

  it('aceite de versão anterior não conta: aluno com aviso próprio e professor fora da conta', async () => {
    render(<LessonRecordingConsentsPanel schoolName="Escola Fixture" />);

    expect(await screen.findByText(/Este aceite é da versão v2 do termo e o texto mudou: não vale para transcrever até o responsável aceitar/)).toBeInTheDocument();
    expect(screen.queryByText(/foi dado pelo próprio aluno/)).not.toBeInTheDocument();
    expect(screen.getByText(/Aceitou a versão v2 do termo; precisa aceitar a versão vigente/)).toBeInTheDocument();
    // Só a professora que aceitou a v3 conta.
    expect(screen.getByText('professores autorizaram').previousElementSibling).toHaveTextContent('1 de 2');
    expect(screen.getByText('alunos autorizaram').previousElementSibling).toHaveTextContent('0 de 1');
  });

  it('servidor anterior à v3 (sem a identidade): o bloco não aparece', async () => {
    delete overview.term_identity;
    render(<LessonRecordingConsentsPanel schoolName="Escola Fixture" />);

    expect(await screen.findByText('Pedro Fixture')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'A escola no termo' })).not.toBeInTheDocument();
  });
});
