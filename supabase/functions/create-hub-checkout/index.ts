/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  asaasCreationFingerprint,
  asaasCreationHttpOutcome,
  claimAsaasCreation,
  findUniqueAsaasEntity,
  recordAsaasCreationState,
} from "../_shared/asaas-creation-guard.ts";
import {
  type AsaasMutationPurpose,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import {
  adoptHubProviderCreationBinding,
  markHubProviderCreationSubmitting,
} from "../_shared/hub-provider-operations.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  HUB_CORE_PRODUCT_FAMILY,
  hubBillingBlockCode,
  hubCheckoutDecision,
  hubFixtureCheckoutBlockCode,
  hubPlanMatchesAccountAudience,
  hubReplacementNeedsProviderReconciliation,
  isSupportedHubProductFamily,
  isValidHubAccountId,
  tenantMayCheckoutProduct,
  WOLFIE_PRODUCT_FAMILY,
} from "../_shared/hub-billing-safety.ts";
import {
  hasCurrentHubCoreLegalAcceptance,
  hasCurrentHubCoreLegalDocumentHashes,
  HUB_CORE_PRIVACY_SHA256,
  HUB_CORE_PRIVACY_SNAPSHOT,
  HUB_CORE_PRIVACY_VERSION,
  HUB_CORE_TERMS_SHA256,
  HUB_CORE_TERMS_SNAPSHOT,
  HUB_CORE_TERMS_VERSION,
  hubCoreLegalSnapshotsMatchExpectedHashes,
} from "./legal.ts";
import {
  decideHubAsaasCustomerPreservation,
  type HubAsaasCustomerOrigin,
  hubAsaasCustomerReference,
  normalizeAsaasCustomerId,
  resolveHubAsaasCustomerCandidate,
  resolveHubAsaasSubscriptionCandidate,
} from "./customer-idempotency.ts";
import {
  type AsaasIntegrationPurpose,
  type ResolvedAsaasIntegration,
  resolvePlatformAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Hub/Wolfie subscriptions are platform revenue and use the platform-owned
// root Asaas credential, regardless of the member's product tenant.
const PLATFORM_ASAAS_TENANT_ID = "school-wise-wolf";
const WOLFIE_STANDALONE_CHECKOUT_ENABLED =
  Deno.env.get("WOLFIE_STANDALONE_CHECKOUT_ENABLED")?.trim().toLowerCase() ===
    "true";
const WOLFIE_TERMS_VERSION = "2026-08-03-v1";
const HUB_CORE_LEGAL_SNAPSHOT_INTEGRITY =
  hubCoreLegalSnapshotsMatchExpectedHashes();

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const digits = (value: unknown) =>
  typeof value === "string" ? value.replace(/\D/g, "") : "";
const text = (value: unknown, max = 180) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const sameMoney = (left: unknown, right: number) => {
  const parsed = Number(left);
  return Number.isFinite(parsed) &&
    Math.round(parsed * 100) === Math.round(right * 100);
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isValidCpf = (value: string) => {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const digit = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(value[index]) * (length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(value[9]) && digit(10) === Number(value[10]);
};

const isValidCnpj = (value: string) => {
  if (!/^\d{14}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const calculate = (length: 12 | 13) => {
    const weights = length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce(
      (total, weight, index) => total + Number(value[index]) * weight,
      0,
    );
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return calculate(12) === Number(value[12]) &&
    calculate(13) === Number(value[13]);
};

const isValidCpfCnpj = (value: string) =>
  isValidCpf(value) || isValidCnpj(value);

async function asaasRequest(
  integration: ResolvedAsaasIntegration,
  path: string,
  init: RequestInit = {},
) {
  if ((init.method || "GET").toUpperCase() === "POST") {
    throw new Error("ASAAS_CREATION_REQUIRES_DURABLE_CLAIM");
  }
  const response = await fetch(`${integration.baseUrl}${path}`, {
    ...init,
    headers: {
      access_token: integration.apiKey,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const resource = path.split("?", 1)[0].split("/").filter(Boolean)[0] ||
      "unknown";
    console.error("Hub Asaas request failed", {
      method: init.method || "GET",
      resource,
      status: response.status,
    });
    throw new Error("ASAAS_REQUEST_FAILED");
  }
  return payload;
}

async function asaasListAll(
  integration: ResolvedAsaasIntegration,
  path: string,
  query: Record<string, string> = {},
): Promise<Array<Record<string, unknown>>> {
  const collected: Array<Record<string, unknown>> = [];
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const params = new URLSearchParams(query);
    params.set("limit", "100");
    params.set("offset", String(offset));
    const payload = await asaasRequest(
      integration,
      `${path}?${params.toString()}`,
    );
    if (!payload || !Array.isArray(payload.data)) {
      throw new Error("ASAAS_COLLECTION_INVALID");
    }
    const page = payload.data.filter((item: unknown) =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
    ) as Array<Record<string, unknown>>;
    collected.push(...page);
    if (payload.hasMore !== true) return collected;
    if (page.length === 0) throw new Error("ASAAS_COLLECTION_CURSOR_STALLED");
    offset += page.length;
  }
  throw new Error("ASAAS_COLLECTION_PAGE_LIMIT");
}

type ProviderPaymentSnapshot = {
  id: string | null;
  invoiceUrl: string | null;
  bankSlipUrl: string | null;
  dueDate: string | null;
};

function assertExactHubProviderPayment(
  entity: unknown,
  expected: {
    paymentId: string;
    subscriptionId: string;
    customerId: string;
    externalReference: string;
    amount: number;
    billingType: string;
    dueDate: string;
  },
): Record<string, unknown> {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    throw new Error("ASAAS_PAYMENT_PROVIDER_IDENTITY_CONFLICT");
  }
  const payment = entity as Record<string, unknown>;
  if (
    text(payment.id, 200) !== expected.paymentId ||
    text(payment.subscription, 200) !== expected.subscriptionId ||
    text(payment.customer, 200) !== expected.customerId ||
    text(payment.externalReference, 240) !== expected.externalReference ||
    text(payment.billingType, 40).toUpperCase() !== expected.billingType ||
    text(payment.dueDate, 10) !== expected.dueDate ||
    !sameMoney(payment.value, expected.amount) ||
    payment.deleted === true
  ) {
    throw new Error("ASAAS_PAYMENT_PROVIDER_IDENTITY_CONFLICT");
  }
  return payment;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    allowInactiveTenant: true,
    corsHeaders,
    allowWolfieDirect: true,
    allowedRoles: [
      "NON_STUDENT",
      "STUDENT",
      "TEACHER",
      "COORDINATOR",
      "SCHOOL_ADMIN",
      "SUPER_ADMIN",
      "SALESPERSON",
    ],
  });
  if (auth.ok === false) return auth.response;

  const integrations = new Map<
    AsaasIntegrationPurpose,
    ResolvedAsaasIntegration
  >();
  let canonicalIntegration: ResolvedAsaasIntegration | null = null;
  const providerIntegration = async (purpose: AsaasIntegrationPurpose) => {
    const cached = integrations.get(purpose);
    if (cached) return cached;
    const resolved = await resolvePlatformAsaasIntegration(
      auth.context.admin,
      purpose,
    );
    if (
      canonicalIntegration &&
      (canonicalIntegration.integrationId !== resolved.integrationId ||
        canonicalIntegration.provider !== resolved.provider ||
        canonicalIntegration.tenantId !== resolved.tenantId ||
        canonicalIntegration.mode !== resolved.mode ||
        canonicalIntegration.version !== resolved.version ||
        canonicalIntegration.baseUrl !== resolved.baseUrl ||
        canonicalIntegration.environment !== resolved.environment ||
        canonicalIntegration.apiKey !== resolved.apiKey)
    ) {
      throw new Error("ASAAS_PLATFORM_INTEGRATION_VERSION_CHANGED");
    }
    canonicalIntegration = canonicalIntegration || resolved;
    integrations.set(purpose, resolved);
    return resolved;
  };
  const providerMutationIntegration = async (
    purpose: AsaasMutationPurpose,
  ): Promise<ResolvedAsaasIntegration> => {
    if (!canonicalIntegration) {
      throw new Error("ASAAS_PLATFORM_INTEGRATION_UNRESOLVED");
    }
    return await revalidateAsaasMutationCapability(auth.context.admin, {
      tenantId: PLATFORM_ASAAS_TENANT_ID,
      purpose,
      expected: canonicalIntegration,
    });
  };

  let checkoutId: string | null = null;
  let providerSubscriptionId: string | null = null;
  let providerPayment: ProviderPaymentSnapshot | null = null;
  let checkoutMetadata: Record<string, unknown> = {};
  let providerCustomerId: string | null = null;
  let providerCustomerOrigin: HubAsaasCustomerOrigin | null = null;
  let providerCustomerLinkConfirmed = false;
  let createdProviderCustomerId: string | null = null;
  let hubLegalAcceptanceId: string | null = null;
  let providerCreationReconciliationRequired = false;
  let providerCreationReviewRequired = false;
  let providerCustomerLinkPending = false;
  let providerSubscriptionMustBePreserved = false;
  let providerPaymentReconciliationRequired = false;
  let inspectCreatedProviderCustomer:
    | (() => Promise<
      | "NOT_CREATED_BY_ATTEMPT"
      | "KEEP_LINKED_CUSTOMER"
      | "PRESERVE_CREATED_CUSTOMER_FOR_REVIEW"
    >)
    | null = null;
  try {
    const body = await req.json() as Record<string, unknown>;
    const planCode = text(body.planCode, 40).toUpperCase();
    const productFamily = text(body.productFamily, 40).toUpperCase() ||
      HUB_CORE_PRODUCT_FAMILY;
    const billingCycle = body.billingCycle === "YEARLY" ? "YEARLY" : "MONTHLY";
    const requestedBillingType = String(body.billingType || "PIX");
    if (!["PIX", "BOLETO"].includes(requestedBillingType)) {
      return json(400, {
        error: "UNSUPPORTED_BILLING_TYPE",
        code: "UNSUPPORTED_BILLING_TYPE",
      });
    }
    const billingType = requestedBillingType as "PIX" | "BOLETO";
    const customerName = text(body.name, 160);
    const customerEmail = text(auth.context.user?.email || body.email)
      .toLowerCase();
    const cpfCnpj = digits(body.cpfCnpj);
    const phone = digits(body.phone);
    const requestedAccountId = text(body.accountId, 40);
    const requestKey = text(body.requestKey, 40);
    const termsVersion = text(body.termsVersion, 80);
    const privacyVersion = text(body.privacyVersion, 80);
    const termsSha256 = text(body.termsSha256, 64).toLowerCase();
    const privacySha256 = text(body.privacySha256, 64).toLowerCase();
    const acceptedTerms = body.acceptedTerms === true;
    const acceptedPrivacy = body.acceptedPrivacy === true;
    const testMode = body.testMode === true;
    const userIsTestFixture =
      auth.context.user?.app_metadata?.test_fixture === true;
    const providerEnvironment = (await providerIntegration("customer.read"))
      .environment;
    const fixtureBlockCode = hubFixtureCheckoutBlockCode({
      testMode,
      userIsTestFixture,
      sandboxProvider: providerEnvironment === "sandbox",
    });
    const isTestFixture = testMode && userIsTestFixture;
    if (
      !planCode || customerName.length < 3 || !customerEmail.includes("@") ||
      !isValidCpfCnpj(cpfCnpj) || phone.length < 10 || phone.length > 13 ||
      !isValidHubAccountId(requestedAccountId) ||
      !UUID_PATTERN.test(requestKey)
    ) {
      return json(400, {
        error: "INVALID_CHECKOUT_DATA",
        code: "INVALID_CHECKOUT_DATA",
      });
    }
    if (!isSupportedHubProductFamily(productFamily)) {
      return json(400, {
        error: "INVALID_PRODUCT_FAMILY",
        code: "INVALID_PRODUCT_FAMILY",
      });
    }
    if (productFamily === HUB_CORE_PRODUCT_FAMILY) {
      if (!await HUB_CORE_LEGAL_SNAPSHOT_INTEGRITY) {
        return json(503, {
          error: "HUB_LEGAL_CONFIGURATION_INVALID",
          code: "HUB_LEGAL_CONFIGURATION_INVALID",
        });
      }
      const currentLegalVersions = termsVersion === HUB_CORE_TERMS_VERSION &&
        privacyVersion === HUB_CORE_PRIVACY_VERSION;
      if (
        acceptedTerms && acceptedPrivacy && currentLegalVersions &&
        !hasCurrentHubCoreLegalDocumentHashes({
          termsSha256,
          privacySha256,
        })
      ) {
        return json(409, {
          error: "HUB_LEGAL_DOCUMENT_MISMATCH",
          code: "HUB_LEGAL_DOCUMENT_MISMATCH",
          currentTermsVersion: HUB_CORE_TERMS_VERSION,
          currentPrivacyVersion: HUB_CORE_PRIVACY_VERSION,
          currentTermsSha256: HUB_CORE_TERMS_SHA256,
          currentPrivacySha256: HUB_CORE_PRIVACY_SHA256,
        });
      }
      if (
        !hasCurrentHubCoreLegalAcceptance({
          acceptedTerms,
          acceptedPrivacy,
          termsVersion,
          privacyVersion,
          termsSha256,
          privacySha256,
        })
      ) {
        return json(400, {
          error: "INVALID_HUB_CORE_LEGAL_ACCEPTANCE",
          code: "INVALID_HUB_CORE_LEGAL_ACCEPTANCE",
          currentTermsVersion: HUB_CORE_TERMS_VERSION,
          currentPrivacyVersion: HUB_CORE_PRIVACY_VERSION,
          currentTermsSha256: HUB_CORE_TERMS_SHA256,
          currentPrivacySha256: HUB_CORE_PRIVACY_SHA256,
        });
      }
      const { data: hubSettings, error: hubSettingsError } = await auth.context
        .admin
        .from("hub_settings")
        .select("metadata")
        .eq("settings_key", "default")
        .maybeSingle();
      if (hubSettingsError) throw hubSettingsError;
      if (hubSettings?.metadata?.hubEnabled === false) {
        return json(503, {
          error: "HUB_DISABLED",
          code: "HUB_DISABLED",
        });
      }
      const { data: catalogReady, error: catalogReadyError } = await auth
        .context.admin
        .rpc("hub_catalog_checkout_is_ready");
      if (catalogReadyError) throw catalogReadyError;
      if (catalogReady !== true) {
        return json(503, {
          error: "HUB_CATALOG_NOT_READY",
          code: "HUB_CATALOG_NOT_READY",
        });
      }
    }
    if (fixtureBlockCode) {
      return json(409, {
        error: fixtureBlockCode,
        code: fixtureBlockCode,
      });
    }
    if (
      !tenantMayCheckoutProduct(
        auth.context.profile?.tenant_id,
        productFamily,
      )
    ) {
      return json(403, {
        error: "WOLFIE_PRODUCT_BOUNDARY_VIOLATION",
        code: "WOLFIE_PRODUCT_BOUNDARY_VIOLATION",
      });
    }
    if (productFamily === WOLFIE_PRODUCT_FAMILY) {
      if (!WOLFIE_STANDALONE_CHECKOUT_ENABLED) {
        return json(503, {
          error: "WOLFIE_CHECKOUT_TEMPORARILY_UNAVAILABLE",
          code: "WOLFIE_CHECKOUT_TEMPORARILY_UNAVAILABLE",
        });
      }
      if (auth.context.profile?.tenant_id !== "wolfie-direct") {
        return json(409, {
          error: "WOLFIE_ACCOUNT_PREPARATION_REQUIRED",
          code: "WOLFIE_ACCOUNT_PREPARATION_REQUIRED",
        });
      }
      if (billingCycle !== "MONTHLY" || termsVersion !== WOLFIE_TERMS_VERSION) {
        return json(400, {
          error: "INVALID_WOLFIE_CHECKOUT_TERMS",
          code: "INVALID_WOLFIE_CHECKOUT_TERMS",
        });
      }
    }

    const membershipQuery = auth.context.admin
      .from("hub_memberships")
      .select(
        "account_id, membership_role, hub_accounts!inner(id, name, audience, account_type, owner_user_id, status, asaas_customer_id)",
      )
      .eq("user_id", auth.context.userId)
      .eq("account_id", requestedAccountId)
      .eq("status", "ACTIVE")
      .order("created_at")
      .limit(1);
    const membershipResult = productFamily === WOLFIE_PRODUCT_FAMILY
      ? await membershipQuery
        .eq("membership_role", "OWNER")
        .eq("hub_accounts.account_type", "PERSONAL")
        .eq("hub_accounts.owner_user_id", auth.context.userId)
        .maybeSingle()
      : await membershipQuery
        .in("membership_role", ["OWNER", "ADMIN"])
        .maybeSingle();
    const { data: membership, error: membershipError } = membershipResult;
    if (membershipError) throw membershipError;
    if (!membership) {
      return json(403, {
        error: "HUB_MANAGER_REQUIRED",
        code: "HUB_MANAGER_REQUIRED",
      });
    }
    const account = Array.isArray(membership.hub_accounts)
      ? membership.hub_accounts[0]
      : membership.hub_accounts;
    if (!account) {
      return json(404, {
        error: "HUB_ACCOUNT_REQUIRED",
        code: "HUB_ACCOUNT_REQUIRED",
      });
    }
    if (account.status !== "ACTIVE") {
      return json(403, {
        error: "HUB_ACCOUNT_INACTIVE",
        code: "HUB_ACCOUNT_INACTIVE",
      });
    }
    if (
      productFamily === WOLFIE_PRODUCT_FAMILY && account.audience !== "LEARNER"
    ) {
      return json(403, {
        error: "WOLFIE_LEARNER_ACCOUNT_REQUIRED",
        code: "WOLFIE_LEARNER_ACCOUNT_REQUIRED",
      });
    }

    const { data: plan, error: planError } = await auth.context.admin
      .from("hub_plans")
      .select(
        "id, code, name, audience, price_monthly, price_yearly, metadata, product_family",
      )
      .eq("code", planCode)
      .eq("product_family", productFamily)
      .eq("is_active", true)
      .eq("is_public", true)
      .maybeSingle();
    if (planError) throw planError;
    if (!plan || plan.code === "DISCOVERY") {
      return json(400, { error: "INVALID_PLAN", code: "INVALID_PLAN" });
    }
    if (plan.product_family !== productFamily) {
      return json(400, {
        error: "INVALID_PRODUCT_PLAN",
        code: "INVALID_PRODUCT_PLAN",
      });
    }
    if (
      !hubPlanMatchesAccountAudience(
        productFamily,
        plan.audience,
        account.audience,
      )
    ) {
      return json(403, {
        error: "HUB_PLAN_AUDIENCE_MISMATCH",
        code: "HUB_PLAN_AUDIENCE_MISMATCH",
      });
    }
    if (plan.metadata?.sales_assisted === true) {
      return json(409, {
        error: "SALES_ASSISTED_PLAN",
        code: "SALES_ASSISTED_PLAN",
      });
    }
    if (productFamily === WOLFIE_PRODUCT_FAMILY) {
      if (
        !["LEARNER", "ALL"].includes(plan.audience) ||
        plan.metadata?.checkout_enabled !== true
      ) {
        return json(400, {
          error: "INVALID_WOLFIE_PLAN",
          code: "INVALID_WOLFIE_PLAN",
        });
      }
      const { data: acceptance, error: acceptanceError } = await auth.context
        .admin
        .from("wolfie_standalone_acceptances")
        .select("id")
        .eq("account_id", membership.account_id)
        .eq("user_id", auth.context.userId)
        .eq("terms_version", termsVersion)
        .maybeSingle();
      if (acceptanceError) throw acceptanceError;
      if (!acceptance) {
        return json(409, {
          error: "WOLFIE_TERMS_ACCEPTANCE_REQUIRED",
          code: "WOLFIE_TERMS_ACCEPTANCE_REQUIRED",
        });
      }
    }
    if (productFamily === HUB_CORE_PRODUCT_FAMILY) {
      const acceptanceIdentity = {
        account_id: membership.account_id,
        user_id: auth.context.userId,
        terms_version: termsVersion,
        privacy_version: privacyVersion,
      };
      const acceptanceProof = {
        terms_snapshot: HUB_CORE_TERMS_SNAPSHOT,
        terms_sha256: termsSha256,
        privacy_snapshot: HUB_CORE_PRIVACY_SNAPSHOT,
        privacy_sha256: privacySha256,
      };
      const { error: acceptanceInsertError } = await auth.context.admin
        .from("hub_core_legal_acceptances")
        .upsert(
          {
            ...acceptanceIdentity,
            ...acceptanceProof,
            source: "HUB_CORE_CHECKOUT",
            request_key: requestKey,
          },
          {
            onConflict: "account_id,user_id,terms_version,privacy_version",
            ignoreDuplicates: true,
          },
        );
      if (acceptanceInsertError) throw acceptanceInsertError;

      const { data: acceptance, error: acceptanceReadError } = await auth
        .context.admin
        .from("hub_core_legal_acceptances")
        .select("id, terms_sha256, privacy_sha256")
        .match(acceptanceIdentity)
        .maybeSingle();
      if (acceptanceReadError || !acceptance) {
        throw acceptanceReadError || new Error("HUB_LEGAL_ACCEPTANCE_REQUIRED");
      }
      if (
        acceptance.terms_sha256 !== termsSha256 ||
        acceptance.privacy_sha256 !== privacySha256
      ) {
        return json(409, {
          error: "HUB_LEGAL_DOCUMENT_VERSION_CONFLICT",
          code: "HUB_LEGAL_DOCUMENT_VERSION_CONFLICT",
        });
      }
      hubLegalAcceptanceId = acceptance.id;
    }
    let amount = Number(
      billingCycle === "YEARLY" ? plan.price_yearly : plan.price_monthly,
    );
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(400, {
        error: "PLAN_PRICE_UNAVAILABLE",
        code: "PLAN_PRICE_UNAVAILABLE",
      });
    }

    let resumableCheckout: {
      id: string;
      created_at: string;
      amount: number;
      asaas_subscription_id: string | null;
      metadata: Record<string, unknown>;
    } | null = null;
    const { data: existingCheckout, error: existingCheckoutError } = await auth
      .context.admin
      .from("hub_checkout_sessions")
      .select(
        "id, account_id, plan_id, product_family, billing_cycle, billing_type, status, amount, invoice_url, bank_slip_url, asaas_payment_id, asaas_subscription_id, metadata, created_at",
      )
      .eq("requested_by", auth.context.userId)
      .eq("request_key", requestKey)
      .maybeSingle();
    if (existingCheckoutError) throw existingCheckoutError;
    if (existingCheckout) {
      if (
        existingCheckout.account_id !== requestedAccountId ||
        existingCheckout.plan_id !== plan.id ||
        existingCheckout.product_family !== productFamily ||
        existingCheckout.billing_cycle !== billingCycle ||
        existingCheckout.billing_type !== billingType
      ) {
        return json(409, {
          error: "IDEMPOTENCY_KEY_REUSED",
          code: "IDEMPOTENCY_KEY_REUSED",
          checkoutId: existingCheckout.id,
        });
      }
      if (existingCheckout.status === "CREATED") {
        resumableCheckout = {
          id: existingCheckout.id,
          created_at: existingCheckout.created_at,
          amount: Number(existingCheckout.amount),
          asaas_subscription_id: existingCheckout.asaas_subscription_id,
          metadata: existingCheckout.metadata &&
              typeof existingCheckout.metadata === "object"
            ? existingCheckout.metadata as Record<string, unknown>
            : {},
        };
        checkoutId = existingCheckout.id;
        checkoutMetadata = resumableCheckout.metadata;
        if (
          !Number.isFinite(resumableCheckout.amount) ||
          resumableCheckout.amount <= 0
        ) {
          throw new Error("HUB_CHECKOUT_AMOUNT_INVALID");
        }
        amount = resumableCheckout.amount;
      } else {
        if (
          ["FAILED", "CANCELLED", "REVERSED"].includes(
            existingCheckout.status,
          )
        ) {
          return json(409, {
            error: "CHECKOUT_RETRY_WITH_NEW_KEY",
            code: "CHECKOUT_RETRY_WITH_NEW_KEY",
            checkoutId: existingCheckout.id,
          });
        }
        let existingPix = null;
        if (existingCheckout.asaas_payment_id) {
          const expectedCustomerId = normalizeAsaasCustomerId(
            account.asaas_customer_id,
          );
          const expectedSubscriptionId = normalizeAsaasCustomerId(
            existingCheckout.asaas_subscription_id,
          );
          const expectedDueDate = text(
            existingCheckout.metadata?.dueDate,
            10,
          );
          if (
            !expectedCustomerId || !expectedSubscriptionId ||
            !/^\d{4}-\d{2}-\d{2}$/.test(expectedDueDate)
          ) {
            throw new Error("ASAAS_PAYMENT_LOCAL_IDENTITY_INCOMPLETE");
          }
          const paymentRead = await providerIntegration("payment.read");
          const providerPaymentSnapshot = await asaasRequest(
            paymentRead,
            `/payments/${
              encodeURIComponent(existingCheckout.asaas_payment_id)
            }`,
          );
          assertExactHubProviderPayment(providerPaymentSnapshot, {
            paymentId: existingCheckout.asaas_payment_id,
            subscriptionId: expectedSubscriptionId,
            customerId: expectedCustomerId,
            externalReference: `hub:${existingCheckout.id}`,
            amount: Number(existingCheckout.amount),
            billingType,
            dueDate: expectedDueDate,
          });
          if (billingType === "PIX") {
            existingPix = await asaasRequest(
              paymentRead,
              `/payments/${
                encodeURIComponent(existingCheckout.asaas_payment_id)
              }/pixQrCode`,
            );
          }
        }
        return json(200, {
          success: true,
          idempotent: true,
          checkoutId: existingCheckout.id,
          status: existingCheckout.status,
          amount: Number(existingCheckout.amount),
          invoiceUrl: existingCheckout.invoice_url,
          bankSlipUrl: existingCheckout.bank_slip_url,
          pix: existingPix
            ? {
              copyPaste: existingPix.payload,
              qrCode: existingPix.encodedImage,
            }
            : null,
        });
      }
    }

    if (!resumableCheckout) {
      const { data: pendingCheckout, error: pendingCheckoutError } = await auth
        .context.admin
        .from("hub_checkout_sessions")
        .select(
          "id, plan_id, product_family, billing_cycle, billing_type, status, amount, invoice_url, bank_slip_url, asaas_payment_id, asaas_subscription_id, metadata, created_at",
        )
        .eq("account_id", membership.account_id)
        .eq("product_family", productFamily)
        .in("status", ["CREATED", "PENDING", "OVERDUE"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (pendingCheckoutError) throw pendingCheckoutError;
      if (pendingCheckout) {
        if (pendingCheckout.status === "CREATED") {
          return json(409, {
            error: "CHECKOUT_IN_PROGRESS",
            code: "CHECKOUT_IN_PROGRESS",
            checkoutId: pendingCheckout.id,
          });
        }
        if (
          pendingCheckout.plan_id !== plan.id ||
          pendingCheckout.product_family !== productFamily ||
          pendingCheckout.billing_cycle !== billingCycle ||
          pendingCheckout.billing_type !== billingType
        ) {
          return json(409, {
            error: "PENDING_CHECKOUT_EXISTS",
            code: "PENDING_CHECKOUT_EXISTS",
            checkoutId: pendingCheckout.id,
          });
        }
        let pendingPix = null;
        if (pendingCheckout.asaas_payment_id) {
          const expectedCustomerId = normalizeAsaasCustomerId(
            account.asaas_customer_id,
          );
          const expectedSubscriptionId = normalizeAsaasCustomerId(
            pendingCheckout.asaas_subscription_id,
          );
          const expectedDueDate = text(pendingCheckout.metadata?.dueDate, 10);
          if (
            !expectedCustomerId || !expectedSubscriptionId ||
            !/^\d{4}-\d{2}-\d{2}$/.test(expectedDueDate)
          ) {
            throw new Error("ASAAS_PAYMENT_LOCAL_IDENTITY_INCOMPLETE");
          }
          const paymentRead = await providerIntegration("payment.read");
          const providerPaymentSnapshot = await asaasRequest(
            paymentRead,
            `/payments/${encodeURIComponent(pendingCheckout.asaas_payment_id)}`,
          );
          assertExactHubProviderPayment(providerPaymentSnapshot, {
            paymentId: pendingCheckout.asaas_payment_id,
            subscriptionId: expectedSubscriptionId,
            customerId: expectedCustomerId,
            externalReference: `hub:${pendingCheckout.id}`,
            amount: Number(pendingCheckout.amount),
            billingType,
            dueDate: expectedDueDate,
          });
          if (billingType === "PIX") {
            pendingPix = await asaasRequest(
              paymentRead,
              `/payments/${
                encodeURIComponent(pendingCheckout.asaas_payment_id)
              }/pixQrCode`,
            );
          }
        }
        return json(200, {
          success: true,
          idempotent: true,
          checkoutId: pendingCheckout.id,
          status: pendingCheckout.status,
          amount: Number(pendingCheckout.amount),
          invoiceUrl: pendingCheckout.invoice_url,
          bankSlipUrl: pendingCheckout.bank_slip_url,
          pix: pendingPix
            ? { copyPaste: pendingPix.payload, qrCode: pendingPix.encodedImage }
            : null,
        });
      }
    }

    const { data: liveSubscription, error: liveSubscriptionError } = await auth
      .context.admin
      .from("hub_subscriptions")
      .select(
        "id, plan_id, status, billing_cycle, trial_ends_at, current_period_ends_at, provider, provider_subscription_id, hub_plans!inner(code, product_family)",
      )
      .eq("account_id", membership.account_id)
      .eq("product_family", productFamily)
      .eq("hub_plans.product_family", productFamily)
      .in("status", ["TRIALING", "INCOMPLETE", "ACTIVE", "PAST_DUE"])
      .maybeSingle();
    if (liveSubscriptionError) throw liveSubscriptionError;
    const livePlan = Array.isArray(liveSubscription?.hub_plans)
      ? liveSubscription?.hub_plans[0]
      : liveSubscription?.hub_plans;
    const liveSubscriptionSnapshot = liveSubscription
      ? {
        status: liveSubscription.status,
        planId: liveSubscription.plan_id,
        planCode: livePlan?.code,
        billingCycle: liveSubscription.billing_cycle,
        trialEndsAt: liveSubscription.trial_ends_at,
        currentPeriodEndsAt: liveSubscription.current_period_ends_at,
        provider: liveSubscription.provider,
        providerSubscriptionId: liveSubscription.provider_subscription_id,
      }
      : null;
    const subscriptionDecision = hubCheckoutDecision(
      liveSubscriptionSnapshot,
      { planId: plan.id, billingCycle },
    );
    if (subscriptionDecision === "BLOCK_INCOMPLETE") {
      return json(409, {
        error: "SUBSCRIPTION_INCOMPLETE",
        code: "SUBSCRIPTION_INCOMPLETE",
        subscriptionId: liveSubscription?.id,
      });
    }
    if (subscriptionDecision === "ALREADY_ACTIVE") {
      return json(409, {
        error: "SUBSCRIPTION_ALREADY_ACTIVE",
        code: "SUBSCRIPTION_ALREADY_ACTIVE",
        subscriptionId: liveSubscription?.id,
      });
    }
    if (
      hubReplacementNeedsProviderReconciliation(
        liveSubscriptionSnapshot,
        subscriptionDecision,
      )
    ) {
      return json(409, {
        error: "SUBSCRIPTION_RECONCILIATION_REQUIRED",
        code: "SUBSCRIPTION_RECONCILIATION_REQUIRED",
        subscriptionId: liveSubscription?.id,
      });
    }

    checkoutMetadata = {
      ...checkoutMetadata,
      ...(!resumableCheckout
        ? {
          fulfillment_snapshot: {
            version: 1,
            account_id: membership.account_id,
            user_id: auth.context.userId,
            plan_id: plan.id,
            product_family: productFamily,
            plan_code: plan.code,
            plan_name: plan.name,
            email_recipient: customerEmail,
            whatsapp_recipient: phone,
            recipient_name: customerName,
            test_fixture: isTestFixture,
          },
        }
        : {}),
      ...(isTestFixture ? { test_fixture: true } : {}),
      ...(testMode ? { testMode: true } : {}),
      product_family: productFamily,
      provider_subscription_description:
        text(checkoutMetadata.provider_subscription_description, 240) ||
        (productFamily === WOLFIE_PRODUCT_FAMILY
          ? `Wolfie AI Tutor - ${plan.name}`
          : `Wise Wolf Hub - ${plan.name} (${billingCycle})`),
      ...(subscriptionDecision === "ALLOW_REPLACEMENT" && liveSubscription
        ? {
          replacesSubscriptionId: liveSubscription.id,
          replacesPlanId: liveSubscription.plan_id,
          replacesProvider: liveSubscription.provider,
          replacesProviderSubscriptionId:
            liveSubscription.provider_subscription_id,
          replacementRequestedAt: new Date().toISOString(),
        }
        : {}),
      ...(productFamily === HUB_CORE_PRODUCT_FAMILY
        ? {
          terms_version: termsVersion,
          privacy_version: privacyVersion,
          terms_sha256: termsSha256,
          privacy_sha256: privacySha256,
          legal_acceptance_id: hubLegalAcceptanceId,
        }
        : productFamily === WOLFIE_PRODUCT_FAMILY
        ? {
          terms_version: termsVersion,
        }
        : {}),
    };

    let checkout = resumableCheckout;
    if (!checkout) {
      const { data: insertedCheckout, error: checkoutError } = await auth
        .context
        .admin
        .from("hub_checkout_sessions")
        .insert({
          account_id: membership.account_id,
          plan_id: plan.id,
          requested_by: auth.context.userId,
          billing_cycle: billingCycle,
          billing_type: billingType,
          amount,
          status: "CREATED",
          request_key: requestKey,
          product_family: productFamily,
          metadata: checkoutMetadata,
        })
        .select("id, created_at")
        .single();
      if (checkoutError || !insertedCheckout) {
        throw checkoutError || new Error("CHECKOUT_CREATE_FAILED");
      }
      checkout = {
        id: insertedCheckout.id,
        created_at: insertedCheckout.created_at,
        amount,
        asaas_subscription_id: null,
        metadata: checkoutMetadata,
      };
      checkoutId = checkout.id;
    }

    // This transactionally repairs the checkout -> outbox crash gap.  It is
    // deliberately outside the fresh-only block: a retry must prove the same
    // frozen recipients and the same two durable rows before any Asaas POST.
    const { data: fulfillmentFenceData, error: fulfillmentFenceError } =
      await auth.context.admin.rpc(
        "hub_ensure_checkout_fulfillment_outbox",
        {
          p_checkout_id: checkout.id,
          p_account_id: membership.account_id,
          p_plan_id: plan.id,
          p_requested_by: auth.context.userId,
          p_product_family: productFamily,
          p_email_recipient: customerEmail,
          p_whatsapp_recipient: phone,
          p_recipient_name: customerName,
          p_test_fixture: isTestFixture,
        },
      );
    if (fulfillmentFenceError) throw fulfillmentFenceError;
    const fulfillmentFence = fulfillmentFenceData &&
        typeof fulfillmentFenceData === "object" &&
        !Array.isArray(fulfillmentFenceData)
      ? fulfillmentFenceData as Record<string, unknown>
      : null;
    if (
      fulfillmentFence?.ok !== true ||
      fulfillmentFence.checkoutId !== checkout.id ||
      Number(fulfillmentFence.rowCount) !== 2
    ) {
      console.error("Hub fulfillment outbox reconciliation required", {
        checkoutId: checkout.id,
        reason: text(fulfillmentFence?.reason, 80) || "invalid_postcondition",
      });
      return json(409, {
        error: "HUB_FULFILLMENT_RECONCILIATION_REQUIRED",
        code: "HUB_FULFILLMENT_RECONCILIATION_REQUIRED",
        checkoutId: checkout.id,
      });
    }
    if (checkoutMetadata.provider_creation_review_required === true) {
      providerCreationReviewRequired = true;
      throw new Error("ASAAS_PROVIDER_CREATION_REVIEW_REQUIRED");
    }

    const assertCheckoutStillAuthorized = async (): Promise<void> => {
      const authorityQuery = auth.context.admin
        .from("hub_memberships")
        .select(
          "membership_role, status, hub_accounts!inner(id, status, account_type, owner_user_id)",
        )
        .eq("user_id", auth.context.userId)
        .eq("account_id", requestedAccountId)
        .eq("status", "ACTIVE");
      const authorityResult = productFamily === WOLFIE_PRODUCT_FAMILY
        ? await authorityQuery
          .eq("membership_role", "OWNER")
          .eq("hub_accounts.account_type", "PERSONAL")
          .eq("hub_accounts.owner_user_id", auth.context.userId)
          .maybeSingle()
        : await authorityQuery
          .in("membership_role", ["OWNER", "ADMIN"])
          .maybeSingle();
      if (authorityResult.error) throw authorityResult.error;
      if (!authorityResult.data) {
        throw new Error("HUB_CHECKOUT_AUTHORIZATION_REVOKED");
      }

      const currentAccount = Array.isArray(authorityResult.data.hub_accounts)
        ? authorityResult.data.hub_accounts[0]
        : authorityResult.data.hub_accounts;
      let hubEnabled = true;
      if (productFamily === HUB_CORE_PRODUCT_FAMILY) {
        const { data: currentSettings, error: currentSettingsError } =
          await auth.context.admin
            .from("hub_settings")
            .select("metadata")
            .eq("settings_key", "default")
            .maybeSingle();
        if (currentSettingsError) throw currentSettingsError;
        hubEnabled = currentSettings?.metadata?.hubEnabled !== false;
      }
      const billingBlock = hubBillingBlockCode(
        productFamily,
        currentAccount?.status,
        hubEnabled,
      );
      if (billingBlock) throw new Error(billingBlock);

      const { data: openCheckout, error: openCheckoutError } = await auth
        .context.admin
        .from("hub_checkout_sessions")
        .select("id")
        .eq("id", checkout.id)
        .in("status", ["CREATED", "PENDING"])
        .maybeSingle();
      if (openCheckoutError) throw openCheckoutError;
      if (!openCheckout) throw new Error("HUB_CHECKOUT_CLOSED");

      if (productFamily === HUB_CORE_PRODUCT_FAMILY) {
        const [catalogRecheck, cancellationRecheck] = await Promise.all([
          auth.context.admin.rpc("hub_catalog_checkout_is_ready"),
          auth.context.admin
            .from("hub_subscriptions")
            .select("id, metadata")
            .eq("account_id", requestedAccountId)
            .eq("product_family", HUB_CORE_PRODUCT_FAMILY)
            .eq("status", "ACTIVE")
            .gt("current_period_ends_at", new Date().toISOString())
            .limit(10),
        ]);
        if (catalogRecheck.error) throw catalogRecheck.error;
        if (catalogRecheck.data !== true) {
          throw new Error("HUB_CATALOG_NOT_READY");
        }
        if (cancellationRecheck.error) throw cancellationRecheck.error;
        const cancellationPending = (cancellationRecheck.data || []).some(
          (subscription) =>
            subscription.metadata?.cancelAtPeriodEnd === true ||
            subscription.metadata?.cancellationInProgress === true,
        );
        if (cancellationPending) {
          throw new Error("HUB_SUBSCRIPTION_CANCELLATION_PENDING");
        }
      }
    };

    const loadAccountCustomerLink = async (requireActive: boolean) => {
      const { data: currentAccount, error: currentAccountError } = await auth
        .context.admin
        .from("hub_accounts")
        .select("id, status, asaas_customer_id")
        .eq("id", membership.account_id)
        .maybeSingle();
      if (currentAccountError) throw currentAccountError;
      if (!currentAccount) {
        return { exists: false, customerId: null as string | null };
      }
      if (requireActive && currentAccount.status !== "ACTIVE") {
        throw new Error("HUB_ACCOUNT_INACTIVE");
      }
      const rawCustomerId = typeof currentAccount.asaas_customer_id === "string"
        ? currentAccount.asaas_customer_id.trim()
        : "";
      const currentCustomerId = normalizeAsaasCustomerId(rawCustomerId);
      if (rawCustomerId && !currentCustomerId) {
        throw new Error("ASAAS_CUSTOMER_LINK_INVALID");
      }
      return { exists: true, customerId: currentCustomerId };
    };

    const loadLinkedAccountIds = async (customerId: string) => {
      const { data: linkedAccounts, error: linkedAccountsError } = await auth
        .context.admin
        .from("hub_accounts")
        .select("id")
        .eq("asaas_customer_id", customerId)
        .limit(2);
      if (linkedAccountsError) throw linkedAccountsError;
      return (linkedAccounts ?? []).map((linkedAccount) => linkedAccount.id);
    };

    const assertCustomerScopedToAccount = async (customerId: string) => {
      const linkedAccountIds = await loadLinkedAccountIds(customerId);
      if (
        linkedAccountIds.some((linkedAccountId) =>
          linkedAccountId !== membership.account_id
        )
      ) {
        throw new Error("ASAAS_CUSTOMER_ACCOUNT_CONFLICT");
      }
    };
    const customerReference = hubAsaasCustomerReference(
      membership.account_id,
    );
    const assertProviderCustomerIdentity = async (customerId: string) => {
      const providerCustomer = await asaasRequest(
        await providerIntegration("customer.read"),
        `/customers/${encodeURIComponent(customerId)}`,
      );
      const resolution = resolveHubAsaasCustomerCandidate(
        [providerCustomer],
        customerReference,
        cpfCnpj,
      );
      if (
        resolution.status !== "MATCH" || resolution.customerId !== customerId
      ) {
        throw new Error("ASAAS_CUSTOMER_PROVIDER_IDENTITY_CONFLICT");
      }
    };

    inspectCreatedProviderCustomer = async () => {
      let linkedCustomerIds: string[] = [];
      let linkStateConfirmed = true;
      if (createdProviderCustomerId) {
        try {
          const linkedAccountIds = await loadLinkedAccountIds(
            createdProviderCustomerId,
          );
          linkedCustomerIds = linkedAccountIds.length > 0
            ? [createdProviderCustomerId]
            : [];
        } catch {
          linkStateConfirmed = false;
        }
      }
      return decideHubAsaasCustomerPreservation({
        createdCustomerId: createdProviderCustomerId,
        linkedCustomerIds,
        linkStateConfirmed,
      });
    };

    await assertCheckoutStillAuthorized();
    const currentLink = await loadAccountCustomerLink(true);
    let customerId = currentLink.customerId;
    if (customerId) {
      await assertCustomerScopedToAccount(customerId);
      providerCustomerId = customerId;
      providerCustomerOrigin = "LINKED";
      providerCustomerLinkConfirmed = true;
    } else {
      const customerPayload = {
        name: customerName,
        email: customerEmail,
        cpfCnpj,
        mobilePhone: phone,
        address: text(body.address) || "A definir",
        addressNumber: text(body.addressNumber, 20) || "SN",
        province: text(body.province) || "Centro",
        postalCode: digits(body.postalCode) || "01000000",
        externalReference: customerReference,
      };
      const customerClaim = await claimAsaasCreation(auth.context.admin, {
        tenantId: PLATFORM_ASAAS_TENANT_ID,
        operation: "CUSTOMER_CREATE",
        logicalKey: `hub-account:${membership.account_id}`,
        externalReference: customerReference,
        requestFingerprint: await asaasCreationFingerprint({
          operation: "CUSTOMER_CREATE",
          tenantId: PLATFORM_ASAAS_TENANT_ID,
          logicalKey: `hub-account:${membership.account_id}`,
          payload: customerPayload,
        }),
      });

      if (customerClaim.action === "ALREADY_SUCCEEDED") {
        customerId = normalizeAsaasCustomerId(
          customerClaim.provider_entity_id,
        );
        if (!customerId) {
          providerCreationReviewRequired = true;
          throw new Error("ASAAS_CUSTOMER_CLAIM_INVALID");
        }
        providerCustomerLinkPending = true;
        providerCustomerOrigin = "RECOVERED";
      } else if (
        customerClaim.action === "REVIEW_REQUIRED" || !customerClaim.ok
      ) {
        providerCreationReviewRequired = true;
        throw new Error("ASAAS_CUSTOMER_CREATION_REVIEW_REQUIRED");
      } else if (customerClaim.action === "IN_PROGRESS") {
        providerCreationReconciliationRequired = true;
        throw new Error("ASAAS_CUSTOMER_CREATION_IN_PROGRESS");
      } else {
        // Provider reads are recovery evidence only; the durable claim above is
        // the concurrency fence and the only authority to submit a POST.
        const customerReadIntegration = await providerIntegration(
          "customer.read",
        );
        const customerLookup = await findUniqueAsaasEntity<
          Record<string, unknown>
        >({
          baseUrl: customerReadIntegration.baseUrl,
          apiKey: customerReadIntegration.apiKey,
          path: "customers",
          query: { externalReference: customerReference },
          matches: (candidate) =>
            candidate.deleted !== true &&
            text(candidate.externalReference, 240) === customerReference,
        });
        if (customerLookup.kind === "DUPLICATE") {
          providerCreationReviewRequired = true;
          await recordAsaasCreationState(auth.context.admin, customerClaim, {
            status: "BLOCKED",
            error: "duplicate_hub_provider_customers",
          });
          throw new Error("ASAAS_CUSTOMER_DUPLICATE_REVIEW_REQUIRED");
        }
        if (customerLookup.kind === "UNAVAILABLE") {
          if (customerClaim.action === "RECONCILE_REQUIRED") {
            providerCreationReconciliationRequired = true;
          }
          await recordAsaasCreationState(auth.context.admin, customerClaim, {
            status: customerClaim.action === "RECONCILE_REQUIRED"
              ? "UNKNOWN"
              : "RETRY",
            httpStatus: customerLookup.httpStatus,
            error: "hub_customer_recovery_lookup_unavailable",
          });
          throw new Error("ASAAS_CUSTOMER_LOOKUP_UNAVAILABLE");
        }
        if (customerLookup.kind === "FOUND") {
          const candidateResolution = resolveHubAsaasCustomerCandidate(
            [customerLookup.entity],
            customerReference,
            cpfCnpj,
          );
          if (candidateResolution.status !== "MATCH") {
            providerCreationReviewRequired = true;
            await recordAsaasCreationState(auth.context.admin, customerClaim, {
              status: "BLOCKED",
              error: "hub_customer_identity_conflict",
            });
            throw new Error("ASAAS_CUSTOMER_IDENTITY_CONFLICT");
          }
          customerId = candidateResolution.customerId;
          providerCustomerLinkPending = true;
          providerCreationReconciliationRequired = true;
          await adoptHubProviderCreationBinding({
            admin: auth.context.admin,
            attemptId: customerClaim.attempt_id,
            claimToken: customerClaim.claim_token,
            accountId: membership.account_id,
            checkoutId: checkout.id,
            providerEntityId: customerId,
            providerStatus: text(customerLookup.entity.status),
          });
          providerCreationReconciliationRequired = false;
          providerCustomerOrigin = "RECOVERED";
        } else if (customerClaim.action === "RECONCILE_REQUIRED") {
          providerCreationReconciliationRequired = true;
          await recordAsaasCreationState(auth.context.admin, customerClaim, {
            status: "UNKNOWN",
            error: "hub_customer_not_yet_observed",
          });
          throw new Error("ASAAS_CUSTOMER_RECONCILIATION_PENDING");
        } else {
          await assertCheckoutStillAuthorized();
          providerCreationReconciliationRequired = true;
          await markHubProviderCreationSubmitting({
            admin: auth.context.admin,
            attemptId: customerClaim.attempt_id,
            claimToken: customerClaim.claim_token,
            accountId: membership.account_id,
            checkoutId: checkout.id,
          });

          let customerCreateIntegration: ResolvedAsaasIntegration;
          try {
            customerCreateIntegration = await providerMutationIntegration(
              "customer.create",
            );
          } catch {
            providerCreationReviewRequired = true;
            await recordAsaasCreationState(auth.context.admin, customerClaim, {
              status: "BLOCKED",
              error: "hub_customer_capability_changed_before_post",
            });
            throw new Error("ASAAS_CUSTOMER_CAPABILITY_CHANGED");
          }

          let customerResponse: Response;
          try {
            customerResponse = await fetch(
              `${customerCreateIntegration.baseUrl}/customers`,
              {
                method: "POST",
                headers: {
                  access_token: customerCreateIntegration.apiKey,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(customerPayload),
                redirect: "error",
                signal: AbortSignal.timeout(15_000),
              },
            );
          } catch {
            await recordAsaasCreationState(auth.context.admin, customerClaim, {
              status: "UNKNOWN",
              error: "hub_customer_post_outcome_unknown",
            });
            throw new Error("ASAAS_CUSTOMER_CREATION_OUTCOME_UNKNOWN");
          }

          const rawCustomer = await customerResponse.text();
          let customer: Record<string, unknown> = {};
          try {
            customer = JSON.parse(rawCustomer);
          } catch {
            // A malformed successful response is still an ambiguous creation.
          }
          const submittedCustomerId = normalizeAsaasCustomerId(customer.id) ||
            "";
          const outcome = asaasCreationHttpOutcome(
            customerResponse.ok,
            customerResponse.status,
            submittedCustomerId,
          );
          if (outcome === "SUCCEEDED") {
            try {
              await assertProviderCustomerIdentity(submittedCustomerId);
              customerId = submittedCustomerId;
              createdProviderCustomerId = submittedCustomerId;
              providerCustomerLinkPending = true;
              providerCustomerOrigin = "CREATED";
            } catch {
              providerCreationReviewRequired = true;
              await recordAsaasCreationState(
                auth.context.admin,
                customerClaim,
                {
                  status: "BLOCKED",
                  providerEntityId: submittedCustomerId,
                  providerStatus: text(customer.status),
                  httpStatus: customerResponse.status,
                  error: "hub_customer_post_identity_conflict",
                },
              );
              throw new Error("ASAAS_CUSTOMER_PROVIDER_IDENTITY_CONFLICT");
            }
          }
          await recordAsaasCreationState(auth.context.admin, customerClaim, {
            status: outcome,
            providerEntityId: submittedCustomerId,
            providerStatus: text(customer.status),
            httpStatus: customerResponse.status,
            error: outcome === "SUCCEEDED"
              ? null
              : outcome === "FAILED"
              ? "hub_customer_creation_rejected"
              : "hub_customer_post_outcome_unknown",
          });
          if (outcome === "UNKNOWN") {
            throw new Error("ASAAS_CUSTOMER_CREATION_OUTCOME_UNKNOWN");
          }
          if (outcome === "FAILED") {
            providerCreationReconciliationRequired = false;
            throw new Error("ASAAS_CUSTOMER_CREATION_REJECTED");
          }
          providerCreationReconciliationRequired = false;
        }
      }

      if (!customerId) throw new Error("ASAAS_CUSTOMER_ID_REQUIRED");

      providerCustomerId = customerId;
      await assertCustomerScopedToAccount(customerId);
      // A claim/provider id is not enough authority to write the canonical
      // account link. Prove id + externalReference + CPF/CNPJ first.
      await assertProviderCustomerIdentity(customerId);
      await adoptHubProviderCreationBinding({
        admin: auth.context.admin,
        attemptId: customerClaim.attempt_id,
        claimToken: customerClaim.claim_token,
        accountId: membership.account_id,
        checkoutId: checkout.id,
        providerEntityId: customerId,
        providerStatus: null,
      });
      const linkedCustomerId = (await loadAccountCustomerLink(true)).customerId;
      if (!linkedCustomerId) {
        throw new Error("ASAAS_CUSTOMER_LINK_REJECTED");
      }
      if (linkedCustomerId !== customerId) {
        if (createdProviderCustomerId === customerId) {
          // The durable claim is already SUCCEEDED and cannot safely point to
          // a customer deleted by compensation. Preserve both ids and require
          // explicit duplicate triage before any subscription is created.
          providerCreationReviewRequired = true;
          throw new Error("ASAAS_CUSTOMER_DUPLICATE_REVIEW_REQUIRED");
        }
        await assertCustomerScopedToAccount(linkedCustomerId);
        customerId = linkedCustomerId;
        providerCustomerId = linkedCustomerId;
        providerCustomerOrigin = "LINKED";
      }
      providerCustomerLinkConfirmed = true;
      providerCustomerLinkPending = false;
    }

    checkoutMetadata = {
      ...checkoutMetadata,
      provider_customer_id: providerCustomerId,
      provider_customer_origin: providerCustomerOrigin,
      provider_customer_link_confirmed: providerCustomerLinkConfirmed,
    };

    if (!customerId) throw new Error("ASAAS_CUSTOMER_ID_REQUIRED");
    await assertProviderCustomerIdentity(customerId);
    const checkoutCreatedDate = text(checkout.created_at, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkoutCreatedDate)) {
      throw new Error("HUB_CHECKOUT_CREATED_AT_INVALID");
    }
    const subscriptionReference = `hub:${checkout.id}`;
    const subscriptionDescription = text(
      checkoutMetadata.provider_subscription_description,
      240,
    );
    if (!subscriptionDescription) {
      throw new Error("HUB_SUBSCRIPTION_DESCRIPTION_INVALID");
    }
    const subscriptionPayload: Record<string, unknown> = {
      customer: customerId,
      billingType,
      value: amount,
      nextDueDate: checkoutCreatedDate,
      cycle: billingCycle,
      description: subscriptionDescription,
      externalReference: subscriptionReference,
    };
    const existingProviderSubscriptionId = normalizeAsaasCustomerId(
      checkout.asaas_subscription_id,
    );
    if (checkout.asaas_subscription_id && !existingProviderSubscriptionId) {
      providerCreationReviewRequired = true;
      throw new Error("ASAAS_SUBSCRIPTION_LOCAL_LINK_INVALID");
    }

    const subscriptionClaim = await claimAsaasCreation(auth.context.admin, {
      tenantId: PLATFORM_ASAAS_TENANT_ID,
      operation: "SUBSCRIPTION_CREATE",
      logicalKey: `hub-checkout:${checkout.id}`,
      externalReference: subscriptionReference,
      requestFingerprint: await asaasCreationFingerprint({
        operation: "SUBSCRIPTION_CREATE",
        tenantId: PLATFORM_ASAAS_TENANT_ID,
        logicalKey: `hub-checkout:${checkout.id}`,
        payload: subscriptionPayload,
      }),
    });

    if (subscriptionClaim.action === "ALREADY_SUCCEEDED") {
      providerSubscriptionId = normalizeAsaasCustomerId(
        subscriptionClaim.provider_entity_id,
      );
      if (!providerSubscriptionId) {
        providerCreationReviewRequired = true;
        throw new Error("ASAAS_SUBSCRIPTION_CLAIM_INVALID");
      }
      providerSubscriptionMustBePreserved = true;
    } else if (
      subscriptionClaim.action === "REVIEW_REQUIRED" ||
      !subscriptionClaim.ok
    ) {
      providerCreationReviewRequired = true;
      throw new Error("ASAAS_SUBSCRIPTION_CREATION_REVIEW_REQUIRED");
    } else if (subscriptionClaim.action === "IN_PROGRESS") {
      providerCreationReconciliationRequired = true;
      throw new Error("ASAAS_SUBSCRIPTION_CREATION_IN_PROGRESS");
    } else {
      const subscriptionReadIntegration = await providerIntegration(
        "subscription.read",
      );
      const subscriptionLookup = await findUniqueAsaasEntity<
        Record<string, unknown>
      >({
        baseUrl: subscriptionReadIntegration.baseUrl,
        apiKey: subscriptionReadIntegration.apiKey,
        path: "subscriptions",
        query: { externalReference: subscriptionReference },
        matches: (candidate) =>
          candidate.deleted !== true &&
          text(candidate.externalReference, 240) === subscriptionReference,
      });
      if (subscriptionLookup.kind === "DUPLICATE") {
        providerCreationReviewRequired = true;
        await recordAsaasCreationState(auth.context.admin, subscriptionClaim, {
          status: "BLOCKED",
          error: "duplicate_hub_provider_subscriptions",
        });
        throw new Error("ASAAS_SUBSCRIPTION_DUPLICATE_REVIEW_REQUIRED");
      }
      if (subscriptionLookup.kind === "UNAVAILABLE") {
        if (
          subscriptionClaim.action === "RECONCILE_REQUIRED" ||
          existingProviderSubscriptionId
        ) {
          providerCreationReconciliationRequired = true;
        }
        await recordAsaasCreationState(auth.context.admin, subscriptionClaim, {
          status: subscriptionClaim.action === "RECONCILE_REQUIRED"
            ? "UNKNOWN"
            : "RETRY",
          httpStatus: subscriptionLookup.httpStatus,
          error: "hub_subscription_recovery_lookup_unavailable",
        });
        throw new Error("ASAAS_SUBSCRIPTION_LOOKUP_UNAVAILABLE");
      }
      if (subscriptionLookup.kind === "FOUND") {
        const subscriptionResolution = resolveHubAsaasSubscriptionCandidate(
          subscriptionLookup.entity,
          {
            externalReference: subscriptionReference,
            customerId,
            billingType,
            billingCycle,
            amount,
            nextDueDate: checkoutCreatedDate,
            description: subscriptionDescription,
            maxPayments: null,
            splitPolicy: { kind: "NONE" },
          },
        );
        if (subscriptionResolution.status !== "MATCH") {
          providerCreationReviewRequired = true;
          await recordAsaasCreationState(
            auth.context.admin,
            subscriptionClaim,
            {
              status: "BLOCKED",
              error: "hub_subscription_payload_conflict",
            },
          );
          throw new Error("ASAAS_SUBSCRIPTION_CONFLICT_REVIEW_REQUIRED");
        }
        if (
          existingProviderSubscriptionId &&
          existingProviderSubscriptionId !==
            subscriptionResolution.subscriptionId
        ) {
          providerCreationReviewRequired = true;
          await recordAsaasCreationState(
            auth.context.admin,
            subscriptionClaim,
            {
              status: "BLOCKED",
              error: "hub_subscription_local_provider_mismatch",
            },
          );
          throw new Error("ASAAS_SUBSCRIPTION_LOCAL_LINK_CONFLICT");
        }
        providerSubscriptionId = subscriptionResolution.subscriptionId;
        providerSubscriptionMustBePreserved = true;
        providerCreationReconciliationRequired = true;
        await adoptHubProviderCreationBinding({
          admin: auth.context.admin,
          attemptId: subscriptionClaim.attempt_id,
          claimToken: subscriptionClaim.claim_token,
          accountId: membership.account_id,
          checkoutId: checkout.id,
          providerEntityId: providerSubscriptionId,
          providerStatus: subscriptionResolution.providerStatus,
        });
        providerCreationReconciliationRequired = false;
      } else if (subscriptionClaim.action === "RECONCILE_REQUIRED") {
        providerCreationReconciliationRequired = true;
        await recordAsaasCreationState(auth.context.admin, subscriptionClaim, {
          status: "UNKNOWN",
          error: "hub_subscription_not_yet_observed",
        });
        throw new Error("ASAAS_SUBSCRIPTION_RECONCILIATION_PENDING");
      } else if (existingProviderSubscriptionId) {
        providerCreationReviewRequired = true;
        await recordAsaasCreationState(auth.context.admin, subscriptionClaim, {
          status: "BLOCKED",
          error: "hub_subscription_local_link_not_observed",
        });
        throw new Error("ASAAS_SUBSCRIPTION_LOCAL_LINK_REVIEW_REQUIRED");
      } else {
        await assertCheckoutStillAuthorized();
        providerCreationReconciliationRequired = true;
        await markHubProviderCreationSubmitting({
          admin: auth.context.admin,
          attemptId: subscriptionClaim.attempt_id,
          claimToken: subscriptionClaim.claim_token,
          accountId: membership.account_id,
          checkoutId: checkout.id,
        });

        let subscriptionCreateIntegration: ResolvedAsaasIntegration;
        try {
          subscriptionCreateIntegration = await providerMutationIntegration(
            "subscription.create",
          );
        } catch {
          providerCreationReviewRequired = true;
          await recordAsaasCreationState(
            auth.context.admin,
            subscriptionClaim,
            {
              status: "BLOCKED",
              error: "hub_subscription_capability_changed_before_post",
            },
          );
          throw new Error("ASAAS_SUBSCRIPTION_CAPABILITY_CHANGED");
        }

        let subscriptionResponse: Response;
        try {
          subscriptionResponse = await fetch(
            `${subscriptionCreateIntegration.baseUrl}/subscriptions`,
            {
              method: "POST",
              headers: {
                access_token: subscriptionCreateIntegration.apiKey,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(subscriptionPayload),
              redirect: "error",
              signal: AbortSignal.timeout(15_000),
            },
          );
        } catch {
          await recordAsaasCreationState(
            auth.context.admin,
            subscriptionClaim,
            {
              status: "UNKNOWN",
              error: "hub_subscription_post_outcome_unknown",
            },
          );
          throw new Error("ASAAS_SUBSCRIPTION_CREATION_OUTCOME_UNKNOWN");
        }

        const rawSubscription = await subscriptionResponse.text();
        let subscription: Record<string, unknown> = {};
        try {
          subscription = JSON.parse(rawSubscription);
        } catch {
          // A malformed successful response is still an ambiguous creation.
        }
        const submittedSubscriptionId = normalizeAsaasCustomerId(
          subscription.id,
        ) || "";
        const outcome = asaasCreationHttpOutcome(
          subscriptionResponse.ok,
          subscriptionResponse.status,
          submittedSubscriptionId,
        );
        if (outcome === "SUCCEEDED") {
          const submittedResolution = resolveHubAsaasSubscriptionCandidate(
            subscription,
            {
              externalReference: subscriptionReference,
              customerId,
              billingType,
              billingCycle,
              amount,
              nextDueDate: checkoutCreatedDate,
              description: subscriptionDescription,
              maxPayments: null,
              splitPolicy: { kind: "NONE" },
            },
          );
          if (submittedResolution.status !== "MATCH") {
            providerSubscriptionId = submittedSubscriptionId;
            providerSubscriptionMustBePreserved = true;
            providerCreationReviewRequired = true;
            await recordAsaasCreationState(
              auth.context.admin,
              subscriptionClaim,
              {
                status: "BLOCKED",
                providerEntityId: submittedSubscriptionId,
                providerStatus: text(subscription.status),
                httpStatus: subscriptionResponse.status,
                error: "hub_subscription_post_payload_conflict",
              },
            );
            throw new Error("ASAAS_SUBSCRIPTION_CONFLICT_REVIEW_REQUIRED");
          }
          providerSubscriptionId = submittedResolution.subscriptionId;
          providerSubscriptionMustBePreserved = true;
        }
        await recordAsaasCreationState(auth.context.admin, subscriptionClaim, {
          status: outcome,
          providerEntityId: submittedSubscriptionId,
          providerStatus: text(subscription.status),
          httpStatus: subscriptionResponse.status,
          error: outcome === "SUCCEEDED"
            ? null
            : outcome === "FAILED"
            ? "hub_subscription_creation_rejected"
            : "hub_subscription_post_outcome_unknown",
        });
        if (outcome === "UNKNOWN") {
          throw new Error("ASAAS_SUBSCRIPTION_CREATION_OUTCOME_UNKNOWN");
        }
        if (outcome === "FAILED") {
          providerCreationReconciliationRequired = false;
          throw new Error("ASAAS_SUBSCRIPTION_CREATION_REJECTED");
        }
        providerCreationReconciliationRequired = false;
      }
    }

    if (!providerSubscriptionId) {
      throw new Error("ASAAS_SUBSCRIPTION_ID_REQUIRED");
    }
    if (
      existingProviderSubscriptionId &&
      existingProviderSubscriptionId !== providerSubscriptionId
    ) {
      providerCreationReviewRequired = true;
      throw new Error("ASAAS_SUBSCRIPTION_LOCAL_LINK_CONFLICT");
    }
    const verifiedProviderSubscription = await asaasRequest(
      await providerIntegration("subscription.read"),
      `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
    );
    const verifiedSubscriptionResolution = resolveHubAsaasSubscriptionCandidate(
      verifiedProviderSubscription,
      {
        externalReference: subscriptionReference,
        customerId,
        billingType,
        billingCycle,
        amount,
        nextDueDate: checkoutCreatedDate,
        description: subscriptionDescription,
        maxPayments: null,
        splitPolicy: { kind: "NONE" },
      },
    );
    if (
      verifiedSubscriptionResolution.status !== "MATCH" ||
      verifiedSubscriptionResolution.subscriptionId !== providerSubscriptionId
    ) {
      providerCreationReviewRequired = true;
      throw new Error("ASAAS_SUBSCRIPTION_PROVIDER_IDENTITY_CONFLICT");
    }

    // Provider recovery and ALREADY_SUCCEEDED claims must cross the account
    // lifecycle fence before the provider id becomes locally authoritative.
    // This RPC records SUCCEEDED and binds the checkout in one transaction, so
    // cancellation can never snapshot between those two state changes.
    await adoptHubProviderCreationBinding({
      admin: auth.context.admin,
      attemptId: subscriptionClaim.attempt_id,
      claimToken: subscriptionClaim.claim_token,
      accountId: membership.account_id,
      checkoutId: checkout.id,
      providerEntityId: providerSubscriptionId,
      providerStatus: verifiedSubscriptionResolution.providerStatus,
    });
    providerPaymentReconciliationRequired = true;

    // Persist the provider link before any secondary provider request. If the
    // process fails later, the existing CREATED row remains an open lock and
    // gives reconciliation a durable subscription id.
    const { data: linkedCheckout, error: linkError } = await auth.context.admin
      .rpc("hub_bind_checkout_provider_subscription", {
        p_checkout_id: checkout.id,
        p_subscription_id: providerSubscriptionId,
        p_metadata_patch: {
          ...checkoutMetadata,
          providerLinkedAt: new Date().toISOString(),
        },
      });
    if (linkError || !linkedCheckout) {
      const { data: currentCheckout, error: currentCheckoutError } = await auth
        .context.admin
        .from("hub_checkout_sessions")
        .select("asaas_subscription_id,status")
        .eq("id", checkout.id)
        .maybeSingle();
      if (
        currentCheckoutError ||
        normalizeAsaasCustomerId(currentCheckout?.asaas_subscription_id) !==
          providerSubscriptionId ||
        !["CREATED", "PENDING"].includes(currentCheckout?.status || "")
      ) {
        throw linkError || currentCheckoutError ||
          new Error("HUB_CHECKOUT_LINK_REJECTED");
      }
    }

    await assertCheckoutStillAuthorized();

    const paymentReadIntegration = await providerIntegration("payment.read");
    const payments = await asaasListAll(
      paymentReadIntegration,
      `/subscriptions/${encodeURIComponent(providerSubscriptionId)}/payments`,
    );
    const matchingPayments = payments.filter((candidate) =>
      candidate.deleted !== true &&
      normalizeAsaasCustomerId(candidate.id) !== null &&
      text(candidate.subscription, 200) === providerSubscriptionId &&
      text(candidate.customer, 200) === customerId &&
      text(candidate.externalReference, 240) === subscriptionReference &&
      text(candidate.billingType, 40).toUpperCase() === billingType &&
      text(candidate.dueDate, 10) === checkoutCreatedDate &&
      sameMoney(candidate.value, amount)
    );
    if (matchingPayments.length !== 1) {
      providerCreationReviewRequired = matchingPayments.length > 1;
      throw new Error(
        matchingPayments.length > 1
          ? "ASAAS_SUBSCRIPTION_PAYMENT_DUPLICATE"
          : "ASAAS_SUBSCRIPTION_PAYMENT_NOT_READY",
      );
    }
    const firstPayment = matchingPayments[0];
    providerPayment = {
      id: typeof firstPayment?.id === "string" ? firstPayment.id : null,
      invoiceUrl: typeof firstPayment?.invoiceUrl === "string"
        ? firstPayment.invoiceUrl
        : null,
      bankSlipUrl: typeof firstPayment?.bankSlipUrl === "string"
        ? firstPayment.bankSlipUrl
        : null,
      dueDate: typeof firstPayment?.dueDate === "string"
        ? firstPayment.dueDate
        : null,
    };
    if (!providerPayment.id) {
      throw new Error("ASAAS_SUBSCRIPTION_PAYMENT_NOT_READY");
    }
    const exactPayment = await asaasRequest(
      paymentReadIntegration,
      `/payments/${encodeURIComponent(providerPayment.id)}`,
    );
    assertExactHubProviderPayment(exactPayment, {
      paymentId: providerPayment.id,
      subscriptionId: providerSubscriptionId,
      customerId,
      externalReference: subscriptionReference,
      amount,
      billingType,
      dueDate: checkoutCreatedDate,
    });
    let pix = null;
    if (providerPayment.id && billingType === "PIX") {
      pix = await asaasRequest(
        paymentReadIntegration,
        `/payments/${encodeURIComponent(providerPayment.id)}/pixQrCode`,
      );
    }

    await assertCheckoutStillAuthorized();
    const { data: finalizedCheckout, error: updateError } = await auth.context
      .admin.rpc("hub_merge_checkout_provider_state", {
        p_checkout_id: checkout.id,
        p_status: "PENDING",
        p_expected_subscription_id: providerSubscriptionId,
        p_payment_id: providerPayment.id,
        p_invoice_url: providerPayment.invoiceUrl,
        p_bank_slip_url: providerPayment.bankSlipUrl,
        p_allowed_statuses: ["CREATED", "PENDING"],
        p_metadata_patch: {
          ...checkoutMetadata,
          dueDate: providerPayment.dueDate,
          providerLinkedAt: new Date().toISOString(),
        },
      });
    if (updateError || !finalizedCheckout) {
      throw updateError || new Error("HUB_CHECKOUT_FINALIZE_REJECTED");
    }

    return json(200, {
      success: true,
      checkoutId: checkout.id,
      status: "PENDING",
      planName: plan.name,
      amount,
      billingCycle,
      invoiceUrl: providerPayment.invoiceUrl,
      bankSlipUrl: providerPayment.bankSlipUrl,
      pix: pix ? { copyPaste: pix.payload, qrCode: pix.encodedImage } : null,
    });
  } catch (error) {
    // A claimed/ambiguous provider creation is never compensated with a blind
    // delete: the creation claim cannot be reset for another POST. Keeping the
    // checkout open makes the next invocation perform GET-only reconciliation.
    const providerObjectsMustBePreserved =
      providerCreationReconciliationRequired ||
      providerCreationReviewRequired ||
      providerCustomerLinkPending ||
      providerSubscriptionMustBePreserved ||
      providerPaymentReconciliationRequired;
    const customerRollbackState = inspectCreatedProviderCustomer
      ? await inspectCreatedProviderCustomer()
      : createdProviderCustomerId
      ? "PRESERVE_CREATED_CUSTOMER_FOR_REVIEW"
      : "NOT_CREATED_BY_ATTEMPT";
    const customerReconciliationRequired =
      customerRollbackState === "PRESERVE_CREATED_CUSTOMER_FOR_REVIEW";
    if (checkoutId) {
      const recoveryRequired = customerReconciliationRequired ||
        providerObjectsMustBePreserved;
      const recoveryStatus = providerCreationReconciliationRequired ||
          providerCreationReviewRequired || providerCustomerLinkPending ||
          providerPaymentReconciliationRequired
        ? "CREATED"
        : recoveryRequired
        ? "PENDING"
        : "FAILED";
      const recoveryMetadata = {
        ...checkoutMetadata,
        provider_customer_id: providerCustomerId,
        provider_customer_origin: providerCustomerOrigin,
        provider_customer_link_confirmed: providerCustomerLinkConfirmed,
        provider_subscription_id: providerSubscriptionId,
        provider_payment_id: providerPayment?.id ?? null,
        reconciliation_required: recoveryRequired,
        // Claimed provider creations are never deleted as compensation.
        rollback_delete_confirmed: false,
        customer_rollback_state: customerRollbackState,
        customer_reconciliation_required: customerReconciliationRequired,
        provider_creation_reconciliation_required:
          providerCreationReconciliationRequired,
        provider_creation_review_required: providerCreationReviewRequired,
        provider_customer_link_pending: providerCustomerLinkPending,
        provider_payment_reconciliation_required:
          providerPaymentReconciliationRequired,
        checkout_failure_at: new Date().toISOString(),
      };
      let recoveryError: { code?: string } | null = null;
      if (providerPayment?.id && providerSubscriptionId) {
        const result = await auth.context.admin.rpc(
          "hub_merge_checkout_provider_state",
          {
            p_checkout_id: checkoutId,
            p_status: recoveryStatus,
            p_expected_subscription_id: providerSubscriptionId,
            p_payment_id: providerPayment.id,
            p_invoice_url: providerPayment.invoiceUrl,
            p_bank_slip_url: providerPayment.bankSlipUrl,
            p_allowed_statuses: recoveryStatus === "CREATED"
              ? ["CREATED"]
              : ["CREATED", "PENDING"],
            p_metadata_patch: recoveryMetadata,
          },
        );
        recoveryError = result.error;
      } else {
        const result = await auth.context.admin.rpc(
          "hub_merge_checkout_provider_state",
          {
            p_checkout_id: checkoutId,
            p_status: recoveryStatus,
            p_allowed_statuses: recoveryStatus === "CREATED"
              ? ["CREATED"]
              : ["CREATED", "PENDING"],
            p_metadata_patch: recoveryMetadata,
          },
        );
        recoveryError = result.error;
      }
      if (recoveryError) {
        // The row was inserted as CREATED before the provider call. Even when
        // this update is unavailable, that open status still prevents a new
        // product checkout through the database unique index.
        console.error("Hub checkout recovery state persistence failed", {
          checkoutId,
          code: recoveryError.code,
        });
      }
    }
    console.error("Hub checkout failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    const reconciliationRequired = customerReconciliationRequired ||
      providerObjectsMustBePreserved;
    return json(reconciliationRequired ? 409 : 500, {
      error: reconciliationRequired
        ? "HUB_CHECKOUT_RECONCILIATION_REQUIRED"
        : "HUB_CHECKOUT_FAILED",
      code: reconciliationRequired
        ? "HUB_CHECKOUT_RECONCILIATION_REQUIRED"
        : "HUB_CHECKOUT_FAILED",
      ...(checkoutId ? { checkoutId } : {}),
    });
  }
});
