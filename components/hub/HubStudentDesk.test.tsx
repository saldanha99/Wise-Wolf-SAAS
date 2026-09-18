import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubBootstrap } from './types';

const supabaseMocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../../lib/supabase', () => ({
  supabase: { rpc: supabaseMocks.rpc, from: supabaseMocks.from },
}));

import HubStudentDesk from './HubStudentDesk';
import HubLearnersPanel, { hubInviteUrl, hubInviteWhatsAppUrl } from './HubLearnersPanel';

const accountId = '11111111-1111-4111-8111-111111111111';
const bootstrap: HubBootstrap = {
  account: { id: accountId, name: 'Teacher Lu Studio', account_type: 'PERSONAL', audience: 'EDUCATOR', status: 'ACTIVE', metadata: {} },
  membership: { membership_role: 'MEMBER', status: 'ACTIVE' },
  memberProfile: { display_name: 'Aluno Pedro', subjectRole: 'LEARNER', onboarding_completed: true },
  subscription: { id: 'subscription-1', status: 'ACTIVE', trial_ends_at: null, current_period_ends_at: null },
  plan: null,
  entitlements: {},
  settings: { settings_key: 'default', brand_name: 'Wise Wolf', headline: 'Hub', subheadline: null, saas_video_url: null, saas_cta_url: '/hub', support_url: null, metadata: {} },
};

// O servidor já tirou o gabarito: nenhuma questão traz `correct`.
const deskPayload = {
  ok: true,
  learner: { id: 'learner-1', display_name: 'Pedro Alves', level_tag: 'A2', objective: 'Check-in no hotel', joined_at: '2026-09-18T10:00:00.000Z' },
  teacher_name: 'Teacher Lu',
  assignments: [
    {
      id: 'assign-journey', note: '', status: 'ASSIGNED', student_note: '', done_at: null, created_at: '2026-09-18T10:00:00.000Z',
      material: { id: 'mat-j', kind: 'journey', niche: 'TRAVEL', level_tag: 'A2', topic: 'Viagem', goal: 'Check-in no hotel', title: 'Sua jornada de viagem', created_at: '2026-09-18T10:00:00.000Z',
        material: { title: 'Sua jornada de viagem', promise_pt: 'No dia 90 você faz o check-in sozinho.', weeks: [{ week: 1, theme: 'At the airport', grammar_point: 'Verb to be', material_kind: 'worksheet', outcome_pt: 'Se apresenta.', class_plan_pt: ['Warm-up'], homework_pt: 'Grave um áudio.' }], milestones: [] } },
    },
    {
      id: 'assign-quiz', note: 'Faça até quinta', status: 'ASSIGNED', student_note: '', done_at: null, created_at: '2026-09-17T10:00:00.000Z',
      material: { id: 'mat-q', kind: 'quiz', niche: 'TRAVEL', level_tag: 'A2', topic: 'Hotel', goal: '', title: 'Hotel quiz', created_at: '2026-09-17T10:00:00.000Z',
        material: { title: 'Hotel quiz', instructions_pt: 'Escolha.', grammar_focus: { point: 'Can for requests', why_pt: 'Pedidos educados.', patterns: [{ en: 'Can I have the key?', pt: 'Pode me dar a chave?' }] }, questions: [{ prompt: 'Can I ___ my key?', options: ['have', 'has', 'having', 'to have'] }], ai_homework: [{ task_pt: 'Peça a chave para a IA.', prompt_en: 'Act as a receptionist.' }] } },
    },
  ],
};

describe('Mesa do aluno convidado', () => {
  beforeEach(() => { supabaseMocks.rpc.mockReset(); });

  it('mostra jornada e materiais do professor, abre na versão do aluno e marca como feito', async () => {
    supabaseMocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'hub_learner_desk') return { data: deskPayload, error: null };
      if (name === 'hub_complete_assignment') return { data: { ok: true }, error: null };
      return { data: null, error: null };
    });
    render(<HubStudentDesk bootstrap={bootstrap} />);

    expect(await screen.findByText('Olá, Pedro.')).toBeTruthy();
    expect(screen.getByText('Sua jornada de viagem')).toBeTruthy();
    expect(screen.getByText('Hotel quiz')).toBeTruthy();
    expect(screen.getByText('A fazer')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Hotel quiz/ }));
    expect(screen.getByText(/Recado de Teacher Lu: Faça até quinta/)).toBeTruthy();
    expect(screen.getByText('Can for requests')).toBeTruthy();
    expect(screen.getByText(/Act as a receptionist/)).toBeTruthy();
    // Sem gabarito e sem marcas de resposta certa na versão do aluno.
    expect(screen.queryAllByLabelText('resposta correta')).toHaveLength(0);
    expect(screen.getByText(/versão do aluno/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/fiz tudo, travei/), { target: { value: 'Travei na 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como feito' }));
    await waitFor(() => expect(supabaseMocks.rpc).toHaveBeenCalledWith('hub_complete_assignment', { p_assignment_id: 'assign-quiz', p_note: 'Travei na 1' }));
  });

  it('sem professor ligado, explica em vez de quebrar', async () => {
    supabaseMocks.rpc.mockResolvedValue({ data: { ok: false, code: 'NOT_A_LEARNER_HERE' }, error: null });
    render(<HubStudentDesk bootstrap={bootstrap} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('ainda não está ligada a um professor');
  });
});

