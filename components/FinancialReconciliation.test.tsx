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
});
