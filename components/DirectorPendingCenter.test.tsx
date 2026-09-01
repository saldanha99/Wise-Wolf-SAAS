import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DirectorPendingCenter from './DirectorPendingCenter';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: { rpc },
}));

beforeEach(() => {
  rpc.mockReset();
});

describe('<DirectorPendingCenter />', () => {
  it('nunca transforma erro da RPC em "Tudo em dia"', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'indisponível' } });

    render(<DirectorPendingCenter />);

    expect(screen.getByText('Consultando pendências…')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar as pendências');
    expect(screen.queryByText(/Tudo em dia/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tentar novamente/i })).toBeInTheDocument();
  });

  it('permite tentar novamente e só mostra o estado positivo após leitura válida', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'falha temporária' } })
      .mockResolvedValueOnce({ data: {}, error: null });

    render(<DirectorPendingCenter />);

    fireEvent.click(await screen.findByRole('button', { name: /tentar novamente/i }));

    expect(await screen.findByText(/Tudo em dia/i)).toBeInTheDocument();
    expect(screen.getByText(/Atualizado às/i)).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('mostra a contagem e registra a última atualização da leitura bem-sucedida', async () => {
    rpc.mockResolvedValue({ data: { presenca: 2 }, error: null });
    const onNavigate = vi.fn();

    render(<DirectorPendingCenter onNavigate={onNavigate} />);

    const pendingButton = await screen.findByRole('button', { name: /Conflitos de presença a resolver/i });
    expect(pendingButton).toHaveTextContent('2');
    expect(screen.getByText(/Atualizado às/i)).toBeInTheDocument();

    fireEvent.click(pendingButton);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('attendance-disputes'));
  });

  it('não deixa uma entrega ambígua de pagamento silenciosa', async () => {
    rpc.mockResolvedValue({ data: { avisos_pagamento: 1 }, error: null });
    const onNavigate = vi.fn();

    render(<DirectorPendingCenter onNavigate={onNavigate} />);

    const pendingButton = await screen.findByRole('button', {
      name: /Avisos de pagamento sem entrega confirmada/i,
    });
    expect(pendingButton).toHaveTextContent('1');
    expect(screen.queryByText(/Tudo em dia/i)).not.toBeInTheDocument();

    fireEvent.click(pendingButton);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('student-payments'));
  });

  it('leva pagamentos sem aluno e divergências do Asaas às filas corretas', async () => {
    rpc.mockResolvedValue({
      data: { pagamentos_sem_aluno: 2, conciliacao_asaas: 3 },
      error: null,
    });
    const onNavigate = vi.fn();

    render(<DirectorPendingCenter onNavigate={onNavigate} />);

    const unlinked = await screen.findByRole('button', {
      name: /Pagamentos aguardando identificação do aluno/i,
    });
    const reconciliation = screen.getByRole('button', {
      name: /Divergências atuais entre Asaas e plataforma/i,
    });
    expect(unlinked).toHaveTextContent('2');
    expect(reconciliation).toHaveTextContent('3');

    fireEvent.click(unlinked);
    fireEvent.click(reconciliation);
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledTimes(2);
      expect(onNavigate).toHaveBeenNthCalledWith(1, 'reconciliation');
      expect(onNavigate).toHaveBeenNthCalledWith(2, 'reconciliation');
    });
  });

  it('torna contratos vencendo visíveis na central do diretor', async () => {
    rpc.mockResolvedValue({
      data: { reconciliacao: 4 },
      error: null,
    });
    const onNavigate = vi.fn();

    render(<DirectorPendingCenter onNavigate={onNavigate} />);

    const renewals = await screen.findByRole('button', {
      name: /Contratos vencendo e pendências financeiras/i,
    });
    expect(renewals).toHaveTextContent('4');

    fireEvent.click(renewals);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('reconciliation'));
  });
});
