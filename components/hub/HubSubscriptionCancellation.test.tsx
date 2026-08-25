import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HubPortal from './HubPortal';
import type { HubAuthorityRole, HubBootstrap, HubPlan, HubSettings } from './types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

const accountId = '11111111-1111-4111-8111-111111111111';
const accessEndsAt = '2099-02-10T12:00:00.000Z';

const settings: HubSettings = {
  settings_key: 'default',
  brand_name: 'Wise Wolf Hub',
  headline: 'Hub',
  subheadline: null,
  saas_video_url: null,
  saas_cta_url: '/new-saas',
  support_url: null,
  metadata: { catalogReady: true },
};

const plan: HubPlan = {
  id: '22222222-2222-4222-8222-222222222222',
  code: 'EDUCATOR_PRO',
  name: 'Professor Pro',
  description: 'Plano ativo',
  audience: 'EDUCATOR',
  price_monthly: 119,
  price_yearly: 1190,
  trial_days: 0,
  features: [],
  metadata: {},
  product_family: 'HUB_CORE',
};

const bootstrap = (
  membershipRole: HubAuthorityRole,
  cancelAtPeriodEnd = false,
): HubBootstrap => ({
  account: {
    id: accountId,
    name: 'Conta Professora Marina',
    account_type: 'PERSONAL',
    audience: 'EDUCATOR',
    status: 'ACTIVE',
    metadata: {},
  },
  membership: { membership_role: membershipRole, status: 'ACTIVE' },
  memberProfile: {
    display_name: 'Marina',
    subjectRole: 'EDUCATOR',
    onboarding_completed: true,
  },
  subscription: {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'ACTIVE',
    trial_ends_at: null,
    current_period_ends_at: accessEndsAt,
    product_family: 'HUB_CORE',
    metadata: cancelAtPeriodEnd
      ? { cancelAtPeriodEnd: true, accessEndsAt }
      : {},
  } as HubBootstrap['subscription'],
  plan,
  entitlements: {},
  settings,
  isManager: membershipRole === 'OWNER' || membershipRole === 'ADMIN',
});

const renderPortal = (
  membershipRole: HubAuthorityRole,
  cancelAtPeriodEnd = false,
  onRefresh = vi.fn().mockResolvedValue(undefined),
) => {
  render(
    <HubPortal
      bootstrap={bootstrap(membershipRole, cancelAtPeriodEnd)}
      plans={[plan]}
      settings={settings}
      content={[]}
      userId="44444444-4444-4444-8444-444444444444"
      userEmail="marina@example.invalid"
      onRefresh={onRefresh}
      onLogout={async () => {}}
      initialTab="plans"
    />,
  );
  return { onRefresh };
};

describe('Cancelamento self-service do Hub Core', () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue({
      data: {
        success: true,
        cancelAtPeriodEnd: true,
        accessEndsAt,
      },
      error: null,
    });
  });

  it.each(['OWNER', 'ADMIN'] as const)('permite %s confirmar em duas etapas', async (role) => {
    const { onRefresh } = renderPortal(role);

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar renovação' }));
    const finalButton = screen.getByRole('button', { name: 'Confirmar cancelamento' }) as HTMLButtonElement;
    expect(finalButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Digite CANCELAR para confirmar'), {
      target: { value: 'CANCELAR' },
    });
    expect(finalButton.disabled).toBe(false);
    fireEvent.click(finalButton);

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      'cancel-hub-subscription',
      { body: { accountId, confirmation: 'CANCELAR' } },
    ));
    expect(await screen.findByText('Renovação cancelada')).toBeTruthy();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('não expõe o cancelamento para MEMBER', () => {
    renderPortal('MEMBER');
    expect(screen.queryByRole('button', { name: 'Cancelar renovação' })).toBeNull();
  });

  it('mostra o fim do acesso sem oferecer uma segunda cobrança ou cancelamento', () => {
    renderPortal('OWNER', true);
    expect(screen.getByText('Renovação cancelada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancelar renovação' })).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
