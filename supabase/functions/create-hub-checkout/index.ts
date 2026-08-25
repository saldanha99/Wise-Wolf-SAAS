/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  failedCheckoutStatus,
  HUB_CORE_PRODUCT_FAMILY,
  hubBillingBlockCode,
  hubCheckoutDecision,
  hubFixtureCheckoutBlockCode,
  hubPlanMatchesAccountAudience,
  hubReplacementNeedsProviderReconciliation,
  isSupportedHubProductFamily,
  isValidHubAccountId,
  providerCancellationIsFinal,
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
  decideHubAsaasCustomerCompensation,
  type HubAsaasCustomerOrigin,
  hubAsaasCustomerReference,
  normalizeAsaasCustomerId,
  resolveHubAsaasCustomerCandidate,
} from "./customer-idempotency.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ASAAS_URL = (Deno.env.get("ASAAS_API_URL") || "https://api.asaas.com")
  .replace(/\/+$/, "")
  .replace(/\/v3$/, "");
const ASAAS_TOKEN =
  (Deno.env.get("ASAAS_ACCESS_TOKEN") || Deno.env.get("ASAAS_API_KEY") || "")
    .trim();
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

async function asaasRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${ASAAS_URL}/v3${path}`, {
    ...init,
    headers: {
      access_token: ASAAS_TOKEN,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
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

async function deleteAsaasCustomer(customerId: string): Promise<void> {
  const response = await fetch(
    `${ASAAS_URL}/v3/customers/${encodeURIComponent(customerId)}`,
    {
      method: "DELETE",
      headers: {
        access_token: ASAAS_TOKEN,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!providerCancellationIsFinal(response.status)) {
    console.error("Hub Asaas customer compensation failed", {
      status: response.status,
    });
    throw new Error("ASAAS_CUSTOMER_COMPENSATION_FAILED");
  }
}

async function cancelAsaasSubscription(subscriptionId: string): Promise<void> {
  const response = await fetch(
    `${ASAAS_URL}/v3/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: "DELETE",
      headers: {
        access_token: ASAAS_TOKEN,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!providerCancellationIsFinal(response.status)) {
    console.error("Hub Asaas subscription cancellation failed", {
      status: response.status,
    });
    throw new Error("ASAAS_SUBSCRIPTION_CANCELLATION_FAILED");
  }
}

