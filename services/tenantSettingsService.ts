import { supabase } from '../lib/supabase';

export type TenantIntegrationProvider = 'asaas' | 'evolution' | 'openai' | 'openrouter';

export interface TenantIntegrationStatus {
  provider: TenantIntegrationProvider;
  configured: boolean;
  environment: 'sandbox' | 'production' | 'platform';
  status: 'not_configured' | 'configured' | 'healthy' | 'error' | 'disabled';
  secretLastFour: string | null;
  accountLabel: string | null;
  lastValidatedAt: string | null;
  updatedAt: string | null;
}

export interface TenantSettingsAuditEntry {
  id: string;
  actor_role: string;
  action: string;
  section: string;
  changes: Record<string, unknown>;
  created_at: string;
}

export interface TenantSchoolInfo {
  name?: string;
  legalName?: string;
  cnpj?: string;
  address?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  directorName?: string;
  legalRepresentativeName?: string;
  legalRepresentativeSignaturePath?: string;
  legalRepresentativeSignatureUrl?: string;
  privacyContactEmail?: string;
}

export interface TenantBrandingForm {
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string;
  faviconUrl: string;
  logoPath: string;
  faviconPath: string;
}

export interface TenantSettingsForm {
  name: string;
  slug: string;
  branding: TenantBrandingForm;
  schoolInfo: TenantSchoolInfo | null;
  whatsappEnabled: boolean;
  financialCutoffDay: number;
  locale: string;
  timezone: string;
  currency: string;
  weekStartsOn: number;
  defaultLessonDurationMinutes: number;
  studentNotificationsEnabled: boolean;
  teacherNotificationsEnabled: boolean;
}

export interface TenantSettingsSnapshot {
  tenant: {
    id: string;
    name: string;
    slug: string;
    domain: string;
    branding: Partial<TenantBrandingForm>;
    schoolInfo: TenantSchoolInfo | null;
    whatsappEnabled: boolean;
    financialCutoffDay: number;
    customDomain: string;
    customDomainVerified: boolean;
    customDomainDnsToken: string;
    customDomainVerifiedAt: string | null;
    studentLimit: number;
    teacherLimit: number;
    planId: string | null;
    subscriptionStatus: string | null;
    currentPeriodEnd: string | null;
  };
  settings: {
    version: number;
    locale: string;
    timezone: string;
    currency: string;
    weekStartsOn: number;
    defaultLessonDurationMinutes: number;
    studentNotificationsEnabled: boolean;
    teacherNotificationsEnabled: boolean;
    updatedAt: string | null;
  };
  integrations: TenantIntegrationStatus[];
  audit: TenantSettingsAuditEntry[];
  dns: {
    verificationRecord: string;
    cnameTarget: string;
  };
  security: {
    tenantAuthority: string;
    tenantDerivedOnServer: boolean;
    secretStorage: string;
    brandingNamespace: string;
    legalAssetNamespace: string;
  };
}

export class TenantSettingsError extends Error {
  constructor(message: string, readonly code = 'SETTINGS_ERROR') {
    super(message);
    this.name = 'TenantSettingsError';
  }
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('tenant-settings-admin', { body });
  if (!error) return data as T;

  let message = error.message || 'Não foi possível concluir a operação.';
  let code = 'SETTINGS_ERROR';
  const context = (error as { context?: Response }).context;
  if (context instanceof Response) {
    try {
      const payload = await context.clone().json() as { error?: string; code?: string };
      message = payload.error || message;
      code = payload.code || code;
    } catch {
      // A mensagem segura do SDK já é suficiente quando não há JSON.
    }
  }
  throw new TenantSettingsError(message, code);
}

export const tenantSettingsService = {
  get(): Promise<TenantSettingsSnapshot> {
    return invoke<TenantSettingsSnapshot>({ action: 'get' });
  },

  save(version: number, settings: TenantSettingsForm): Promise<{ ok: true; version: number }> {
    const schoolInfo = settings.schoolInfo ? { ...settings.schoolInfo } : null;
    if (schoolInfo) delete schoolInfo.legalRepresentativeSignatureUrl;
    return invoke({ action: 'save', version, settings: { ...settings, schoolInfo } });
  },

  setSecret(
    provider: TenantIntegrationProvider,
    secret: string,
    environment: 'sandbox' | 'production',
  ): Promise<{ ok: true; integration: TenantIntegrationStatus }> {
    return invoke({ action: 'secret:set', provider, secret, environment });
  },

  deleteSecret(provider: TenantIntegrationProvider): Promise<{ ok: true; removed: boolean }> {
    return invoke({ action: 'secret:delete', provider });
  },

  requestDomain(domain: string): Promise<{
    ok: true;
    domain: string;
    dns: { txtName: string; txtValue: string; cnameName: string; cnameValue: string };
  }> {
    return invoke({ action: 'domain:request', domain });
  },

  verifyDomain(): Promise<{
    ok: boolean;
    verifiedAt?: string;
    verification: { txtVerified: boolean; cnameVerified: boolean };
  }> {
    return invoke({ action: 'domain:verify' });
  },
};
