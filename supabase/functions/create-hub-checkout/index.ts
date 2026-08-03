/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  failedCheckoutStatus,
  providerCancellationIsFinal,
  tenantMayCheckoutProduct,
  WOLFIE_PRODUCT_FAMILY,
} from "../_shared/hub-billing-safety.ts";

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
    console.error("Hub Asaas request failed", {
      path,
      status: response.status,
    });
    throw new Error("ASAAS_REQUEST_FAILED");
  }
  return payload;
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
  try {
    const body = await req.json() as Record<string, unknown>;
    const planCode = text(body.planCode, 40).toUpperCase();
    const productFamily = text(body.productFamily, 40).toUpperCase() ||
      "HUB_CORE";
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
    const requestKey = text(body.requestKey, 40);
    const termsVersion = text(body.termsVersion, 80);
    const testMode = body.testMode === true;
    if (
      !planCode || customerName.length < 3 || !customerEmail.includes("@") ||
      !isValidCpfCnpj(cpfCnpj) || phone.length < 10 || phone.length > 13 ||
      !UUID_PATTERN.test(requestKey)
    ) {
      return json(400, {
        error: "INVALID_CHECKOUT_DATA",
        code: "INVALID_CHECKOUT_DATA",
      });
    }
    if (testMode) {
      const fixtureAllowed =
        auth.context.user?.app_metadata?.test_fixture === true;
      const sandboxProvider = ASAAS_URL.toLowerCase().includes("sandbox");
      if (!fixtureAllowed || !sandboxProvider) {
        return json(409, {
          error: "TEST_MODE_REQUIRES_SANDBOX",
          code: "TEST_MODE_REQUIRES_SANDBOX",
        });
      }
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
        "account_id, membership_role, hub_accounts!inner(id, name, audience, account_type, owner_user_id, asaas_customer_id)",
      )
      .eq("user_id", auth.context.userId)
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
    if (
      productFamily === WOLFIE_PRODUCT_FAMILY && account.audience !== "LEARNER"
    ) {
      return json(403, {
        error: "WOLFIE_LEARNER_ACCOUNT_REQUIRED",
        code: "WOLFIE_LEARNER_ACCOUNT_REQUIRED",
      });
    }

    const { data: existingCheckout, error: existingCheckoutError } = await auth
      .context.admin
      .from("hub_checkout_sessions")
      .select(
        "id, status, amount, invoice_url, bank_slip_url, asaas_payment_id",
      )
      .eq("requested_by", auth.context.userId)
      .eq("request_key", requestKey)
      .maybeSingle();
    if (existingCheckoutError) throw existingCheckoutError;
    if (existingCheckout) {
      if (existingCheckout.status === "CREATED") {
        return json(409, {
          error: "CHECKOUT_IN_PROGRESS",
          code: "CHECKOUT_IN_PROGRESS",
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

    const { data: plan, error: planError } = await auth.context.admin
      .from("hub_plans")
      .select(
        "id, code, name, audience, price_monthly, price_yearly, metadata, product_family",
      )
      .eq("code", planCode)
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
    const amount = Number(
      billingCycle === "YEARLY" ? plan.price_yearly : plan.price_monthly,
    );
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(400, {
        error: "PLAN_PRICE_UNAVAILABLE",
        code: "PLAN_PRICE_UNAVAILABLE",
      });
    }

    const { data: liveSubscription, error: liveSubscriptionError } = await auth
      .context.admin
      .from("hub_subscriptions")
      .select("id, plan_id, status")
      .eq("account_id", membership.account_id)
      .eq("product_family", productFamily)
      .in("status", ["TRIALING", "INCOMPLETE", "ACTIVE", "PAST_DUE"])
      .maybeSingle();
    if (liveSubscriptionError) throw liveSubscriptionError;
    if (liveSubscription) {
      return json(409, {
        error: "SUBSCRIPTION_ALREADY_EXISTS",
        code: "SUBSCRIPTION_ALREADY_EXISTS",
        subscriptionId: liveSubscription.id,
      });
    }

    const { data: pendingCheckout, error: pendingCheckoutError } = await auth
      .context.admin
      .from("hub_checkout_sessions")
      .select(
        "id, plan_id, billing_type, status, amount, invoice_url, bank_slip_url, asaas_payment_id",
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

    checkoutMetadata = {
      ...(testMode ? { test_fixture: true, testMode: true } : {}),
      ...(productFamily === WOLFIE_PRODUCT_FAMILY
        ? {
          product_family: productFamily,
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

    let customerId = account.asaas_customer_id as string | null;
    if (!customerId) {
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
          externalReference: `hub-account:${membership.account_id}`,
        }),
      });
      customerId = customer.id;
      await auth.context.admin.from("hub_accounts").update({
        asaas_customer_id: customerId,
      }).eq("id", membership.account_id);
    }

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
    const { error: linkError } = await auth.context.admin.from(
      "hub_checkout_sessions",
    ).update({
      asaas_subscription_id: providerSubscriptionId,
      metadata: {
        ...checkoutMetadata,
        providerLinkedAt: new Date().toISOString(),
      },
    }).eq("id", checkout.id).in("status", ["CREATED", "PENDING"]);
    if (linkError) throw linkError;

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

    const { error: updateError } = await auth.context.admin.from(
      "hub_checkout_sessions",
    ).update({
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
    }).eq("id", checkout.id).in("status", ["CREATED", "PENDING"]);
    if (updateError) throw updateError;

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
    if (checkoutId) {
      const recoveryRequired = providerSubscriptionId !== null &&
        !providerCancellationConfirmed;
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
          provider_subscription_id: providerSubscriptionId,
          provider_payment_id: providerPayment?.id ?? null,
          reconciliation_required: recoveryRequired,
          rollback_delete_confirmed: providerCancellationConfirmed,
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
    const reconciliationRequired = providerSubscriptionId !== null &&
      !providerCancellationConfirmed;
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
