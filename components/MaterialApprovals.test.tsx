import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MaterialApprovals from './MaterialApprovals';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../services/materialAccessService', () => ({ openMaterialAccess: vi.fn() }));

const item = { id: 'm1', title: 'Book fixture', status: 'PENDING', type: 'PDF', author: 'Prof fixture', created_at: '2026-11-20T12:00:00Z' };

afterEach(cleanup);
beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(async (fn: string) => {
    if (fn === 'list_material_approvals') return { data: { items: [item], pending_count: 1 }, error: null };
    if (fn === 'review_material') return { data: { ok: true }, error: null };
    throw new Error(`unexpected rpc ${fn}`);
  });
});

const user = { id: 'director' } as never;

describe('MaterialApprovals', () => {
  it('approves with a toast instead of a blocking alert()', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    render(<MaterialApprovals user={user} />);
    fireEvent.click(await screen.findByRole('button', { name: /Aprovar/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('Material aprovado');
    expect(rpc).toHaveBeenCalledWith('review_material', { p_id: 'm1', p_approve: true, p_reason: null });
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('asks the rejection reason in a modal, not prompt()', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockImplementation(() => null);
    render(<MaterialApprovals user={user} />);
    fireEvent.click(await screen.findByRole('button', { name: /Reprovar/ }));
    const dialog = screen.getByRole('dialog', { name: 'Reprovar material' });
    fireEvent.change(screen.getByLabelText('Motivo (opcional)'), { target: { value: '  Arquivo incompleto ' } });
    fireEvent.click(dialog.querySelector('button.bg-red-600') as HTMLButtonElement);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('review_material', { p_id: 'm1', p_approve: false, p_reason: 'Arquivo incompleto' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('cancelling the modal does not review', async () => {
    render(<MaterialApprovals user={user} />);
    fireEvent.click(await screen.findByRole('button', { name: /Reprovar/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rpc).not.toHaveBeenCalledWith('review_material', expect.anything());
  });

  it('shows an error toast when the review fails', async () => {
    rpc.mockImplementation(async (fn: string) => fn === 'list_material_approvals'
      ? { data: { items: [item], pending_count: 1 }, error: null }
      : { data: null, error: new Error('boom') });
    render(<MaterialApprovals user={user} />);
    fireEvent.click(await screen.findByRole('button', { name: /Aprovar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível revisar');
  });
});

describe('MaterialApprovals — teclado', () => {
  it('Escape closes the reject modal without reviewing', async () => {
    render(<MaterialApprovals user={user} />);
    fireEvent.click(await screen.findByRole('button', { name: /Reprovar/ }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rpc).not.toHaveBeenCalledWith('review_material', expect.anything());
  });
});
