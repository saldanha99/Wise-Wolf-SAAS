import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubBootstrap } from './types';

const supabaseMocks = vi.hoisted(() => ({
  from: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: supabaseMocks.from,
    functions: { invoke: supabaseMocks.invoke },
  },
}));

import HubMaterialGenerator, { type HubMaterialRecord, materialAsText } from './HubMaterialGenerator';

const accountId = '11111111-1111-4111-8111-111111111111';

const bootstrap = (limit: number | null = 40, used = 3): HubBootstrap => ({
  account: { id: accountId, name: 'Teacher Lu', account_type: 'PERSONAL', audience: 'EDUCATOR', status: 'ACTIVE', metadata: {} },
  membership: { membership_role: 'OWNER', status: 'ACTIVE' },
  subscription: { id: 'subscription-1', status: 'ACTIVE', trial_ends_at: null, current_period_ends_at: null },
  plan: null,
  entitlements: { 'educator_ai.generate': { limit, resetPeriod: 'MONTH', used } },
  settings: { settings_key: 'default', brand_name: 'Wise Wolf', headline: 'Hub', subheadline: null, saas_video_url: null, saas_cta_url: '/hub', support_url: null, metadata: {} },
});

const quizMaterial = {
  title: 'Daily stand-up quiz',
  instructions_pt: 'Escolha a alternativa correta.',
  questions: [
    { prompt: 'We ___ a stand-up every morning.', options: ['have', 'has', 'having', 'haves'], correct: 0, explanation_pt: "Sujeito 'we' pede 'have'." },
    { prompt: 'She ___ the blocker yesterday.', options: ['fix', 'fixed', 'fixes', 'fixing'], correct: 1, explanation_pt: 'Passado simples.' },
    { prompt: 'Any ___?', options: ['blockers', 'blocker', 'blocking', 'blocked'], correct: 0, explanation_pt: 'Plural.' },
  ],
};

// Cadeia `from(...).select().eq().order().limit()` do histórico e o `delete().eq()`.
const historyChain = (rows: unknown[]) => {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(async () => ({ data: rows, error: null })),
    delete: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
  };
  return chain;
};

describe('Gerador de material do Hub', () => {
  beforeEach(() => {
    supabaseMocks.from.mockReset();
    supabaseMocks.invoke.mockReset();
  });

  it('gera pelo gateway do Hub com tipo, nicho, nível e tema, e mostra o gabarito na versão do professor', async () => {
    supabaseMocks.from.mockImplementation(() => historyChain([]));
    supabaseMocks.invoke.mockResolvedValue({
      data: { material_id: 'mat-1', title: quizMaterial.title, kind: 'quiz', niche: 'TECH', level: 'B1', topic: 'Daily stand-up', material: quizMaterial, dropped: 1, created_at: '2026-09-18T12:00:00.000Z' },
      error: null,
    });
    const onRefresh = vi.fn(async () => {});

    render(<HubMaterialGenerator bootstrap={bootstrap()} onRefresh={onRefresh} onUpgrade={vi.fn()} />);

    expect(screen.getByTestId('hub-material-quota').textContent).toContain('37 de 40');
    fireEvent.click(screen.getByRole('button', { name: /^Quiz/ }));
    fireEvent.change(screen.getByLabelText('Nicho'), { target: { value: 'TECH' } });
    fireEvent.change(screen.getByLabelText('Nível CEFR'), { target: { value: 'B1' } });
    fireEvent.change(screen.getByLabelText('Tema / situação do aluno'), { target: { value: 'Daily stand-up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar material' }));

    await waitFor(() => expect(supabaseMocks.invoke).toHaveBeenCalledTimes(1));
    const [functionName, options] = supabaseMocks.invoke.mock.calls[0];
    expect(functionName).toBe('pedagogical-content');
    expect(options.body).toMatchObject({ hubMode: true, action: 'material', accountId, kind: 'quiz', niche: 'TECH', level: 'B1', topic: 'Daily stand-up', count: 8, bilingual: true });
    expect(typeof options.body.requestKey).toBe('string');

    expect(await screen.findByText('Daily stand-up quiz')).toBeTruthy();
    // Versão do professor: a alternativa correta é marcada e a explicação aparece.
    expect(screen.getAllByLabelText('resposta correta')).toHaveLength(3);
    expect(screen.getByText("Sujeito 'we' pede 'have'.")).toBeTruthy();
    expect(screen.getByText(/1 questão foi descartada/)).toBeTruthy();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Versão do aluno: sem gabarito.
    fireEvent.click(screen.getByRole('button', { name: 'Ver versão do aluno' }));
    expect(screen.queryAllByLabelText('resposta correta')).toHaveLength(0);
    expect(screen.queryByText("Sujeito 'we' pede 'have'.")).toBeNull();
  });

  it('traduz o limite atingido e não deixa o erro de cota virar mensagem genérica', async () => {
    supabaseMocks.from.mockImplementation(() => historyChain([]));
    supabaseMocks.invoke.mockResolvedValue({ data: { error: 'USAGE_LIMIT_REACHED', code: 'USAGE_LIMIT_REACHED' }, error: null });

    render(<HubMaterialGenerator bootstrap={bootstrap(40, 39)} onRefresh={vi.fn(async () => {})} onUpgrade={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Tema / situação do aluno'), { target: { value: 'Airport check-in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar material' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('todas as gerações do seu plano');
  });

  it('plano sem gerações (Essencial) vê o bloqueio com o caminho para o Pro, não o formulário', () => {
    supabaseMocks.from.mockImplementation(() => historyChain([]));
    const onUpgrade = vi.fn();
    render(<HubMaterialGenerator bootstrap={bootstrap(0, 0)} onRefresh={vi.fn(async () => {})} onUpgrade={onUpgrade} />);

    expect(screen.getByText('Gerador de material não incluído neste plano')).toBeTruthy();
    expect(screen.queryByLabelText('Tema / situação do aluno')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver planos com Educador IA' }));
    expect(onUpgrade).toHaveBeenCalled();
  });

  it('reabre um material do histórico da conta', async () => {
    supabaseMocks.from.mockImplementation(() => historyChain([
      { id: 'mat-9', kind: 'quiz', niche: 'TRAVEL', level_tag: 'A2', topic: 'Hotel check-in', title: 'Hotel check-in quiz', created_at: '2026-09-17T10:00:00.000Z', dropped_items: 0, material: quizMaterial },
    ]));
    render(<HubMaterialGenerator bootstrap={bootstrap()} onRefresh={vi.fn(async () => {})} onUpgrade={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /^Hotel check-in quiz/ }));
    expect(screen.getByRole('heading', { level: 2, name: 'Hotel check-in quiz' })).toBeTruthy();
    expect(screen.getByText(/Tema: Hotel check-in/)).toBeTruthy();
  });

  it('texto copiável carrega as questões e o gabarito', () => {
    const record: HubMaterialRecord = { id: 'mat-1', kind: 'quiz', niche: 'TECH', level_tag: 'B1', topic: 'Daily stand-up', title: 'Daily stand-up quiz', created_at: '2026-09-18T12:00:00.000Z', dropped_items: 0, material: quizMaterial };
    const text = materialAsText(record);
    expect(text).toContain('1. We ___ a stand-up every morning.');
    expect(text).toContain('A) have');
    expect(text).toContain('Gabarito: 1-A · 2-B · 3-A');
    expect(text).toContain('Wise Wolf Hub');
  });
});
