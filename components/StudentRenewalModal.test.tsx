import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StudentRenewalModal from './StudentRenewalModal';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const baseContext = {
  ok: true,
  student: {
    id: 's-1', full_name: 'Aluno Sintetico', lifecycle_status: 'active', monthly_fee: 187, class_frequency: null,
    due_day: 17, contract_accepted: false, has_asaas_customer: false, subscription_status: null,
    subscription_end_date: null, weekly_lessons: 3,
  },
  period: { current_end: '2027-02-17', source: 'PAID_THROUGH', suggested_start: '2027-02-17' },
  catalog: [{ term_months: 12, classes_per_week: 3, monthly_price: 229 }],
  offers: [],
};

const mockRpc = (context: unknown, create: unknown = { ok: true, token: 'a'.repeat(64), link_sent: true }) => {
  rpc.mockImplementation((name: string) => Promise.resolve({
    data: name === 'get_student_renewal_context' ? context : create,
    error: null,
  }));
};

const generate = () => screen.getByRole('button', { name: /Gerar renovação/ });
const confirm = () => screen.getByRole('checkbox', { name: /Conferi prazo/ });

beforeEach(() => { rpc.mockReset(); });

describe('StudentRenewalModal', () => {
  it('abre com o período, o valor e o aviso de preço fora do catálogo', async () => {
    mockRpc(baseContext);
    render(<StudentRenewalModal studentId="s-1" onClose={() => undefined} />);
    expect(await screen.findByText('Aluno Sintetico')).toBeInTheDocument();
    expect(screen.getByText(/até 17\/02\/2027/)).toBeInTheDocument();
    expect(screen.getByText(/229,00/)).toBeInTheDocument();
    expect(screen.getByText(/12 × R\$\s187,00 = R\$\s2\.244,00/)).toBeInTheDocument();
    expect(screen.getByText(/Meses cobertos: 02\/2027 a 01\/2028/)).toBeInTheDocument();
    expect(screen.getByText(/A cobrança só é criada depois da assinatura/)).toBeInTheDocument();
  });

  it('parcelado fica indisponível para quem não tem cadastro no Asaas', async () => {
    mockRpc(baseContext);
    render(<StudentRenewalModal studentId="s-1" onClose={() => undefined} />);
    expect(await screen.findByRole('radio', { name: /Parcelado/ })).toBeDisabled();
  });

  it('sem documento e sem motivo do preço não dá para gerar', async () => {
    mockRpc(baseContext);
    render(<StudentRenewalModal studentId="s-1" onClose={() => undefined} />);
    await screen.findByText('Aluno Sintetico');
    expect(confirm()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Documento prorrogado/), { target: { value: 'Contrato em PDF de 2026' } });
    expect(confirm()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Quem autorizou este valor/), { target: { value: 'Direção manteve o valor' } });
    expect(confirm()).not.toBeDisabled();
    expect(generate()).toBeDisabled();
    fireEvent.click(confirm());
    expect(generate()).not.toBeDisabled();
  });

  it('manda ao servidor as condições conferidas e mostra o link', async () => {
    mockRpc(baseContext);
    render(<StudentRenewalModal studentId="s-1" onClose={() => undefined} />);
    await screen.findByText('Aluno Sintetico');
    fireEvent.change(screen.getByLabelText(/Documento prorrogado/), { target: { value: 'Contrato em PDF de 2026' } });
    fireEvent.change(screen.getByLabelText(/Quem autorizou este valor/), { target: { value: 'Direção manteve o valor' } });
    fireEvent.click(confirm());
    fireEvent.click(generate());
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('create_student_renewal_offer', expect.objectContaining({
      p_student: 's-1', p_term_months: 12, p_monthly_fee: 187, p_classes_per_week: 3, p_due_day: 17,
      p_contract_start: '2027-02-17', p_payment_plan: 'UPFRONT_CHARGE', p_billing_type: 'PIX',
      p_contract_reference: 'Contrato em PDF de 2026', p_send_link: true,
    })));
    expect(await screen.findByText('Renovação criada')).toBeInTheDocument();
    expect((screen.getByLabelText('Link da renovação') as HTMLInputElement).value).toContain('/renovar-curso?token=aaaa');
  });

  it('recebido por fora exige data e comprovante e não pede forma de cobrança', async () => {
    mockRpc({ ...baseContext, student: { ...baseContext.student, contract_accepted: true } });
    render(<StudentRenewalModal studentId="s-1" onClose={() => undefined} />);
    await screen.findByText('Aluno Sintetico');
    fireEvent.click(screen.getByRole('radio', { name: /já recebido por fora/ }));
    expect(screen.queryByLabelText(/Cobrar por/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Quem autorizou este valor/), { target: { value: 'Direção manteve o valor' } });
    expect(confirm()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Data do recebimento/), { target: { value: '2026-11-05' } });
    fireEvent.change(screen.getByLabelText(/Referência do comprovante/), { target: { value: 'Pix de 05/11' } });
    expect(confirm()).not.toBeDisabled();
    expect(screen.getByText(/não vai para o caixa nem para o rateio/)).toBeInTheDocument();
  });

  it('erro do servidor aparece em português e não fecha o formulário', async () => {
    mockRpc({ ...baseContext, student: { ...baseContext.student, contract_accepted: true, monthly_fee: 229 } }, { ok: false, error: 'periodo_ja_pago' });
    render(<StudentRenewalModal studentId="s-1" onClose={() => undefined} />);
    await screen.findByText('Aluno Sintetico');
    fireEvent.click(confirm());
    fireEvent.click(generate());
    expect(await screen.findByRole('alert')).toHaveTextContent(/ainda está pago/);
    expect(generate()).toBeInTheDocument();
  });

  it('com renovação aberta não oferece outra, mostra o link e deixa cancelar', async () => {
    const pending = {
      id: 'o-1', status: 'PENDING_SIGNATURE', billing_status: 'NOT_AUTHORIZED', billing_strategy: 'UPFRONT_CHARGE', billing_type: 'PIX',
      term_months: 12, monthly_fee_cents: 18700, total_cents: 224400, classes_per_week: 3, contract_start: '2027-02-17',
      first_due_date: '2027-02-17', last_due_date: '2028-01-17', service_end_date: '2028-02-17', upfront_due_date: '2026-11-10',
      expires_at: '2026-12-06', signed_at: null, expired: false, billing_error: null, invoice_url: null,
      coverage_registered_at: null, token: 'b'.repeat(64), notice_status: 'PENDING',
    };
    mockRpc({ ...baseContext, offers: [pending] }, { ok: true });
    render(<StudentRenewalModal studentId="s-1" onClose={() => undefined} />);
    expect(await screen.findByText(/Aguardando a assinatura do aluno/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Gerar renovação/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    const reason = screen.getByLabelText(/Motivo do cancelamento/);
    expect(screen.getByRole('button', { name: 'Cancelar renovação' })).toBeDisabled();
    fireEvent.change(reason, { target: { value: 'Condição combinada mudou' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar renovação' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('cancel_student_renewal_offer', { p_offer: 'o-1', p_reason: 'Condição combinada mudou' }));
  });

  it('cobrança em revisão oferece nova tentativa com a explicação', async () => {
    const review = {
      id: 'o-2', status: 'SIGNED', billing_status: 'REVIEW', billing_strategy: 'UPFRONT_CHARGE', billing_type: 'PIX',
      term_months: 12, monthly_fee_cents: 18700, total_cents: 224400, classes_per_week: 3, contract_start: '2027-02-17',
      first_due_date: '2027-02-17', last_due_date: '2028-01-17', service_end_date: '2028-02-17', upfront_due_date: '2026-11-10',
      expires_at: '2026-12-06', signed_at: '2026-11-07', expired: false, billing_error: 'payment_post_outcome_unknown', invoice_url: null,
      coverage_registered_at: null, token: null, notice_status: null,
    };
    mockRpc({ ...baseContext, offers: [review] }, { ok: true });
    render(<StudentRenewalModal studentId="s-1" onClose={() => undefined} />);
    expect(await screen.findByText(/sem risco de duplicar/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Tentar de novo/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('retry_student_renewal_billing', { p_offer: 'o-2' }));
  });

  it('sem permissão não mostra formulário', async () => {
    mockRpc({ ok: false, error: 'sem_permissao' });
    render(<StudentRenewalModal studentId="s-1" onClose={() => undefined} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Somente a direção/);
    expect(screen.queryByRole('button', { name: /Gerar renovação/ })).toBeNull();
  });
});
