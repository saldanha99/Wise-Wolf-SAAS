import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BillingMethodManager from './BillingMethodManager';

const card = () => {
  fireEvent.change(screen.getByPlaceholderText('Nome impresso no cartão'), { target: { value: 'Aluno Teste' } });
  fireEvent.change(screen.getByPlaceholderText('Número do cartão'), { target: { value: '4111111111111111' } });
  fireEvent.change(screen.getByPlaceholderText('MM'), { target: { value: '12' } });
  fireEvent.change(screen.getByPlaceholderText('AAAA'), { target: { value: '2030' } });
  fireEvent.change(screen.getByPlaceholderText('CVV'), { target: { value: '123' } });
};

afterEach(() => vi.restoreAllMocks());

describe('<BillingMethodManager />', () => {
  it('confirma e cobra a fatura vencida, preservando a recorrência', async () => {
    const load = vi.fn().mockResolvedValue({
      success: true,
      billingType: 'PIX',
      subscriptionStatus: 'ACTIVE',
      overdue: {
        count: 1,
        total: 229,
        oldestDueDate: '2026-08-10',
        confirmationKey: 'pay_august',
      },
    });
    const update = vi.fn().mockResolvedValue({
      success: true,
      billingType: 'CREDIT_CARD',
      pendingPaymentsUpdated: true,
      cardChargedNow: true,
      chargedNowCount: 1,
      chargedNowTotal: 229,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<BillingMethodManager studentId="student-1" loadBillingMethod={load} updateBillingMethod={update} />);
    await screen.findByText(/Atual no Asaas:/i);
    fireEvent.click(screen.getByRole('button', { name: 'Cartão' }));
    expect(screen.getByText(/fatura vencida em 10\/08\/2026 será cobrado agora/i)).toBeInTheDocument();
    card();
    fireEvent.click(screen.getByRole('button', { name: /mudar para cartão/i }));

    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/cobrança imediata de R\$\s*229,00/i)));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'student-1',
      billingType: 'CREDIT_CARD',
      overdueConfirmationKey: 'pay_august',
    })));
    expect(await screen.findByText(/Fatura vencida cobrada agora/i)).toBeInTheDocument();
  });

  it('não cobra agora quando o aluno está em dia', async () => {
    const load = vi.fn().mockResolvedValue({
      success: true,
      billingType: 'PIX',
      subscriptionStatus: 'ACTIVE',
      overdue: {
        count: 0,
        total: 0,
        oldestDueDate: null,
        confirmationKey: 'NO_OVERDUE_PAYMENTS',
      },
    });
    const update = vi.fn().mockResolvedValue({
      success: true,
      billingType: 'CREDIT_CARD',
      pendingPaymentsUpdated: true,
      cardChargedNow: false,
      chargedNowCount: 0,
      chargedNowTotal: 0,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<BillingMethodManager studentId="student-2" loadBillingMethod={load} updateBillingMethod={update} />);
    await screen.findByText(/Atual no Asaas:/i);
    fireEvent.click(screen.getByRole('button', { name: 'Cartão' }));
    expect(screen.getByText(/O aluno está em dia: nada será cobrado agora/i)).toBeInTheDocument();
    card();
    fireEvent.click(screen.getByRole('button', { name: /mudar para cartão/i }));

    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/nenhuma cobrança será feita agora/i)));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'student-2',
      overdueConfirmationKey: 'NO_OVERDUE_PAYMENTS',
    })));
    expect(await screen.findByText(/nenhuma cobrança foi feita agora/i)).toBeInTheDocument();
  });
});
