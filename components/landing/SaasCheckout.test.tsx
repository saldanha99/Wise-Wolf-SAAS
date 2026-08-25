import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../lib/supabase', () => ({
  supabase: { functions: { invoke } },
}));

import SaasCheckout from './SaasCheckout';

const plan = {
  id: '00000000-0000-4000-8000-000000000200',
  name: 'School OS Pro',
  price: 397,
  price_yearly: 3970,
};

describe('checkout premium do School OS', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({
      data: {
        success: true,
        invoice_url: 'https://billing.example.invalid/invoice',
        value: 397,
      },
      error: null,
    });
  });

  it('não renderiza PAN/CVV e envia somente PIX ou boleto', async () => {
    render(<SaasCheckout plan={plan} yearly={false} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Wise Wolf Centro'), {
      target: { value: 'Escola Horizonte' },
    });
    fireEvent.change(screen.getByPlaceholderText('João Silva'), {
      target: { value: 'Marina Silva' },
    });
    fireEvent.change(screen.getByPlaceholderText('voce@escola.com.br'), {
      target: { value: 'marina@example.invalid' },
    });
    fireEvent.change(screen.getByPlaceholderText('000.000.000-00'), {
      target: { value: '11.222.333/0001-81' },
    });
    fireEvent.change(screen.getByPlaceholderText('(11) 99999-9999'), {
      target: { value: '(11) 99999-0000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continuar/i }));

    expect(screen.queryByText(/^Cartão$/i)).toBeNull();
    expect(screen.queryByText(/CVV/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/0000 0000/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /boleto/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirmar/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const payload = invoke.mock.calls[0]?.[1]?.body;
    expect(invoke).toHaveBeenCalledWith('create-saas-checkout', {
      body: expect.objectContaining({
        billing_type: 'BOLETO',
        billing_cycle: 'MONTHLY',
        plan_id: plan.id,
      }),
    });
    expect(payload).not.toHaveProperty('creditCard');
    expect(JSON.stringify(payload).toLowerCase()).not.toContain('ccv');
    expect(await screen.findByText(/contratação foi registrada/i)).toBeTruthy();
  });
});
