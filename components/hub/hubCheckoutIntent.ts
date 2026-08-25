import type { HubBillingCycle, HubCheckoutIntent } from './types';

export const HUB_CHECKOUT_INTENT_STORAGE_KEY = 'wise-wolf-hub-checkout-intent:v1';
export const HUB_CHECKOUT_INTENT_TTL_MS = 60 * 60 * 1000;

const LEGACY_PLAN_INTENT_STORAGE_KEY = 'wise-wolf-hub-plan-intent';
const PLAN_PARAM = 'hub_plan';
const CYCLE_PARAM = 'hub_cycle';
const EXPIRES_PARAM = 'hub_expires';
const PLAN_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;

const isBillingCycle = (value: unknown): value is HubBillingCycle =>
  value === 'MONTHLY' || value === 'YEARLY';

const parseIntent = (value: unknown, now: number): HubCheckoutIntent | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<HubCheckoutIntent>;
  if (candidate.version !== 1) return null;
  if (typeof candidate.planCode !== 'string' || !PLAN_CODE_PATTERN.test(candidate.planCode)) return null;
  if (!isBillingCycle(candidate.billingCycle)) return null;
  if (!Number.isSafeInteger(candidate.expiresAt)) return null;
  if ((candidate.expiresAt as number) <= now || (candidate.expiresAt as number) > now + HUB_CHECKOUT_INTENT_TTL_MS) return null;
  return candidate as HubCheckoutIntent;
};

export const createHubCheckoutIntent = (
  planCode: string,
  billingCycle: HubBillingCycle,
  now = Date.now(),
): HubCheckoutIntent | null => parseIntent({
  version: 1,
  planCode,
  billingCycle,
  expiresAt: now + HUB_CHECKOUT_INTENT_TTL_MS,
}, now);

export const readHubCheckoutIntentFromUrl = (
  url: string | URL,
  now = Date.now(),
): HubCheckoutIntent | null => {
  try {
    const parsed = url instanceof URL ? url : new URL(url);
    const expiresAt = Number(parsed.searchParams.get(EXPIRES_PARAM));
    return parseIntent({
      version: 1,
      planCode: parsed.searchParams.get(PLAN_PARAM),
      billingCycle: parsed.searchParams.get(CYCLE_PARAM),
      expiresAt,
    }, now);
  } catch {
    return null;
  }
};

export const readStoredHubCheckoutIntent = (
  storage: Pick<Storage, 'getItem'>,
  now = Date.now(),
): HubCheckoutIntent | null => {
  try {
    const raw = storage.getItem(HUB_CHECKOUT_INTENT_STORAGE_KEY);
    return raw ? parseIntent(JSON.parse(raw), now) : null;
  } catch {
    return null;
  }
};

export const restoreHubCheckoutIntent = (
  url: string | URL,
  storage: Pick<Storage, 'getItem'>,
  now = Date.now(),
): HubCheckoutIntent | null =>
  readHubCheckoutIntentFromUrl(url, now) ?? readStoredHubCheckoutIntent(storage, now);

export const persistHubCheckoutIntent = (
  storage: Pick<Storage, 'setItem'>,
  intent: HubCheckoutIntent,
): void => {
  try {
    storage.setItem(HUB_CHECKOUT_INTENT_STORAGE_KEY, JSON.stringify(intent));
  } catch {}
};

export const appendHubCheckoutIntentToUrl = (
  url: string | URL,
  intent: HubCheckoutIntent,
): string => {
  const parsed = url instanceof URL ? new URL(url.toString()) : new URL(url);
  parsed.searchParams.set(PLAN_PARAM, intent.planCode);
  parsed.searchParams.set(CYCLE_PARAM, intent.billingCycle);
  parsed.searchParams.set(EXPIRES_PARAM, String(intent.expiresAt));
  return parsed.toString();
};

export const removeHubCheckoutIntentFromUrl = (url: string | URL): string => {
  const parsed = url instanceof URL ? new URL(url.toString()) : new URL(url);
  parsed.searchParams.delete(PLAN_PARAM);
  parsed.searchParams.delete(CYCLE_PARAM);
  parsed.searchParams.delete(EXPIRES_PARAM);
  return parsed.toString();
};

export const clearStoredHubCheckoutIntent = (
  storage: Pick<Storage, 'removeItem'>,
  legacyStorage?: Pick<Storage, 'removeItem'>,
): void => {
  try {
    storage.removeItem(HUB_CHECKOUT_INTENT_STORAGE_KEY);
  } catch {}
  try {
    legacyStorage?.removeItem(LEGACY_PLAN_INTENT_STORAGE_KEY);
  } catch {}
};
