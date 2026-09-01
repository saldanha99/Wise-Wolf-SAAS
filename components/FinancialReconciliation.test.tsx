import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FinancialReconciliation from './FinancialReconciliation';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

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

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation((name: string) => {
    if (name === 'financial_reconciliation') {
      return Promise.resolve({ data: emptyReconciliation, error: null });
    }
    if (name === 'asaas_reconciliation_attention') {
      return Promise.resolve({ data: null, error: { message: 'offline' } });
    }
    if (name === 'list_student_renewal_cases') {
      return Promise.resolve({ data: { ok: true, items: [] }, error: null });
    }
    if (name === 'ofertas_de_renovacao') {
      return Promise.resolve({ data: { ok: true, itens: [] }, error: null });
    }
    return Promise.resolve({ data: { itens: [] }, error: null });
  });
});

describe('<FinancialReconciliation />', () => {
  it('nunca declara tudo conferido quando a leitura do Asaas falha', async () => {
    render(
      <FinancialReconciliation
        user={{} as never}
        tenantId="school-wise-wolf"
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível conferir o Asaas agora',
    );
    expect(screen.queryByText(/Tudo conferido/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tentar novamente/i })).toBeInTheDocument();
  });

  it('não trata uma falha do radar de contratos como ausência de rematrículas', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'financial_reconciliation') {
        return Promise.resolve({ data: emptyReconciliation, error: null });
      }
      if (name === 'contratos_para_renovar') {
        return Promise.resolve({ data: null, error: { message: 'radar offline' } });
      }
      if (name === 'ofertas_de_renovacao') {
        return Promise.resolve({ data: { ok: true, itens: [] }, error: null });
      }
      if (name === 'list_student_renewal_cases') {
        return Promise.resolve({ data: { ok: true, items: [] }, error: null });
      }
      if (name === 'asaas_reconciliation_attention') {
        return Promise.resolve({
          data: { audit_available: true, itens: [], qtd: 0, total: 0 },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(
      <FinancialReconciliation
        user={{} as never}
        tenantId="school-wise-wolf"
      />,
    );

    expect(await screen.findByText(/radar de contratos vencendo não pôde ser carregado/i)).toBeInTheDocument();
    expect(screen.queryByText(/Tudo conferido/i)).not.toBeInTheDocument();
  });

  it('mantém as rematrículas disponíveis quando somente a reconciliação financeira falha', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'financial_reconciliation') {
        return Promise.resolve({ data: null, error: { message: 'financeiro offline' } });
      }
      if (name === 'contratos_para_renovar') {
        return Promise.resolve({
          data: {
            vencendo: { itens: [], qtd: 0, mensal: 0 },
            encerrado: { itens: [], qtd: 0, mensal: 0 },
          },
          error: null,
        });
      }
      if (name === 'ofertas_de_renovacao') {
        return Promise.resolve({
          data: {
            ok: true,
            itens: [{
              student_id: 'student-partial',
              aluno: 'Aluna com rematrícula',
              termina: '2026-09-20',
              dias: 19,
              paga_hoje: 250,
              mensagem: 'Mensagem para conferir.',
            }],
          },
          error: null,
        });
      }
      if (name === 'list_student_renewal_cases') {
        return Promise.resolve({ data: { ok: true, items: [] }, error: null });
      }
      if (name === 'asaas_reconciliation_attention') {
        return Promise.resolve({
          data: { audit_available: true, itens: [], qtd: 0, total: 0 },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(
      <FinancialReconciliation
        user={{} as never}
        tenantId="school-wise-wolf"
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível conferir as pendências financeiras agora',
    );
    expect(screen.getByText('Acompanhamento de rematrículas')).toBeInTheDocument();
    expect(screen.getByText('Aluna com rematrícula')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /registrar contato/i })).toBeEnabled();
    expect(screen.queryByText(/Tudo conferido/i)).not.toBeInTheDocument();
  });
});
