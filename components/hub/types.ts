export type HubAudience = 'LEARNER' | 'EDUCATOR' | 'INSTITUTION';
export type HubBillingCycle = 'MONTHLY' | 'YEARLY';
export type HubAuthorityRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type HubSubjectRole = 'LEARNER' | 'EDUCATOR';

export interface HubCheckoutIntent {
  version: 1;
  planCode: string;
  billingCycle: HubBillingCycle;
  expiresAt: number;
}

export interface HubPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  audience: 'ALL' | HubAudience;
  price_monthly: number | null;
  price_yearly: number | null;
  trial_days: number;
  features: string[];
  metadata: Record<string, unknown>;
  product_family: string;
}

export interface HubAccountSummary {
  id: string;
  name: string;
  audience: HubAudience;
  account_type: 'PERSONAL' | 'ORGANIZATION';
  status: string;
  membership_role: HubAuthorityRole;
}

export interface HubSettings {
  settings_key: string;
  brand_name: string;
  headline: string;
  subheadline: string | null;
  saas_video_url: string | null;
  saas_cta_url: string;
  support_url: string | null;
  metadata: Record<string, unknown>;
}

export interface HubContentItem {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  content_type: 'PDF' | 'VIDEO' | 'AUDIO' | 'LINK' | 'ACTIVITY';
  level_tag: string | null;
  niche: string;
  collection_name: string | null;
  // Estrutura de livro espelhada de `pedagogical_collections`: é o que liga o
  // modo "Pastas" (Nicho › Nível › Livro › Partes) do módulo da escola.
  collection_id: string | null;
  part_number: number | null;
  cover_url: string | null;
  preview_enabled: boolean;
  license_summary: string | null;
  author_name: string | null;
  metadata: Record<string, unknown>;
}

export interface HubEntitlement {
  limit: number | null;
  resetPeriod: 'DAY' | 'MONTH' | 'SUBSCRIPTION';
  used: number;
}

export interface HubPreferences {
  onboarding_completed?: boolean;
  level?: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  role?: string;
  goal?: string;
  interests?: string;
  preferred_modality?: 'text' | 'voice' | 'mixed';
  personalized_at?: string;
}

export interface HubMemberProfile extends HubPreferences {
  display_name?: string | null;
  subjectRole: HubSubjectRole;
}

export interface HubBootstrap {
  account: {
    id: string;
    name: string;
    account_type: 'PERSONAL' | 'ORGANIZATION';
    audience: HubAudience;
    status: string;
    trial_claimed_at?: string | null;
    metadata: HubPreferences & Record<string, unknown>;
  };
  membership: {
    membership_role: HubAuthorityRole;
    status: string;
  };
  subscription: {
    id: string;
    plan_id?: string;
    status: string;
    billing_cycle?: 'MONTHLY' | 'YEARLY' | null;
    trial_ends_at: string | null;
    current_period_ends_at: string | null;
    product_family?: string;
  } | null;
  plan: HubPlan | null;
  entitlements: Record<string, HubEntitlement>;
  settings: HubSettings;
  memberProfile?: HubMemberProfile;
  isManager?: boolean;
  access?: { allowed: boolean; code?: string };
}

export interface HubUsageResult {
  allowed: boolean;
  code?: string;
  used?: number;
  limit?: number | null;
  remaining?: number | null;
  periodEndsAt?: string;
}
