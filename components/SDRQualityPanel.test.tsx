import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SDRQualityPanel from './SDRQualityPanel';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const report = (name = 'Aluno de teste') => ({ generated_at: new Date().toISOString(), days: 7, viewer_id: 'owner', metrics: {
  leads: 10, trials: 4, enrollments: 1, unanswered: 0, attention: 1, sent: 20, suspected_duplicates: 1,
  acceptance_minutes: null, acceptance_samples: 0, delivery_failures: 0,
}, attention: [{ id: 'lead-a', name, phone: '5511999999999', reason: 'delivery_review', waiting_since: new Date().toISOString(), owner_id: null, owner_name: null }] });
beforeEach(() => rpc.mockReset());
afterEach(() => vi.restoreAllMocks());
describe('Qualidade da IA', () => {
  it('shows the exact cohort and distinguishes suspected duplicates from proven delivery', async () => {
    rpc.mockResolvedValue({ data: report(), error: null });
    render(<SDRQualityPanel tenantId="school-a" />);
    expect(await screen.findByText('40%')).toBeInTheDocument();
    expect(screen.getByText('Possíveis repetições')).toBeInTheDocument();
    expect(screen.getByText('0 aceites de experimental e remarcação')).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('sdr_operations_dashboard', { p_tenant_id: 'school-a', p_days: 7 });
  });
  it('does not show an empty queue as success when the server refuses access', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'forbidden' } });
    render(<SDRQualityPanel tenantId="school-a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar');
    expect(screen.queryByText('Nenhuma pendência para este filtro.')).not.toBeInTheDocument();
  });
  it('shows ownership races without pretending the case was taken', async () => {
    rpc.mockResolvedValueOnce({ data: report(), error: null }).mockResolvedValueOnce({ data: { ok: false, error: 'already_assigned' }, error: null });
    render(<SDRQualityPanel tenantId="school-a" />);
    fireEvent.click(await screen.findByText('Assumir atendimento'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Outra pessoa já assumiu');
    expect(rpc).toHaveBeenLastCalledWith('manage_sdr_attention', { p_tenant_id: 'school-a', p_lead_id: 'lead-a', p_action: 'take' });
  });
  it('updates the period and filters the attention reasons', async () => {
    rpc.mockResolvedValue({ data: report(), error: null });
    render(<SDRQualityPanel tenantId="school-a" />);
    await screen.findByText('Aluno de teste');
    fireEvent.change(screen.getByLabelText('Motivo da pendência'), { target: { value: 'teacher_timeout' } });
    expect(screen.queryByText('Aluno de teste')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Período dos indicadores'), { target: { value: '30' } });
    await waitFor(() => expect(rpc).toHaveBeenLastCalledWith('sdr_operations_dashboard', { p_tenant_id: 'school-a', p_days: 30 }));
  });
  it('ignores stale data returned after changing schools', async () => {
    let finishOld: (value: unknown) => void = () => {};
    rpc.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValue({ data: report('Aluno da escola B'), error: null });
    const { rerender } = render(<SDRQualityPanel tenantId="school-a" />);
    rerender(<SDRQualityPanel tenantId="school-b" />);
    await screen.findByText('Aluno da escola B');
    finishOld({ data: report('Aluno da escola A'), error: null });
    await waitFor(() => expect(screen.queryByText('Aluno da escola A')).not.toBeInTheDocument());
  });
});
