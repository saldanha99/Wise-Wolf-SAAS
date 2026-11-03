import { describe, expect, it } from 'vitest';
import {
  getHubSubscriptionAccessState,
  HUB_PAYMENT_GRACE_DAYS,
  hubSubscriptionHasCurrentAccess,
  isHubCorePlan,
  isHubEnabled,
  isHubPlanAvailableToAudience,
} from './hubService';
import type { HubPlan, HubSettings } from './types';

const plan = (productFamily?: string, audience: HubPlan['audience'] = 'EDUCATOR'): HubPlan => ({
  id: 'plan-id',
  code: 'EDUCATOR_PRO',
  name: 'Educador Pro',
  description: null,
  audience,
  price_monthly: 119,
  price_yearly: 1190,
  trial_days: 0,
  features: [],
  metadata: {},
  product_family: productFamily || '',
});

const settings = (hubEnabled?: boolean): HubSettings => ({
  settings_key: 'default',
  brand_name: 'Wise Wolf Hub',
  headline: 'Headline',
  subheadline: null,
  saas_video_url: null,
  saas_cta_url: '/new-saas',
  support_url: null,
  metadata: hubEnabled === undefined ? {} : { hubEnabled },
});

describe('Hub commercial boundaries', () => {
  it('keeps only plans explicitly assigned to Hub Core', () => {
    expect(isHubCorePlan(plan('HUB_CORE'))).toBe(true);
    expect(isHubCorePlan(plan('WOLFIE_STANDALONE'))).toBe(false);
    expect(isHubCorePlan(plan())).toBe(false);
  });

  it('shows only plans matching the selected account audience', () => {
    expect(isHubPlanAvailableToAudience(plan('HUB_CORE', 'ALL'), 'EDUCATOR')).toBe(true);
    expect(isHubPlanAvailableToAudience(plan('HUB_CORE', 'EDUCATOR'), 'EDUCATOR')).toBe(true);
    expect(isHubPlanAvailableToAudience(plan('HUB_CORE', 'INSTITUTION'), 'EDUCATOR')).toBe(false);
    expect(isHubPlanAvailableToAudience(plan('WOLFIE_STANDALONE', 'LEARNER'), 'LEARNER')).toBe(false);
  });

  it('defaults the Hub to enabled while honoring an explicit kill switch', () => {
    expect(isHubEnabled(settings())).toBe(true);
    expect(isHubEnabled(settings(true))).toBe(true);
    expect(isHubEnabled(settings(false))).toBe(false);
  });
});

describe('Hub subscription access state', () => {
  const now = Date.parse('2026-08-22T12:00:00.000Z');

  it('distinguishes active trials and expired trials', () => {
    expect(getHubSubscriptionAccessState({
      id: 'trial',
      status: 'TRIALING',
      trial_ends_at: '2026-08-23T12:00:00.000Z',
      current_period_ends_at: null,
    }, now)).toBe('ACTIVE_TRIAL');
    expect(getHubSubscriptionAccessState({
      id: 'trial',
      status: 'TRIALING',
      trial_ends_at: '2026-08-21T12:00:00.000Z',
      current_period_ends_at: null,
    }, now)).toBe('EXPIRED');
  });

  it('requires an unexpired paid period for active access', () => {
    expect(getHubSubscriptionAccessState({
      id: 'paid',
      status: 'ACTIVE',
      trial_ends_at: null,
      current_period_ends_at: '2026-09-22T12:00:00.000Z',
    }, now)).toBe('ACTIVE_PAID');
    expect(getHubSubscriptionAccessState({
      id: 'paid',
      status: 'ACTIVE',
      trial_ends_at: null,
      current_period_ends_at: '2026-08-01T12:00:00.000Z',
    }, now)).toBe('EXPIRED');
    expect(getHubSubscriptionAccessState(null, now)).toBe('NONE');
  });

  it('keeps paid access for 5 days after the period ends, like the server', () => {
    const paid = (status: string, endsAt: string | null) => ({
      id: 'paid',
      status,
      trial_ends_at: null,
      current_period_ends_at: endsAt,
    });
    // now = 2026-08-22T12:00Z
    expect(getHubSubscriptionAccessState(paid('ACTIVE', '2026-08-20T12:00:00.000Z'), now)).toBe('GRACE_PAID');
    expect(getHubSubscriptionAccessState(paid('ACTIVE', '2026-08-16T12:00:00.000Z'), now)).toBe('EXPIRED');
    expect(getHubSubscriptionAccessState(paid('PAST_DUE', '2026-08-19T12:00:00.000Z'), now)).toBe('GRACE_PAID');
    expect(getHubSubscriptionAccessState(paid('PAST_DUE', '2026-08-17T11:00:00.000Z'), now)).toBe('EXPIRED');
    expect(getHubSubscriptionAccessState(paid('PAST_DUE', '2026-08-25T12:00:00.000Z'), now)).toBe('GRACE_PAID');
    expect(getHubSubscriptionAccessState(paid('EXPIRED', '2026-09-22T12:00:00.000Z'), now)).toBe('EXPIRED');
    expect(getHubSubscriptionAccessState(paid('CANCELLED', '2026-09-22T12:00:00.000Z'), now)).toBe('EXPIRED');
    expect(getHubSubscriptionAccessState(paid('ACTIVE', null), now)).toBe('EXPIRED');
    expect(hubSubscriptionHasCurrentAccess('GRACE_PAID')).toBe(true);
    expect(hubSubscriptionHasCurrentAccess('EXPIRED')).toBe(false);
    expect(HUB_PAYMENT_GRACE_DAYS).toBe(5);
  });

  it('gives no grace to an expired trial', () => {
    expect(getHubSubscriptionAccessState({
      id: 'trial',
      status: 'TRIALING',
      trial_ends_at: '2026-08-22T11:00:00.000Z',
      current_period_ends_at: '2026-09-22T12:00:00.000Z',
    }, now)).toBe('EXPIRED');
  });
});
