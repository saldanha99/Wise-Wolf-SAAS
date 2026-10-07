import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeacherStudentScheduleEditor from './TeacherStudentScheduleEditor';

const { rpc, from, rows } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), rows: [{ id: 'booking-test', day_of_week: 'Segunda', time_slot: '08:00' }] }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, from } }));
beforeEach(() => {
  rpc.mockReset(); from.mockReset();
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order']) query[method] = vi.fn(() => query);
  query.then = (resolve: (data: unknown) => unknown) => Promise.resolve(resolve({ data: rows, error: null }));
  from.mockReturnValue(query);
  rpc.mockImplementation((name: string) => Promise.resolve(name === 'booking_schedule_on_date'
    ? { data: { day_of_week: 'Segunda', time_slot: '08:00', valid: false }, error: null }
    : name === 'teacher_apply_student_schedule_change'
      ? { data: { ok: true, changed: 1, notification_queued: true }, error: null }
      : { data: { ok: true, id: 'request-test', status: 'PENDING_FAMILY' }, error: null }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
const props = { studentId: 'student-test', studentName: 'Aluno Teste', tenantId: 'tenant-test', teacherId: 'teacher-test', onClose: vi.fn() };
describe('professor altera o horário do próprio aluno', () => {
  it('aplica a troca permanente direto e avisa que a Gestão foi informada', async () => {
    render(<TeacherStudentScheduleEditor {...props} />);
    const day = await screen.findByRole('combobox', { name: 'Dia proposto para Segunda 08:00' });
    fireEvent.change(day, { target: { value: 'Terça' } });
    fireEvent.change(screen.getByPlaceholderText(/explique o motivo/i), { target: { value: 'Aluno pediu para estudar de manhã.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar troca (1)' }));
    expect(await screen.findByRole('status')).toHaveTextContent('O aviso à coordenação foi colocado na fila');
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('teacher_apply_student_schedule_change', expect.objectContaining({
      p_student_id: 'student-test',
      p_changes: [{ booking_id: 'booking-test', new_day: 'Terça', new_time: '08:00' }],
      p_reason: 'Aluno pediu para estudar de manhã.',
    })));
    expect(rpc.mock.calls.some(([name]) => name === 'request_booking_schedule_change' || name === 'change_booking_schedule')).toBe(false);
  });
  it('não aplica sem motivo e mostra o choque de agenda sem anunciar mudança', async () => {
    render(<TeacherStudentScheduleEditor {...props} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Dia proposto para Segunda 08:00' }), { target: { value: 'Terça' } });
    expect(screen.getByRole('button', { name: 'Aplicar troca (1)' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/explique o motivo/i), { target: { value: 'Motivo suficientemente explicado.' } });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Choque de agenda: Terça às 08:00 já está ocupado.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar troca (1)' }));
    expect(await screen.findByText('Choque de agenda: Terça às 08:00 já está ocupado.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it.each([
    ['invalid_enrollment_booking_link', 'aula vinculada à matrícula'],
    ['booking_conflicts_with_enrollment_reservation', 'reservado para uma matrícula em andamento'],
    ['Sessão expirada. Entre novamente.', 'Sessão expirada. Entre novamente.'],
    ['permission denied for table internal_table', 'Seus dados foram mantidos. Tente novamente'],
  ])('explica a falha %s sem culpar campos válidos e permite tentar de novo', async (message, expected) => {
    const onChanged = vi.fn();
    render(<TeacherStudentScheduleEditor {...props} onChanged={onChanged} />);
    fireEvent.change(await screen.findByLabelText('Horário proposto para Segunda 08:00'), { target: { value: '16:30' } });
    fireEvent.change(screen.getByLabelText('A partir de'), { target: { value: '2026-10-12' } });
    fireEvent.change(screen.getByPlaceholderText(/explique o motivo/i), { target: { value: 'solicitação do aluno para escola' } });
    rpc.mockResolvedValueOnce({ data: null, error: { message } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar troca (1)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    expect(screen.getByPlaceholderText(/explique o motivo/i)).toHaveValue('solicitação do aluno para escola');
    expect(screen.getByLabelText('A partir de')).toHaveValue('2026-10-12');
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar troca (1)' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Horário alterado a partir de 12/10/2026');
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it('troca de uma aula só continua como solicitação à escola', async () => {
    render(<TeacherStudentScheduleEditor {...props} />);
    await screen.findByRole('combobox', { name: 'Dia proposto para Segunda 08:00' });
    fireEvent.change(screen.getByLabelText(/tipo de mudança/i), { target: { value: 'ONE_OFF' } });
    expect(screen.getByRole('button', { name: 'Solicitar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /aplicar troca/i })).not.toBeInTheDocument();
  });
});
