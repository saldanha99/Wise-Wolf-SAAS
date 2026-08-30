import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StudentAuditPanel from './StudentAuditPanel';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: { rpc },
}));

const audit = (overrides: Record<string, unknown> = {}) => ({
  id: 'confirmation-1',
  teacher_name: 'Professor Paulo',
  class_date: '2026-08-28',
  class_time: '14:00:00',
  student_response: null,
  status: 'PENDING',
  responded_at: null,
  can_correct: true,
  editable_until: null,
  allowed_responses: [
    'STUDENT_PRESENT',
    'TEACHER_NO_SHOW',
    'STUDENT_SELF_ABSENT',
    'CANCELLED_RESCHEDULED',
  ],
  ...overrides,
});

beforeEach(() => rpc.mockReset());

describe('<StudentAuditPanel />', () => {
  it('responde pela RPC autenticada usando o id, sem reutilizar token público', async () => {
    rpc
      .mockResolvedValueOnce({ data: [audit()], error: null })
      .mockResolvedValueOnce({
        data: { ok: true, student_response: 'CANCELLED_RESCHEDULED' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: [audit({ student_response: 'CANCELLED_RESCHEDULED', status: 'ATTENDANCE_MISMATCH' })],
        error: null,
      });

    render(<StudentAuditPanel />);

    expect(await screen.findByText(/qual situação descreve melhor/i)).toBeInTheDocument();
    expect(screen.getByText(/gestores autorizados podem consultá-la/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /cancelada\/remarcada/i }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('apply_my_attendance_response', {
      p_confirmation_id: 'confirmation-1',
      p_response: 'CANCELLED_RESCHEDULED',
    }));
    expect(rpc).not.toHaveBeenCalledWith('apply_student_response', expect.anything());
    expect(await screen.findByText('Aula cancelada ou remarcada')).toBeInTheDocument();
  });

  it('oferece correção somente quando a projeção autenticada autoriza', async () => {
    rpc.mockResolvedValueOnce({
      data: [audit({
        student_response: 'STUDENT_PRESENT',
        status: 'CONFIRMED',
        can_correct: true,
        editable_until: '2026-08-28T15:30:00-03:00',
      })],
      error: null,
    });

    render(<StudentAuditPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /corrigir/i }));
    expect(screen.getByText(/corrija sua resposta/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancelar correção/i })).toBeInTheDocument();
  });

  it('não cria uma pendência impossível quando a confirmação expirou', async () => {
    rpc.mockResolvedValueOnce({
      data: [audit({ student_response: null, can_correct: false, status: 'PENDING' })],
      error: null,
    });

    render(<StudentAuditPanel />);

    expect(await screen.findByText(/não há confirmação disponível/i)).toBeInTheDocument();
    expect(screen.queryByText(/qual situação descreve melhor/i)).not.toBeInTheDocument();
  });
});
