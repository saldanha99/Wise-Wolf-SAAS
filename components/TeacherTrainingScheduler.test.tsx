import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import TeacherTrainingScheduler from './TeacherTrainingScheduler';
import { renderTrainingInvite } from '../supabase/functions/teacher-training-invite/page';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const data = { teachers: [{ id: 'trainer', name: 'Mateus', is_trainer: true }, { id: 'trainee', name: 'Teacher Maria', is_trainer: false }], sessions: [] };
beforeEach(() => rpc.mockReset());
describe('directed teacher training', () => {
  it('schedules the chosen pair with a Brasília timestamp and stable retry key', async () => {
    rpc.mockImplementation((method: string) => Promise.resolve(method === 'schedule_teacher_training' ? { error: { message: 'Falha temporária' } } : { data }));
    render(<TeacherTrainingScheduler tenantId="school-fixture" />);
    await screen.findByRole('option', { name: 'Teacher Maria' });
    fireEvent.change(screen.getByLabelText('Teacher que receberá o treinamento'), { target: { value: 'trainee' } });
    fireEvent.change(screen.getByLabelText('Data do treinamento'), { target: { value: '2099-09-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar e enviar convite' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Agendar e enviar convite' }));
    await waitFor(() => expect(rpc.mock.calls.filter(([m]) => m === 'schedule_teacher_training')).toHaveLength(2));
    const args = rpc.mock.calls.filter(([m]) => m === 'schedule_teacher_training').map(([,a]) => a);
    expect(args[0]).toEqual(args[1]);
    expect(args[0]).toMatchObject({ p_tenant: 'school-fixture', p_trainer: 'trainer', p_trainee: 'trainee', p_start: '2099-09-10T19:30:00.000Z' });
  });
  it('shows queue success separately from accepted training and payroll', async () => {
    rpc.mockImplementation((method: string) => Promise.resolve(method === 'schedule_teacher_training' ? { data: { ok: true } } : { data }));
    render(<TeacherTrainingScheduler tenantId="school-fixture" />);
    await screen.findByRole('option', { name: 'Teacher Maria' });
    fireEvent.change(screen.getByLabelText('Teacher que receberá o treinamento'), { target: { value: 'trainee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar e enviar convite' }));
    await screen.findByText(/convite entrou na fila/i);
    expect(screen.getByText(/O aceite confirma o horário/)).toBeTruthy();
  });
  it('renders a POST acceptance, escapes names, and hides the meeting link before acceptance', () => {
    const html = renderTrainingInvite({ ok: true, status: 'PENDING', trainer: '<script>alert(1)</script>', trainee: 'Maria', starts_at: '2026-09-10T19:30:00Z', meeting_link: 'javascript:alert(1)' }, 'a'.repeat(64));
    expect(html).toContain('method="post"'); expect(html).toContain('16:30');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('javascript:');
    expect(html).not.toContain('Abrir sala');
    const accepted = renderTrainingInvite({ ok: true, status: 'CONFIRMED', trainer: 'Mateus', trainee: 'Maria', starts_at: '2026-09-10T19:30:00Z', meeting_link: 'https://example.invalid/room' }, 'a'.repeat(64));
    expect(accepted).toContain('Abrir sala'); expect(accepted).not.toContain('<form');
  });
});
