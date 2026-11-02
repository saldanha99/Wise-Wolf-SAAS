import { describe, expect, it } from 'vitest';
import { budgetPercent, draftApprovableUntil, formatUsd, generationErrorText, originLabel, pauseReasonText, reviewDeadline, waitingText } from './meetSummary';

const NOW = Date.parse('2026-09-27T15:00:00Z');

describe('fila "Aulas para revisar"', () => {
  it('conta a espera em dias inteiros', () => {
    expect(waitingText('2026-09-27T10:00:00Z', NOW)).toBe('Esperando desde hoje');
    expect(waitingText('2026-09-26T10:00:00Z', NOW)).toBe('Esperando há 1 dia');
    expect(waitingText('2026-09-23T10:00:00Z', NOW)).toBe('Esperando há 4 dias');
    expect(waitingText(null, NOW)).toBe('Esperando revisão');
  });

  it('o prazo de aprovação fica urgente na última semana', () => {
    expect(reviewDeadline('2026-12-20T15:00:00Z', NOW)).toEqual({ text: 'Aprovar até 20/12/2026', urgent: false });
    expect(reviewDeadline('2026-10-01T15:00:00Z', NOW)).toEqual({ text: 'Aprovar até 01/10/2026 (faltam 4 dias)', urgent: true });
    expect(reviewDeadline('2026-09-28T10:00:00Z', NOW)).toEqual({ text: 'Aprovar até 28/09/2026 (último dia)', urgent: true });
    expect(reviewDeadline(null, NOW).urgent).toBe(false);
  });

  it('a validade do rascunho é a da fonte que vence primeiro', () => {
    expect(draftApprovableUntil(['a', 'b', 'sumiu'], [
      { id: 'a', expires_at: '2026-12-25T00:00:00Z' },
      { id: 'b', expires_at: '2026-12-20T00:00:00Z' },
    ])).toBe('2026-12-20T00:00:00Z');
    expect(draftApprovableUntil([], [])).toBeNull();
  });

  it('origem do rascunho em português', () => {
    expect(originLabel('GEMINI_API')).toBe('Rascunho da IA');
    expect(originLabel('GOOGLE_SMART_NOTES')).toBe('Notas do Gemini');
  });
});

describe('teto mensal de IA', () => {
  it('percentual do teto e valores em dólar', () => {
    expect(budgetPercent(5, 20)).toBe(25);
    expect(budgetPercent(25, 20)).toBe(100);
    expect(budgetPercent(0, 0)).toBe(100);
    expect(formatUsd(3.456)).toBe('US$ 3.46');
  });

  it('motivos de pausa e falha nunca aparecem como código cru', () => {
    expect(pauseReasonText('google_summary_provider_credits')).toMatch(/sem créditos/);
    expect(pauseReasonText('qualquer_coisa')).not.toMatch(/_/);
    expect(generationErrorText('invalid_summary_evidence')).toMatch(/citação/);
    expect(generationErrorText(null)).toBe('falha na geração');
  });
});
