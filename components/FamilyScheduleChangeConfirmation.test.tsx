import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FamilyScheduleChangeConfirmation from './FamilyScheduleChangeConfirmation';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const change = { found: true, status: 'PENDING_FAMILY', scope: 'PERMANENT', old_day: 'Segunda', old_time: '08:00', new_day: 'Terça', new_time: '09:00', effective_from: '2026-10-01', reason: 'Mudança familiar de rotina', student_name: 'Aluno Teste', teacher_name: 'Professor Teste' };
beforeEach(() => { rpc.mockReset(); window.history.replaceState({}, '', '/confirmar-alteracao?token=public-family-token'); });
describe('aceite familiar de agenda', () => {
  it('explica a vigência e registra aceite sem afirmar que a agenda já mudou', async () => {
    rpc.mockResolvedValueOnce({ data: change, error: null }).mockResolvedValueOnce({ data: { ok: true, status: 'ACCEPTED' }, error: null });
    render(<FamilyScheduleChangeConfirmation />);
    expect(await screen.findByText(/permanente a partir de 01\/10\/2026/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar proposta' }));
    expect(await screen.findByRole('status')).toHaveTextContent('A escola ainda precisa confirmar a aplicação');
    await waitFor(() => expect(rpc).toHaveBeenLastCalledWith('respond_schedule_change_public', { p_token: 'public-family-token', p_accept: true }));
  });
  it('recusa a proposta e preserva o horário vigente', async () => {
    rpc.mockResolvedValueOnce({ data: { ...change, scope: 'ONE_OFF', original_date: '2026-10-05', proposed_date: '2026-10-06' }, error: null }).mockResolvedValueOnce({ data: { ok: true, status: 'REJECTED' }, error: null });
    render(<FamilyScheduleChangeConfirmation />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manter horário atual' }));
    expect(await screen.findByRole('status')).toHaveTextContent('O horário não foi alterado');
  });
  it('não oferece ações em token expirado e não mostra sucesso em falha de gravação', async () => {
    rpc.mockResolvedValueOnce({ data: { found: false }, error: null });
    const view = render(<FamilyScheduleChangeConfirmation />);
    expect(await screen.findByRole('alert')).toHaveTextContent('expirou');
    expect(screen.queryByRole('button', { name: 'Aceitar proposta' })).not.toBeInTheDocument();
    view.unmount();
    rpc.mockResolvedValueOnce({ data: change, error: null }).mockResolvedValueOnce({ data: null, error: { message: 'expired_link' } });
    render(<FamilyScheduleChangeConfirmation />);
    fireEvent.click(await screen.findByRole('button', { name: 'Aceitar proposta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível registrar');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
