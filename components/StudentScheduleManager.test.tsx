import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StudentScheduleManager from './StudentScheduleManager';

const { rpc, from, state } = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(),
  state: { time: '16:00', fail: false },
}));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, from } }));
vi.mock('./TeacherTransferGenerator', () => ({ default: () => null }));
vi.mock('./DirectTeacherTransferModal', () => ({ default: () => null }));

const props = {
  studentId: 'student-test', tenantId: 'tenant-test', teachers: [],
  student: { id: 'student-test', full_name: 'Aluno Teste' },
};
beforeEach(() => {
  state.time = '16:00'; state.fail = false;
  rpc.mockReset(); from.mockReset();
  from.mockImplementation(() => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order']) query[method] = vi.fn(() => query);
    query.then = (resolve: (data: unknown) => unknown) => Promise.resolve(resolve({
      data: [{ id: 'booking-test', day_of_week: 'Segunda', time_slot: state.time, teacher_id: 'teacher-test', teacher: { full_name: 'Professor Teste' } }], error: null,
    }));
    return query;
  });
  rpc.mockImplementation(async (name: string) => {
    if (name === 'booking_schedule_on_date') return { data: { day_of_week: 'Segunda', time_slot: state.time }, error: null };
    if (state.fail) return { data: null, error: { message: 'Choque de agenda: Segunda às 16:30 já está ocupado.' } };
    state.time = '16:30';
    return { data: { ok: true, changed: 1, notification_queued: true }, error: null };
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

async function draftChange() {
  fireEvent.click(await screen.findByRole('button', { name: 'Alterar horário de Segunda 16:00' }));
  fireEvent.change(await screen.findByLabelText('Horário proposto para Segunda 16:00'), { target: { value: '16:30' } });
  fireEvent.change(screen.getByPlaceholderText(/explique o motivo/i), { target: { value: 'Horário combinado pela direção.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar troca (1)' }));
}

describe('troca de horário no gerenciador da direção', () => {
  it('salva 16:30 pela RPC com vigência e atualiza a agenda e o mapa pai', async () => {
    const onUpdate = vi.fn();
    render(<StudentScheduleManager {...props} onUpdate={onUpdate} />);
    await draftChange();
    expect(await screen.findByRole('status')).toHaveTextContent('Horário alterado a partir de');
    expect(rpc).toHaveBeenCalledWith('teacher_apply_student_schedule_change', expect.objectContaining({
      p_student_id: props.studentId,
      p_changes: [{ booking_id: 'booking-test', new_day: 'Segunda', new_time: '16:30' }],
      p_effective_from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      p_reason: 'Horário combinado pela direção.',
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Alterar horário de Segunda 16:30' })).toBeInTheDocument());
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.some(([name]) => name === 'change_booking_schedule')).toBe(false);
  });

  it('mantém 16:00 e não anuncia sucesso nem atualiza o pai quando há conflito', async () => {
    state.fail = true;
    const onUpdate = vi.fn();
    render(<StudentScheduleManager {...props} onUpdate={onUpdate} />);
    await draftChange();
    expect(await screen.findByText('Choque de agenda: Segunda às 16:30 já está ocupado.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Alterar horário de Segunda 16:00' })).toBeInTheDocument();
  });
});
