import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubBootstrap } from './types';

const supabaseMocks = vi.hoisted(() => ({ from: vi.fn(), invoke: vi.fn() }));
vi.mock('../../lib/supabase', () => ({
  supabase: { from: supabaseMocks.from, functions: { invoke: supabaseMocks.invoke } },
}));

import HubToolsCatalog, { filterHubTools } from './HubToolsCatalog';
import HubCefrChecker from './HubCefrChecker';
import HubAuthenticAdapter from './HubAuthenticAdapter';
import { HubMaterialView, materialAsText, type HubMaterialRecord } from './HubMaterialGenerator';
import { HUB_TOOLS } from '../../supabase/functions/_shared/hub-tools';
import { HUB_FASE2_TOUR_STEPS } from './hubFeatureTour';

const accountId = '11111111-1111-4111-8111-111111111111';
const bootstrap = (entitlements: HubBootstrap['entitlements']): HubBootstrap => ({
  account: { id: accountId, name: 'Teacher Lu', account_type: 'PERSONAL', audience: 'EDUCATOR', status: 'ACTIVE', metadata: {} },
  membership: { membership_role: 'OWNER', status: 'ACTIVE' },
  subscription: { id: 'subscription-1', status: 'ACTIVE', trial_ends_at: null, current_period_ends_at: null },
  plan: null,
  entitlements,
  settings: { settings_key: 'default', brand_name: 'Wise Wolf', headline: 'Hub', subheadline: null, saas_video_url: null, saas_cta_url: '/hub', support_url: null, metadata: {} },
} as HubBootstrap);

const record = (kind: string, material: Record<string, unknown>): HubMaterialRecord => ({
  id: 'm1', kind: kind as HubMaterialRecord['kind'], niche: 'TRAVEL', level_tag: 'A2', topic: 'Hotel', title: 'Hotel', created_at: '2026-11-23T12:00:00Z', dropped_items: 0, material,
});

beforeEach(() => {
  supabaseMocks.from.mockReset();
  supabaseMocks.invoke.mockReset();
});

