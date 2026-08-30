import { describe, expect, it } from 'vitest';
import { hasActiveAsaasSubscription } from './studentSubscriptionStatus';

describe('hasActiveAsaasSubscription', () => {
  it('exige status ACTIVE real no Asaas', () => {
    expect(hasActiveAsaasSubscription({ subscription_id: 'sub_historico' })).toBe(false);
    expect(hasActiveAsaasSubscription({ subscription_id: 'sub_1', asaas_subscription_status: 'INACTIVE' })).toBe(false);
    expect(hasActiveAsaasSubscription({ subscription_id: 'sub_1', asaas_subscription_status: 'DELETED' })).toBe(false);
  });

  it('respeita o desligamento local mesmo quando o Asaas ainda diz ACTIVE', () => {
    expect(hasActiveAsaasSubscription({
      subscription_id: 'sub_1',
      asaas_subscription_status: 'ACTIVE',
      lifecycle_status: 'offboarded',
    })).toBe(false);
  });

  it('considera ativa somente a combinação operacional', () => {
    expect(hasActiveAsaasSubscription({
      subscription_id: 'sub_1',
      asaas_subscription_status: 'active',
      lifecycle_status: 'active',
    })).toBe(true);
  });
});
