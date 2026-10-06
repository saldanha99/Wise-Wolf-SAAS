import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LessonAdvancesManager, { advanceDateLimit } from './LessonAdvancesManager';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, from } }));

beforeEach(() => {
  vi.clearAllMocks();
  from.mockImplementation((table: string) => {
    const result = { data: table === 'profiles' ? [{ id: 'student', full_name: 'Aluno teste' }] : [], error: null };
    const query: Record<string, unknown> = {};
    for (const key of ['select', 'eq', 'order']) query[key] = vi.fn(() => query);
    query.limit = vi.fn(() => Promise.resolve(result));
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return query;
  });
  rpc.mockResolvedValue({ data: [{ booking_id: 'booking', original_date: '2026-11-08', start_time: '14:30', teacher_name: 'Teacher teste' }], error: null });
});

it('limita a realização ao mês anterior inclusive em janeiro e ano bissexto', () => {
  expect(advanceDateLimit('2026-10-08')).toBe('2026-09-30');
  expect(advanceDateLimit('2027-01-05')).toBe('2026-12-31');
  expect(advanceDateLimit('2028-03-05')).toBe('2028-02-29');
});

describe('lista de antecipações', () => {
  it('consulta a agenda canônica e recarrega ao atualizar', async () => {
    render(<LessonAdvancesManager tenantId="school" />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'student' } });
    await screen.findByText('Teacher teste');
    expect(rpc).toHaveBeenCalledWith('list_lesson_advance_candidates', expect.objectContaining({ p_student_id: 'student' }));
    expect(from).not.toHaveBeenCalledWith('bookings');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar aula de 08/11/2026' }));
    expect(screen.getByLabelText('Nova data da aula de 08/11/2026')).toHaveAttribute('max', '2026-10-31');
    rpc.mockResolvedValue({ data: [], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await screen.findByText(/Não há aulas futuras disponíveis/);
    expect(screen.queryByText('Teacher teste')).not.toBeInTheDocument();
  });

  it('não libera lista antiga enquanto consulta outro aluno ou mês', async () => {
    render(<LessonAdvancesManager tenantId="school" />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'student' } });
    await screen.findByText('Teacher teste');
    rpc.mockReturnValue(new Promise(() => {}));
    fireEvent.change(screen.getByDisplayValue(/^\d{4}-\d{2}$/), { target: { value: '2026-12' } });
    await screen.findByRole('status');
    expect(screen.queryByText('Teacher teste')).not.toBeInTheDocument();
    expect(screen.queryByText(/Não há aulas futuras/)).not.toBeInTheDocument();
  });

  it('bloqueia data no mesmo mês antes de enviar a criação', async () => {
    render(<LessonAdvancesManager tenantId="school" />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'student' } });
    await screen.findByText('Teacher teste');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar aula de 08/11/2026' }));
    fireEvent.change(screen.getByLabelText('Nova data da aula de 08/11/2026'), { target: { value: '2026-11-01' } });
    fireEvent.click(screen.getByRole('button', { name: /Criar 1/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('mês anterior');
    expect(rpc.mock.calls.some(([name]) => name === 'create_lesson_advances')).toBe(false);
  });

  it('exibe recusa do servidor em português preservando o preenchimento', async () => {
    render(<LessonAdvancesManager tenantId="school" />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'student' } });
    await screen.findByText('Teacher teste');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar aula de 08/11/2026' }));
    fireEvent.change(screen.getByLabelText('Nova data da aula de 08/11/2026'), { target: { value: '2026-10-01' } });
    rpc.mockResolvedValue({ error: { message: 'lesson_advance_origin_must_be_future' } });
    fireEvent.click(screen.getByRole('button', { name: /Criar 1/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('posterior a hoje'));
    expect(screen.getByLabelText('Nova data da aula de 08/11/2026')).toHaveValue('2026-10-01');
  });
});
