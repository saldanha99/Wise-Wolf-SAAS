import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FinancialReconciliation from './FinancialReconciliation';

const { rpc, writeText } = vi.hoisted(() => ({
  rpc: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: { rpc },
}));

const emptyReconciliation = {
  sem_cobertura: { itens: [], qtd: 0, total: 0 },
  cobrado_sem_estudar: { itens: [], qtd: 0, total: 0 },
  arquivado_com_fatura: { itens: [], qtd: 0, total: 0 },
  pago_sem_nf: { itens: [], qtd: 0, total: 0 },
  parado_com_nf: { itens: [], qtd: 0, total: 0 },
  aula_nao_lancada: { itens: [], qtd: 0, total: 0 },
};

const renewalOffer = {
  student_id: 'student-1',
  aluno: 'Aluna Renovação',
  termina: '2026-09-10',
  dias: 9,
  paga_hoje: 261,
  p12: 229,
  mensagem: 'Mensagem de renovação para conferir.',
};

const baseRenewalRadar = {
  vencendo: {
    itens: [{
      student_id: renewalOffer.student_id,
      aluno: renewalOffer.aluno,
      termina: renewalOffer.termina,
      dias: renewalOffer.dias,
      cobranca_parada: true,
      professor: 'Professora',
      horarios: 'Segunda 14:30',
      mensalidade: 261,
    }],
    qtd: 1,
    mensal: 261,
  },
  encerrado: { itens: [], qtd: 0, mensal: 0 },
};

