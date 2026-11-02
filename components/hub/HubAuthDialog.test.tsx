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
    expect(
      await screen.findByText(/A confirmação do e-mail, sozinha, não ativa plano nem cria cobrança/),
    ).toBeInTheDocument();
  });
});

describe('Cadastro pelo convite do professor', () => {
  beforeEach(() => {
    authMocks.signUp.mockReset().mockResolvedValue({ data: { session: { access_token: 'x' } }, error: null });
  });

  it('fala com o aluno, não com o educador, e cadastra a conta como LEARNER', async () => {
    const onAuthenticated = vi.fn();
    render(
      <HubAuthDialog
        initialMode="signup"
        initialAudience="LEARNER"
        invite={{ teacher_name: 'Teacher Lu', learner_name: 'Pedro' }}
        onClose={vi.fn()}
        onAuthenticated={onAuthenticated}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Entre na turma de Teacher Lu' })).toBeInTheDocument();
    expect(screen.getByText('Conta de aluno de Teacher Lu')).toBeInTheDocument();
    expect(screen.queryByText('Acesso profissional para educadores')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Seu nome'), { target: { value: 'Pedro Alves' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'pedro@example.com' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'senha-segura' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar na turma' }));

    await waitFor(() => expect(authMocks.signUp).toHaveBeenCalledTimes(1));
    expect(authMocks.signUp.mock.calls[0][0].options.data.hub_audience).toBe('LEARNER');
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('LEARNER', 'Pedro Alves'));
  });
});
