import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubPlan } from './types';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../lib/supabase', () => ({
  supabase: {
    functions: { invoke },
  },
}));

import HubCheckoutDialog from './HubCheckoutDialog';

const plan: HubPlan = {
  id: '00000000-0000-4000-8000-000000000101',
  code: 'EDUCATOR_PRO',
  name: 'Professor Pro',
  description: 'Biblioteca e planejamento nativos.',
  audience: 'EDUCATOR',
  product_family: 'HUB_CORE',
  price_monthly: 119,
  price_yearly: 1190,
  trial_days: 0,
  features: ['Biblioteca completa', 'Educador IA'],
  metadata: { popular: true },
};

const renderCheckout = () => render(
  <HubCheckoutDialog
    plan={plan}
    accountId="00000000-0000-4000-8000-000000000201"
    accountName="Estúdio Marina"
    email="marina@example.invalid"
    initialBillingCycle="YEARLY"
    onClose={vi.fn()}
  />,
);

describe('Checkout do Hub até a fronteira segura do Asaas', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({
      data: {
        planName: 'Professor Pro',
        amount: 1190,
        pix: { copyPaste: 'PIX_FIXTURE_SEM_VALOR' },
      },
      error: null,
    });
  });

  it('revisa os dados e cria somente a cobrança selecionada', async () => {
    renderCheckout();

    expect(screen.getByRole('button', { name: /anual/i })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByLabelText(/nome completo/i), {
      target: { value: 'Marina Professora' },
    });
    fireEvent.change(screen.getByLabelText(/cpf ou cnpj/i), {
      target: { value: '11.222.333/0001-81' },
    });
    fireEvent.change(screen.getByLabelText(/telefone com ddd/i), {
      target: { value: '(11) 99999-0000' },
    });
    expect(screen.getByRole('link', { name: /Termos de Uso/i })).toHaveAttribute('href', '/hub/termos');
    expect(screen.getByRole('link', { name: /Política de Privacidade/i })).toHaveAttribute('href', '/hub/privacidade');
    fireEvent.click(screen.getByRole('checkbox', { name: /Termos de Uso/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Política de Privacidade/i }));
    fireEvent.click(screen.getByRole('button', { name: /revisar assinatura/i }));

    expect(await screen.findByRole('heading', { name: /revise antes de gerar/i })).toBeTruthy();
    expect(screen.getByText(/Final 0181/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /gerar pix no asaas/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('create-hub-checkout', {
      body: expect.objectContaining({
        accountId: '00000000-0000-4000-8000-000000000201',
        planCode: 'EDUCATOR_PRO',
        productFamily: 'HUB_CORE',
        billingCycle: 'YEARLY',
        billingType: 'PIX',
        name: 'Marina Professora',
        email: 'marina@example.invalid',
        cpfCnpj: '11.222.333/0001-81',
        phone: '(11) 99999-0000',
        acceptedTerms: true,
        acceptedPrivacy: true,
        termsVersion: '2026-08-24',
        privacyVersion: '2026-08-24',
        requestKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      }),
    });
    expect(invoke.mock.calls[0]?.[1]?.body).not.toHaveProperty('testMode');
    expect(await screen.findByRole('heading', { name: /agora falta confirmar o pagamento/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /copiar pix/i })).toBeTruthy();
  });

  it('não libera produto quando a função recusa a cobrança', async () => {
    invoke.mockResolvedValue({
      data: { error: 'HUB_ACCOUNT_INACTIVE', code: 'HUB_ACCOUNT_INACTIVE' },
      error: null,
    });
    renderCheckout();

    fireEvent.change(screen.getByLabelText(/cpf ou cnpj/i), {
      target: { value: '11222333000181' },
    });
    fireEvent.change(screen.getByLabelText(/telefone com ddd/i), {
      target: { value: '11999990000' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Termos de Uso/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Política de Privacidade/i }));
    fireEvent.click(screen.getByRole('button', { name: /revisar assinatura/i }));
    fireEvent.click(await screen.findByRole('button', { name: /gerar pix no asaas/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/conta está suspensa ou encerrada/i);
    expect(screen.queryByRole('heading', { name: /agora falta confirmar o pagamento/i })).toBeNull();
  });

  it('bloqueia a revisão enquanto os dois aceites explícitos estiverem desmarcados', () => {
    renderCheckout();

    expect(screen.getByRole('checkbox', { name: /Termos de Uso/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Política de Privacidade/i })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText(/cpf ou cnpj/i), {
      target: { value: '11222333000181' },
    });
    fireEvent.change(screen.getByLabelText(/telefone com ddd/i), {
      target: { value: '11999990000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /revisar assinatura/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/Termos de Uso e a Política de Privacidade/i);
    expect(invoke).not.toHaveBeenCalled();
  });
});