const installRpc = (
  caseItems: unknown[] = [],
  offerItems: unknown[] = [renewalOffer],
  recordHandler?: () => Promise<unknown>,
  options: { offerError?: boolean } = {},
) => {
  rpc.mockImplementation((name: string) => {
    if (name === 'financial_reconciliation') {
      return Promise.resolve({ data: emptyReconciliation, error: null });
    }
    if (name === 'contratos_para_renovar') {
      return Promise.resolve({ data: baseRenewalRadar, error: null });
    }
    if (name === 'ofertas_de_renovacao') {
      if (options.offerError) {
        return Promise.resolve({ data: null, error: { message: 'ofertas offline' } });
      }
      return Promise.resolve({
        data: { ok: true, ativo: false, itens: offerItems, qtd: offerItems.length },
        error: null,
      });
    }
    if (name === 'asaas_reconciliation_attention') {
      return Promise.resolve({
        data: { audit_available: true, itens: [], qtd: 0, total: 0 },
        error: null,
      });
    }
    if (name === 'list_student_renewal_cases') {
      return Promise.resolve({ data: { ok: true, items: caseItems }, error: null });
    }
    if (name === 'record_student_renewal_action') {
      if (recordHandler) return recordHandler();
      return Promise.resolve({
        data: {
          ok: true,
          replayed: false,
          case_id: 'case-1',
          status: 'AWAITING_REPLY',
          version: 1,
          last_contact_at: '2026-09-01T12:00:00.000Z',
          last_channel: 'WHATSAPP',
          next_action_at: null,
          interest_term_months: null,
        },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
};

beforeEach(() => {
  rpc.mockReset();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

describe('acompanhamento interno de rematrículas', () => {
  it('deixa claro que copiar não envia nem registra contato', async () => {
    installRpc();

    render(
      <FinancialReconciliation
        user={{} as never}
        tenantId="school-wise-wolf"
      />,
    );

    expect(await screen.findByText('Acompanhamento de rematrículas')).toBeInTheDocument();
    expect(screen.getByText(/não representa aceite, não envia mensagem/i)).toBeInTheDocument();
    expect(screen.getByText(/Copiar não envia nem registra contato/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /copiar mensagem/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(renewalOffer.mensagem));
    expect(rpc.mock.calls.some(([name]) => name === 'record_student_renewal_action')).toBe(false);
  });

  it('registra o contato por RPC sem afirmar assinatura ou renovar cobrança', async () => {
    installRpc();

    render(
      <FinancialReconciliation
        user={{} as never}
        tenantId="school-wise-wolf"
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /registrar contato/i }));
    expect(screen.getByPlaceholderText(/Não registre cartão, CPF/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /salvar registro interno/i }));

    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith(
        'record_student_renewal_action',
        expect.objectContaining({
          p_student_id: renewalOffer.student_id,
          p_service_end_date: renewalOffer.termina,
          p_action: 'CONTACTED',
          p_expected_version: 0,
          p_channel: 'WHATSAPP',
          p_interest_term_months: null,
        }),
      );
    });
    expect(await screen.findByText('Aguardando resposta')).toBeInTheDocument();
    expect(screen.getByText(/A formalização deve ser feita pelo próprio aluno/i)).toBeInTheDocument();
  });

  it('mostra interesse informado como etapa interna antes da formalização', async () => {
    installRpc([{
      id: 'case-1',
      student_id: renewalOffer.student_id,
      service_end_date: renewalOffer.termina,
      status: 'INTEREST_RECORDED',
      last_contact_at: '2026-09-01T12:00:00.000Z',
      last_channel: 'WHATSAPP',
      next_action_at: null,
      interest_term_months: 12,
      cycle_current: true,
      version: 2,
      updated_by_name: 'Diretora',
      event_count: 2,
    }]);

    render(
      <FinancialReconciliation
        user={{} as never}
        tenantId="school-wise-wolf"
      />,
    );

    expect((await screen.findAllByText('Interesse informado')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/interesse em 12 meses/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /aguardar formalização/i })).toBeInTheDocument();
    expect(screen.queryByText(/^Renovado$/i)).not.toBeInTheDocument();
  });

  it('mantém um acompanhamento visível depois que ele sai do radar comercial', async () => {
    installRpc([{
      id: 'case-expired',
      student_id: 'student-expired',
      student_name: 'Aluna com retorno pendente',
      service_end_date: '2026-08-20',
      status: 'FORMALIZATION_PENDING',
      last_contact_at: '2026-08-18T12:00:00.000Z',
      last_channel: 'WHATSAPP',
      next_action_at: '2026-08-25T12:00:00.000Z',
      interest_term_months: 6,
      monthly_fee_snapshot: 250,
      cycle_current: true,
      version: 3,
      updated_by_name: 'Diretora',
      event_count: 3,
    }], []);

    render(
      <FinancialReconciliation
        user={{} as never}
        tenantId="school-wise-wolf"
      />,
    );

    expect(await screen.findByText('Aluna com retorno pendente')).toBeInTheDocument();
    expect(screen.getByText(/saiu do radar comercial atual/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Aguardando formalização/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: /copiar mensagem/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Tudo conferido/i)).not.toBeInTheDocument();
  });

  it('repete o mesmo envelope após erro de rede e bloqueia dados diferentes', async () => {
    let attempts = 0;
    const recordHandler = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve({ data: null, error: { message: 'conexão interrompida' } });
      }
      return Promise.resolve({
        data: {
          ok: true,
          replayed: true,
          case_id: 'case-1',
          status: 'AWAITING_REPLY',
          version: 1,
          last_contact_at: '2026-09-01T12:00:00.000Z',
          last_channel: 'WHATSAPP',
          next_action_at: null,
          interest_term_months: null,
        },
        error: null,
      });
    });
    installRpc([], [renewalOffer], recordHandler);

    render(
      <FinancialReconciliation
        user={{} as never}
        tenantId="school-wise-wolf"
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /registrar contato/i }));
    const note = screen.getByPlaceholderText(/Não registre cartão, CPF/i);
    fireEvent.change(note, { target: { value: 'Primeiro registro' } });
    fireEvent.click(screen.getByRole('button', { name: /salvar registro interno/i }));
    expect(await screen.findByText(/mesma ação não será duplicada/i)).toBeInTheDocument();

    const firstCall = rpc.mock.calls.find(([name]) => name === 'record_student_renewal_action');
    expect(firstCall).toBeTruthy();
    fireEvent.change(note, { target: { value: 'Registro alterado' } });
    fireEvent.click(screen.getByRole('button', { name: /salvar registro interno/i }));
    expect(await screen.findByText(/Repita exatamente a mesma ação/i)).toBeInTheDocument();
    expect(recordHandler).toHaveBeenCalledTimes(1);

    fireEvent.change(note, { target: { value: 'Primeiro registro' } });
    fireEvent.click(screen.getByRole('button', { name: /salvar registro interno/i }));
    await waitFor(() => expect(recordHandler).toHaveBeenCalledTimes(2));
    const recordCalls = rpc.mock.calls.filter(([name]) => name === 'record_student_renewal_action');
    expect(recordCalls[1][1]).toEqual(recordCalls[0][1]);
  });

  it('bloqueia ações quando o ciclo atual não pôde ser confirmado', async () => {
    installRpc([{
      id: 'case-unknown-cycle',
      student_id: renewalOffer.student_id,
      student_name: renewalOffer.aluno,
      service_end_date: renewalOffer.termina,
      status: 'INTEREST_RECORDED',
      last_contact_at: null,
      last_channel: null,
      next_action_at: null,
      interest_term_months: 6,
      version: 2,
    }]);

    render(
      <FinancialReconciliation
        user={{} as never}
        tenantId="school-wise-wolf"
      />,
    );

    expect(await screen.findByText('Ciclo anterior')).toBeInTheDocument();
    expect(screen.getByText(/somente para consulta/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /aguardar formalização/i })).not.toBeInTheDocument();
  });

  it('preserva o aviso de cobertura incompleta depois de uma ação que recarrega os casos', async () => {
    const pendingCase = {
      id: 'case-partial-load',
      student_id: renewalOffer.student_id,
      student_name: renewalOffer.aluno,
      service_end_date: renewalOffer.termina,
      status: 'PENDING_CONTACT',
      last_contact_at: null,
      last_channel: null,
      next_action_at: null,
      interest_term_months: null,
      monthly_fee_snapshot: 261,
      cycle_current: true,
      version: 0,
      updated_by_name: null,
      event_count: 0,
    };
    const recordHandler = vi.fn(() => Promise.resolve({
      data: {
        ok: true,
        replayed: true,
        case_id: pendingCase.id,
        status: 'AWAITING_REPLY',
        version: 1,
        last_contact_at: '2026-09-01T12:00:00.000Z',
        last_channel: 'WHATSAPP',
        next_action_at: null,
        interest_term_months: null,
      },
      error: null,
    }));
    installRpc([pendingCase], [], recordHandler, { offerError: true });

    render(
      <FinancialReconciliation
        user={{} as never}
        tenantId="school-wise-wolf"
      />,
    );

    const warning = await screen.findByText(/lista de novos contratos não pôde ser carregada/i);
    fireEvent.click(screen.getByRole('button', { name: /registrar contato/i }));
    fireEvent.click(screen.getByRole('button', { name: /salvar registro interno/i }));

    await waitFor(() => expect(recordHandler).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByPlaceholderText(/Não registre cartão, CPF/i)).not.toBeInTheDocument());
    expect(warning).toBeInTheDocument();
    expect(screen.getByText(/lista de novos contratos não pôde ser carregada/i)).toBeInTheDocument();
  });
});
