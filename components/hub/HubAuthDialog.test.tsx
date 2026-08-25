import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HubAuthDialog from './HubAuthDialog';
import { createHubCheckoutIntent } from './hubCheckoutIntent';

const authMocks = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: authMocks,
  },
}));

vi.mock('./HubMarketingShell', () => ({
  HUB_THEME_STORAGE_KEY: 'wise-wolf-hub-theme',
}));

describe('Hub email confirmation checkout intent', () => {
  beforeEach(() => {
    localStorage.clear();
    authMocks.signUp.mockReset().mockResolvedValue({ data: { session: null }, error: null });
    authMocks.signInWithPassword.mockReset();
  });

  it('carries plan and cycle in the safe redirect and avoids automatic activation claims', async () => {
    const checkoutIntent = createHubCheckoutIntent('HUB_COMPLETE', 'YEARLY')!;
    render(
      <HubAuthDialog
        initialMode="signup"
        initialAudience="EDUCATOR"
        checkoutIntent={checkoutIntent}
        onClose={vi.fn()}
        onAuthenticated={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Seu nome'), { target: { value: 'Maria Educadora' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'maria@example.com' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'senha-segura' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e continuar' }));

    await waitFor(() => expect(authMocks.signUp).toHaveBeenCalledTimes(1));
    const request = authMocks.signUp.mock.calls[0][0];
    const redirect = new URL(request.options.emailRedirectTo);
    expect(redirect.searchParams.get('hub_plan')).toBe('HUB_COMPLETE');
    expect(redirect.searchParams.get('hub_cycle')).toBe('YEARLY');
    expect(Number(redirect.searchParams.get('hub_expires'))).toBeGreaterThan(Date.now());
    expect(screen.getByText(/A confirmação do e-mail, sozinha, não ativa plano nem cria cobrança/)).toBeInTheDocument();
  });
});
