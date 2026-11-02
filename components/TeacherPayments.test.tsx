import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), update: vi.fn(), getSession: vi.fn() }));
const invoice = {
  id: 'closing-fixture', teacher_id: 'teacher-fixture', month_year: '2026-09',
  total_amount: 126, total_lessons: 12, status: 'PENDENTE',
  teacher: { full_name: 'Professor fixture', email: 'fixture@example.invalid', avatar_url: null },
};
vi.mock('../lib/supabase', () => ({
  FUNCTIONS_URL: 'https://example.invalid/functions',
  supabase: {
    rpc: mocks.rpc, auth: { getSession: mocks.getSession },
    from: () => {
      const query = { select: () => query, eq: () => query, order: async () => ({ data: [invoice], error: null }), update: mocks.update };
      return query;
    },
  },
}));
vi.mock('./TeacherPixKey', () => ({ default: () => null }));
vi.mock('./TeacherPayrollReportModal', () => ({ default: () => null }));
vi.mock('./AjusteRepasseModal', () => ({ default: () => null }));
vi.mock('./InvoiceReviewModal', () => ({ default: () => null }));
import TeacherPayments from './TeacherPayments';

describe('confirmação de PIX do professor', () => {
  beforeEach(() => {
    mocks.rpc.mockReset(); mocks.update.mockReset(); mocks.getSession.mockReset();
    mocks.rpc.mockImplementation(async (name: string) => name === 'payroll_month_preview'
      ? { data: { teachers: [] }, error: null }
      : { data: { ok: true, notice: { ok: true } }, error: null });
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('registra baixa pela RPC após confirmar o PIX realizado, sem iniciar transferência', async () => {
    render(<TeacherPayments tenantId="school-fixture" />);
    fireEvent.click(await screen.findByTitle('Confirmar PIX já realizado e avisar o professor'));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('confirm_teacher_payout', { p_closing_id: 'closing-fixture' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('R$ 126,00'));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('cancelar a confirmação não marca pago nem prepara aviso', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<TeacherPayments tenantId="school-fixture" />);
    fireEvent.click(await screen.findByTitle('Confirmar PIX já realizado e avisar o professor'));
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'confirm_teacher_payout')).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('baixa registrada sem contato preparado avisa a direção', async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === 'payroll_month_preview'
      ? { data: { teachers: [] }, error: null }
      : { data: { ok: true, notice: { ok: false, reason: 'payout_phone_missing' } }, error: null });
    render(<TeacherPayments tenantId="school-fixture" />);
    fireEvent.click(await screen.findByTitle('Confirmar PIX já realizado e avisar o professor'));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('confira o WhatsApp')));
  });
});
