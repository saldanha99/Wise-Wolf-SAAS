import { describe, expect, it } from 'vitest';
import {
  appendHubCheckoutIntentToUrl,
  clearStoredHubCheckoutIntent,
  createHubCheckoutIntent,
  HUB_CHECKOUT_INTENT_STORAGE_KEY,
  HUB_CHECKOUT_INTENT_TTL_MS,
  persistHubCheckoutIntent,
  readHubCheckoutIntentFromUrl,
  readStoredHubCheckoutIntent,
  removeHubCheckoutIntentFromUrl,
  restoreHubCheckoutIntent,
} from './hubCheckoutIntent';

describe('Hub checkout intent', () => {
  const now = Date.parse('2026-08-23T12:00:00.000Z');

  it('round-trips only plan, billing cycle and a short expiration', () => {
    const intent = createHubCheckoutIntent('EDUCATOR_PRO', 'YEARLY', now);
    expect(intent).toEqual({
      version: 1,
      planCode: 'EDUCATOR_PRO',
      billingCycle: 'YEARLY',
      expiresAt: now + HUB_CHECKOUT_INTENT_TTL_MS,
    });

    const redirect = appendHubCheckoutIntentToUrl('https://system.wisewolflanguage.com.br/hub?code=auth-code', intent!);
    expect(redirect).not.toContain('email');
    expect(readHubCheckoutIntentFromUrl(redirect, now)).toEqual(intent);
    expect(new URL(redirect).searchParams.get('code')).toBe('auth-code');
  });

  it('rejects expired, malformed and artificially long-lived URL intents', () => {
    const base = new URL('https://system.wisewolflanguage.com.br/hub');
    base.searchParams.set('hub_plan', 'EDUCATOR_PRO');
    base.searchParams.set('hub_cycle', 'MONTHLY');
    base.searchParams.set('hub_expires', String(now));
    expect(readHubCheckoutIntentFromUrl(base, now)).toBeNull();

    base.searchParams.set('hub_cycle', 'WEEKLY');
    base.searchParams.set('hub_expires', String(now + 10_000));
    expect(readHubCheckoutIntentFromUrl(base, now)).toBeNull();

    base.searchParams.set('hub_cycle', 'YEARLY');
    base.searchParams.set('hub_plan', '../SCHOOL_ADMIN');
    expect(readHubCheckoutIntentFromUrl(base, now)).toBeNull();

    base.searchParams.set('hub_plan', 'EDUCATOR_PRO');
    base.searchParams.set('hub_expires', String(now + HUB_CHECKOUT_INTENT_TTL_MS + 1));
    expect(readHubCheckoutIntentFromUrl(base, now)).toBeNull();
  });

  it('prefers a valid email redirect intent and falls back to local storage', () => {
    localStorage.clear();
    const stored = createHubCheckoutIntent('LIBRARY_SOLO', 'MONTHLY', now)!;
    const redirected = createHubCheckoutIntent('HUB_COMPLETE', 'YEARLY', now)!;
    persistHubCheckoutIntent(localStorage, stored);

    expect(readStoredHubCheckoutIntent(localStorage, now)).toEqual(stored);
    expect(restoreHubCheckoutIntent(appendHubCheckoutIntentToUrl(window.location.href, redirected), localStorage, now)).toEqual(redirected);
    expect(restoreHubCheckoutIntent(window.location.href, localStorage, now)).toEqual(stored);
  });

  it('clears storage and removes only checkout parameters from the URL', () => {
    localStorage.setItem(HUB_CHECKOUT_INTENT_STORAGE_KEY, '{}');
    sessionStorage.setItem('wise-wolf-hub-plan-intent', 'EDUCATOR_PRO');
    clearStoredHubCheckoutIntent(localStorage, sessionStorage);
    expect(localStorage.getItem(HUB_CHECKOUT_INTENT_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('wise-wolf-hub-plan-intent')).toBeNull();

    const cleaned = removeHubCheckoutIntentFromUrl('https://system.wisewolflanguage.com.br/hub?hub_plan=EDUCATOR_PRO&hub_cycle=YEARLY&hub_expires=123&code=auth-code');
    expect(new URL(cleaned).searchParams.get('hub_plan')).toBeNull();
    expect(new URL(cleaned).searchParams.get('code')).toBe('auth-code');
  });
});
