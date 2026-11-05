import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TermSignatureContactCard from './TermSignatureContactCard';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const contact = (data: Record<string, unknown>) => ({ data: { ok: true, ...data }, error: null });

beforeEach(() => rpc.mockReset());

describe('<TermSignatureContactCard />', () => {
  it('sem número válido, explica o problema e salva o celular', async () => {
    rpc.mockResolvedValueOnce(contact({ phone: null, needs_number: true }));
    rpc.mockResolvedValueOnce(contact({ phone: '5511977776666', links_sent: 4 }));
    render(<TermSignatureContactCard />);

    expect(await screen.findByText(/ainda não chega a ninguém/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Celular com DDD'), { target: { value: '(11) 97777-6666' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar número' }));

    expect(await screen.findByRole('status')).toHaveTextContent('4 links de assinatura foram enviados');
    expect(rpc).toHaveBeenLastCalledWith('set_my_term_signature_contact', { p_phone: '(11) 97777-6666' });
    expect(screen.getByText('(11) 97777-6666')).toBeInTheDocument();
    expect(screen.queryByText(/ainda não chega a ninguém/)).not.toBeInTheDocument();
  });

  it('recusa o número da escola com a explicação e mantém o formulário', async () => {
    rpc.mockResolvedValueOnce(contact({ phone: null, needs_number: true }));
    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'numero_da_escola' }, error: null });
    render(<TermSignatureContactCard />);

    fireEvent.change(await screen.findByLabelText('Celular com DDD'), { target: { value: '11988887773' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar número' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('mesmo que envia as mensagens');
    expect(screen.getByLabelText('Celular com DDD')).toHaveValue('11988887773');
  });

  it('com número salvo, mostra o destino e só abre o formulário ao trocar', async () => {
    rpc.mockResolvedValueOnce(contact({ phone: '5511977776666', needs_number: false }));
    render(<TermSignatureContactCard />);

    expect(await screen.findByText('(11) 97777-6666')).toBeInTheDocument();
    expect(screen.queryByLabelText('Celular com DDD')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Trocar número' }));
    expect(screen.getByLabelText('Celular com DDD')).toBeInTheDocument();
  });

  it('quem não é da direção, ou falha na leitura, não vê o cartão', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'not_authorized' }, error: null });
    const { container, unmount } = render(<TermSignatureContactCard />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
    unmount();

    rpc.mockRejectedValueOnce(new Error('sem rede'));
    const second = render(<TermSignatureContactCard />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });
});
