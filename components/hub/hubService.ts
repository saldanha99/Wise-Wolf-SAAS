import { supabase } from '../../lib/supabase';
import type {
  HubAudience,
  HubBootstrap,
  HubContentItem,
  HubPlan,
  HubPreferences,
  HubSettings,
} from './types';

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
      .select('id, code, name, description, audience, price_monthly, price_yearly, trial_days, features, metadata')
      .eq('is_active', true)
      .eq('is_public', true)
      .order('display_order'),
    supabase
      .from('hub_settings')
      .select('*')
      .eq('settings_key', 'default')
      .maybeSingle(),
    supabase
      .from('hub_content_items')
      .select('id, slug, title, description, content_type, level_tag, niche, collection_name, cover_url, preview_enabled, license_summary, author_name, metadata')
      .eq('is_active', true)
      .order('published_at', { ascending: false })
      .limit(60),
  ]);

  if (plansResult.error) throw plansResult.error;
  if (settingsResult.error) throw settingsResult.error;
  if (contentResult.error) throw contentResult.error;

  return {
    plans: (plansResult.data ?? []) as HubPlan[],
    settings: (settingsResult.data as HubSettings | null) ?? DEFAULT_HUB_SETTINGS,
    content: (contentResult.data ?? []) as HubContentItem[],
  };
}

export async function claimHubTrial(
  audience: HubAudience,
  accountName?: string,
): Promise<void> {
  const { error } = await supabase.rpc('hub_claim_trial', {
    p_audience: audience,
    p_account_name: accountName?.trim() || null,
  });
  if (error) throw error;
}

export async function loadHubBootstrap(): Promise<HubBootstrap | null> {
  const { data, error } = await supabase.rpc('hub_bootstrap');
  if (error) throw error;
  return (data as HubBootstrap | null) ?? null;
}

export async function updateHubPreferences(
  accountId: string,
  preferences: HubPreferences,
): Promise<void> {
  const { error } = await supabase.rpc('hub_update_preferences', {
    p_account_id: accountId,
    p_preferences: preferences,
  });
  if (error) throw error;
}

export async function trackHubEvent(
  eventName: string,
  source?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase.rpc('hub_track_event', {
    p_event_name: eventName,
    p_source: source ?? null,
    p_metadata: metadata,
  });
  if (error) console.warn('Hub event was not recorded', error.code);
}

export async function openHubContent(
  contentId: string,
  asset: 'PREVIEW' | 'FULL',
): Promise<{ signedUrl: string; expiresIn: number }> {
  const { data, error } = await supabase.functions.invoke('hub-library-access', {
    body: { contentId, asset },
  });
  if (error) throw error;
  if (!data?.signedUrl) {
    const reason = data?.code || data?.error || 'CONTENT_UNAVAILABLE';
    throw new Error(reason);
  }
  return data as { signedUrl: string; expiresIn: number };
}
