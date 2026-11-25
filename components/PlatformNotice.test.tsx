import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlatformNotice from './PlatformNotice';
import { parsePlatformNotices } from '../lib/platformNotices';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
beforeEach(() => {
  rpc.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

const notice = { id: 'n1', title: 'Recesso de fim de ano', body: 'De 24/12 a 01/01 não haverá aulas.' };

describe('aviso da escola em pop-up', () => {
  it('mostra o aviso e some só depois de o servidor gravar o "Entendi"', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'my_pending_platform_notices'
      ? { data: [notice], error: null }
      : { data: { ok: true, acknowledged_at: '2026-12-01T10:00:00Z' }, error: null }));
    const active = vi.fn();
    render(<PlatformNotice userId="u1" onActiveChange={active} />);
    expect(await screen.findByRole('heading', { name: 'Recesso de fim de ano' })).toBeInTheDocument();
    expect(active).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Entendi' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Recesso de fim de ano' })).not.toBeInTheDocument());
    expect(rpc).toHaveBeenCalledWith('acknowledge_platform_notice', { p_notice_id: 'n1' });
    await waitFor(() => expect(active).toHaveBeenLastCalledWith(false));
  });

  it('falha ao gravar: o aviso fica, com erro visível e "Tentar de novo"', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'my_pending_platform_notices'
      ? { data: [notice], error: null }
      : { data: null, error: { message: 'offline' } }));
    render(<PlatformNotice userId="u2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Entendi' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Não consegui registrar');
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recesso de fim de ano' })).toBeInTheDocument();
  });

  it('sem aviso, com erro ou com formato estranho, não abre nada', async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null }).mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    render(<PlatformNotice userId="u3" />);
    render(<PlatformNotice userId="u4" />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(parsePlatformNotices([{ id: 1, title: 'x', body: 'y' }, null, 'z'])).toEqual([]);
  });
});
