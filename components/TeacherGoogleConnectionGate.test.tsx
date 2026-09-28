import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeacherGoogleConnectionGate from './TeacherGoogleConnectionGate';

const { rpc, googleMeetAction } = vi.hoisted(() => ({ rpc: vi.fn(), googleMeetAction: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../lib/googleMeet', () => ({ googleMeetAction }));
const verified = { email: 'professor@gmail.com', verified_at: '2026-09-28T12:00:00Z' };
beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: null, error: null });
  googleMeetAction.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => vi.restoreAllMocks());

describe('conexão obrigatória do professor', () => {
  it('não interrompe quem já tem identidade confirmada', async () => {
    rpc.mockResolvedValue({ data: verified, error: null });
    const active = vi.fn();
    render(<TeacherGoogleConnectionGate onActiveChange={active} onLogout={vi.fn()} />);
    await waitFor(() => expect(active).toHaveBeenLastCalledWith(false));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('abre modal sem adiar ou fechar e impede Escape, mas permite sair da conta', async () => {
    const logout = vi.fn();
    render(<TeacherGoogleConnectionGate onActiveChange={vi.fn()} onLogout={logout} />);
    await screen.findByRole('button', { name: 'Conectar minha conta do Google Meet' });
    const modal = screen.getByRole('dialog');
    expect(modal).toHaveAttribute('open');
    const cancel = new Event('cancel', { bubbles: false, cancelable: true });
    modal.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(screen.queryByRole('button', { name: /adiar|depois|fechar/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sair da conta do portal' }));
    expect(logout).toHaveBeenCalledOnce();
  });
  it('abre Google no clique, confirma ao voltar e libera após mostrar a conta', async () => {
    const popup = { opener: window, closed: false, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    googleMeetAction.mockResolvedValue({ authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture' });
    const active = vi.fn();
    render(<TeacherGoogleConnectionGate onActiveChange={active} onLogout={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar minha conta do Google Meet' }));
    await waitFor(() => expect(popup.location.href).toContain('accounts.google.com'));
    expect(googleMeetAction).toHaveBeenCalledWith('teacher_identity_connect');
    rpc.mockResolvedValue({ data: verified, error: null });
    fireEvent(window, new Event('focus'));
    await screen.findByText('professor@gmail.com');
    expect(active).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Continuar no portal' }));
    await waitFor(() => expect(active).toHaveBeenLastCalledWith(false));
  });
  it('dá alternativa destacada para aba bloqueada e não libera por erro na consulta', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    googleMeetAction.mockResolvedValue({ authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture' });
    const active = vi.fn();
    render(<TeacherGoogleConnectionGate onActiveChange={active} onLogout={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar minha conta do Google Meet' }));
    expect(await screen.findByRole('link', { name: 'Abrir login do Google' })).toHaveAttribute('href', expect.stringContaining('accounts.google.com'));
    rpc.mockResolvedValue({ data: null, error: { code: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Já conectei · Conferir novamente' }));
    await screen.findByRole('alert');
    expect(active).toHaveBeenLastCalledWith(true);
  });
});