describe('Painel Meus alunos do professor', () => {
  const teacherBootstrap: HubBootstrap = { ...bootstrap, membership: { membership_role: 'OWNER', status: 'ACTIVE' }, memberProfile: { display_name: 'Teacher Lu', subjectRole: 'EDUCATOR', onboarding_completed: true } };
  const fromChain = () => {
    const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), order: vi.fn(() => chain), limit: vi.fn(async () => ({ data: [{ id: 'mat-q', title: 'Hotel quiz', kind: 'quiz', level_tag: 'A2' }], error: null })) };
    return chain;
  };

  beforeEach(() => { supabaseMocks.rpc.mockReset(); supabaseMocks.from.mockReset(); supabaseMocks.from.mockImplementation(fromChain); });

  it('lista assentos, gera o link de convite e envia material para quem já entrou', async () => {
    const seats = [
      { id: 'learner-1', display_name: 'Pedro Alves', level_tag: 'A2', objective: 'Hotel', seat: 'NONE', invite_token: null, invite_expires_at: null, joined_at: null, assignments: [] },
      { id: 'learner-2', display_name: 'Ana Lima', level_tag: 'B1', objective: 'Reuniões', seat: 'ACTIVE', invite_token: null, invite_expires_at: null, joined_at: '2026-09-18T10:00:00.000Z', assignments: [{ id: 'a1', material_id: 'mat-q', title: 'Hotel quiz', kind: 'quiz', status: 'DONE', note: '', student_note: 'Fácil', done_at: '2026-09-18T12:00:00.000Z', created_at: '2026-09-17T10:00:00.000Z' }] },
    ];
    const token = 'a'.repeat(64);
    let invited = false;
    supabaseMocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'hub_list_learner_seats') {
        return { data: invited ? [{ ...seats[0], seat: 'INVITED', invite_token: token, invite_expires_at: '2026-10-02T00:00:00.000Z' }, seats[1]] : seats, error: null };
      }
      if (name === 'hub_learner_seats') return { data: { used: invited ? 2 : 1, limit: 8 }, error: null };
      if (name === 'hub_invite_learner') { invited = true; expect(args).toMatchObject({ p_account_id: accountId, p_learner_id: 'learner-1' }); return { data: { ok: true, token }, error: null }; }
      if (name === 'hub_assign_material') return { data: { ok: true, assignment_id: 'a2' }, error: null };
      return { data: null, error: null };
    });
    render(<HubLearnersPanel bootstrap={teacherBootstrap} />);

    expect(await screen.findByText('Pedro Alves')).toBeTruthy();
    expect(screen.getByTestId('hub-seats-usage').textContent).toContain('1 de 8 assentos');
    expect(screen.getByText('Dentro da plataforma')).toBeTruthy();
    expect(screen.getByText(/Feito em .* · “Fácil”/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Gerar link de convite' }));
    expect(await screen.findByText('Convite enviado')).toBeTruthy();
    const whatsapp = screen.getByRole('link', { name: 'Mandar pelo WhatsApp' }) as HTMLAnchorElement;
    expect(whatsapp.href).toContain(encodeURIComponent(hubInviteUrl(token)));
    expect(screen.getByTestId('hub-seats-usage').textContent).toContain('2 de 8 assentos');
  });

  it('monta o link do convite no host público do Hub', () => {
    const token = 'b'.repeat(64);
    expect(hubInviteUrl(token)).toBe(`https://hub.wisewolflanguage.com.br/?convite=${token}`);
    expect(hubInviteWhatsAppUrl('Pedro Alves', 'Teacher Lu', token)).toContain('https://wa.me/?text=');
    expect(decodeURIComponent(hubInviteWhatsAppUrl('Pedro Alves', 'Teacher Lu', token))).toContain('Oi, Pedro!');
  });
});
