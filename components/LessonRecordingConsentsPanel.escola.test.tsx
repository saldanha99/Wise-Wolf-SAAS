import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LessonRecordingConsentsPanel from './LessonRecordingConsentsPanel';

// Painel da escola no registro AUTORIZADO PELA ESCOLA (migration 20260929100000):
// "Autorizado pela escola" para todos, destaque de quem pediu para não
// registrar, o botão da direção para registrar/desfazer o pedido, sem envio em
// lote e sem link por aluno; e a troca de modo com confirmação na tela.

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const base = {
  requires_guardian: false,
  guardian_reason: null,
  school_birth_date: '1990-05-10',
  guardian_name: null,
  contact_phone: '5511900000001',
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
};

let overview: Record<string, unknown>;

function defaultOverview(): Record<string, unknown> {
  return {
    ok: true,
    google_connected: true,
    authorization: {
      mode: 'SCHOOL_DEFAULT',
      current: {
        mode: 'SCHOOL_DEFAULT', since: '2026-09-29T12:00:00Z', decided_on: '2026-09-27',
        decided_by_name: 'Diretor Fixture', reason: 'Decisão da direção: registro pelo contrato.', source: 'MIGRATION',
      },
      history: [],
      notice_versions: { STUDENT: 'v4', TEACHER: 'v4' },
      can_change: true,
    },
    term_versions: { STUDENT: 'v3', TEACHER: 'v3' },
    students: [
      { ...base, student_id: 'kid-1', name: 'Crianca Fixture', requires_guardian: true, guardian_reason: 'KIDS',
        guardian_name: 'Mae Fixture', decision: 'NONE', effective: true },
      { ...base, student_id: 'adult-1', name: 'Adulta Pediu', decision: 'REVOKED', effective: false,
        decided_at: '2026-09-29T15:00:00Z', signer_relation: 'SCHOOL', signer_name: 'Diretor Fixture' },
    ],
    teachers: [
      { teacher_id: 'prof-1', name: 'Professora Sem Conta', decision: 'NONE', decided_at: null, effective: true,
        google_identity_confirmed: false },
      { teacher_id: 'prof-2', name: 'Professor Pediu', decision: 'REFUSED', decided_at: '2026-09-29T16:00:00Z',
        effective: false, google_identity_confirmed: true },
    ],
  };
}

beforeEach(() => {
  overview = defaultOverview();
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'list_lesson_recording_consents') return { data: overview, error: null };
    if (name === 'list_lesson_recording_consent_requests') {
      return { data: { ok: true, can_send: false, authorization_mode: 'SCHOOL_DEFAULT', term_version: 'v3', students: [] }, error: null };
    }
    return { data: { ok: true }, error: null };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<LessonRecordingConsentsPanel /> — registro autorizado pela escola', () => {
  it('mostra "Autorizado pela escola", destaca quem pediu para não registrar e não gera link nem envia termo', async () => {
    render(<LessonRecordingConsentsPanel schoolName="Escola Fixture" />);

    const mode = await screen.findByRole('region', { name: 'Como a escola autoriza o registro' });
    expect(within(mode).getByText('Registro autorizado pela escola')).toBeInTheDocument();
    expect(within(mode).getByText(/Decidido por Diretor Fixture em 27\/09\/2026/)).toBeInTheDocument();

    expect(screen.getAllByText('Autorizado pela escola').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pediu para não registrar').length).toBe(2);
    expect(screen.getByText(/Pedido registrado pela escola em/)).toBeInTheDocument();
    expect(screen.getByText(/o pedido para não registrar pode vir do responsável \(Mae Fixture\)/)).toBeInTheDocument();
    expect(screen.getByText(/Sem conta Google confirmada: a sala da escola não nasce/)).toBeInTheDocument();

    // Contadores do modo da escola.
    expect(screen.getByText('alunos com registro autorizado pela escola').previousElementSibling).toHaveTextContent('1 de 2');
    // Um aluno e um professor pediram.
    expect(screen.getAllByText('1 pediu para não registrar', { selector: 'p' })).toHaveLength(2);
    expect(screen.getByText(/1 sem conta Google confirmada/)).toBeInTheDocument();

    // Sem link por aluno e sem envio em lote.
    expect(screen.queryByRole('button', { name: /Gerar link/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enviar termo aos alunos pendentes/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Envio do termo pelo WhatsApp da escola/)).not.toBeInTheDocument();
    expect(screen.queryByText('Sem resposta')).not.toBeInTheDocument();
  });

  it('a direção registra o pedido para não registrar com o motivo, e desfaz', async () => {
    const prompt = vi.spyOn(window, 'prompt');
    render(<LessonRecordingConsentsPanel schoolName="Escola Fixture" />);
    await screen.findByText('Crianca Fixture');

    prompt.mockReturnValueOnce('A mãe pediu pelo WhatsApp em 29/09.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Registrar pedido para não registrar' })[0]);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('revoke_lesson_recording_consent', {
      p_subject_id: 'kid-1', p_reason: 'A mãe pediu pelo WhatsApp em 29/09.',
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('Pedido de Crianca Fixture registrado');

    prompt.mockReturnValueOnce('Pediu pelo WhatsApp para voltar a registrar.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Desfazer pedido' })[0]);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('withdraw_lesson_recording_objection', {
      p_subject_id: 'adult-1', p_reason: 'Pediu pelo WhatsApp para voltar a registrar.',
    }));

    // Sem motivo, nada é gravado.
    rpc.mockClear();
    prompt.mockReturnValueOnce(null);
    fireEvent.click(screen.getAllByRole('button', { name: 'Registrar pedido para não registrar' })[0]);
    expect(rpc).not.toHaveBeenCalledWith('revoke_lesson_recording_consent', expect.anything());
  });

  it('a troca de modo pede confirmação na tela e o motivo', async () => {
    render(<LessonRecordingConsentsPanel schoolName="Escola Fixture" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Voltar ao aceite individual' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/volta a precisar aceitar o termo vigente/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Confirmar a mudança' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'O jurídico pediu o aceite individual.' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_lesson_recording_authorization_mode', {
      p_mode: 'INDIVIDUAL_CONSENT', p_reason: 'O jurídico pediu o aceite individual.',
    }));
  });

  it('coordenação vê o modo, mas não o botão de troca', async () => {
    overview = defaultOverview();
    (overview.authorization as Record<string, unknown>).can_change = false;
    render(<LessonRecordingConsentsPanel schoolName="Escola Fixture" />);
    await screen.findByRole('region', { name: 'Como a escola autoriza o registro' });
    expect(screen.queryByRole('button', { name: 'Voltar ao aceite individual' })).not.toBeInTheDocument();
  });

  it('no aceite individual o painel continua o de antes, com a opção de passar ao modo da escola', async () => {
    overview = {
      ...defaultOverview(),
      authorization: { mode: 'INDIVIDUAL_CONSENT', current: null, history: [], notice_versions: { STUDENT: 'v4', TEACHER: 'v4' }, can_change: true },
      students: [{ ...base, student_id: 'a-1', name: 'Aluna Individual', decision: 'NONE', effective: false }],
      teachers: [],
    };
    render(<LessonRecordingConsentsPanel schoolName="Escola Fixture" />);
    expect(await screen.findByRole('button', { name: 'Gerar link' })).toBeInTheDocument();
    expect(screen.getByText('Sem resposta')).toBeInTheDocument();
    expect(screen.getByText('alunos autorizaram')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Passar a autorizar pela escola' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/inclusive os menores de idade/)).toBeInTheDocument();
  });
});
