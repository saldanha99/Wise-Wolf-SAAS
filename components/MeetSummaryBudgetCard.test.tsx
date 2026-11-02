import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

import MeetSummaryBudgetCard from './MeetSummaryBudgetCard';

const budget = (overrides: Record<string, unknown> = {}) => ({
  ok: true, month: '2026-09', cap_usd: 20, default_cap: true, spent_usd: 1.25, remaining_usd: 18.75,
  cap_reached: false, paused_until: null, pause_reason: null, automatic_count: 40, manual_count: 2, failed_count: 1,
  ...overrides,
});

beforeEach(() => rpc.mockReset());

describe('Teto mensal do resumo por IA (direção)', () => {
  it('mostra o gasto do mês e salva o teto novo', async () => {
    rpc.mockImplementation((name: string, args?: Record<string, unknown>) => Promise.resolve(name === 'get_meet_summary_budget'
      ? { data: budget(), error: null }
      : { data: budget({ cap_usd: Number(args?.p_cap_usd), default_cap: false }), error: null }));
    render(<MeetSummaryBudgetCard aiEnabled model="google/gemini-3.6-flash" />);
    await screen.findByText('Gasto em 2026-09: US$ 1.25 de US$ 20.00');
    expect(screen.getByText(/40 automático\(s\) · 2 manual\(is\) · 1 sem rascunho/)).toBeTruthy();
    expect(screen.getByText(/Padrão da plataforma: US\$ 20 por mês/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Teto mensal (US$)'), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar teto' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_meet_summary_monthly_cap', { p_cap_usd: 35 }));
    await screen.findByText('Teto mensal salvo.');
    expect(screen.getByText('Gasto em 2026-09: US$ 1.25 de US$ 35.00')).toBeTruthy();
  });

  it('teto atingido e pausa por configuração ficam visíveis', async () => {
    rpc.mockResolvedValue({ data: budget({ cap_reached: true, spent_usd: 20, paused_until: '2026-09-27T18:00:00Z',
      pause_reason: 'google_summary_provider_credits' }), error: null });
    render(<MeetSummaryBudgetCard aiEnabled />);
    await screen.findByTestId('summary-cap-reached');
    expect(screen.getByText(/a conta do OpenRouter está sem créditos/)).toBeTruthy();
  });

  it('teto fora do limite não vai ao servidor', async () => {
    rpc.mockResolvedValue({ data: budget(), error: null });
    render(<MeetSummaryBudgetCard aiEnabled={false} />);
    await screen.findByText(/desligado nesta instalação/);
    fireEvent.change(screen.getByLabelText('Teto mensal (US$)'), { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar teto' }));
    await screen.findByRole('alert');
    expect(rpc).not.toHaveBeenCalledWith('set_meet_summary_monthly_cap', expect.anything());
  });

  it('as sugestões do cartão aparecem dentro do mesmo teto (e somem quando não há nenhuma)', async () => {
    rpc.mockResolvedValue({ data: budget({ card_suggestion_count: 3, card_suggestion_spent_usd: 0.0123 }), error: null });
    const first = render(<MeetSummaryBudgetCard aiEnabled />);
    expect((await screen.findByTestId('summary-card-suggestions')).textContent)
      .toMatch(/Inclui US\$ 0\.01 de 3 leitura\(s\) de aula aprovada para sugerir o cartão do aluno/);
    first.unmount();
    rpc.mockResolvedValue({ data: budget(), error: null });
    render(<MeetSummaryBudgetCard aiEnabled />);
    await screen.findByText('Gasto em 2026-09: US$ 1.25 de US$ 20.00');
    expect(screen.queryByTestId('summary-card-suggestions')).toBeNull();
    // Sem leitura no mês, a tela não anuncia as sugestões do cartão.
    expect(screen.queryByText(/sugere itens para o cartão/)).toBeNull();
  });

  it('sugestões do cartão desligadas na instalação: dito como desligadas, não anunciadas', async () => {
    rpc.mockResolvedValue({ data: budget({ card_suggestions_pause_reason: 'card_suggestions_not_configured' }), error: null });
    render(<MeetSummaryBudgetCard aiEnabled />);
    expect((await screen.findByTestId('summary-card-suggestions-off')).textContent)
      .toMatch(/desligadas nesta instalação/);
    expect(screen.queryByTestId('summary-card-suggestions')).toBeNull();
  });
});
