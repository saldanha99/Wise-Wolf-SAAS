import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CourseRenewalProposals from './CourseRenewalProposals';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const proposal = { id: 'draft-1', student_name: 'Aluna de teste', term_months: 6, monthly_fee_cents: 26100, total_cents: 156600, classes_per_week: 3, suggested_due_day: 10, status: 'DRAFT', signature_status: 'NOT_REQUESTED', billing_status: 'NOT_AUTHORIZED' };
beforeEach(() => rpc.mockReset());
describe('CourseRenewalProposals', () => {
  it('shows the commercial conditions without promising a signature or a payment', async () => {
    rpc.mockResolvedValue({ data: { items: [proposal] }, error: null });
    render(<CourseRenewalProposals tenantId="school-a" />);
    expect(await screen.findByText('Aluna de teste')).toBeInTheDocument();
    expect(screen.getByText(/Ainda não há contrato reassinado/)).toBeInTheDocument();
    expect(screen.getByText(/1\.566,00/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('list_student_course_renewal_proposals', { p_tenant: 'school-a' });
  });
  it('fails closed on incorrect term, total or signature state', async () => {
    rpc.mockResolvedValue({ data: { items: [{ ...proposal, total_cents: 1 }] }, error: null });
    render(<CourseRenewalProposals tenantId="school-a" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Aluna de teste')).not.toBeInTheDocument();
    rpc.mockResolvedValue({ data: { items: [{ ...proposal, signature_status: 'SIGNED' }] }, error: null });
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
  it('does not show an old tenant response after switching tenants', async () => {
    let finish!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    rpc.mockResolvedValueOnce({ data: { items: [] }, error: null });
    const { rerender } = render(<CourseRenewalProposals tenantId="school-a" />);
    rerender(<CourseRenewalProposals tenantId="school-b" />);
    await act(async () => finish({ data: { items: [proposal] }, error: null }));
    expect(screen.queryByText('Aluna de teste')).not.toBeInTheDocument();
  });
  it('permits a read retry, never an external write', async () => {
    rpc.mockRejectedValueOnce(new Error('offline'));
    rpc.mockResolvedValueOnce({ data: { items: [proposal] }, error: null });
    render(<CourseRenewalProposals tenantId="school-a" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Aluna de teste')).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
