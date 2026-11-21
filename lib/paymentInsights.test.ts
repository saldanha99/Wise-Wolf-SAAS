import { describe, expect, it } from 'vitest';
import { billingLabel, dueHint, paymentBucket, paymentViewSignals, summarizePayments } from './paymentInsights';

describe('summarizePayments', () => {
  const payments = [
    { status: 'RECEIVED', value: 198, due_date: '2026-11-05' },
    { status: 'RECEIVED_IN_CASH', value: '100', due_date: '2026-11-06' },
    { status: 'CONFIRMED', value: 198, due_date: '2026-11-10' },
    { status: 'PENDING', value: 169, due_date: '2026-11-04' },
    { status: 'PENDING', value: 389, due_date: '2026-11-30' },
    { status: 'OVERDUE', value: 198, due_date: '2026-10-30' },
    { status: 'CANCELLED', value: 500, due_date: '2026-11-01' },
  ];
  const s = summarizePayments(payments, '2026-11-01');

  it('cancelada fica fora do previsto', () => {
    expect(s.expected).toEqual({ count: 6, total: 1252 });
    expect(s.byBucket.CANCELLED.total).toBe(500);
  });

  it('cartão confirmado não conta como recebido', () => {
    expect(s.byBucket.SETTLED.total).toBe(298);
    expect(s.byBucket.CONFIRMED.total).toBe(198);
    expect(s.settledPct).toBe(24);
  });

  it('separa o que vence nos próximos 7 dias', () => {
    expect(s.dueThisWeek).toEqual({ count: 1, total: 169 });
  });

  it('mês sem cobrança não divide por zero', () => {
    expect(summarizePayments([], '2026-11-01').settledPct).toBe(0);
  });
});

describe('dueHint', () => {
  it('fala o prazo de quem ainda deve', () => {
    expect(dueHint('PENDING', '2026-11-01', '2026-11-01')).toBe('vence hoje');
    expect(dueHint('PENDING', '2026-11-02', '2026-11-01')).toBe('vence amanhã');
    expect(dueHint('PENDING', '2026-11-30', '2026-11-01')).toBe('vence em 29 dias');
    expect(dueHint('OVERDUE', '2026-10-31', '2026-11-01')).toBe('atrasada há 1 dia');
    expect(dueHint('OVERDUE', '2026-10-27', '2026-11-01')).toBe('atrasada há 5 dias');
  });

  it('pago e cancelado não ganham prazo', () => {
    expect(dueHint('RECEIVED', '2026-10-27', '2026-11-01')).toBeNull();
    expect(dueHint('CANCELLED', '2026-10-27', '2026-11-01')).toBeNull();
  });
});

describe('paymentBucket e billingLabel', () => {
  it('classifica status e traduz a forma de pagamento', () => {
    expect(paymentBucket('received_in_cash')).toBe('SETTLED');
    expect(paymentBucket('REFUNDED')).toBe('OTHER');
    expect(billingLabel('CREDIT_CARD')).toBe('Cartão');
    expect(billingLabel(null)).toBe('A definir');
  });
});

describe('paymentViewSignals', () => {
  it('mostra a visualização do Asaas no horário de Brasília', () => {
    expect(paymentViewSignals({ provider_viewed_at: '2026-11-21T17:05:00Z' })).toEqual(['Visualizada em 21/11 14:05']);
  });

  it('abertura de e-mail é provável e o clique tem prioridade', () => {
    expect(paymentViewSignals({ email_opened_at: '2026-11-21T12:00:00Z' })).toEqual(['E-mail aberto (provável) em 21/11 09:00']);
    expect(paymentViewSignals({ email_opened_at: '2026-11-21T12:00:00Z', email_clicked_at: '2026-11-21T12:01:00Z' }))
      .toEqual(['Link do e-mail aberto em 21/11 09:01']);
  });

  it('sem sinal não mostra nada', () => {
    expect(paymentViewSignals({})).toEqual([]);
    expect(paymentViewSignals({ provider_viewed_at: 'lixo' })).toEqual([]);
  });
});
