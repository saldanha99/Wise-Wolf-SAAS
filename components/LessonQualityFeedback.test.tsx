import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LessonQualityFeedback from './LessonQualityFeedback';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
beforeEach(() => rpc.mockReset());
describe('independent family quality feedback', () => {
  it('records unknown without confirming attendance', async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    render(<LessonQualityFeedback token="test-token" />);
    fireEvent.click(screen.getByText(/Relatar atraso/));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar para a qualidade' }));
    await screen.findByRole('status');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('submit_lesson_quality_feedback', { p_token: 'test-token', p_payload: { happened: 'UNKNOWN', punctuality: 'UNKNOWN', ended_early: 'UNKNOWN', reschedule_by: 'UNKNOWN', comment: '' } });
  });
  it('retains the form and allows retry when the server fails', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'failed' }, error: null }).mockResolvedValue({ data: { ok: true }, error: null });
    render(<LessonQualityFeedback confirmationId="audit-id" />);
    fireEvent.click(screen.getByText(/Relatar atraso/));
    fireEvent.change(screen.getByLabelText('O professor iniciou no horário combinado?'), { target: { value: 'LATE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar para a qualidade' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar para a qualidade' }));
    await waitFor(() => expect(rpc).toHaveBeenLastCalledWith('submit_my_lesson_quality_feedback', expect.objectContaining({ p_confirmation_id: 'audit-id', p_payload: expect.objectContaining({ punctuality: 'LATE' }) })));
    await screen.findByRole('status');
  });
});
