import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OralTestsPanel from './OralTestsPanel';
import { UserRole } from '../types';

const { rpc, from, test } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), test: { id: 'test', student_id: 'student', native_teacher_id: 'native', examiner_id: 'examiner', status: 'SCHEDULED', cycle_start: '2026-09-01', due_date: '2026-10-15', scheduled_at: '2026-10-15T22:00:00Z', appointment_id: 'reservation', done_at: null } }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, from } }));
beforeEach(() => {
  rpc.mockReset(); from.mockReset();
  from.mockImplementation((table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order']) query[method] = vi.fn(() => query);
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: table === 'oral_tests' ? [test] : [{ id: 'examiner', full_name: 'Examinadora', can_oral_test: true }], error: null }));
    return query;
  });
  rpc.mockImplementation((name: string) => Promise.resolve({ data: name === 'oral_test_panel_context' ? [{ id: 'test', student_name: 'Aluno Fixture', notices: { ORAL_TEST_STUDENT: 'queued', ORAL_TEST_TEACHER: 'accepted' } }] : { reserved: true, notices: { ORAL_TEST_STUDENT: 'queued', ORAL_TEST_TEACHER: 'queued' } }, error: null }));
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});
describe('agendamento oral conectado à agenda e aos avisos', () => {
  it('mostra a fila e o aceite sem afirmar que houve entrega', async () => {
    render(<OralTestsPanel user={{ id: 'admin', role: UserRole.SCHOOL_ADMIN }} tenantId="tenant" />);
    expect(await screen.findByText('Aluno Fixture')).toBeInTheDocument();
    expect(screen.getByText(/Aviso aluno: na fila/)).toHaveTextContent('Aviso examinador: aceito pelo WhatsApp');
  });
  it('reagendamento preserva examinador e horário atual e trata erro de conflito', async () => {
    render(<OralTestsPanel user={{ id: 'admin', role: UserRole.SCHOOL_ADMIN }} tenantId="tenant" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reagendar' }));
    expect(screen.getByRole('combobox')).toHaveValue('examiner');
    expect(document.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.value).not.toBe('');
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'schedule_oral_test' ? { error: { message: 'O examinador já tem um compromisso nesse horário.' }, data: null } : { data: [], error: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('já tem um compromisso')));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('schedule_oral_test', expect.objectContaining({ p_test_id: 'test', p_examiner_id: 'examiner', p_scheduled_at: test.scheduled_at.replace('00Z','00.000Z') }));
  });
});