type ProviderPaymentSnapshot = {
  id: string | null;
  invoiceUrl: string | null;
  bankSlipUrl: string | null;
  dueDate: string | null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
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
  if (!ASAAS_TOKEN) {
    return json(503, {
      error: "PAYMENT_PROVIDER_UNAVAILABLE",
      code: "PAYMENT_PROVIDER_UNAVAILABLE",
    });
  }

  let checkoutId: string | null = null;
  let providerSubscriptionId: string | null = null;
  let providerPayment: ProviderPaymentSnapshot | null = null;
  let checkoutMetadata: Record<string, unknown> = {};
  let providerCustomerId: string | null = null;
  let providerCustomerOrigin: HubAsaasCustomerOrigin | null = null;
  let providerCustomerLinkConfirmed = false;
  let createdProviderCustomerId: string | null = null;
  let hubLegalAcceptanceId: string | null = null;
  let compensateCreatedProviderCustomer:
    | ((providerObjectsSafeToDelete: boolean) => Promise<
      | "NOT_CREATED_BY_ATTEMPT"
      | "DEFER_UNCONFIRMED_STATE"
      | "KEEP_LINKED_CUSTOMER"
      | "DELETE_CONFIRMED"
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
    const billingType = requestedBillingType;
    const customerName = text(body.name);
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
    const fixtureBlockCode = hubFixtureCheckoutBlockCode({
      testMode,
      userIsTestFixture,
      sandboxProvider: ASAAS_URL.toLowerCase().includes("sandbox"),
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
    const amount = Number(
      billingCycle === "YEARLY" ? plan.price_yearly : plan.price_monthly,
    );
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(400, {
        error: "PLAN_PRICE_UNAVAILABLE",
        code: "PLAN_PRICE_UNAVAILABLE",
      });
    }

    const { data: existingCheckout, error: existingCheckoutError } = await auth
      .context.admin
      .from("hub_checkout_sessions")
      .select(
        "id, account_id, plan_id, product_family, billing_cycle, billing_type, status, amount, invoice_url, bank_slip_url, asaas_payment_id",
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
        return json(409, {
          error: "CHECKOUT_IN_PROGRESS",
          code: "CHECKOUT_IN_PROGRESS",
          checkoutId: existingCheckout.id,
        });
      }
      if (
        ["FAILED", "CANCELLED", "REVERSED"].includes(existingCheckout.status)
      ) {
        return json(409, {
          error: "CHECKOUT_RETRY_WITH_NEW_KEY",
          code: "CHECKOUT_RETRY_WITH_NEW_KEY",
          checkoutId: existingCheckout.id,
        });
      }
      let existingPix = null;
      if (existingCheckout.asaas_payment_id && billingType === "PIX") {
        existingPix = await asaasRequest(
          `/payments/${
            encodeURIComponent(existingCheckout.asaas_payment_id)
          }/pixQrCode`,
        );
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
          ? { copyPaste: existingPix.payload, qrCode: existingPix.encodedImage }
          : null,
      });
    }

    const { data: pendingCheckout, error: pendingCheckoutError } = await auth
      .context.admin
      .from("hub_checkout_sessions")
      .select(
        "id, plan_id, product_family, billing_cycle, billing_type, status, amount, invoice_url, bank_slip_url, asaas_payment_id",
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
      if (pendingCheckout.asaas_payment_id && billingType === "PIX") {
        pendingPix = await asaasRequest(
          `/payments/${
            encodeURIComponent(pendingCheckout.asaas_payment_id)
          }/pixQrCode`,
        );
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
      ...(isTestFixture ? { test_fixture: true } : {}),
      ...(testMode ? { testMode: true } : {}),
      product_family: productFamily,
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

    const { data: checkout, error: checkoutError } = await auth.context.admin
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
      .select("id")
      .single();
    if (checkoutError || !checkout) {
      throw checkoutError || new Error("CHECKOUT_CREATE_FAILED");
    }
    checkoutId = checkout.id;

    const { error: fulfillmentError } = await auth.context.admin
      .from("hub_fulfillment_outbox")
      .insert([
        {
          checkout_id: checkout.id,
          account_id: membership.account_id,
          user_id: auth.context.userId,
          product_family: productFamily,
          plan_code: plan.code,
          plan_name: plan.name,
          channel: "EMAIL",
          recipient: customerEmail,
          recipient_name: customerName,
          metadata: isTestFixture ? { test_fixture: true } : {},
        },
        {
          checkout_id: checkout.id,
          account_id: membership.account_id,
          user_id: auth.context.userId,
          product_family: productFamily,
          plan_code: plan.code,
          plan_name: plan.name,
          channel: "WHATSAPP",
          recipient: phone,
          recipient_name: customerName,
          metadata: isTestFixture ? { test_fixture: true } : {},
        },
      ]);
    if (fulfillmentError) throw fulfillmentError;

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

    const bindCustomerToAccount = async (candidateCustomerId: string) => {
      const { data: linkedAccount, error: linkError } = await auth.context.admin
        .from("hub_accounts")
        .update({ asaas_customer_id: candidateCustomerId })
        .eq("id", membership.account_id)
        .eq("status", "ACTIVE")
        .is("asaas_customer_id", null)
        .select("asaas_customer_id")
        .maybeSingle();

      const updatedCustomerId = normalizeAsaasCustomerId(
        linkedAccount?.asaas_customer_id,
      );
      if (!linkError && updatedCustomerId) return updatedCustomerId;

      // The update result can be ambiguous after a network failure or can lose
      // a compare-and-set race. Re-read the authoritative account link before
      // deciding whether the provider customer is orphaned.
      const currentLink = await loadAccountCustomerLink(true);
      if (currentLink.customerId) return currentLink.customerId;
      if (linkError) throw linkError;
      throw new Error("ASAAS_CUSTOMER_LINK_REJECTED");
    };

    compensateCreatedProviderCustomer = async (
      providerObjectsSafeToDelete: boolean,
    ) => {
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
      const decision = decideHubAsaasCustomerCompensation({
        createdCustomerId: createdProviderCustomerId,
        linkedCustomerIds,
        linkStateConfirmed,
        providerObjectsSafeToDelete,
      });
      if (decision !== "DELETE_CREATED_CUSTOMER") return decision;
      try {
        await deleteAsaasCustomer(createdProviderCustomerId!);
        return "DELETE_CONFIRMED";
      } catch {
        return "DEFER_UNCONFIRMED_STATE";
      }
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
      const customerReference = hubAsaasCustomerReference(
        membership.account_id,
      );
      const existingCustomers = await asaasRequest(
        `/customers?externalReference=${
          encodeURIComponent(customerReference)
        }&limit=100`,
      );
      if (!Array.isArray(existingCustomers?.data)) {
        throw new Error("ASAAS_CUSTOMER_LOOKUP_INVALID");
      }
      const candidateResolution = resolveHubAsaasCustomerCandidate(
        existingCustomers.data,
        customerReference,
        cpfCnpj,
      );
      if (candidateResolution.status === "IDENTITY_CONFLICT") {
        throw new Error("ASAAS_CUSTOMER_IDENTITY_CONFLICT");
      }

      if (candidateResolution.status === "MATCH") {
        customerId = candidateResolution.customerId;
        providerCustomerOrigin = "RECOVERED";
      } else {
        const customer = await asaasRequest("/customers", {
          method: "POST",
          body: JSON.stringify({
            name: customerName,
            email: customerEmail,
            cpfCnpj,
            mobilePhone: phone,
            address: text(body.address) || "A definir",
            addressNumber: text(body.addressNumber, 20) || "SN",
            province: text(body.province) || "Centro",
            postalCode: digits(body.postalCode) || "01000000",
            externalReference: customerReference,
          }),
        });
        customerId = normalizeAsaasCustomerId(customer?.id);
        if (!customerId) throw new Error("ASAAS_CUSTOMER_ID_REQUIRED");
        createdProviderCustomerId = customerId;
        providerCustomerOrigin = "CREATED";
      }

      providerCustomerId = customerId;
      await assertCustomerScopedToAccount(customerId);
      const linkedCustomerId = await bindCustomerToAccount(customerId);
      providerCustomerLinkConfirmed = true;
      if (linkedCustomerId !== customerId) {
        if (createdProviderCustomerId === customerId) {
          const compensation = await compensateCreatedProviderCustomer(true);
          if (compensation !== "DELETE_CONFIRMED") {
            throw new Error("ASAAS_CUSTOMER_RECONCILIATION_REQUIRED");
          }
          createdProviderCustomerId = null;
        }
        await assertCustomerScopedToAccount(linkedCustomerId);
        customerId = linkedCustomerId;
        providerCustomerId = linkedCustomerId;
        providerCustomerOrigin = "LINKED";
      }
    }

    checkoutMetadata = {
      ...checkoutMetadata,
      provider_customer_id: providerCustomerId,
      provider_customer_origin: providerCustomerOrigin,
      provider_customer_link_confirmed: providerCustomerLinkConfirmed,
    };

    const subscriptionPayload: Record<string, unknown> = {
      customer: customerId,
      billingType,
      value: amount,
      nextDueDate: new Date().toISOString().slice(0, 10),
      cycle: billingCycle,
      description: productFamily === WOLFIE_PRODUCT_FAMILY
        ? `Wolfie AI Tutor - ${plan.name}`
        : `Wise Wolf Hub - ${plan.name} (${billingCycle})`,
      externalReference: `hub:${checkout.id}`,
    };

    await assertCheckoutStillAuthorized();
    const subscription = await asaasRequest("/subscriptions", {
      method: "POST",
      body: JSON.stringify(subscriptionPayload),
    });
    providerSubscriptionId = typeof subscription?.id === "string"
      ? subscription.id
      : null;
    if (!providerSubscriptionId) {
      throw new Error("ASAAS_SUBSCRIPTION_ID_REQUIRED");
    }

    // Persist the provider link before any secondary provider request. If the
    // process fails later, the existing CREATED row remains an open lock and
    // gives reconciliation a durable subscription id.
    const { data: linkedCheckout, error: linkError } = await auth.context.admin
      .from("hub_checkout_sessions")
      .update({
        asaas_subscription_id: providerSubscriptionId,
        metadata: {
          ...checkoutMetadata,
          providerLinkedAt: new Date().toISOString(),
        },
      })
      .eq("id", checkout.id)
      .in("status", ["CREATED", "PENDING"])
      .select("id")
      .maybeSingle();
    if (linkError || !linkedCheckout) {
      throw linkError || new Error("HUB_CHECKOUT_LINK_REJECTED");
    }

    await assertCheckoutStillAuthorized();

    const payments = await asaasRequest(
      `/subscriptions/${encodeURIComponent(providerSubscriptionId)}/payments`,
    );
    const firstPayment = Array.isArray(payments?.data)
      ? payments.data[0]
      : null;
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
    let pix = null;
    if (providerPayment.id && billingType === "PIX") {
      pix = await asaasRequest(
        `/payments/${encodeURIComponent(providerPayment.id)}/pixQrCode`,
      );
    }

    await assertCheckoutStillAuthorized();
    const { data: finalizedCheckout, error: updateError } = await auth.context
      .admin
      .from("hub_checkout_sessions")
      .update({
        status: "PENDING",
        asaas_subscription_id: providerSubscriptionId,
        asaas_payment_id: providerPayment.id,
        invoice_url: providerPayment.invoiceUrl,
        bank_slip_url: providerPayment.bankSlipUrl,
        metadata: {
          ...checkoutMetadata,
          dueDate: providerPayment.dueDate,
          providerLinkedAt: new Date().toISOString(),
        },
      })
      .eq("id", checkout.id)
      .in("status", ["CREATED", "PENDING"])
      .select("id")
      .maybeSingle();
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
    let providerCancellationConfirmed = providerSubscriptionId === null;
    if (providerSubscriptionId) {
      try {
        await cancelAsaasSubscription(providerSubscriptionId);
        providerCancellationConfirmed = true;
      } catch {
        console.error("Hub checkout rollback failed", { checkoutId });
      }
    }
    const customerRollbackState = compensateCreatedProviderCustomer
      ? await compensateCreatedProviderCustomer(providerCancellationConfirmed)
      : createdProviderCustomerId
      ? "DEFER_UNCONFIRMED_STATE"
      : "NOT_CREATED_BY_ATTEMPT";
    const customerReconciliationRequired =
      customerRollbackState === "DEFER_UNCONFIRMED_STATE";
    if (checkoutId) {
      const recoveryRequired = customerReconciliationRequired ||
        (providerSubscriptionId !== null && !providerCancellationConfirmed);
      const { error: recoveryError } = await auth.context.admin.from(
        "hub_checkout_sessions",
      ).update({
        status: failedCheckoutStatus(
          providerSubscriptionId !== null,
          providerCancellationConfirmed,
        ),
        ...(providerSubscriptionId
          ? { asaas_subscription_id: providerSubscriptionId }
          : {}),
        ...(providerPayment?.id
          ? { asaas_payment_id: providerPayment.id }
          : {}),
        ...(providerPayment?.invoiceUrl
          ? { invoice_url: providerPayment.invoiceUrl }
          : {}),
        ...(providerPayment?.bankSlipUrl
          ? { bank_slip_url: providerPayment.bankSlipUrl }
          : {}),
        metadata: {
          ...checkoutMetadata,
          provider_customer_id: providerCustomerId,
          provider_customer_origin: providerCustomerOrigin,
          provider_customer_link_confirmed: providerCustomerLinkConfirmed,
          provider_subscription_id: providerSubscriptionId,
          provider_payment_id: providerPayment?.id ?? null,
          reconciliation_required: recoveryRequired,
          rollback_delete_confirmed: providerCancellationConfirmed,
          customer_rollback_state: customerRollbackState,
          customer_reconciliation_required: customerReconciliationRequired,
          checkout_failure_at: new Date().toISOString(),
        },
      }).eq("id", checkoutId).in("status", ["CREATED", "PENDING"]);
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
      (providerSubscriptionId !== null && !providerCancellationConfirmed);
    return json(500, {
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
