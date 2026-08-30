import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkoutPayloadMatches,
  containsCardMaterial,
  parseSaasCheckoutBillingType,
  resolveProviderCustomer,
  resolveProviderSubscription,
  saasCheckoutNextDueDate,
  saasCheckoutProviderReference,
} from '../supabase/functions/create-saas-checkout/provider-safety';

const checkoutId = '00000000-0000-4000-8000-000000000100';
const reference = saasCheckoutProviderReference(checkoutId);

describe('segurança do checkout School OS', () => {
  it('aceita apenas PIX ou boleto e bloqueia qualquer material de cartão', () => {
    expect(parseSaasCheckoutBillingType('PIX')).toBe('PIX');
    expect(parseSaasCheckoutBillingType('BOLETO')).toBe('BOLETO');
    expect(parseSaasCheckoutBillingType('CREDIT_CARD')).toBeNull();
    expect(containsCardMaterial({ creditCard: { number: '4111111111111111' } })).toBe(true);
    expect(containsCardMaterial({ payment: { cvv: '123' } })).toBe(true);
    expect(containsCardMaterial({ billing_type: 'PIX', postalCode: '01000-000' })).toBe(false);
  });

  it('reutiliza somente o customer da mesma referência e identidade', () => {
    expect(resolveProviderCustomer([
      {
        id: 'cus_wrong',
        externalReference: 'saas:other',
        cpfCnpj: '11222333000181',
      },
      {
        id: 'cus_expected',
        externalReference: reference,
        cpfCnpj: '11.222.333/0001-81',
      },
    ], reference, '11222333000181')).toEqual({
      status: 'MATCH',
      id: 'cus_expected',
    });
    expect(resolveProviderCustomer([
      {
        id: 'cus_conflict',
        externalReference: reference,
        cpfCnpj: '99888777000166',
      },
    ], reference, '11222333000181')).toEqual({ status: 'CONFLICT' });
  });

  it('reutiliza somente a assinatura com escopo financeiro idêntico', () => {
    const expected = {
      reference,
      customerId: 'cus_expected',
      billingType: 'PIX' as const,
      billingCycle: 'YEARLY' as const,
      amount: 1190,
      description: 'Assinatura anual Wise Wolf',
      maxPayments: null,
      splitPolicy: { kind: 'NONE' as const },
      nextDueDate: '2026-08-26',
      status: 'ACTIVE' as const,
    };
    expect(resolveProviderSubscription([
      {
        id: 'sub_expected',
        externalReference: reference,
        customer: 'cus_expected',
        billingType: 'PIX',
        cycle: 'YEARLY',
        value: 1190,
        description: 'Assinatura anual Wise Wolf',
        nextDueDate: '2026-08-26',
        status: 'ACTIVE',
      },
    ], expected)).toEqual({ status: 'MATCH', id: 'sub_expected' });
    expect(resolveProviderSubscription([
      {
        id: 'sub_wrong_customer',
        externalReference: reference,
        customer: 'cus_other',
        billingType: 'PIX',
        cycle: 'YEARLY',
        value: 1190,
        description: 'Assinatura anual Wise Wolf',
        nextDueDate: '2026-08-26',
        status: 'ACTIVE',
      },
    ], expected)).toEqual({ status: 'CONFLICT' });
  });

  it('falha fechado quando duas assinaturas têm a mesma referência e escopo', () => {
    const expected = {
      reference,
      customerId: 'cus_expected',
      billingType: 'PIX' as const,
      billingCycle: 'MONTHLY' as const,
      amount: 397,
      description: 'Assinatura mensal Wise Wolf',
      maxPayments: null,
      splitPolicy: { kind: 'NONE' as const },
      nextDueDate: '2026-08-26',
      status: 'ACTIVE' as const,
    };
    const duplicate = {
      externalReference: reference,
      customer: 'cus_expected',
      billingType: 'PIX',
      cycle: 'MONTHLY',
      value: 397,
      description: 'Assinatura mensal Wise Wolf',
      nextDueDate: '2026-08-26',
      status: 'ACTIVE',
    };
    expect(resolveProviderSubscription([
      { ...duplicate, id: 'sub_older', dateCreated: '2026-08-23' },
      { ...duplicate, id: 'sub_newer', dateCreated: '2026-08-24' },
    ], expected)).toEqual({ status: 'CONFLICT' });
  });

  it('congela o primeiro vencimento a partir da criação do checkout', () => {
    expect(saasCheckoutNextDueDate('2026-08-25T23:59:59.000Z')).toBe('2026-08-26');
    expect(saasCheckoutNextDueDate('invalid')).toBeNull();
  });

  it('recusa reutilizar a mesma chave com outro payload', () => {
    const stored = {
      school_name: 'Wise Wolf Centro',
      owner_name: 'Marina Silva',
      owner_email: 'marina@example.invalid',
      owner_cpf_cnpj: '11.222.333/0001-81',
      owner_phone: '(11) 99999-0000',
      plan_id: '00000000-0000-4000-8000-000000000200',
      billing_cycle: 'MONTHLY',
      billing_type: 'PIX',
    };
    const expected = {
      schoolName: 'Wise Wolf Centro',
      ownerName: 'Marina Silva',
      ownerEmail: 'marina@example.invalid',
      ownerCpfCnpj: '11222333000181',
      ownerPhone: '11999990000',
      planId: '00000000-0000-4000-8000-000000000200',
      billingCycle: 'MONTHLY' as const,
      billingType: 'PIX' as const,
    };
    expect(checkoutPayloadMatches(stored, expected)).toBe(true);
    expect(checkoutPayloadMatches(stored, {
      ...expected,
      planId: '00000000-0000-4000-8000-000000000201',
    })).toBe(false);
  });

  it('reconcilia por GET e cerca os dois únicos POSTs sem compensação destrutiva', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'supabase/functions/create-saas-checkout/index.ts'),
      'utf8',
    );
    const customerClaim = source.indexOf('operation: "CUSTOMER_CREATE"');
    const customerLookup = source.indexOf(
      'const customerLookup = await findUniqueAsaasEntity',
      customerClaim,
    );
    const customerFence = source.indexOf(
      'await markAsaasCreationSubmitting(supabase, customerClaim)',
      customerLookup,
    );
    const customerCapabilityFence = source.indexOf(
      'await revalidateAsaasMutationCapability(',
      customerFence,
    );
    const customerPost = source.indexOf(
      '`${freshCustomerCreateIntegration.baseUrl}/customers`',
      customerCapabilityFence,
    );
    const subscriptionClaim = source.indexOf(
      'operation: "SUBSCRIPTION_CREATE"',
      customerPost,
    );
    const subscriptionLookup = source.indexOf(
      'const subscriptionLookup = await findUniqueAsaasEntity',
      subscriptionClaim,
    );
    const subscriptionFence = source.indexOf(
      'await markAsaasCreationSubmitting(supabase, subscriptionClaim)',
      subscriptionLookup,
    );
    const subscriptionCapabilityFence = source.indexOf(
      'await revalidateAsaasMutationCapability(',
      subscriptionFence,
    );
    const subscriptionPost = source.indexOf(
      '`${freshSubscriptionCreateIntegration.baseUrl}/subscriptions`',
      subscriptionCapabilityFence,
    );
    expect(customerClaim).toBeGreaterThanOrEqual(0);
    expect(customerLookup).toBeGreaterThan(customerClaim);
    expect(customerFence).toBeGreaterThan(customerLookup);
    expect(customerCapabilityFence).toBeGreaterThan(customerFence);
    expect(customerPost).toBeGreaterThan(customerCapabilityFence);
    expect(subscriptionClaim).toBeGreaterThan(customerPost);
    expect(subscriptionLookup).toBeGreaterThan(subscriptionClaim);
    expect(subscriptionFence).toBeGreaterThan(subscriptionLookup);
    expect(subscriptionCapabilityFence).toBeGreaterThan(subscriptionFence);
    expect(subscriptionPost).toBeGreaterThan(subscriptionCapabilityFence);
    expect(source.match(/method: "POST"/g)).toHaveLength(2);
    expect(source).toContain('method !== "GET"');
    expect(source).toContain('customerLookup.kind === "CONFLICT"');
    expect(source).toContain('subscriptionLookup.kind === "CONFLICT"');
    expect(source).toContain('.is("asaas_customer_id", null)');
    expect(source).toContain('.is("asaas_subscription_id", null)');
    expect(source).toContain('.eq("status", "PENDING")');
    expect(source).toContain('code: "INVALID_IDEMPOTENCY_KEY"');
    expect(source).not.toContain('method: "DELETE"');
    expect(source).not.toContain('reconcileAfterMutation(');
    expect(source).not.toContain('body.creditCard');
  });
});
