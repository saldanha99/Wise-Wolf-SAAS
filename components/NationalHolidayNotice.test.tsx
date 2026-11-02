import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NationalHolidayNotice from './NationalHolidayNotice';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
beforeEach(() => {
  rpc.mockReset();
  window.localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

describe('pop-up do feriado nacional', () => {
  it('mostra o feriado da semana e não volta depois de fechado', async () => {
    rpc.mockResolvedValue({ data: { date: '2026-11-02', name: 'Finados', days_until: 5 }, error: null });
    const active = vi.fn();
    const { unmount } = render(<NationalHolidayNotice userId="u1" onActiveChange={active} />);
    expect(await screen.findByRole('heading', { name: 'Não haverá aula na segunda-feira, 02/11' })).toBeInTheDocument();
    expect(screen.getByText('Finados')).toBeInTheDocument();
    expect(active).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Entendi' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(active).toHaveBeenLastCalledWith(false);
    unmount();
    render(<NationalHolidayNotice userId="u1" />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('sem feriado próximo ou com erro, não abre nada', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    render(<NationalHolidayNotice userId="u2" />);
    render(<NationalHolidayNotice userId="u3" />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