describe('catálogo de ferramentas', () => {
  it('filtra por habilidade e por nome sem acento', () => {
    expect(filterHubTools('all', '').length).toBe(HUB_TOOLS.length);
    expect(filterHubTools('speaking', '').every((tool) => tool.skill === 'speaking')).toBe(true);
    expect(filterHubTools('all', 'redacao').map((tool) => tool.id)).toContain('writing-prompt');
  });

  it('abre a ferramenta, manda só o id (o preset fica no servidor) e mostra o resultado', async () => {
    const onRefresh = vi.fn(async () => {});
    supabaseMocks.invoke.mockResolvedValue({
      data: {
        material_id: 'abc', title: 'Hotel words', topic: 'Hotel', created_at: '2026-11-23T12:00:00Z', dropped: 0,
        material: { title: 'Hotel words', left_items: ['lobby', 'suite'], right_items: ['a big room', 'the entrance hall'], answer_key: [1, 0], grammar_focus: { point: 'There is', patterns: [{ en: 'There is a gym.', pt: 'Há uma academia.' }] } },
      },
      error: null,
    });
    render(<HubToolsCatalog bootstrap={bootstrap({ 'educator_ai.generate': { limit: 100, resetPeriod: 'MONTH', used: 1 } })} onRefresh={onRefresh} onUpgrade={vi.fn()} />);
    expect(screen.getByText('99 de 100 gerações restantes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Associação palavra–definição/ }));
    fireEvent.change(screen.getByPlaceholderText('Ex.: verbos de escritório'), { target: { value: 'Hotel' } });
    fireEvent.change(screen.getByPlaceholderText(/booking, check-in/), { target: { value: 'lobby, suite' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }));
    await waitFor(() => expect(screen.getByText('Hotel words', { selector: 'h2' })).toBeTruthy());
    const body = supabaseMocks.invoke.mock.calls[0][1].body;
    expect(body).toMatchObject({ hubMode: true, action: 'material', toolId: 'vocab-matching', kind: 'matching', targetWords: 'lobby, suite', accountId });
    expect(body).not.toHaveProperty('preset');
    expect(body).not.toHaveProperty('sourceText');
    expect(onRefresh).toHaveBeenCalled();
    // Professor vê o gabarito (letra do par); aluno não.
    expect(screen.getAllByText(/→ B/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Ver versão do aluno/ }));
    expect(screen.queryByText(/→ B/)).toBeNull();
  });

  it('ferramenta que exige texto não chama a IA com texto curto', async () => {
    render(<HubToolsCatalog bootstrap={bootstrap({ 'educator_ai.generate': { limit: null, resetPeriod: 'MONTH', used: 0 } })} onRefresh={vi.fn(async () => {})} onUpgrade={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Perguntas sobre um texto seu/ }));
    fireEvent.change(screen.getByPlaceholderText(/notícia sobre trabalho remoto/), { target: { value: 'News' } });
    fireEvent.change(screen.getByPlaceholderText(/Cole aqui o texto/), { target: { value: 'Too short.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/30 palavras/);
    expect(supabaseMocks.invoke).not.toHaveBeenCalled();
  });

  it('sem cota mostra o bloqueio', () => {
    render(<HubToolsCatalog bootstrap={bootstrap({ 'educator_ai.generate': { limit: 0, resetPeriod: 'MONTH', used: 0 } })} onRefresh={vi.fn(async () => {})} onUpgrade={vi.fn()} />);
    expect(screen.getByText(/não incluídas neste plano/)).toBeTruthy();
  });
});

describe('tipos novos na tela e no texto', () => {
  it('versão do aluno não mostra resposta de lacunas, V/F, correção, transformação nem texto-modelo', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['gap_fill', { word_bank: ['gym', 'key'], gaps: [{ prompt: 'My ___, please.', answer: 'key', explanation_pt: 'chave' }] }, 'chave'],
      ['true_false', { text: 'Maria works.', statements: [{ statement: 'Maria works.', correct: true, explanation_pt: 'Está no texto' }] }, 'Está no texto'],
      ['error_correction', { sentences: [{ sentence: 'She work.', answer: 'She works now.', explanation_pt: '-s' }] }, 'She works now.'],
      ['sentence_transformation', { items: [{ original: 'They clean it.', instruction: 'Passive', answer: 'It is cleaned.', explanation_pt: '' }] }, 'It is cleaned.'],
      ['writing_prompt', { task: 'Write an email.', rubric: [{ criterion_pt: 'Tarefa', descriptor_pt: 'ok' }], model_answer: 'Dear Ana, model.', word_count: 80 }, 'Dear Ana, model.'],
    ];
    for (const [kind, material, secret] of cases) {
      const { unmount } = render(<HubMaterialView record={record(kind, material)} teacher={false} />);
      expect(screen.queryByText(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeNull();
      unmount();
      const teacherView = render(<HubMaterialView record={record(kind, material)} teacher />);
      expect(within(teacherView.container).getAllByText(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThan(0);
      teacherView.unmount();
    }
  });

  it('texto copiado leva gabarito e a fonte do material adaptado', () => {
    const text = materialAsText(record('true_false', {
      text: 'Maria works.', statements: [{ statement: 'A', correct: true }, { statement: 'B', correct: false }],
      source: { type: 'url', url: 'https://example.com/news', title: 'News' },
    }));
    expect(text).toContain('Gabarito: 1-T · 2-F');
    expect(text).toContain('Fonte: https://example.com/news');
  });
});

describe('verificador CEFR', () => {
  it('mostra o nível, os trechos e a versão simplificada', async () => {
    supabaseMocks.invoke.mockResolvedValue({
      data: {
        metrics: { words: 30, sentences: 2, avg_words_per_sentence: 15, long_words_pct: 20, metrics_band: 'B1-B2' },
        result: { estimated_level: 'B2', confidence: 'high', summary_pt: 'Bom para B2.', reasons_pt: ['Voz passiva'], above_level: [{ excerpt: 'notwithstanding', issue_pt: 'formal', suggestion: 'even so' }], simplified_text: 'This is the easy text.', glossary: [], target_level: 'A2', above_target: true },
      },
      error: null,
    });
    render(<HubCefrChecker bootstrap={bootstrap({ 'educator_ai.cefr_check': { limit: 150, resetPeriod: 'MONTH', used: 0 } })} onRefresh={vi.fn(async () => {})} onUpgrade={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Cole aqui o texto/), { target: { value: 'word '.repeat(20) } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'A2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verificar nível' }));
    expect((await screen.findByTestId('cefr-level')).textContent).toBe('B2');
    expect(screen.getByText('This is the easy text.')).toBeTruthy();
    expect(screen.getByText(/Acima do A2/)).toBeTruthy();
    expect(supabaseMocks.invoke.mock.calls[0][1].body).toMatchObject({ action: 'cefr_check', targetLevel: 'A2', accountId });
  });

  it('erro de cota vira mensagem em português', async () => {
    supabaseMocks.invoke.mockResolvedValue({ data: { code: 'USAGE_LIMIT_REACHED' }, error: null });
    render(<HubCefrChecker bootstrap={bootstrap({ 'educator_ai.cefr_check': { limit: 10, resetPeriod: 'MONTH', used: 2 } })} onRefresh={vi.fn(async () => {})} onUpgrade={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Cole aqui o texto/), { target: { value: 'word '.repeat(20) } });
    fireEvent.click(screen.getByRole('button', { name: 'Verificar nível' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/cota desta ferramenta/);
  });
});

describe('adaptação de material', () => {
  it('link inválido não chama a IA; link válido manda sourceType url', async () => {
    supabaseMocks.invoke.mockResolvedValue({ data: { code: 'URL_NO_READABLE_TEXT' }, error: null });
    render(<HubAuthenticAdapter bootstrap={bootstrap({ 'educator_ai.adapt': { limit: 20, resetPeriod: 'MONTH', used: 0 } })} onRefresh={vi.fn(async () => {})} onUpgrade={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Link/ }));
    fireEvent.change(screen.getByLabelText('Link da página'), { target: { value: 'ftp://x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adaptar' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/não é válido/);
    expect(supabaseMocks.invoke).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Link da página'), { target: { value: 'https://example.com/news' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adaptar' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/login/));
    expect(supabaseMocks.invoke.mock.calls[0][1].body).toMatchObject({ action: 'adapt_authentic', sourceType: 'url', url: 'https://example.com/news', kind: 'reading' });
  });
});

describe('tour da fase 2', () => {
  it('cada passo aponta para um data-tour que existe nas telas novas', async () => {
    const fs = await import('node:fs');
    const code = ['HubPortal.tsx', 'HubToolsCatalog.tsx', 'HubCefrChecker.tsx', 'HubAuthenticAdapter.tsx']
      .map((file) => fs.readFileSync(`components/hub/${file}`, 'utf8')).join('\n');
    for (const step of HUB_FASE2_TOUR_STEPS) {
      expect(code).toContain(`data-tour="${step.target}"`);
    }
  });
});
