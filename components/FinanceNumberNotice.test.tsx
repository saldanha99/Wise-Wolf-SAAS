import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FinanceNumberNotice, { formatBrazilPhone, parseFinanceWhatsAppNotice } from './FinanceNumberNotice';

const { rpc, upsert } = vi.hoisted(() => ({ rpc: vi.fn(), upsert: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, from: () => ({ upsert }) } }));
beforeEach(() => {
  rpc.mockReset();
  upsert.mockReset().mockResolvedValue({ error: null });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

const aviso = { notice_id: 'aviso-2026-11-22-numero-financeiro', phone: '5511900000000', display_name: 'Wise Wolf Financeiro' };

describe('pop-up do número do financeiro', () => {
  it('mostra o número, a foto e o link do WhatsApp; Entendi grava e fecha', async () => {
    rpc.mockResolvedValue({ data: aviso, error: null });
    const active = vi.fn();
    render(<FinanceNumberNotice userId="u1" onActiveChange={active} />);
    expect(await screen.findByRole('heading', { name: 'Suas cobranças agora vêm deste número' })).toBeInTheDocument();
    expect(screen.getByText('+55 (11) 90000-0000')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', '/assets/brand/wise-wolf-financeiro-20261122.png');
    expect(screen.getByRole('link', { name: /Abrir no WhatsApp/ }).getAttribute('href')).toMatch(/^https:\/\/wa\.me\/5511900000000\?text=/);
    expect(active).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Entendi' }));
    expect(upsert).toHaveBeenCalledWith({ user_id: 'u1', tour_id: aviso.notice_id }, expect.anything());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(active).toHaveBeenLastCalledWith(false);
  });

  it('sem aviso, com erro ou com resposta estranha, não abre nada', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: aviso, error: { message: 'x' } })
      .mockResolvedValueOnce({ data: { ...aviso, phone: '123' }, error: null });
    render(<FinanceNumberNotice userId="u2" />);
    render(<FinanceNumberNotice userId="u3" />);
    render(<FinanceNumberNotice userId="u4" />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('formata celular e fixo', () => {
    expect(formatBrazilPhone('5511912345678')).toBe('+55 (11) 91234-5678');
    expect(formatBrazilPhone('551133334444')).toBe('+55 (11) 3333-4444');
    expect(parseFinanceWhatsAppNotice({ ...aviso, notice_id: '' })).toBeNull();
  });
});
