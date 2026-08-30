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
});
