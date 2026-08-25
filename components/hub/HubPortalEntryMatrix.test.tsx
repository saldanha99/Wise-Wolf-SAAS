import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubBootstrap, HubSettings } from './types';

const bridge = vi.hoisted(() => ({
  initialTab: null as string | null,
}));

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  loadHubAccounts: vi.fn(),
  loadHubBootstrap: vi.fn(),
  loadHubPublicData: vi.fn(),
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      signOut: vi.fn(),
    },
  },
}));

vi.mock('./HubPortal', () => ({
  default: (props: Record<string, unknown>) => {
    bridge.initialTab = String(props.initialTab);
    return <div>Portal aberto em {String(props.initialTab)}</div>;
  },
}));

vi.mock('./HubLanding', () => ({ default: () => null }));
vi.mock('./HubAudienceLanding', () => ({ default: () => null }));
vi.mock('./HubSolutionLanding', () => ({ default: () => null }));
vi.mock('./HubAuthDialog', () => ({ default: () => null }));
vi.mock('./useHubHashNavigation', () => ({ useHubHashNavigation: vi.fn() }));
vi.mock('./hubService', () => ({
  DEFAULT_HUB_SETTINGS: {
    settings_key: 'default',
    brand_name: 'Wise Wolf Hub',
    headline: 'Hub',
    subheadline: null,
    saas_video_url: null,
    saas_cta_url: '/new-saas',
    support_url: null,
    metadata: {},
  },
  claimHubTrial: vi.fn(),
  isHubEnabled: () => true,
  loadHubAccounts: mocks.loadHubAccounts,
  loadHubBootstrap: mocks.loadHubBootstrap,
  loadHubPublicData: mocks.loadHubPublicData,
  trackHubEvent: vi.fn(),
}));

import HubApp from './HubApp';

const accountId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

const settings: HubSettings = {
  settings_key: 'default',
  brand_name: 'Wise Wolf Hub',
  headline: 'Hub',
  subheadline: null,
  saas_video_url: null,
  saas_cta_url: '/new-saas',
  support_url: null,
  metadata: {},
};

const bootstrap: HubBootstrap = {
  account: {
    id: accountId,
    name: 'Conta E2E isolada',
    account_type: 'ORGANIZATION',
    audience: 'INSTITUTION',
    status: 'ACTIVE',
    metadata: { test_fixture: true },
  },
  membership: { membership_role: 'OWNER', status: 'ACTIVE' },
  memberProfile: {
    display_name: 'Responsável E2E',
    subjectRole: 'EDUCATOR',
    onboarding_completed: true,
  },
  subscription: {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'ACTIVE',
    trial_ends_at: null,
    current_period_ends_at: '2099-01-01T00:00:00.000Z',
    product_family: 'HUB_CORE',
  },
  plan: null,
  entitlements: {
    'library.full_access': { limit: null, resetPeriod: 'MONTH', used: 0 },
    'educator_ai.generate': { limit: 100, resetPeriod: 'MONTH', used: 0 },
    'wolfie.turn': { limit: 100, resetPeriod: 'MONTH', used: 0 },
  },
  settings,
  isManager: true,
};

describe('LP autenticada abre o módulo nativo correspondente', () => {
  beforeEach(() => {
    bridge.initialTab = null;
    window.localStorage.clear();
    mocks.getSession.mockReset().mockResolvedValue({
      data: { session: { user: { id: userId, email: 'e2e@example.invalid' } } },
    });
    mocks.loadHubAccounts.mockReset().mockResolvedValue([{
      id: accountId,
      name: bootstrap.account.name,
      audience: bootstrap.account.audience,
      account_type: bootstrap.account.account_type,
      status: bootstrap.account.status,
      membership_role: bootstrap.membership.membership_role,
    }]);
    mocks.loadHubBootstrap.mockReset().mockResolvedValue(bootstrap);
    mocks.loadHubPublicData.mockReset().mockResolvedValue({
      plans: [],
      settings,
      content: [],
    });
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  it.each([
    ['/hub/biblioteca', 'library'],
    ['/hub/educador-ia', 'educator'],
    ['/hub/wolfie', 'wolfie'],
    ['/hub/saas-escolar', 'saas'],
  ] as const)('%s abre %s sem passar pelo resumo genérico', async (pathname, expectedTab) => {
    window.history.replaceState({}, '', pathname);

    render(<HubApp />);

    expect(await screen.findByText(`Portal aberto em ${expectedTab}`)).toBeTruthy();
    expect(bridge.initialTab).toBe(expectedTab);
    expect(mocks.loadHubBootstrap).toHaveBeenCalledWith(accountId);
  });
});
