import { describe, expect, it } from 'vitest';
import {
  addMonthsIso, isRenewalContext, renewalCatalogPrice, renewalError, renewalFeeCents,
  renewalFirstDueDate, renewalOfferStatus, renewalPreview, type RenewalContext, type RenewalOffer,
} from './studentRenewal';

const TODAY = '2026-11-06';

describe('prévia da renovação', () => {
  it('12 meses a partir do fim do período pago', () => {
    expect(renewalPreview('2027-02-17', 17, 12, 18700, TODAY)).toEqual({
      firstDue: '2027-02-17', lastDue: '2028-01-17', serviceEnd: '2028-02-17',
      firstMonth: '2027-02', lastMonth: '2028-01', totalCents: 224400,
    });
  });

  it('6 meses continuam com seis competências', () => {
    const preview = renewalPreview('2027-02-17', 17, 6, 18700, TODAY);
    expect(preview?.lastDue).toBe('2027-07-17');
    expect(preview?.totalCents).toBe(112200);
  });

  it('dia de vencimento antes do início passa para o mês seguinte', () => {
    expect(renewalFirstDueDate('2027-02-20', 17, TODAY)).toBe('2027-03-17');
    expect(renewalFirstDueDate('2027-02-10', 17, TODAY)).toBe('2027-02-17');
  });

  it('vencimento nunca fica antes de amanhã', () => {
    expect(renewalFirstDueDate('2026-11-01', 3, TODAY)).toBe('2026-11-07');
    expect(renewalFirstDueDate('2026-11-05', 6, TODAY)).toBe('2026-11-07');
  });

  it('recusa entrada que o servidor recusaria', () => {
    expect(renewalPreview('2027-02-17', 29, 12, 18700, TODAY)).toBeNull();
    expect(renewalPreview('2027-02-17', 17, 7, 18700, TODAY)).toBeNull();
    expect(renewalPreview('2027-02-17', 17, 12, null, TODAY)).toBeNull();
    expect(renewalPreview('17/02/2027', 17, 12, 18700, TODAY)).toBeNull();
  });

  it('virada de ano mantém o dia', () => {
    expect(addMonthsIso('2027-12-17', 1)).toBe('2028-01-17');
    expect(addMonthsIso('2027-02-17', 11)).toBe('2028-01-17');
  });
});

describe('valor digitado', () => {
  it('aceita vírgula, ponto e milhar', () => {
    expect(renewalFeeCents('187,00')).toBe(18700);
    expect(renewalFeeCents('187.5')).toBe(18750);
    expect(renewalFeeCents('1.234,50')).toBe(123450);
  });
  it('recusa texto solto, zero e mais de dois decimais', () => {
    expect(renewalFeeCents('187 reais')).toBeNull();
    expect(renewalFeeCents('0')).toBeNull();
    expect(renewalFeeCents('187,005')).toBeNull();
  });
});

const offer = (over: Partial<RenewalOffer>): RenewalOffer => ({
  id: 'o', status: 'SIGNED', billing_status: 'SYNCED', billing_strategy: 'UPFRONT_CHARGE', billing_type: 'PIX',
  term_months: 12, monthly_fee_cents: 18700, total_cents: 224400, classes_per_week: 3,
  contract_start: '2027-02-17', first_due_date: '2027-02-17', last_due_date: '2028-01-17', service_end_date: '2028-02-17',
  upfront_due_date: '2026-11-10', expires_at: '2026-12-06', signed_at: null, expired: false, billing_error: null,
  invoice_url: null, coverage_registered_at: null, token: null, notice_status: null, ...over,
});

describe('situação da renovação', () => {
  it('cobrança gerada não é pagamento', () => {
    expect(renewalOfferStatus(offer({})).label).toMatch(/aguardando o pagamento/);
  });
  it('só a cobertura diz que está pago', () => {
    expect(renewalOfferStatus(offer({ coverage_registered_at: '2026-11-10T12:00:00Z' })).tone).toBe('ok');
  });
  it('revisão aparece como problema', () => {
    expect(renewalOfferStatus(offer({ billing_status: 'REVIEW' })).tone).toBe('bad');
  });
  it('link vencido não finge que espera assinatura', () => {
    expect(renewalOfferStatus(offer({ status: 'PENDING_SIGNATURE', expired: true })).label).toBe('Link vencido');
  });
});

describe('leitura do servidor', () => {
  it('recusa resposta sem aluno ou período', () => {
    expect(isRenewalContext({ ok: false, error: 'sem_permissao' })).toBe(false);
    expect(isRenewalContext({ ok: true, student: { id: 'a' } })).toBe(false);
  });
  it('acha o catálogo pelo prazo e pela frequência', () => {
    const context = { catalog: [{ term_months: 12, classes_per_week: 3, monthly_price: 229 }] } as unknown as RenewalContext;
    expect(renewalCatalogPrice(context, 12, 3)).toBe(229);
    expect(renewalCatalogPrice(context, 6, 3)).toBeNull();
  });
  it('erro desconhecido não vira mensagem técnica', () => {
    expect(renewalError('xyz')).toMatch(/Não foi possível concluir/);
    expect(renewalError('periodo_ja_pago')).toMatch(/ainda está pago/);
  });
});
