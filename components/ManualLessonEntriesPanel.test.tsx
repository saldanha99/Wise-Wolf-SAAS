import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ManualLessonEntriesPanel from './ManualLessonEntriesPanel';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const OPTIONS = {
  teachers: [{ id: 'maria', name: 'Maria Luisa' }],
  students: [{ id: 'davi', name: 'Davi Marques' }],
};

const ENTRY = {
  id: 'e1', kind: 'TESTE_ORAL', teacher_id: 'maria', teacher_name: 'Maria Luisa',
  student_id: null, student_name: null, guest_name: 'Sara Elisa', class_date: '2026-11-09',
  start_time: '10:00', units: 1, reason: 'Prova oral de quem não é aluna', rate_override: null,
  created_by_name: 'Direção', created_at: '2026-11-10T12:00:00Z', cancelled_at: null,
  cancelled_by_name: null, cancel_reason: null, month_closed: false, valor: 8,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T15:00:00-03:00'));
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'manual_lesson_options') return { data: OPTIONS, error: null };
    if (name === 'list_manual_lesson_entries') return { data: [ENTRY], error: null };
    if (name === 'create_manual_lesson_entry') return { data: { ok: true, id: 'e2', aulas: 1, valor: 8 }, error: null };
    if (name === 'cancel_manual_lesson_entry') return { data: { ok: true }, error: null };
    return { data: null, error: { message: 'unexpected ' + name } };
  });
});
afterEach(() => vi.useRealTimers());

describe('ManualLessonEntriesPanel', () => {
  it('lista as baixas do mês com motivo, quem lançou e valor', async () => {
    render(<ManualLessonEntriesPanel />);
    expect(await screen.findByText(/Teste oral · Sara Elisa/)).toBeTruthy();
    expect(screen.getByText(/Prova oral de quem não é aluna/)).toBeTruthy();
    expect(screen.getByText(/Lançada por Direção/)).toBeTruthy();
  });

  it('só envia com motivo e manda nome livre para quem não é aluno', async () => {
    render(<ManualLessonEntriesPanel />);
    await screen.findByText(/Teste oral · Sara Elisa/);
    fireEvent.change(screen.getByLabelText('Professor'), { target: { value: 'maria' } });
    fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'TESTE_ORAL' } });
    fireEvent.change(screen.getByLabelText('Data'), { target: { value: '2026-11-09' } });
    fireEvent.change(screen.getByLabelText('Horário'), { target: { value: '10:00' } });
    fireEvent.change(screen.getByLabelText('Nome de quem fez a aula'), { target: { value: 'Sara Elisa' } });
    const submit = screen.getByRole('button', { name: /Lançar na folha/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Prova oral de avaliação de outra escola' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('create_manual_lesson_entry', expect.objectContaining({
      p_teacher_id: 'maria', p_kind: 'TESTE_ORAL', p_student_id: null, p_guest_name: 'Sara Elisa', p_rate_override: null,
    })));
    expect(await screen.findByText(/Entra na folha do professor: R\$\s?8,00/)).toBeTruthy();
  });

  it('mostra o erro do servidor em português', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'manual_lesson_options') return { data: OPTIONS, error: null };
      if (name === 'list_manual_lesson_entries') return { data: [], error: null };
      return { data: null, error: { message: 'mes_fechado' } };
    });
    render(<ManualLessonEntriesPanel />);
    await screen.findByText(/Nenhuma baixa manual/);
    fireEvent.change(screen.getByLabelText('Professor'), { target: { value: 'maria' } });
    fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'OUTRO' } });
    fireEvent.change(screen.getByLabelText('Data'), { target: { value: '2026-10-09' } });
    fireEvent.change(screen.getByLabelText('Horário'), { target: { value: '10:00' } });
    fireEvent.change(screen.getByLabelText('Nome de quem fez a aula'), { target: { value: 'Fulano' } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Aula avulsa do mês passado' } });
    fireEvent.click(screen.getByRole('button', { name: /Lançar na folha/ }));
    expect(await screen.findByText(/fechamento desse mês já foi feito/)).toBeTruthy();
  });
});
