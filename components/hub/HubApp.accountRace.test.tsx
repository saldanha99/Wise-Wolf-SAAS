import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubBootstrap } from './types';

const accountA = '11111111-1111-4111-8111-111111111111';
const accountB = '22222222-2222-4222-8222-222222222222';

const bridge = vi.hoisted(() => ({
  portalProps: null as Record<string, any> | null,
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
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(),
    },
  },
}));

vi.mock('./HubPortal', () => ({
  default: (props: Record<string, any>) => {
    bridge.portalProps = props;
    return <div>Portal {props.bootstrap.account.id}</div>;
  },
}));

vi.mock('./HubLanding', () => ({ default: () => null }));
vi.mock('./HubAudienceLanding', () => ({ default: () => null }));
vi.mock('./HubSolutionLanding', () => ({ default: () => null }));
vi.mock('./HubAuthDialog', () => ({ default: () => null }));
vi.mock('./useHubHashNavigation', () => ({ useHubHashNavigation: vi.fn() }));
vi.mock('./hubRoutes', () => ({
  hubCanonicalUrl: () => 'https://hub.example.invalid/',
  hubMarketingPath: () => '/',
  resolveHubMarketingPage: () => 'overview',
  resolveSystemAppUrl: () => '/',
}));

vi.mock('./hubService', () => ({
  DEFAULT_HUB_SETTINGS: {
    settings_key: 'default',
    brand_name: 'Wise Wolf Hub',
    headline: 'Hub',
    subheadline: null,
    saas_video_url: null,
    saas_cta_url: '/',
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

const session = {
  user: { id: '33333333-3333-4333-8333-333333333333', email: 'member@example.invalid' },
};

const bootstrap = (accountId: string, name: string): HubBootstrap => ({
  account: {
    id: accountId,
    name,
    account_type: 'ORGANIZATION',
    audience: 'INSTITUTION',
    status: 'ACTIVE',
    metadata: {},
  },
  membership: { membership_role: 'MEMBER', status: 'ACTIVE' },
  memberProfile: {
    display_name: 'Membro',
    subjectRole: 'LEARNER',
    onboarding_completed: true,
  },
  subscription: null,
  plan: null,
  entitlements: {},
  settings: {
    settings_key: 'default',
    brand_name: 'Wise Wolf Hub',
    headline: 'Hub',
    subheadline: null,
    saas_video_url: null,
    saas_cta_url: '/',
    support_url: null,
    metadata: {},
  },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

describe('Troca concorrente de conta no Hub', () => {
  beforeEach(() => {
    bridge.portalProps = null;
    mocks.getSession.mockReset();
    mocks.loadHubAccounts.mockReset();
    mocks.loadHubBootstrap.mockReset();
    mocks.loadHubPublicData.mockReset();
    window.localStorage.clear();
    window.localStorage.setItem(`wise-wolf-hub-account:${session.user.id}`, accountA);
    mocks.getSession.mockResolvedValue({ data: { session } });
    mocks.loadHubAccounts.mockResolvedValue([
      { id: accountA, name: 'Conta A', audience: 'INSTITUTION', account_type: 'ORGANIZATION', status: 'ACTIVE', membership_role: 'MEMBER' },
      { id: accountB, name: 'Conta B', audience: 'INSTITUTION', account_type: 'ORGANIZATION', status: 'ACTIVE', membership_role: 'MEMBER' },
    ]);
    mocks.loadHubPublicData.mockResolvedValue({
      plans: [],
      content: [],
      settings: bootstrap(accountA, 'Conta A').settings,
    });
  });

  it('ignora a resposta antiga de A depois que B foi selecionada', async () => {
    const refreshA = deferred<HubBootstrap>();
    const switchB = deferred<HubBootstrap>();
    let bootstrapCalls = 0;
    mocks.loadHubBootstrap.mockImplementation((accountId: string) => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) return Promise.resolve(bootstrap(accountA, 'Conta A'));
      if (accountId === accountA) return refreshA.promise;
      return switchB.promise;
    });

    render(<HubApp />);
    expect(await screen.findByText(`Portal ${accountA}`)).toBeTruthy();

    let staleRefresh!: Promise<void>;
    act(() => {
      staleRefresh = bridge.portalProps!.onRefresh();
    });
    await waitFor(() => expect(mocks.loadHubBootstrap).toHaveBeenCalledTimes(2));

    let latestSwitch!: Promise<void>;
    act(() => {
      latestSwitch = bridge.portalProps!.onSwitchAccount(accountB);
    });
    await waitFor(() => expect(mocks.loadHubBootstrap).toHaveBeenCalledTimes(3));

    await act(async () => {
      switchB.resolve(bootstrap(accountB, 'Conta B'));
      await latestSwitch;
    });
    expect(await screen.findByText(`Portal ${accountB}`)).toBeTruthy();

    await act(async () => {
      refreshA.resolve(bootstrap(accountA, 'Conta A'));
      await staleRefresh;
    });
    expect(screen.getByText(`Portal ${accountB}`)).toBeTruthy();
    expect(screen.queryByText(`Portal ${accountA}`)).toBeNull();
  });
});
