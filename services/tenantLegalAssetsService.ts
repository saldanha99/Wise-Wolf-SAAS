import { supabase } from '../lib/supabase';
import type { SchoolInfo } from '../components/ContractDocument';

interface TenantLegalCurrentResponse {
  tenantId: string;
  schoolInfo: SchoolInfo | null;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('tenant-legal-assets', { body });
  if (error) throw error;
  const payload = data as { error?: string } | null;
  if (payload?.error) throw new Error(payload.error);
  return data as T;
}

export const tenantLegalAssetsService = {
  current(): Promise<TenantLegalCurrentResponse> {
    return invoke({ action: 'current' });
  },

  teacherOffer(offerId: string): Promise<Record<string, unknown>> {
    return invoke({ action: 'offer', offerType: 'teacher', offerId });
  },

  vendorOffer(offerId: string): Promise<Record<string, unknown>> {
    return invoke({ action: 'offer', offerType: 'vendor', offerId });
  },

  enrollmentOffer(offerId: string): Promise<Record<string, unknown>> {
    return invoke({ action: 'offer', offerType: 'enrollment', offerId });
  },

  teacherContract(userId: string): Promise<Record<string, unknown>> {
    return invoke({ action: 'contract', userId });
  },
};
