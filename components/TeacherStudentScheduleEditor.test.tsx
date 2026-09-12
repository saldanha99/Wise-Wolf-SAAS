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
    : { data: { ok: true, id: 'request-test', status: 'PENDING_FAMILY' }, error: null }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
const props = { studentId: 'student-test', studentName: 'Aluno Teste', tenantId: 'tenant-test', teacherId: 'teacher-test', onClose: vi.fn() };
describe('professor solicita mudança de agenda', () => {
  it('envia motivo e vigência à RPC de solicitação e preserva o horário atual', async () => {
    render(<TeacherStudentScheduleEditor {...props} />);
    const day = await screen.findByRole('combobox', { name: 'Dia proposto para Segunda 08:00' });
    fireEvent.change(day, { target: { value: 'Terça' } });
    fireEvent.change(screen.getByPlaceholderText(/explique o motivo/i), { target: { value: 'Preciso solicitar uma revisão familiar da agenda.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Aguarde o aceite da família');
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('request_booking_schedule_change', expect.objectContaining({ p_booking_id: 'booking-test', p_new_day: 'Terça', p_scope: 'PERMANENT', p_reason: 'Preciso solicitar uma revisão familiar da agenda.', p_initiated_by: 'TEACHER' })));
    expect(rpc.mock.calls.some(([name]) => name === 'change_booking_schedule')).toBe(false);
    expect(day).toHaveValue('Segunda');
  });
  it('impede solicitação sem motivo e apresenta erro sem anunciar mudança', async () => {
    render(<TeacherStudentScheduleEditor {...props} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Dia proposto para Segunda 08:00' }), { target: { value: 'Terça' } });
    expect(screen.getByRole('button', { name: 'Solicitar' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/explique o motivo/i), { target: { value: 'Motivo suficientemente explicado à família.' } });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'schedule_change_one_pending_idx duplicate key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar' }));
    expect(await screen.findByText(/já existe uma proposta pendente/i)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
