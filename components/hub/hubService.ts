import { supabase } from '../../lib/supabase';
import type {
  HubAudience,
  HubAccountSummary,
  HubBootstrap,
  HubContentItem,
  HubMemberProfile,
  HubPlan,
  HubPreferences,
  HubSettings,
} from './types';

export const HUB_CORE_PRODUCT_FAMILY = 'HUB_CORE';

export function isHubCorePlan(plan: HubPlan): boolean {
  return plan.product_family === HUB_CORE_PRODUCT_FAMILY;
}

export function isHubPlanAvailableToAudience(plan: HubPlan, audience: HubAudience): boolean {
  return isHubCorePlan(plan) && (plan.audience === 'ALL' || plan.audience === audience);
}

export function isHubEnabled(settings: HubSettings): boolean {
  return settings.metadata?.hubEnabled !== false;
}

export function isHubCatalogReady(
  settings: HubSettings,
  content: HubContentItem[],
): boolean {
  return settings.metadata?.catalogReady === true && content.length > 0;
}

export type HubSubscriptionAccessState = 'ACTIVE_TRIAL' | 'ACTIVE_PAID' | 'EXPIRED' | 'NONE';

export function getHubSubscriptionAccessState(
  subscription: HubBootstrap['subscription'],
  nowMs = Date.now(),
): HubSubscriptionAccessState {
  if (!subscription) return 'NONE';
  const isFuture = (value: string | null) => {
    if (!value) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp > nowMs;
  };
  if (subscription.status === 'TRIALING' && isFuture(subscription.trial_ends_at)) return 'ACTIVE_TRIAL';
  if (subscription.status === 'ACTIVE' && isFuture(subscription.current_period_ends_at)) return 'ACTIVE_PAID';
  return 'EXPIRED';
}

export const DEFAULT_HUB_SETTINGS: HubSettings = {
  settings_key: 'default',
  brand_name: 'Wise Wolf Hub',
  headline: 'Materiais, inteligência e operação em um só ecossistema.',
  subheadline:
    'Comece com as ferramentas que você precisa e evolua para o sistema escolar completo quando estiver pronto.',
  saas_video_url: null,
  saas_cta_url: '/new-saas',
  support_url: null,
  metadata: {},
};

export async function loadHubPublicData(): Promise<{
  plans: HubPlan[];
  settings: HubSettings;
  content: HubContentItem[];
}> {
  const [plansResult, settingsResult, contentResult] = await Promise.all([
    supabase
      .from('hub_plans')
      .select('id, code, name, description, audience, price_monthly, price_yearly, trial_days, features, metadata, product_family')
      .eq('product_family', HUB_CORE_PRODUCT_FAMILY)
      .eq('is_active', true)
      .eq('is_public', true)
      .order('display_order'),
    supabase.rpc('hub_get_public_settings'),
    supabase
      .from('hub_content_items')
      .select('id, slug, title, description, content_type, level_tag, niche, collection_name, collection_id, part_number, cover_url, preview_enabled, license_summary, author_name')
      .eq('is_active', true)
      .order('published_at', { ascending: false })
      .limit(60),
  ]);

  if (plansResult.error) throw plansResult.error;
  if (settingsResult.error) throw settingsResult.error;
  if (contentResult.error) throw contentResult.error;

  return {
    plans: ((plansResult.data ?? []) as HubPlan[]).filter(isHubCorePlan),
    settings: (settingsResult.data as HubSettings | null) ?? DEFAULT_HUB_SETTINGS,
    content: (contentResult.data ?? []).map((item) => ({ ...item, metadata: {} })) as HubContentItem[],
  };
}

export async function claimHubTrial(
  audience: HubAudience,
  accountName?: string,
): Promise<{ accountId: string }> {
  const { data, error } = await supabase.rpc('hub_claim_trial', {
    p_audience: audience,
    p_account_name: accountName?.trim() || null,
  });
  if (error) throw error;
  if (!data?.accountId) throw new Error('HUB_ACCOUNT_REQUIRED');
  return data as { accountId: string };
}

export async function loadHubAccounts(): Promise<HubAccountSummary[]> {
  const { data, error } = await supabase.rpc('hub_list_accounts');
  if (error) throw error;
  return (data ?? []) as HubAccountSummary[];
}

export async function loadHubBootstrap(accountId?: string | null): Promise<HubBootstrap | null> {
  const { data, error } = await supabase.rpc('hub_bootstrap', {
    p_account_id: accountId ?? null,
  });
  if (error) throw error;
  if (data?.access?.code === 'HUB_ACCOUNT_AMBIGUOUS') {
    throw new Error('HUB_ACCOUNT_AMBIGUOUS');
  }
  if (!data) return null;

  const bootstrap = data as HubBootstrap;
  if (bootstrap.access?.allowed === false) return bootstrap;
  if (!bootstrap.account?.id) throw new Error('HUB_BOOTSTRAP_INVALID');

  const { data: profileData, error: profileError } = await supabase.rpc('hub_get_member_profile', {
    p_account_id: bootstrap.account.id,
  });
  if (profileError) throw profileError;
  if (!profileData || typeof profileData !== 'object' || Array.isArray(profileData)) {
    throw new Error('HUB_MEMBER_PROFILE_INVALID');
  }

  const profile = profileData as Record<string, unknown>;
  const subjectRole = profile.subjectRole;
  if (
    profile.accountId !== bootstrap.account.id
    || (subjectRole !== 'LEARNER' && subjectRole !== 'EDUCATOR')
  ) {
    throw new Error('HUB_MEMBER_PROFILE_INVALID');
  }

  const memberProfile: HubMemberProfile = {
    subjectRole,
    display_name: typeof profile.displayName === 'string' ? profile.displayName : null,
    onboarding_completed: profile.onboarding_completed === true,
  };
  if (['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(String(profile.level))) {
    memberProfile.level = profile.level as HubMemberProfile['level'];
  }
  if (typeof profile.role === 'string') memberProfile.role = profile.role;
  if (typeof profile.goal === 'string') memberProfile.goal = profile.goal;
  if (typeof profile.interests === 'string') memberProfile.interests = profile.interests;
  if (['text', 'voice', 'mixed'].includes(String(profile.preferred_modality))) {
    memberProfile.preferred_modality = profile.preferred_modality as HubMemberProfile['preferred_modality'];
  }
  if (typeof profile.personalized_at === 'string') memberProfile.personalized_at = profile.personalized_at;

  return { ...bootstrap, memberProfile };
}

export async function updateHubPreferences(
  accountId: string,
  preferences: HubPreferences,
): Promise<void> {
  const { error } = await supabase.rpc('hub_update_member_preferences', {
    p_account_id: accountId,
    p_preferences: preferences,
  });
  if (error) throw error;
}

export async function trackHubEvent(
  eventName: string,
  source?: string,
  metadata: Record<string, unknown> = {},
  accountId?: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('hub_track_event', {
    p_event_name: eventName,
    p_source: source ?? null,
    p_metadata: metadata,
    p_account_id: accountId ?? null,
  });
  if (error) console.warn('Hub event was not recorded', error.code);
}

export async function openHubContent(
  accountId: string,
  contentId: string,
  asset: 'PREVIEW' | 'FULL',
): Promise<{ signedUrl: string; expiresIn: number }> {
  const { data, error } = await supabase.functions.invoke('hub-library-access', {
    body: { accountId, contentId, asset },
  });
  if (error) throw error;
  if (!data?.signedUrl) {
    const reason = data?.code || data?.error || 'CONTENT_UNAVAILABLE';
    throw new Error(reason);
  }
  return data as { signedUrl: string; expiresIn: number };
}
