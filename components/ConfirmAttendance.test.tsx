import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConfirmAttendance from './ConfirmAttendance';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: { rpc },
}));

const confirmation = (overrides: Record<string, unknown> = {}) => ({
  found: true,
  already: false,
  student_name: 'Ana Aluna',
  teacher_name: 'Professor Paulo',
  class_date: '2026-08-28',
  class_time: '14:00:00',
  allowed_responses: ['STUDENT_PRESENT', 'TEACHER_NO_SHOW', 'STUDENT_SELF_ABSENT'],
  ...overrides,
});

beforeEach(() => {
  rpc.mockReset();
  window.history.replaceState({}, '', '/confirmar-presenca?token=token-publico-teste');
});

describe('<ConfirmAttendance />', () => {
  it('faz uma pergunta neutra e explica o uso da resposta sem prometer confidencialidade', async () => {
    rpc.mockResolvedValueOnce({ data: confirmation(), error: null });

    render(<ConfirmAttendance />);

    expect(await screen.findByRole('heading', { name: /o que aconteceu com sua aula/i })).toBeInTheDocument();
    expect(screen.getByText(/compara.*registro do professor/i)).toBeInTheDocument();
    expect(screen.queryByText(/confidencial/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /a aula aconteceu e eu participei/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /a aula aconteceu, mas eu não participei/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancelada ou remarcada/i })).not.toBeInTheDocument();
  });

  it('só oferece cancelamento ou remarcação quando o servidor autoriza a resposta', async () => {
    rpc
      .mockResolvedValueOnce({
        data: confirmation({
          allowed_responses: [
            'STUDENT_PRESENT',
            'TEACHER_NO_SHOW',
            'STUDENT_SELF_ABSENT',
            'CANCELLED_RESCHEDULED',
          ],
        }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: { ok: true, student_response: 'CANCELLED_RESCHEDULED' },
        error: null,
      });

    render(<ConfirmAttendance />);
    fireEvent.click(await screen.findByRole('button', { name: /a aula foi cancelada ou remarcada/i }));

    await waitFor(() => expect(rpc).toHaveBeenLastCalledWith('apply_student_response', {
      p_token: 'token-publico-teste',
      p_response: 'CANCELLED_RESCHEDULED',
    }));
    expect(await screen.findByText(/registramos que a aula foi cancelada ou remarcada/i)).toBeInTheDocument();
  });

  it('permite corrigir uma resposta anterior somente durante a janela informada pelo servidor', async () => {
    rpc
      .mockResolvedValueOnce({
        data: confirmation({
          already: true,
          student_response: 'STUDENT_PRESENT',
          can_correct: true,
          editable_until: '2026-08-28T15:30:00-03:00',
        }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: { ok: true, corrected: true, student_response: 'STUDENT_SELF_ABSENT' },
        error: null,
      });

    render(<ConfirmAttendance />);

    fireEvent.click(await screen.findByRole('button', { name: /corrigir minha resposta/i }));
    expect(screen.getByRole('heading', { name: /corrija sua resposta/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /a aula aconteceu, mas eu não participei/i }));

    await waitFor(() => expect(rpc).toHaveBeenLastCalledWith('apply_student_response', {
      p_token: 'token-publico-teste',
      p_response: 'STUDENT_SELF_ABSENT',
    }));
    expect(await screen.findByText(/a aula aconteceu, mas você não participou/i)).toBeInTheDocument();
  });

  it('não mostra correção quando a resposta já está bloqueada', async () => {
    rpc.mockResolvedValueOnce({
      data: confirmation({
        already: true,
        student_response: 'STUDENT_PRESENT',
        can_correct: false,
      }),
      error: null,
    });

    render(<ConfirmAttendance />);

    expect(await screen.findByText(/registramos que a aula aconteceu e você participou/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /corrigir minha resposta/i })).not.toBeInTheDocument();
  });

  it('não aceita resposta nova quando o servidor informa que o link expirou', async () => {
    rpc.mockResolvedValueOnce({
      data: confirmation({ expired: true }),
      error: null,
    });

    render(<ConfirmAttendance />);

    expect(await screen.findByRole('heading', { name: /o prazo desta confirmação terminou/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /participei/i })).not.toBeInTheDocument();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
