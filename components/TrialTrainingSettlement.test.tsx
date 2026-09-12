import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrialTrainingSettlement from './TrialTrainingSettlement';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const session = {
  appointment_id: 'trial-fixture', type: 'experimental',
  start_time: '2026-09-01T12:00:00Z', student_name: 'Aluno de teste',
  teacher_id: 'teacher-fixture', teacher_name: 'Teacher de teste', hourly_rate: 16,
};

beforeEach(() => {
  rpc.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('liquidação de experimentais com resposta autoritativa', () => {
  it.each([
    ['appointment_not_ended', 'Aguarde o término dos 30 minutos'],
    ['appointment_time_missing', 'sem um horário válido'],
  ])('preserva a pendência e explica %s sem sucesso falso', async (code, message) => {
    rpc.mockResolvedValueOnce({ data: [session], error: null })
      .mockResolvedValueOnce({ data: { ok: false, error: code }, error: null });
    render(<TrialTrainingSettlement user={{} as any} />);
    fireEvent.click(await screen.findByRole('button', { name: /Compareceu \/ Pagar/i }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(expect.stringContaining(message)));
    expect(screen.getByText('Aluno de teste')).toBeInTheDocument();
    expect(screen.queryByText('Tudo em dia!')).not.toBeInTheDocument();
    expect(rpc).toHaveBeenLastCalledWith('settle_trial_session', {
      p_appointment_id: 'trial-fixture', p_attended: true,
    });
  });

  it('não aceita um ok textual como confirmação de gravação', async () => {
    rpc.mockResolvedValueOnce({ data: [session], error: null })
      .mockResolvedValueOnce({ data: { ok: 'false' }, error: null });
    render(<TrialTrainingSettlement user={{} as any} />);
    fireEvent.click(await screen.findByRole('button', { name: /Compareceu \/ Pagar/i }));
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    expect(screen.getByText('Aluno de teste')).toBeInTheDocument();
  });

  it('mantém a conclusão legítima quando o servidor confirma após o fim', async () => {
    rpc.mockResolvedValueOnce({ data: [session], error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });
    render(<TrialTrainingSettlement user={{} as any} />);
    fireEvent.click(await screen.findByRole('button', { name: /Compareceu \/ Pagar/i }));
    expect(await screen.findByText('Tudo em dia!')).toBeInTheDocument();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it.each([
    { data: { ok: false, error: 'forbidden' }, error: null },
    { data: null, error: { message: 'Network failure' } },
  ])('não apresenta tudo em dia quando a consulta de pendências falha', async response => {
    rpc.mockResolvedValueOnce(response);
    render(<TrialTrainingSettlement user={{} as any} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar');
    expect(screen.queryByText('Tudo em dia!')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Compareceu \/ Pagar/i })).not.toBeInTheDocument();
  });
});
