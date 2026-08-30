const INACTIVE_LIFECYCLE_STATUSES = new Set([
  'SUSPENDED',
  'OFFBOARDED',
  'INACTIVE',
  'DELETED',
]);

export interface StudentSubscriptionStatus {
  subscription_id?: string | null;
  asaas_subscription_status?: string | null;
  lifecycle_status?: string | null;
}

/** Um ID histórico não comprova que a assinatura ainda está operante no Asaas. */
export const hasActiveAsaasSubscription = (profile: StudentSubscriptionStatus): boolean => {
  const providerStatus = String(profile?.asaas_subscription_status || '').trim().toUpperCase();
  const lifecycleStatus = String(profile?.lifecycle_status || '').trim().toUpperCase();
  return Boolean(profile?.subscription_id)
    && providerStatus === 'ACTIVE'
    && !INACTIVE_LIFECYCLE_STATUSES.has(lifecycleStatus);
};
