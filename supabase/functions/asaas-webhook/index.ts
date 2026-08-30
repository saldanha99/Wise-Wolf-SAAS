import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  applyEnrollmentPaymentObservation,
  type EnrollmentPaymentKind,
  type EnrollmentPaymentObservation,
  type EnrollmentPaymentObservationBinding,
  EnrollmentPaymentObservationError,
  enrollmentPaymentObservationFailureDisposition,
  resolveEnrollmentPaymentObservationBinding,
} from "../_shared/enrollment-progress.ts";
import {
  prepareAccountActivation,
  preparedAccountActivationFromStoredPayload,
  secureInitialPassword,
  sendPreparedAccountActivation,
} from "../_shared/account-invite.ts";
import {
  claimSaasOwnerActivation,
  classifySaasOwnerActivationIdentity,
  repairSaasOwnerAccess,
  stageSaasOwnerActivationPayload,
  submitSaasOwnerActivationOnce,
  suppressSaasOwnerActivation,
} from "../_shared/saas-owner-activation.ts";
import { classifyStudentPaymentType } from "./payment-classification.ts";
import {
  actualCreditAt,
  asaasDateToIso,
  completedRefundAmount,
  financialReviewReason,
  isProvenHistoricalReversalEvent,
  isSettledPaymentEvent,
  paymentCustomerMatchesCanonicalBinding,
  providerEventRank,
  providerGeneratedSubscriptionPaymentMatches,
  SETTLED_PAYMENT_EVENTS,
  shouldApplyProviderEvent,
  studentIdFromKnownPaymentReference,
} from "./event-contract.ts";
import {
  activateThenCancelHubReplacement,
  HUB_CORE_PRODUCT_FAMILY,
  hubActivationAllowsReplacementCancellation,
  type HubBillingBlockCode,
  hubBillingBlockCode,
  hubCheckoutIdFromExternalReference,
  hubRecoveryReason,
  isHubRecoveryEvent,
  replacementProviderSubscriptionId,
} from "../_shared/hub-billing-safety.ts";
import { cancelHubProviderSubscriptionOnce } from "../_shared/hub-provider-operations.ts";
import { safeCommunicationText } from "../_shared/tenant-communication.ts";
import {
  authorizeAsaasHistoricalReversal,
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
  resolvePlatformAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";
import {
  billingIdentityMismatch,
  hubPaymentEventRequiresIdentity,
  providerWebhookEventKey,
} from "./billing-safety.ts";
import { parseCanonicalAsaasReference } from "../_shared/asaas-mutation-guard.ts";
import {
  wolfieTopupDescription,
  wolfieTopupDueDate,
  wolfieTopupPaymentCoreIdentityMatches,
  wolfieTopupPaymentMatches,
  wolfieTopupProviderReference,
} from "../create-wolfie-topup/provider-safety.ts";
import {
  claimOutboundMessage,
  finishOutboundMessage,
  markOutboundMessageSubmittingDecision,
} from "../_shared/student-billing-period-guard.ts";

// EdgeRuntime é injetado pelo runtime do Supabase (não tem tipagem nos types padrão)
declare const EdgeRuntime:
  | { waitUntil: (promise: Promise<unknown>) => void }
  | undefined;

type AsaasWebhookPayment = {
  id: string;
  customer: string;
  status: string;
  value?: number;
  externalReference?: string | null;
  description?: string | null;
  dueDate?: string | null;
  paymentDate?: string | null;
  creditDate?: string | null;
  estimatedCreditDate?: string | null;
  billingType?: string | null;
  subscription?: string | null;
  bankSlipUrl?: string | null;
  invoiceUrl?: string | null;
  refundedValue?: number | null;
  refunds?: Array<{ value?: number | null; status?: string | null }> | null;
};

type AsaasWebhookSubscription = {
  id: string;
  customer: string;
  status?: string | null;
  value?: number | null;
  externalReference?: string | null;
  billingType?: string | null;
  cycle?: string | null;
};

type AsaasWebhookBody = {
  id?: string;
  event?: string;
  dateCreated?: string | null;
  payment?: AsaasWebhookPayment;
  subscription?: AsaasWebhookSubscription;
};

const PAID_EVENTS = SETTLED_PAYMENT_EVENTS;
const TOPUP_REVERSAL_EVENTS = new Set([
  "PAYMENT_DELETED",
  "PAYMENT_REFUNDED",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_RECEIVED_IN_CASH_UNDONE",
]);
const TOPUP_FREEZE_EVENTS = new Set([
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
]);
const HUB_REVERSAL_EVENTS = new Set([
  "PAYMENT_DELETED",
  "PAYMENT_REFUNDED",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_RECEIVED_IN_CASH_UNDONE",
]);
const SAAS_ACCESS_EVENTS = new Set([
  ...PAID_EVENTS,
  "PAYMENT_OVERDUE",
  "PAYMENT_REFUND_IN_PROGRESS",
  "PAYMENT_BANK_SLIP_CANCELLED",
  "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
  "PAYMENT_REPROVED_BY_RISK_ANALYSIS",
  "PAYMENT_DELETED",
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_RECEIVED_IN_CASH_UNDONE",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "SUBSCRIPTION_INACTIVATED",
  "SUBSCRIPTION_DELETED",
]);

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(
      value,
    );
}

// Environment Variables
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ASAAS_WEBHOOK_TOKEN = (Deno.env.get("ASAAS_WEBHOOK_TOKEN") || "").trim();
const MAX_WEBHOOK_BYTES = 256 * 1024;

async function readWebhookBody(req: Request): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      throw new Error("PAYLOAD_TOO_LARGE");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

// META CAPI — mede o evento "Purchase" (matrícula paga) server-side. FB_CAPI_TOKEN ainda não
// configurado → no-op silencioso até o secret existir.
const FB_PIXEL_ID = "1475651934149356";
const FB_CAPI_TOKEN = (Deno.env.get("FB_CAPI_TOKEN") || "").trim();
const FB_CAPI_TENANT_ID = (Deno.env.get("FB_CAPI_TENANT_ID") || "").trim();
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input.trim().toLowerCase()),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")
  }}`;
}

async function sha256ExactHex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function sendMetaCapiEvent(opts: {
  eventName: string;
  phone?: string | null;
  value?: number;
  currency?: string;
}): Promise<{
  status: "SENT" | "FAILED" | "UNKNOWN";
  providerHttpStatus: number | null;
  error: string | null;
}> {
  try {
    const userData: Record<string, unknown> = {};
    if (opts.phone) {
      const digits = opts.phone.replace(/\D/g, "");
      userData.ph = [
        await sha256Hex(digits.startsWith("55") ? digits : `55${digits}`),
      ];
    }
    const body = {
      data: [
        {
          event_name: opts.eventName,
          event_time: Math.floor(Date.now() / 1000),
          action_source: "system_generated",
          event_source_url: "https://system.wisewolflanguage.com.br",
          user_data: userData,
          ...(opts.value
            ? {
              custom_data: {
                value: opts.value,
                currency: opts.currency || "BRL",
              },
            }
            : {}),
        },
      ],
    };
    const response = await fetch(
      `https://graph.facebook.com/v20.0/${FB_PIXEL_ID}/events?access_token=${FB_CAPI_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (response.ok) {
      return {
        status: "SENT",
        providerHttpStatus: response.status,
        error: null,
      };
    }
    const ambiguous = [408, 409, 425, 429].includes(response.status) ||
      response.status >= 500;
    return {
      status: ambiguous ? "UNKNOWN" : "FAILED",
      providerHttpStatus: response.status,
      error: ambiguous
        ? "provider_delivery_outcome_unknown"
        : `provider_http_${response.status}`,
    };
  } catch {
    return {
      status: "UNKNOWN",
      providerHttpStatus: null,
      error: "provider_delivery_outcome_unknown",
    };
  }
}

async function deliverMetaPurchaseOnce(input: {
  admin: SupabaseClient;
  tenantId: string;
  studentId: string;
  localPaymentId: string;
  phone: string;
  value?: number;
}): Promise<void> {
  const claim = await claimOutboundMessage(input.admin, {
    tenantId: input.tenantId,
    studentId: input.studentId,
    providerEntityId: input.localPaymentId,
    notificationKind: "PAYMENT_CONFIRMED_CAPI",
  });
  if (claim.action === "IN_PROGRESS") {
    throw new Error("capi_outbound_claim_in_progress");
  }
  if (claim.action !== "SUBMIT_ONCE") return;

  if (
    !FB_CAPI_TOKEN || !FB_CAPI_TENANT_ID ||
    FB_CAPI_TENANT_ID !== input.tenantId
  ) {
    await finishOutboundMessage(input.admin, claim, {
      status: "SUPPRESSED",
      error: !FB_CAPI_TOKEN || !FB_CAPI_TENANT_ID
        ? "capi_not_configured"
        : "capi_tenant_mismatch",
    });
    return;
  }

  const submit = await markOutboundMessageSubmittingDecision(
    input.admin,
    claim,
  );
  if (submit.ok !== true || submit.status !== "SUBMITTING") return;

  const delivery = await sendMetaCapiEvent({
    eventName: "Purchase",
    phone: input.phone,
    value: input.value,
  });
  await finishOutboundMessage(input.admin, claim, delivery);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, asaas-access-token",
};

// fetch com timeout (AbortController) — impede que uma API externa lenta
// (ASAAS ou Evolution) pendure o processamento por dezenas de segundos.
async function fetchComTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function cancelHubProviderSubscriptionForAccount(
  supabase: SupabaseClient,
  accountId: string,
  providerSubscriptionId: string,
): Promise<void> {
  const [checkoutResult, accountResult] = await Promise.all([
    supabase
      .from("hub_checkout_sessions")
      .select("id")
      .eq("account_id", accountId)
      .eq("asaas_subscription_id", providerSubscriptionId)
      .limit(2),
    supabase
      .from("hub_accounts")
      .select("asaas_customer_id")
      .eq("id", accountId)
      .maybeSingle(),
  ]);
  if (checkoutResult.error) throw checkoutResult.error;
  if (accountResult.error) throw accountResult.error;
  const matches = checkoutResult.data || [];
  const providerCustomerId = String(
    accountResult.data?.asaas_customer_id || "",
  ).trim();
  if (
    matches.length !== 1 || !isUuid(matches[0].id) ||
    !providerCustomerId || providerCustomerId.length > 200
  ) {
    throw new Error("hub_provider_subscription_local_binding_invalid");
  }
  await cancelHubProviderSubscriptionOnce({
    admin: supabase,
    accountId,
    target: {
      providerSubscriptionId,
      providerCustomerId,
      checkoutId: matches[0].id,
    },
  });
}

async function ensureSaasOwnerAccess(
  supabase: SupabaseClient,
  provisioned: {
    checkout_id: string;
    tenant_id: string;
    owner_name: string;
    owner_email: string;
  },
): Promise<void> {
  const ownerEmail = provisioned.owner_email.trim().toLowerCase();
  const activationClaim = await claimSaasOwnerActivation(supabase, {
    checkoutId: provisioned.checkout_id,
    tenantId: provisioned.tenant_id,
    ownerEmail,
  });
  const { data: existingUserId, error: lookupError } = await supabase.rpc(
    "get_user_id_by_email",
    { email_input: ownerEmail },
  );
  if (lookupError) {
    throw new Error(`owner_lookup_${lookupError.code || "failed"}`);
  }

  let userId = existingUserId as string | null;
  let createdForCheckout = false;
  if (!userId && activationClaim.action === "ALREADY_FINAL") {
    const repairPreflight = await repairSaasOwnerAccess(supabase, {
      checkoutId: provisioned.checkout_id,
      ownerUserId: null,
    });
    if (
      repairPreflight === "NOT_REQUIRED" || repairPreflight === "REPAIRED"
    ) return;
    if (repairPreflight !== "IDENTITY_REQUIRED") {
      throw new Error("saas_owner_access_repair_preflight_invalid");
    }
  }
  if (!userId) {
    const { data: created, error: createError } = await supabase.auth.admin
      .createUser({
        email: ownerEmail,
        password: secureInitialPassword(),
        email_confirm: true,
        app_metadata: {
          saas_owner_activation_checkout_id: provisioned.checkout_id,
        },
        user_metadata: { full_name: provisioned.owner_name },
      });
    if (createError || !created.user) {
      // A duplicate created by a concurrent webhook is safe to recover.
      const retryLookup = await supabase.rpc("get_user_id_by_email", {
        email_input: ownerEmail,
      });
      if (retryLookup.error || !retryLookup.data) {
        throw new Error(`owner_create_${createError?.status || "failed"}`);
      }
      userId = retryLookup.data as string;
    } else {
      userId = created.user.id;
      createdForCheckout = true;
    }
  }
  if (!userId) throw new Error("owner_user_id_unavailable");
  if (activationClaim.action === "ALREADY_FINAL") {
    const repairResult = await repairSaasOwnerAccess(supabase, {
      checkoutId: provisioned.checkout_id,
      ownerUserId: userId,
    });
    if (repairResult === "REPAIRED") return;
    if (repairResult === "NOT_REQUIRED" && !createdForCheckout) return;
    throw new Error(
      repairResult === "IDENTITY_REQUIRED"
        ? "saas_owner_access_repair_identity_conflict"
        : "saas_owner_access_repair_not_completed",
    );
  }

  const identityDisposition = await classifySaasOwnerActivationIdentity(
    supabase,
    {
      checkoutId: provisioned.checkout_id,
      claimToken: activationClaim.claimToken,
      ownerUserId: userId,
    },
  );
  switch (identityDisposition) {
    case "CHECKOUT_IDENTITY":
    case "DORMANT_CHECKOUT_IDENTITY":
      break;
    case "EXISTING_ACCOUNT":
      await suppressSaasOwnerActivation(supabase, {
        checkoutId: provisioned.checkout_id,
        claimToken: activationClaim.claimToken,
        ownerUserId: userId,
        reason: "existing_owner_account",
      });
      return;
    case "NOT_REQUIRED":
      await suppressSaasOwnerActivation(supabase, {
        checkoutId: provisioned.checkout_id,
        claimToken: activationClaim.claimToken,
        ownerUserId: userId,
        reason: "owner_activation_not_required",
      });
      return;
  }

  const { data: priorActivation, error: priorActivationError } = await supabase
    .from("saas_owner_activation_attempts")
    .select("checkout_id,status")
    .eq("owner_user_id", userId)
    .in("status", [
      "CLAIMED",
      "SUBMITTING",
      "SENT",
      "FAILED",
      "UNKNOWN",
      "SUPPRESSED",
    ])
    .neq("checkout_id", provisioned.checkout_id)
    .limit(1)
    .maybeSingle();
  if (priorActivationError) {
    throw new Error(
      `owner_activation_history_${priorActivationError.code || "failed"}`,
    );
  }
  if (priorActivation) {
    await suppressSaasOwnerActivation(supabase, {
      checkoutId: provisioned.checkout_id,
      claimToken: activationClaim.claimToken,
      ownerUserId: userId,
      reason: "owner_activation_not_required",
    });
    return;
  }

  const idempotencyKey = `saas-owner-activation/${provisioned.checkout_id}`;
  const preparedActivation = activationClaim.action === "SUBMIT_ONCE"
    ? await prepareAccountActivation(supabase, {
      email: ownerEmail,
      name: provisioned.owner_name,
      accountLabel: "administrador da escola",
      idempotencyKey,
    })
    : preparedAccountActivationFromStoredPayload({
      payload: activationClaim.providerPayload,
      expectedEmail: ownerEmail,
      idempotencyKey,
    });
  if (activationClaim.action === "SUBMIT_ONCE") {
    const staged = await stageSaasOwnerActivationPayload(supabase, {
      checkoutId: provisioned.checkout_id,
      claimToken: activationClaim.claimToken,
      ownerUserId: userId,
      providerPayload: preparedActivation.payload,
    });
    if (staged === "SUPPRESSED") return;
  }

  const delivery = await submitSaasOwnerActivationOnce(supabase, {
    checkoutId: provisioned.checkout_id,
    claimToken: activationClaim.claimToken,
    ownerUserId: userId,
    send: () => sendPreparedAccountActivation(preparedActivation),
  });
  if (delivery.status !== "SENT") {
    console.error("[Webhook] SaaS owner activation delivery failed", {
      status: delivery.status,
    });
    await supabase
      .from("saas_checkout_intents")
      .update({
        last_error: `activation_email_${delivery.status.toLowerCase()}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", provisioned.checkout_id);
    if (delivery.status === "UNKNOWN") {
      // The next inbox pass must reuse both the exact staged body and key.
      throw new Error("saas_activation_delivery_unknown");
    }
  }
}

async function resumePendingSaasOwnerActivation(
  supabase: SupabaseClient,
  checkoutId: string,
): Promise<void> {
  const { data: attempt, error: attemptError } = await supabase
    .from("saas_owner_activation_attempts")
    .select("status")
    .eq("checkout_id", checkoutId)
    .maybeSingle();
  if (attemptError) {
    throw new Error(
      `saas_activation_recovery_${attemptError.code || "failed"}`,
    );
  }
  if (
    attempt &&
    ![
      "CLAIMED",
      "SUBMITTING",
      "UNKNOWN",
      "SENT",
      "FAILED",
      "SUPPRESSED",
    ].includes(attempt.status)
  ) return;

  const { data: checkout, error: checkoutError } = await supabase
    .from("saas_checkout_intents")
    .select("id,tenant_id,owner_name,owner_email")
    .eq("id", checkoutId)
    .maybeSingle();
  if (checkoutError) {
    throw new Error(
      `saas_activation_checkout_recovery_${checkoutError.code || "failed"}`,
    );
  }
  if (
    !checkout || typeof checkout.tenant_id !== "string" ||
    !checkout.tenant_id.trim() || typeof checkout.owner_name !== "string" ||
    !checkout.owner_name.trim() || typeof checkout.owner_email !== "string" ||
    !checkout.owner_email.trim()
  ) {
    throw new Error("saas_activation_checkout_recovery_invalid");
  }
  await ensureSaasOwnerAccess(supabase, {
    checkout_id: checkout.id,
    tenant_id: checkout.tenant_id,
    owner_name: checkout.owner_name,
    owner_email: checkout.owner_email,
  });
}

type SaasBillingInboxClaim = {
  duplicate: boolean;
  eventKey: string;
};

async function resolveSaasCheckoutId(
  body: AsaasWebhookBody,
): Promise<string | null> {
  const entity = body.payment || body.subscription;
  const externalReference = entity?.externalReference?.trim() ?? "";
  if (externalReference.startsWith("saas:")) {
    const checkoutId = externalReference.slice(5);
    return isUuid(checkoutId) ? checkoutId : null;
  }

  const providerSubscriptionId = body.payment?.subscription?.trim() ||
    body.subscription?.id?.trim() || "";
  const providerPaymentId = body.payment?.id?.trim() || "";
  if (!providerSubscriptionId && !providerPaymentId) return null;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("saas_checkout_lookup_unavailable");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let query = supabase.from("saas_checkout_intents").select("id");
  query = providerSubscriptionId
    ? query.eq("asaas_subscription_id", providerSubscriptionId)
    : query.eq("asaas_payment_id", providerPaymentId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

async function claimSaasBillingEvent(
  supabase: SupabaseClient,
  body: AsaasWebhookBody,
  checkoutId: string,
): Promise<SaasBillingInboxClaim> {
  const event = body.event || "UNKNOWN";
  const providerEntityId = body.payment?.id || body.subscription?.id ||
    "unknown";
  const providerEventId = typeof body.id === "string" ? body.id.trim() : "";
  const eventKey = providerWebhookEventKey(
    "saas",
    providerEventId,
    event,
    providerEntityId,
  );
  const leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
  const { error: insertError } = await supabase
    .from("saas_billing_event_inbox")
    .insert({
      event_key: eventKey,
      provider_event_id: providerEventId || null,
      event_name: event,
      provider_entity_id: providerEntityId,
      checkout_id: checkoutId,
      status: "PROCESSING",
      lease_expires_at: leaseExpiresAt,
      metadata: {
        paymentStatus: body.payment?.status || null,
        subscriptionStatus: body.subscription?.status || null,
        subscriptionId: body.payment?.subscription || body.subscription?.id ||
          null,
        customerId: body.payment?.customer || body.subscription?.customer ||
          null,
        amount: body.payment?.value ?? body.subscription?.value ?? null,
        billingType: body.payment?.billingType ||
          body.subscription?.billingType || null,
        billingCycle: body.subscription?.cycle || null,
        externalReference: body.payment?.externalReference ||
          body.subscription?.externalReference ||
          null,
      },
    });

  if (!insertError) return { duplicate: false, eventKey };
  if (insertError.code !== "23505") throw insertError;

  const { data: existing, error: existingError } = await supabase
    .from("saas_billing_event_inbox")
    .select("status, lease_expires_at, attempt_count")
    .eq("event_key", eventKey)
    .maybeSingle();
  if (existingError) throw existingError;
  if (!existing) throw new Error("saas_event_inbox_missing");
  if (existing.status === "PROCESSED") {
    return { duplicate: true, eventKey };
  }
  const leaseIsActive = existing.status === "PROCESSING" &&
    Date.parse(existing.lease_expires_at) > Date.now();
  if (leaseIsActive) throw new Error("saas_event_already_processing");

  const { data: reclaimed, error: reclaimError } = await supabase
    .from("saas_billing_event_inbox")
    .update({
      status: "PROCESSING",
      lease_expires_at: leaseExpiresAt,
      last_error: null,
      attempt_count: Math.min(Number(existing.attempt_count || 1) + 1, 100),
      updated_at: new Date().toISOString(),
    })
    .eq("event_key", eventKey)
    .neq("status", "PROCESSED")
    .select("event_key")
    .maybeSingle();
  if (reclaimError) throw reclaimError;
  return { duplicate: !reclaimed, eventKey };
}

async function finishSaasBillingEvent(
  supabase: SupabaseClient,
  eventKey: string,
  status: "PROCESSED" | "FAILED",
  lastError?: string,
): Promise<void> {
  const { error } = await supabase
    .from("saas_billing_event_inbox")
    .update({
      status,
      last_error: lastError?.slice(0, 500) || null,
      processed_at: status === "PROCESSED" ? new Date().toISOString() : null,
      lease_expires_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("event_key", eventKey);
  if (error) throw error;
}

async function processSaasCheckoutEvent(
  supabase: SupabaseClient,
  body: AsaasWebhookBody,
  resolvedCheckoutId?: string | null,
): Promise<boolean> {
  const event = body.event || "";
  if (!SAAS_ACCESS_EVENTS.has(event)) return false;

  const checkoutId = resolvedCheckoutId ?? (await resolveSaasCheckoutId(body));
  if (!checkoutId || !isUuid(checkoutId)) return false;
  const providerEventId = typeof body.id === "string" ? body.id.trim() : "";
  const providerEventAt = asaasDateToIso(body.dateCreated);
  if (!providerEventId || !providerEventAt) {
    throw new AsaasTriageError(
      "saas_provider_event_ordering_identity_missing",
      null,
      checkoutId,
    );
  }

  const { data: checkout, error: checkoutError } = await supabase
    .from("saas_checkout_intents")
    .select(
      "id,tenant_id,status,amount,billing_type,billing_cycle,asaas_customer_id,asaas_subscription_id,asaas_payment_id",
    )
    .eq("id", checkoutId)
    .maybeSingle();
  if (checkoutError) throw checkoutError;
  if (!checkout) throw new Error("saas_checkout_not_found");

  const claim = await claimSaasBillingEvent(supabase, body, checkoutId);
  if (claim.duplicate) {
    const checkoutCanRepairOwnerActivation =
      typeof checkout.tenant_id === "string" && checkout.tenant_id.trim() &&
      ["PROVISIONING", "PROVISIONING_FAILED", "PROVISIONED"].includes(
        String(checkout.status || "").toUpperCase(),
      );
    if (PAID_EVENTS.has(event) && checkoutCanRepairOwnerActivation) {
      await resumePendingSaasOwnerActivation(supabase, checkoutId);
    }
    return true;
  }

  try {
    const providerIdentity = body.payment
      ? {
        subscriptionId: body.payment.subscription,
        customerId: body.payment.customer,
        amount: body.payment.value,
        billingType: body.payment.billingType,
        billingCycle: undefined,
      }
      : {
        subscriptionId: body.subscription?.id,
        customerId: body.subscription?.customer,
        amount: body.subscription?.value,
        billingType: body.subscription?.billingType,
        billingCycle: body.subscription?.cycle,
      };
    const identityMismatch = billingIdentityMismatch(
      {
        subscriptionId: checkout.asaas_subscription_id,
        customerId: checkout.asaas_customer_id,
        amount: Number(checkout.amount),
        billingType: checkout.billing_type,
        billingCycle: checkout.billing_cycle,
      },
      providerIdentity,
      { requireBillingCycle: Boolean(body.subscription) },
    );
    if (identityMismatch) {
      throw new Error(`saas_${identityMismatch.toLowerCase()}`);
    }

    const { data: applied, error: applyError } = await supabase.rpc(
      "apply_saas_checkout_billing_event",
      {
        p_checkout_id: checkoutId,
        p_event_name: event,
        p_provider_event_id: providerEventId,
        p_event_created_at: providerEventAt,
        p_payment_id: body.payment?.id || null,
        p_payment_value: providerIdentity.amount,
        p_billing_type: providerIdentity.billingType,
        p_customer_id: providerIdentity.customerId,
        p_subscription_id: providerIdentity.subscriptionId,
        p_billing_cycle: providerIdentity.billingCycle || null,
        p_paid_at: body.payment?.paymentDate || null,
        p_due_date: body.payment?.dueDate || null,
        p_invoice_url: body.payment?.invoiceUrl || null,
        p_bank_slip_url: body.payment?.bankSlipUrl || null,
      },
    );
    if (applyError || !applied?.ok) {
      throw applyError || new Error("saas_billing_event_not_applied");
    }
    if (applied.action === "REVIEW_REQUIRED") {
      throw new AsaasTriageError(
        String(applied.reason || "saas_provider_event_review_required"),
        typeof checkout.tenant_id === "string" ? checkout.tenant_id : null,
        checkoutId,
      );
    }
    if (
      applied.action === "STALE_IGNORED" ||
      applied.action === "STALE_ENTITY_APPLIED" ||
      applied.action === "TERMINAL_IGNORED" ||
      applied.action === "TERMINAL_REPLAY_IGNORED"
    ) {
      await finishSaasBillingEvent(supabase, claim.eventKey, "PROCESSED");
      return true;
    }

    if (applied.action === "PROVISION_REQUIRED") {
      const paymentId = body.payment?.id;
      if (!paymentId) throw new Error("saas_payment_id_required");
      const { data: provisioned, error: provisionError } = await supabase.rpc(
        "provision_paid_saas_checkout",
        {
          p_checkout_id: checkoutId,
          p_payment_id: paymentId,
        },
      );
      if (provisionError || !provisioned?.ok) {
        throw provisionError || new Error("saas_tenant_provision_failed");
      }

      try {
        await ensureSaasOwnerAccess(supabase, provisioned);
      } catch (ownerError) {
        const reason = ownerError instanceof Error
          ? ownerError.message.slice(0, 500)
          : "owner_provision_failed";
        await supabase
          .from("saas_checkout_intents")
          .update({
            status: "PROVISIONING_FAILED",
            last_error: reason,
            updated_at: new Date().toISOString(),
          })
          .eq("id", checkoutId)
          .in("status", ["PAID", "PROVISIONING", "PROVISIONING_FAILED"]);
        throw ownerError;
      }
      console.log(`[Webhook] SaaS provisionado: ${checkoutId}`);
    } else if (PAID_EVENTS.has(event)) {
      await resumePendingSaasOwnerActivation(supabase, checkoutId);
    }

    await finishSaasBillingEvent(supabase, claim.eventKey, "PROCESSED");
    return true;
  } catch (error) {
    const reason = error instanceof Error
      ? error.message
      : "saas_billing_failed";
    try {
      await finishSaasBillingEvent(supabase, claim.eventKey, "FAILED", reason);
    } catch (finishError) {
      console.error("[Webhook] SaaS inbox failure could not be recorded", {
        type: finishError instanceof Error ? finishError.message : "unknown",
      });
    }
    throw error;
  }
}

async function listAllPaymentRefunds(
  paymentId: string,
  integration: ResolvedAsaasIntegration,
): Promise<Array<{ value?: unknown; status?: unknown }> | null> {
  const refunds: Array<{ value?: unknown; status?: unknown }> = [];
  for (let offset = 0, pages = 0; pages < 1_000; offset += 100, pages++) {
    const params = new URLSearchParams({
      limit: "100",
      offset: String(offset),
    });
    const response = await fetch(
      `${integration.baseUrl}/payments/${
        encodeURIComponent(paymentId)
      }/refunds?${params}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          access_token: integration.apiKey,
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    const payload = await response.json().catch(() => null) as
      | { data?: unknown; hasMore?: unknown }
      | null;
    if (!response.ok || !payload || !Array.isArray(payload.data)) return null;
    refunds.push(
      ...payload.data as Array<{ value?: unknown; status?: unknown }>,
    );
    if (payload.hasMore !== true) return refunds;
  }
  throw new Error("asaas_refunds_page_limit");
}

async function processWolfieTopupEvent(
  body: AsaasWebhookBody,
): Promise<boolean> {
  const { event, payment } = body;
  const reference = payment?.externalReference ?? "";
  const prefix = "wolfie-topup-order:";
  const isLegacy = reference.startsWith("topup:");
  if (!isLegacy && !reference.startsWith(prefix)) return false;
  if (
    !event ||
    !payment ||
    !payment.id ||
    payment.id.length > 200 ||
    reference.length > 300
  ) {
    throw new Error("invalid_wolfie_topup_webhook");
  }
  const amount = Number(payment.value);
  if (payment.value !== undefined && (!Number.isFinite(amount) || amount < 0)) {
    throw new Error("invalid_wolfie_topup_amount");
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("wolfie_topup_database_unavailable");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const explicitEventId =
    typeof body.id === "string" && body.id.length >= 1 && body.id.length <= 240
      ? body.id
      : null;
  const eventId = explicitEventId ??
    `synthetic:${await sha256Hex(
      JSON.stringify([
        event,
        payment.id,
        reference,
        payment.status,
        payment.value ?? null,
        payment.refundedValue ?? null,
        payment.paymentDate ?? null,
      ]),
    )}`;
  const receivedAt = new Date().toISOString();
  const { error: inboxError } = await supabase
    .from("wolfie_topup_webhook_inbox")
    .upsert(
      {
        provider_event_id: eventId,
        event_type: event.slice(0, 120),
        provider_payment_id: payment.id,
        external_reference: reference,
        payment_amount_brl: Number.isFinite(amount) ? amount : null,
        refunded_amount_brl: Number.isFinite(Number(payment.refundedValue)) &&
            Number(payment.refundedValue) >= 0
          ? Number(payment.refundedValue)
          : null,
        billing_type: typeof payment.billingType === "string"
          ? payment.billingType.slice(0, 40)
          : null,
        processing_status: "RECEIVED",
        last_error: null,
        last_received_at: receivedAt,
        updated_at: receivedAt,
      },
      { onConflict: "provider_event_id" },
    );
  if (inboxError) throw new Error("wolfie_topup_inbox_unavailable");

  const finishInbox = async (
    status: "APPLIED" | "IGNORED" | "LEGACY_REVIEW" | "FAILED",
    lastError: string | null = null,
  ) => {
    const { error } = await supabase
      .from("wolfie_topup_webhook_inbox")
      .update({
        processing_status: status,
        last_error: lastError,
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("provider_event_id", eventId);
    if (error) throw new Error("wolfie_topup_inbox_update_failed");
  };

  if (isLegacy) {
    // The old reference has no tenant snapshot. Persist it for manual triage
    // and ACK 200 so one poison event cannot pause the whole Asaas queue.
    await finishInbox("LEGACY_REVIEW", "tenant_snapshot_missing");
    return true;
  }

  const orderId = reference.slice(prefix.length);
  if (!isUuid(orderId)) {
    await finishInbox("FAILED", "invalid_order_reference");
    throw new Error("invalid_wolfie_topup_webhook");
  }
  if (
    !PAID_EVENTS.has(event) &&
    !TOPUP_REVERSAL_EVENTS.has(event) &&
    !TOPUP_FREEZE_EVENTS.has(event)
  ) {
    await finishInbox("IGNORED");
    return true;
  }
  if (!Number.isFinite(amount) || amount < 0) {
    await finishInbox("FAILED", "invalid_payment_amount");
    throw new Error("invalid_wolfie_topup_amount");
  }

  const { data: topupOrder, error: topupOrderError } = await supabase
    .from("wolfie_topup_orders")
    .select(
      "id,tenant_id,student_id,package_name,amount_brl,provider_customer_id,provider_payment_id,created_at",
    )
    .eq("id", orderId)
    .maybeSingle();
  const providerCustomerId = String(
    topupOrder?.provider_customer_id || "",
  ).trim();
  const providerReference = wolfieTopupProviderReference(orderId);
  const dueDate = wolfieTopupDueDate(topupOrder?.created_at);
  const description = wolfieTopupDescription(topupOrder?.package_name);
  const expectedAmount = Number(topupOrder?.amount_brl);
  if (
    topupOrderError || !topupOrder || !providerCustomerId || !dueDate ||
    !description || !Number.isFinite(expectedAmount) || expectedAmount < 0
  ) {
    await finishInbox("FAILED", "topup_customer_snapshot_unavailable");
    throw new Error("wolfie_topup_identity_unavailable");
  }
  const expectedTopupPayment = {
    reference: providerReference,
    customerId: providerCustomerId,
    value: expectedAmount,
    dueDate,
    description,
    splitPolicy: { kind: "NONE" as const },
  };
  const locallyBoundPayment = String(
    topupOrder.provider_payment_id || "",
  ).trim();
  if (locallyBoundPayment && locallyBoundPayment !== payment.id) {
    await finishInbox("FAILED", "provider_payment_binding_mismatch");
    throw new Error("wolfie_topup_payment_mismatch");
  }

  let topupReadIntegration: ResolvedAsaasIntegration | null = null;
  let verifiedProviderPayment: Record<string, unknown> | null = null;
  try {
    topupReadIntegration = await resolvePlatformAsaasIntegration(
      supabase,
      "payment.read",
    );
    const identityResponse = await fetch(
      `${topupReadIntegration.baseUrl}/payments/${
        encodeURIComponent(payment.id)
      }`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          access_token: topupReadIntegration.apiKey,
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    const identityPayload = await identityResponse.json().catch(() => null);
    if (
      identityResponse.ok &&
      wolfieTopupPaymentCoreIdentityMatches(
        identityPayload,
        payment.id,
        expectedTopupPayment,
      ) &&
      (locallyBoundPayment ||
        wolfieTopupPaymentMatches(identityPayload, expectedTopupPayment))
    ) {
      verifiedProviderPayment = identityPayload;
    }
  } catch {
    // A locally linked immutable payment may still be reversed after the
    // provider object becomes unreadable. An unbound order never gets this
    // fallback: adoption always requires a fresh exact provider GET.
  }
  if (
    !verifiedProviderPayment && locallyBoundPayment === payment.id &&
    wolfieTopupPaymentCoreIdentityMatches(
      payment,
      payment.id,
      expectedTopupPayment,
    )
  ) {
    verifiedProviderPayment = payment as unknown as Record<string, unknown>;
  }
  if (!verifiedProviderPayment) {
    await finishInbox("FAILED", "provider_payment_identity_unverified");
    throw new Error("wolfie_topup_provider_identity_unverified");
  }
  const verifiedAmount = Number(verifiedProviderPayment.value);
  const verifiedCustomerId = String(
    verifiedProviderPayment.customer || "",
  ).trim();
  const verifiedReference = String(
    verifiedProviderPayment.externalReference || "",
  ).trim();
  const verifiedBillingType = String(
    verifiedProviderPayment.billingType || "",
  ).trim();

  let refundedAmount = typeof payment.refundedValue === "number" &&
      Number.isFinite(payment.refundedValue) &&
      payment.refundedValue >= 0
    ? payment.refundedValue
    : Number.NaN;
  if (
    !Number.isFinite(refundedAmount) &&
    (TOPUP_FREEZE_EVENTS.has(event) || TOPUP_REVERSAL_EVENTS.has(event))
  ) {
    try {
      const refundIntegration = topupReadIntegration ||
        await resolvePlatformAsaasIntegration(supabase, "payment.read");
      const refunds = await listAllPaymentRefunds(
        payment.id,
        refundIntegration,
      );
      if (refunds) {
        refundedAmount = refunds.reduce<number>((sum, refund) => {
          const value = Number(refund.value);
          const status = String(refund.status || "").toUpperCase();
          return sum +
            (status === "DONE" && Number.isFinite(value) && value > 0
              ? value
              : 0);
        }, 0);
      }
    } catch {
      console.warn("[Webhook] Refund amount lookup unavailable", {
        paymentId: payment.id,
      });
    }
  }
  const { data, error } = await supabase.rpc(
    "apply_verified_wolfie_topup_payment",
    {
      p_order_id: orderId,
      p_payment_id: payment.id,
      p_event: event,
      p_amount_brl: verifiedAmount,
      p_refunded_amount_brl: Number.isFinite(refundedAmount)
        ? refundedAmount
        : null,
      p_provider_customer_id: verifiedCustomerId,
      p_external_reference: verifiedReference,
      p_billing_type: verifiedBillingType,
    },
  );
  if (error || !data?.ok) {
    await finishInbox("FAILED", "payment_not_applied");
    throw new Error("wolfie_topup_payment_not_applied");
  }
  await finishInbox("APPLIED");
  return true;
}

type HubPaymentInboxClaim = {
  duplicate: boolean;
  eventKey: string;
};

async function claimHubPaymentEvent(
  supabase: SupabaseClient,
  body: AsaasWebhookBody,
  checkoutId: string,
): Promise<HubPaymentInboxClaim> {
  const event = body.event || "UNKNOWN";
  const paymentId = body.payment?.id || "unknown";
  const providerEventId = typeof body.id === "string" ? body.id.trim() : "";
  const eventKey = providerWebhookEventKey(
    "hub",
    providerEventId,
    event,
    paymentId,
  );
  const leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
  const { error: insertError } = await supabase
    .from("hub_payment_event_inbox")
    .insert({
      event_key: eventKey,
      event_name: event,
      payment_id: paymentId,
      checkout_id: checkoutId,
      status: "PROCESSING",
      lease_expires_at: leaseExpiresAt,
      metadata: {
        paymentStatus: body.payment?.status || null,
        subscriptionId: body.payment?.subscription || null,
      },
    });

  if (!insertError) return { duplicate: false, eventKey };
  if (insertError.code !== "23505") throw insertError;

  const { data: existing, error: existingError } = await supabase
    .from("hub_payment_event_inbox")
    .select("status, lease_expires_at, attempt_count")
    .eq("event_key", eventKey)
    .maybeSingle();
  if (existingError) throw existingError;
  if (!existing) throw new Error("hub_event_inbox_missing");
  if (existing.status === "PROCESSED") {
    return { duplicate: true, eventKey };
  }
  const leaseIsActive = existing.status === "PROCESSING" &&
    Date.parse(existing.lease_expires_at) > Date.now();
  if (leaseIsActive) throw new Error("hub_event_already_processing");

  const { data: reclaimed, error: reclaimError } = await supabase
    .from("hub_payment_event_inbox")
    .update({
      status: "PROCESSING",
      lease_expires_at: leaseExpiresAt,
      last_error: null,
      attempt_count: Math.min(Number(existing.attempt_count || 1) + 1, 100),
      updated_at: new Date().toISOString(),
    })
    .eq("event_key", eventKey)
    .neq("status", "PROCESSED")
    .select("event_key")
    .maybeSingle();
  if (reclaimError) throw reclaimError;
  return { duplicate: !reclaimed, eventKey };
}

async function finishHubPaymentEvent(
  supabase: SupabaseClient,
  eventKey: string,
  status: "PROCESSED" | "FAILED",
  lastError?: string,
): Promise<void> {
  const { error } = await supabase
    .from("hub_payment_event_inbox")
    .update({
      status,
      last_error: lastError?.slice(0, 500) || null,
      processed_at: status === "PROCESSED" ? new Date().toISOString() : null,
      lease_expires_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("event_key", eventKey);
  if (error) throw error;
}

function scheduleHubFulfillment(checkoutId: string): void {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  const delivery = fetch(
    `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/process-hub-fulfillment`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ checkoutId }),
      signal: AbortSignal.timeout(30_000),
    },
  )
    .then((response) => {
      if (!response.ok) {
        console.warn("[Webhook] Hub fulfillment kickoff deferred", {
          status: response.status,
        });
      }
    })
    .catch((error) => {
      console.warn("[Webhook] Hub fulfillment kickoff unavailable", {
        type: error instanceof Error ? error.name : "unknown",
      });
    });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(delivery);
  }
}

async function resolveHubCheckoutId(
  body: AsaasWebhookBody,
): Promise<string | null> {
  const directId = hubCheckoutIdFromExternalReference(
    body.payment?.externalReference,
  );
  if (directId !== null) return directId;

  const providerSubscriptionId = body.payment?.subscription?.trim() ?? "";
  if (!providerSubscriptionId) return null;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("hub_subscription_lookup_unavailable");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from("hub_checkout_sessions")
    .select("id")
    .eq("asaas_subscription_id", providerSubscriptionId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

async function loadHubBillingBlock(
  supabase: SupabaseClient,
  accountId: string,
  productFamily: string,
): Promise<HubBillingBlockCode | null> {
  const { data: account, error: accountError } = await supabase
    .from("hub_accounts")
    .select("status")
    .eq("id", accountId)
    .maybeSingle();
  if (accountError) throw accountError;

  let hubEnabled = true;
  if (productFamily === HUB_CORE_PRODUCT_FAMILY) {
    const { data: settings, error: settingsError } = await supabase
      .from("hub_settings")
      .select("metadata")
      .eq("settings_key", "default")
      .maybeSingle();
    if (settingsError) throw settingsError;
    hubEnabled = settings?.metadata?.hubEnabled !== false;
  }

  return hubBillingBlockCode(productFamily, account?.status, hubEnabled);
}

async function cancelBlockedHubBilling(
  supabase: SupabaseClient,
  checkout: {
    id: string;
    account_id: string;
    product_family: string;
    asaas_payment_id: string | null;
    metadata: unknown;
  },
  providerSubscriptionId: string | null,
  paymentId: string,
  blockCode: HubBillingBlockCode,
): Promise<void> {
  if (!providerSubscriptionId) {
    throw new Error("hub_provider_subscription_required_for_billing_block");
  }

  await cancelHubProviderSubscriptionForAccount(
    supabase,
    checkout.account_id,
    providerSubscriptionId,
  );
  const blockedAt = new Date().toISOString();

  const { error: subscriptionError } = await supabase
    .from("hub_subscriptions")
    .update({
      status: "CANCELLED",
      cancelled_at: blockedAt,
      updated_at: blockedAt,
    })
    .eq("account_id", checkout.account_id)
    .eq("product_family", checkout.product_family)
    .eq("provider", "ASAAS")
    .eq("provider_subscription_id", providerSubscriptionId)
    .in("status", ["TRIALING", "INCOMPLETE", "ACTIVE", "PAST_DUE"]);
  if (subscriptionError) throw subscriptionError;

  const { error: checkoutError } = await supabase.rpc(
    "hub_merge_checkout_provider_state",
    {
      p_checkout_id: checkout.id,
      p_payment_id: paymentId,
      p_expected_subscription_id: providerSubscriptionId,
      p_status: "CANCELLED",
      p_allowed_statuses: [
        "CREATED",
        "PENDING",
        "OVERDUE",
        "PAID",
        "CANCELLED",
      ],
      p_metadata_patch: {
        billingBlockedCode: blockCode,
        billingBlockedPaymentId: paymentId,
        billingBlockedAt: blockedAt,
        providerCancellationId: providerSubscriptionId,
        requiresManualReconciliation: true,
      },
    },
  );
  if (checkoutError) throw checkoutError;
}

async function processHubPaymentEvent(
  body: AsaasWebhookBody,
  resolvedCheckoutId?: string | null,
): Promise<void> {
  const event = body.event;
  const payment = body.payment;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !event || !payment?.id) {
    throw new Error("hub_webhook_payload_invalid");
  }
  const checkoutId = resolvedCheckoutId ??
    hubCheckoutIdFromExternalReference(payment.externalReference) ??
    "";
  if (!isUuid(checkoutId)) throw new Error("hub_checkout_reference_invalid");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const claim = await claimHubPaymentEvent(supabase, body, checkoutId);
  if (claim.duplicate) return;

  try {
    const { data: checkout, error: checkoutError } = await supabase
      .from("hub_checkout_sessions")
      .select(
        "id, account_id, requested_by, status, product_family, billing_type, amount, asaas_subscription_id, asaas_payment_id, metadata",
      )
      .eq("id", checkoutId)
      .maybeSingle();
    if (checkoutError) throw checkoutError;
    if (!checkout) throw new Error("hub_checkout_not_found");
    if (
      payment.subscription &&
      checkout.asaas_subscription_id &&
      payment.subscription !== checkout.asaas_subscription_id
    ) {
      throw new Error("hub_subscription_mismatch");
    }
    const providerSubscriptionId = checkout.asaas_subscription_id ||
      payment.subscription || null;

    if (hubPaymentEventRequiresIdentity(event)) {
      const { data: billingAccount, error: billingAccountError } =
        await supabase
          .from("hub_accounts")
          .select("asaas_customer_id")
          .eq("id", checkout.account_id)
          .maybeSingle();
      if (billingAccountError) throw billingAccountError;
      const identityMismatch = billingIdentityMismatch(
        {
          subscriptionId: checkout.asaas_subscription_id,
          customerId: billingAccount?.asaas_customer_id,
          amount: Number(checkout.amount),
          billingType: checkout.billing_type,
        },
        {
          subscriptionId: payment.subscription,
          customerId: payment.customer,
          amount: payment.value,
          billingType: payment.billingType,
        },
      );
      if (identityMismatch) {
        throw new Error(`hub_${identityMismatch.toLowerCase()}`);
      }
    }

    if (PAID_EVENTS.has(event)) {
      if (!providerSubscriptionId) {
        throw new Error("hub_provider_subscription_required_for_payment");
      }
      const initialBillingBlock = await loadHubBillingBlock(
        supabase,
        checkout.account_id,
        checkout.product_family,
      );
      if (initialBillingBlock) {
        await cancelBlockedHubBilling(
          supabase,
          checkout,
          providerSubscriptionId,
          payment.id,
          initialBillingBlock,
        );
        await finishHubPaymentEvent(supabase, claim.eventKey, "PROCESSED");
        return;
      }

      const replacedProviderSubscriptionId = replacementProviderSubscriptionId(
        checkout.metadata,
        providerSubscriptionId,
      );
      if (replacedProviderSubscriptionId && !providerSubscriptionId) {
        throw new Error("hub_replacement_provider_subscription_required");
      }
      await activateThenCancelHubReplacement(
        async () => {
          const { data: activation, error } = await supabase.rpc(
            "hub_activate_paid_checkout",
            {
              p_checkout_id: checkoutId,
              p_payment_id: payment.id,
            },
          );
          if (error) {
            const racedBillingBlock = await loadHubBillingBlock(
              supabase,
              checkout.account_id,
              checkout.product_family,
            );
            if (racedBillingBlock) {
              await cancelBlockedHubBilling(
                supabase,
                checkout,
                providerSubscriptionId,
                payment.id,
                racedBillingBlock,
              );
              return false;
            }
            throw error;
          }
          return hubActivationAllowsReplacementCancellation(activation);
        },
        replacedProviderSubscriptionId,
        async (subscriptionId) =>
          await cancelHubProviderSubscriptionForAccount(
            supabase,
            checkout.account_id,
            subscriptionId,
          ),
        async (cancelledProviderSubscriptionId) => {
          const { error: replacementError } = await supabase.rpc(
            "hub_merge_checkout_provider_state",
            {
              p_checkout_id: checkoutId,
              p_payment_id: payment.id,
              p_expected_subscription_id: providerSubscriptionId,
              p_metadata_patch: {
                replacementProviderCancellationCompletedAt: new Date()
                  .toISOString(),
                replacementProviderCancellationId:
                  cancelledProviderSubscriptionId,
              },
            },
          );
          if (replacementError) throw replacementError;
        },
      );
    } else if (HUB_REVERSAL_EVENTS.has(event)) {
      if (!providerSubscriptionId) {
        throw new Error("hub_provider_subscription_required_for_reversal");
      }
      // A local reversal without cancelling the scheduler would keep creating
      // charges for an account whose access was already revoked. Deletion is
      // idempotent (404/410 means it was already absent) and must finish first.
      await cancelHubProviderSubscriptionForAccount(
        supabase,
        checkout.account_id,
        providerSubscriptionId,
      );
      const { error } = await supabase.rpc("hub_reverse_paid_checkout", {
        p_checkout_id: checkoutId,
        p_payment_id: payment.id,
        p_event_name: event,
      });
      if (error) throw error;
    } else if (isHubRecoveryEvent(event)) {
      // Official Asaas recovery/dispute events are recorded for reconciliation
      // only. They never call the paid RPC, so they cannot grant a fresh period
      // or resurrect a provider subscription that was deliberately cancelled.
      const { error } = await supabase.rpc(
        "hub_merge_checkout_provider_state",
        {
          p_checkout_id: checkoutId,
          p_payment_id: payment.id,
          p_expected_subscription_id: providerSubscriptionId,
          p_metadata_patch: {
            providerRecoveryEvent: event,
            providerRecoveryReason: hubRecoveryReason(event),
            providerRecoveryPaymentId: payment.id,
            providerRecoveryAt: new Date().toISOString(),
            requiresManualReconciliation: true,
          },
        },
      );
      if (error) throw error;
    } else if (
      event === "PAYMENT_OVERDUE" ||
      event === "PAYMENT_REFUND_IN_PROGRESS" ||
      event === "PAYMENT_BANK_SLIP_CANCELLED"
    ) {
      const { error } = await supabase.rpc("hub_mark_checkout_overdue", {
        p_checkout_id: checkoutId,
        p_payment_id: payment.id,
      });
      if (error) throw error;
    } else {
      const { error } = await supabase.rpc(
        "hub_merge_checkout_provider_state",
        {
          p_checkout_id: checkoutId,
          p_payment_id: payment.id,
          p_expected_subscription_id: providerSubscriptionId,
          p_invoice_url: payment.invoiceUrl || null,
          p_bank_slip_url: payment.bankSlipUrl || null,
          p_allowed_statuses: ["CREATED", "PENDING", "OVERDUE", "PAID"],
          p_metadata_patch: {},
        },
      );
      if (error) throw error;
    }

    await finishHubPaymentEvent(supabase, claim.eventKey, "PROCESSED");
    if (PAID_EVENTS.has(event)) scheduleHubFulfillment(checkoutId);
  } catch (error) {
    const reason = error instanceof Error
      ? error.message
      : "hub_payment_failed";
    try {
      await finishHubPaymentEvent(supabase, claim.eventKey, "FAILED", reason);
    } catch (finishError) {
      console.error("[Webhook] Hub inbox failure could not be recorded", {
        type: finishError instanceof Error ? finishError.message : "unknown",
      });
    }
    throw error;
  }
}

class AsaasTriageError extends Error {
  constructor(
    message: string,
    readonly tenantId: string | null = null,
    readonly localEntityId: string | null = null,
  ) {
    super(message);
    this.name = "AsaasTriageError";
  }
}

function buildWebhookEnrollmentObservation(input: {
  tenantId: string;
  studentId: string;
  offerId: string | null;
  payment: AsaasWebhookPayment;
  paymentKind: EnrollmentPaymentKind;
  outcome: "SETTLED" | "UNSETTLED";
  externalReference: string;
  providerStatus: string;
  providerValue: number;
  persistedDueDate: string | null;
  localPaymentId: string;
}): EnrollmentPaymentObservation {
  const externalReference = input.externalReference.trim();
  const dueDate = String(
    input.payment.dueDate || input.persistedDueDate || "",
  ).trim();
  const billingType = String(input.payment.billingType || "").trim()
    .toUpperCase();
  const description = String(input.payment.description || "").trim();
  const providerStatus = input.providerStatus.trim();
  const providerCustomerId = input.payment.customer.trim();

  if (
    !input.payment.id.trim() || !providerCustomerId || !externalReference ||
    !providerStatus || providerStatus.length > 120 ||
    !Number.isFinite(input.providerValue) || input.providerValue <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
    !["PIX", "BOLETO", "CREDIT_CARD"].includes(billingType) ||
    !description || description.length > 500
  ) {
    throw new AsaasTriageError(
      "enrollment_observation_evidence_incomplete",
      input.tenantId,
      input.localPaymentId,
    );
  }

  return {
    tenantId: input.tenantId,
    studentId: input.studentId,
    offerId: input.offerId,
    providerPaymentId: input.payment.id.trim(),
    providerCustomerId,
    providerSubscriptionId: input.paymentKind === "PRO_RATA"
      ? null
      : String(input.payment.subscription || "").trim() || null,
    paymentKind: input.paymentKind,
    outcome: input.outcome,
    providerValue: input.providerValue,
    externalReference,
    providerStatus,
    dueDate,
    billingType: billingType as "PIX" | "BOLETO" | "CREDIT_CARD",
    description,
  };
}

async function resolveWebhookEnrollmentObservationBinding(
  supabase: SupabaseClient,
  input: {
    tenantId: string;
    studentId: string;
    providerPaymentId: string;
    externalReference: string | null;
    outcome: "SETTLED" | "UNSETTLED";
    localPaymentId: string;
  },
): Promise<EnrollmentPaymentObservationBinding | null> {
  try {
    return await resolveEnrollmentPaymentObservationBinding(supabase, input);
  } catch (error) {
    const disposition = enrollmentPaymentObservationFailureDisposition(error);
    if (disposition === "TRIAGE") {
      throw new AsaasTriageError(
        error instanceof EnrollmentPaymentObservationError
          ? error.reason
          : "enrollment_binding_rejected",
        input.tenantId,
        input.localPaymentId,
      );
    }
    if (disposition === "SUPPRESS") return null;
    throw error;
  }
}

async function applyWebhookEnrollmentObservation(
  supabase: SupabaseClient,
  input: EnrollmentPaymentObservation,
  localPaymentId: string,
): Promise<
  { applied: true; result: Record<string, unknown> } | {
    applied: false;
    reason: string;
  }
> {
  try {
    return {
      applied: true,
      result: await applyEnrollmentPaymentObservation(supabase, input),
    };
  } catch (error) {
    const disposition = enrollmentPaymentObservationFailureDisposition(error);
    if (disposition === "SUPPRESS") {
      const reason = error instanceof EnrollmentPaymentObservationError
        ? error.reason
        : "enrollment_observation_suppressed";
      console.info("[Webhook] Enrollment effects safely suppressed", {
        paymentId: input.providerPaymentId,
        reason,
      });
      return { applied: false, reason };
    }
    if (disposition === "TRIAGE") {
      throw new AsaasTriageError(
        error instanceof EnrollmentPaymentObservationError
          ? error.reason
          : "enrollment_observation_rejected",
        input.tenantId,
        localPaymentId,
      );
    }
    throw error;
  }
}

async function recordAsaasAutomationIssue(
  supabase: SupabaseClient,
  issue: {
    tenantId: string | null;
    kind: string;
    severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
    providerEntityId: string;
    localEntityId?: string | null;
    fingerprint: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.from("asaas_reconciliation_issues").insert({
    run_id: null,
    tenant_id: issue.tenantId,
    source: "WEBHOOK",
    kind: issue.kind,
    severity: issue.severity,
    provider_entity_id: issue.providerEntityId,
    local_entity_id: issue.localEntityId || null,
    fingerprint: issue.fingerprint,
    details: issue.details || {},
  });
  if (error && error.code !== "23505") throw error;
}

type ExistingStudentPayment = {
  id: string;
  status: string | null;
  provider_status: string | null;
  last_provider_event_at: string | null;
  last_provider_event_rank: number | null;
  student_id: string | null;
  tenant_id: string | null;
  provider_customer_id: string | null;
  value: number | null;
  refunded_amount: number | null;
  due_date: string | null;
  asaas_payment_id: string | null;
  asaas_id: string | null;
};

async function loadExistingStudentPaymentByProviderId(
  supabase: SupabaseClient,
  providerPaymentId: string,
): Promise<ExistingStudentPayment | null> {
  const columns =
    "id,status,provider_status,last_provider_event_at,last_provider_event_rank,student_id,tenant_id,provider_customer_id,value,refunded_amount,due_date,asaas_payment_id,asaas_id";
  const [canonicalResult, legacyResult] = await Promise.all([
    supabase.from("student_payments").select(columns)
      .eq("asaas_payment_id", providerPaymentId).limit(2),
    supabase.from("student_payments").select(columns)
      .eq("asaas_id", providerPaymentId).limit(2),
  ]);
  if (canonicalResult.error) throw canonicalResult.error;
  if (legacyResult.error) throw legacyResult.error;

  const matches = new Map<string, ExistingStudentPayment>();
  for (
    const row of [...(canonicalResult.data || []), ...(legacyResult.data || [])]
  ) {
    matches.set(String(row.id), row as ExistingStudentPayment);
  }
  if (matches.size > 1) {
    throw new AsaasTriageError("student_payment_provider_alias_ambiguous");
  }
  const payment = matches.values().next().value as
    | ExistingStudentPayment
    | undefined;
  if (!payment) return null;

  const canonical = String(payment.asaas_payment_id || "").trim();
  const legacy = String(payment.asaas_id || "").trim();
  if (
    (canonical && canonical !== providerPaymentId) ||
    (legacy && legacy !== providerPaymentId) ||
    (canonical && legacy && canonical !== legacy)
  ) {
    throw new AsaasTriageError(
      "student_payment_provider_alias_divergent",
      payment.tenant_id,
      payment.id,
    );
  }
  return payment;
}

// Processa uma cobrança escolar já persistida na inbox durável. Falhas
// transitórias são relançadas para lease/retry; inconsistências de identidade
// viram AsaasTriageError e nunca criam/adotam registros financeiros.
async function processarPagamento(body: AsaasWebhookBody): Promise<void> {
  try {
    const { event, payment } = body;

    if (
      !event ||
      !payment ||
      typeof payment.id !== "string" ||
      !payment.id.trim() ||
      typeof payment.customer !== "string" ||
      !payment.customer.trim()
    ) {
      throw new AsaasTriageError("payment_payload_missing");
    }

    console.log("[Webhook] Payment event received", {
      event,
      status: payment.status,
    });

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    if (await processSaasCheckoutEvent(supabase, body)) {
      return;
    }

    // Keep a single Hub billing implementation even if this background
    // dispatcher is called directly by a future entrypoint.
    if (payment.externalReference?.startsWith("hub:")) {
      await processHubPaymentEvent(body);
      return;
    }

    // Load the immutable local binding before applying operational gates. A
    // proven refund may arrive after offboarding/suspension and must still
    // correct the historical cash ledger, but it may never create or adopt a
    // local payment through this exceptional path.
    const existingPayment = await loadExistingStudentPaymentByProviderId(
      supabase,
      payment.id,
    );
    const eventAt = asaasDateToIso(body.dateCreated);
    if (!eventAt) {
      throw new AsaasTriageError(
        "provider_event_timestamp_missing",
        existingPayment?.tenant_id || null,
        existingPayment?.id || null,
      );
    }
    const eventRank = providerEventRank(event);
    const providerStatus = String(
      payment.status || event.replace(/^PAYMENT_/, ""),
    );
    const historicalReversalAmount = completedRefundAmount(
      {
        ...payment,
        value: existingPayment?.value ?? payment.value,
      },
      event,
    );
    // Explicit reversal events and any snapshot carrying completed refund
    // evidence take the update-only path. This includes PAYMENT_UPDATED with a
    // DONE refund and prevents it from recreating a missing payment.
    const isHistoricalReversal = isProvenHistoricalReversalEvent(event) ||
      historicalReversalAmount > 0;

    if (isHistoricalReversal && !existingPayment) {
      throw new AsaasTriageError("historical_reversal_payment_missing");
    }

    let studentId: string | null = null;
    let studentTenantId: string | null = null;
    let canonicalPaymentReference: string | null = null;
    let persistedPayment: { id: string; due_date: string | null } | null = null;
    let previousLocalStatus: string | null = existingPayment?.status || null;
    let creditedAt: string | null = null;
    let estimatedCreditAt: string | null = null;
    let inactiveSettlementUpdateOnly = false;
    const refundedAmount = historicalReversalAmount;
    const paymentValue = Number(
      isHistoricalReversal ? existingPayment?.value : payment.value,
    );

    if (
      !isHistoricalReversal && isSettledPaymentEvent(event) && existingPayment
    ) {
      const localStudentId = String(existingPayment.student_id || "").trim();
      const localTenantId = String(existingPayment.tenant_id || "").trim();
      let localCustomerId = String(
        existingPayment.provider_customer_id || "",
      ).trim();
      // Cobranças legadas podiam existir antes de provider_customer_id passar
      // a ser capturado no INSERT. Adoção ampla pelo perfil seria insegura;
      // esta RPC aceita somente o evento autenticado já persistido na inbox,
      // com pagamento, cliente, valor, vencimento, assinatura e oferta
      // corroborados exatamente. Depois do primeiro vínculo, o trigger o torna
      // imutável como em qualquer cobrança nova.
      if (
        localStudentId && localTenantId && !localCustomerId &&
        typeof body.id === "string" && body.id.trim()
      ) {
        const { data: legacyBinding, error: legacyBindingError } =
          await supabase
            .rpc("bind_legacy_student_payment_from_webhook", {
              p_provider_event_id: body.id.trim(),
              p_expected_local_payment_id: existingPayment.id,
              p_expected_student_id: localStudentId,
              p_expected_tenant_id: localTenantId,
              p_expected_provider_customer_id: payment.customer.trim(),
              p_payload: body,
            });
        if (!legacyBindingError && legacyBinding?.ok === true) {
          localCustomerId = payment.customer.trim();
          existingPayment.provider_customer_id = localCustomerId;
        }
      }
      if (!localStudentId || !localTenantId || !localCustomerId) {
        throw new AsaasTriageError(
          "inactive_settlement_local_binding_incomplete",
          localTenantId || null,
          existingPayment.id,
        );
      }
      if (
        !paymentCustomerMatchesCanonicalBinding(
          localCustomerId,
          payment.customer,
        )
      ) {
        throw new AsaasTriageError(
          "inactive_settlement_customer_mismatch",
          localTenantId,
          existingPayment.id,
        );
      }
      const referencedStudentId = studentIdFromKnownPaymentReference(
        payment.externalReference,
      );
      if (referencedStudentId && referencedStudentId !== localStudentId) {
        throw new AsaasTriageError(
          "inactive_settlement_reference_mismatch",
          localTenantId,
          existingPayment.id,
        );
      }
      const [profileResult, membershipsResult] = await Promise.all([
        supabase.from("profiles")
          .select("id,tenant_id,role,lifecycle_status")
          .eq("id", localStudentId)
          .maybeSingle(),
        supabase.from("tenant_memberships")
          .select("tenant_id,role,status")
          .eq("user_id", localStudentId)
          .limit(2),
      ]);
      if (profileResult.error) throw profileResult.error;
      if (membershipsResult.error) throw membershipsResult.error;
      const currentProfile = profileResult.data;
      if (
        currentProfile &&
        (currentProfile.tenant_id !== localTenantId ||
          currentProfile.role !== "STUDENT")
      ) {
        throw new AsaasTriageError(
          "inactive_settlement_profile_scope_mismatch",
          localTenantId,
          existingPayment.id,
        );
      }
      const memberships = Array.isArray(membershipsResult.data)
        ? membershipsResult.data
        : [];
      const exclusivelyActive = memberships.length === 1 &&
        memberships[0].tenant_id === localTenantId &&
        memberships[0].role === "STUDENT" &&
        memberships[0].status === "ACTIVE";
      inactiveSettlementUpdateOnly = !currentProfile ||
        String(currentProfile.lifecycle_status || "").trim().toLowerCase() !==
          "active" ||
        !exclusivelyActive;
    }

    if (isHistoricalReversal) {
      studentId = existingPayment!.student_id;
      studentTenantId = existingPayment!.tenant_id;
      const providerCustomerId = existingPayment!.provider_customer_id;
      if (!studentId || !studentTenantId || !providerCustomerId) {
        throw new AsaasTriageError(
          "historical_reversal_local_binding_incomplete",
          studentTenantId,
          existingPayment!.id,
        );
      }
      if (
        !paymentCustomerMatchesCanonicalBinding(
          providerCustomerId,
          payment.customer,
        )
      ) {
        throw new AsaasTriageError(
          "historical_reversal_customer_mismatch",
          studentTenantId,
          existingPayment!.id,
        );
      }
      const referencedStudentId = studentIdFromKnownPaymentReference(
        payment.externalReference,
      );
      if (referencedStudentId && referencedStudentId !== studentId) {
        throw new AsaasTriageError(
          "historical_reversal_reference_mismatch",
          studentTenantId,
          existingPayment!.id,
        );
      }
      if (refundedAmount <= 0) {
        throw new AsaasTriageError(
          "historical_reversal_amount_unproven",
          studentTenantId,
          existingPayment!.id,
        );
      }
      if (typeof body.id !== "string" || !body.id.trim()) {
        throw new AsaasTriageError(
          "historical_reversal_event_id_missing",
          studentTenantId,
          existingPayment!.id,
        );
      }

      // This authorization returns no API endpoint or credential. A historical
      // correction therefore cannot accidentally issue a provider GET after
      // the connection was disabled or its credentials were offboarded.
      await authorizeAsaasHistoricalReversal(supabase, studentTenantId);

      if (!shouldApplyProviderEvent(existingPayment, eventAt, eventRank)) {
        console.info("[Webhook] Older historical reversal ignored", {
          event,
          paymentId: payment.id,
        });
        return;
      }

      const { data: reversalResult, error: reversalError } = await supabase.rpc(
        "apply_historical_asaas_payment_reversal",
        {
          p_provider_payment_id: payment.id,
          p_expected_local_payment_id: existingPayment!.id,
          p_expected_student_id: studentId,
          p_expected_tenant_id: studentTenantId,
          p_expected_provider_customer_id: providerCustomerId,
          p_event_id: body.id,
          p_event_name: event,
          p_event_created_at: eventAt,
          p_event_rank: eventRank,
          p_provider_status: providerStatus,
          p_refunded_amount: refundedAmount,
          p_payload: body,
        },
      );
      if (reversalError) {
        if (["22023", "23514"].includes(String(reversalError.code))) {
          throw new AsaasTriageError(
            "historical_reversal_database_rejected",
            studentTenantId,
            existingPayment!.id,
          );
        }
        throw reversalError;
      }
      if (reversalResult?.ok !== true) {
        if (
          reversalResult?.reason === "payment_confirmation_delivery_in_flight"
        ) {
          throw new Error("payment_confirmation_delivery_in_flight");
        }
        throw new AsaasTriageError(
          String(reversalResult?.reason || "historical_reversal_not_applied"),
          studentTenantId,
          existingPayment!.id,
        );
      }
      if (reversalResult.action === "IGNORED") return;
      if (typeof reversalResult.id !== "string" || !reversalResult.id) {
        throw new Error("historical_reversal_result_invalid");
      }
      persistedPayment = {
        id: reversalResult.id,
        due_date: reversalResult.due_date || existingPayment!.due_date || null,
      };
    } else if (inactiveSettlementUpdateOnly) {
      studentId = existingPayment!.student_id;
      studentTenantId = existingPayment!.tenant_id;
      const providerCustomerId = String(
        existingPayment!.provider_customer_id || "",
      ).trim();
      const providerValue = Number(payment.value);
      const paymentDate = String(payment.paymentDate || "").trim();
      if (
        !studentId || !studentTenantId || !providerCustomerId ||
        !Number.isFinite(providerValue) || providerValue <= 0 ||
        typeof body.id !== "string" || !body.id.trim() ||
        (paymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) ||
        (event === "PAYMENT_RECEIVED_IN_CASH" && !paymentDate)
      ) {
        throw new AsaasTriageError(
          "inactive_settlement_evidence_incomplete",
          studentTenantId,
          existingPayment!.id,
        );
      }
      await resolveAsaasIntegration(supabase, studentTenantId, "payment.event");
      if (!shouldApplyProviderEvent(existingPayment, eventAt, eventRank)) {
        console.info("[Webhook] Older inactive settlement ignored", {
          event,
          paymentId: payment.id,
        });
        return;
      }
      creditedAt = actualCreditAt(event, payment);
      estimatedCreditAt = asaasDateToIso(payment.estimatedCreditDate);
      const { data: settlementResult, error: settlementError } = await supabase
        .rpc("apply_inactive_student_payment_settlement", {
          p_provider_payment_id: payment.id,
          p_expected_local_payment_id: existingPayment!.id,
          p_expected_student_id: studentId,
          p_expected_tenant_id: studentTenantId,
          p_expected_provider_customer_id: providerCustomerId,
          p_event_id: body.id,
          p_event_name: event,
          p_event_created_at: eventAt,
          p_event_rank: eventRank,
          p_provider_status: providerStatus,
          p_provider_value: providerValue,
          p_payment_date: paymentDate || null,
          p_credited_at: creditedAt,
          p_estimated_credit_at: estimatedCreditAt,
          p_payload: body,
        });
      if (settlementError) {
        if (["22023", "23514"].includes(String(settlementError.code))) {
          throw new AsaasTriageError(
            "inactive_settlement_database_rejected",
            studentTenantId,
            existingPayment!.id,
          );
        }
        throw settlementError;
      }
      if (settlementResult?.ok !== true) {
        throw new AsaasTriageError(
          String(settlementResult?.reason || "inactive_settlement_not_applied"),
          studentTenantId,
          existingPayment!.id,
        );
      }
      if (settlementResult.action === "IGNORED") return;
      persistedPayment = {
        id: settlementResult.id,
        due_date: settlementResult.due_date || existingPayment!.due_date ||
          null,
      };
    } else {
      // Normal provider events still require the current canonical profile and
      // membership. A pre-persisted enrollment payment may use an offer-scoped
      // reference, so resolve it only through its immutable local payment plus
      // the exact owned offer. The Asaas customer remains mandatory proof.
      const existingStudentId = String(existingPayment?.student_id || "")
        .trim();
      const offerScopedEnrollmentReference = parseCanonicalAsaasReference(
        payment.externalReference,
        existingStudentId || "__offer_scoped_enrollment_reference__",
        "payment",
      );
      const externalStudentId = studentIdFromKnownPaymentReference(
        payment.externalReference,
      );
      const studentScopedDirectMatch = String(payment.externalReference || "")
        .trim().match(
          /^student:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(one-time|pro-rata)$/i,
        );
      if (
        offerScopedEnrollmentReference?.kind === "ENROLLMENT" &&
        ["fee", "one-time", "pro-rata"].includes(
          offerScopedEnrollmentReference.purpose,
        )
      ) {
        const { data: enrollmentOffer, error: enrollmentOfferError } =
          await supabase.from("offers")
            .select("id,tenant_id,kind,processing_by,consumed_by")
            .eq("id", offerScopedEnrollmentReference.offerId)
            .eq("kind", "ENROLLMENT")
            .maybeSingle();
        if (enrollmentOfferError) throw enrollmentOfferError;
        const offerStudents = new Set(
          [enrollmentOffer?.processing_by, enrollmentOffer?.consumed_by]
            .map((value) => String(value || "").trim())
            .filter((value) => isUuid(value)),
        );
        if (
          !enrollmentOffer || !enrollmentOffer.tenant_id ||
          offerStudents.size !== 1
        ) {
          throw new AsaasTriageError(
            "enrollment_payment_offer_binding_mismatch",
            enrollmentOffer?.tenant_id || existingPayment?.tenant_id || null,
            existingPayment?.id || enrollmentOffer?.id || null,
          );
        }
        const offerStudentId = [...offerStudents][0];
        if (
          offerScopedEnrollmentReference.purpose === "pro-rata" &&
          (!existingPayment || existingPayment.student_id !== offerStudentId ||
            existingPayment.tenant_id !== enrollmentOffer.tenant_id ||
            !paymentCustomerMatchesCanonicalBinding(
              existingPayment.provider_customer_id,
              payment.customer,
            ))
        ) {
          throw new AsaasTriageError(
            "enrollment_pro_rata_payment_binding_mismatch",
            enrollmentOffer.tenant_id,
            existingPayment?.id || enrollmentOffer.id,
          );
        }
        const { data: enrollmentProfile, error: enrollmentProfileError } =
          await supabase.from("profiles")
            .select("id,tenant_id,role,asaas_customer_id")
            .eq("id", offerStudentId)
            .eq("tenant_id", enrollmentOffer.tenant_id)
            .eq("role", "STUDENT")
            .maybeSingle();
        if (enrollmentProfileError) throw enrollmentProfileError;
        if (
          !enrollmentProfile?.asaas_customer_id ||
          !paymentCustomerMatchesCanonicalBinding(
            enrollmentProfile.asaas_customer_id,
            payment.customer,
          )
        ) {
          throw new AsaasTriageError(
            "enrollment_payment_customer_mismatch",
            enrollmentOffer.tenant_id,
            existingPayment?.id || enrollmentOffer.id,
          );
        }
        studentId = offerStudentId;
        studentTenantId = enrollmentOffer.tenant_id;
        canonicalPaymentReference = String(payment.externalReference || "")
          .trim();
      } else if (studentScopedDirectMatch) {
        const referencedStudent = studentScopedDirectMatch[1].toLowerCase();
        if (
          !existingPayment ||
          existingPayment.student_id !== referencedStudent ||
          !existingPayment.tenant_id ||
          !paymentCustomerMatchesCanonicalBinding(
            existingPayment.provider_customer_id,
            payment.customer,
          )
        ) {
          throw new AsaasTriageError(
            "student_direct_payment_binding_mismatch",
            existingPayment?.tenant_id || null,
            existingPayment?.id || null,
          );
        }
        const { data: directProfile, error: directProfileError } =
          await supabase
            .from("profiles")
            .select("id,tenant_id,role,asaas_customer_id")
            .eq("id", referencedStudent)
            .eq("tenant_id", existingPayment.tenant_id)
            .eq("role", "STUDENT")
            .maybeSingle();
        if (directProfileError) throw directProfileError;
        if (
          !directProfile?.asaas_customer_id ||
          !paymentCustomerMatchesCanonicalBinding(
            directProfile.asaas_customer_id,
            payment.customer,
          )
        ) {
          throw new AsaasTriageError(
            "student_direct_payment_profile_mismatch",
            existingPayment.tenant_id,
            existingPayment.id,
          );
        }
        studentId = referencedStudent;
        studentTenantId = existingPayment.tenant_id;
        canonicalPaymentReference = String(payment.externalReference).trim();
      } else if (externalStudentId) {
        const { data: referenced, error: referencedError } = await supabase
          .from("profiles")
          .select("id,tenant_id,role,asaas_customer_id")
          .eq("id", externalStudentId)
          .maybeSingle();
        if (referencedError) throw referencedError;
        if (
          !referenced ||
          referenced.role !== "STUDENT" ||
          !referenced.tenant_id ||
          !referenced.asaas_customer_id ||
          !paymentCustomerMatchesCanonicalBinding(
            referenced.asaas_customer_id,
            payment.customer,
          )
        ) {
          throw new AsaasTriageError(
            "external_reference_customer_mismatch",
            referenced?.tenant_id || null,
            referenced?.id || externalStudentId,
          );
        }
        studentId = referenced.id;
        studentTenantId = referenced.tenant_id;
        canonicalPaymentReference = String(payment.externalReference || "")
          .trim();
      } else {
        // A customer id alone is not proof that an out-of-band payment belongs
        // to this ledger. A provider-generated recurring charge may omit our
        // directly parseable student reference, so adopt it only through the
        // exact local subscription plus an authoritative GET of its parent.
        const providerSubscriptionId = String(payment.subscription || "")
          .trim();
        if (!providerSubscriptionId) {
          throw new AsaasTriageError("unbound_provider_payment_origin");
        }
        const { data: candidates, error: subscriptionLookupError } =
          await supabase
            .from("profiles")
            .select(
              "id,tenant_id,role,asaas_customer_id,subscription_id",
            )
            .eq("subscription_id", providerSubscriptionId)
            .eq("asaas_customer_id", payment.customer)
            .eq("role", "STUDENT")
            .limit(2);
        if (subscriptionLookupError) throw subscriptionLookupError;
        if (candidates?.length !== 1 || !candidates[0].tenant_id) {
          throw new AsaasTriageError(
            candidates?.length && candidates.length > 1
              ? "ambiguous_subscription_binding"
              : "subscription_binding_unresolved",
          );
        }
        const subscriptionProfile = candidates[0];
        const subscriptionIntegration = await resolveAsaasIntegration(
          supabase,
          subscriptionProfile.tenant_id,
          "subscription.read",
        );
        let parentResponse: Response;
        try {
          parentResponse = await fetch(
            `${subscriptionIntegration.baseUrl}/subscriptions/${
              encodeURIComponent(providerSubscriptionId)
            }`,
            {
              method: "GET",
              headers: { access_token: subscriptionIntegration.apiKey },
              signal: AbortSignal.timeout(12_000),
            },
          );
        } catch {
          throw new AsaasTriageError(
            "provider_subscription_identity_lookup_unavailable",
            subscriptionProfile.tenant_id,
            subscriptionProfile.id,
          );
        }
        if (!parentResponse.ok) {
          throw new AsaasTriageError(
            parentResponse.status === 404
              ? "provider_subscription_identity_not_found"
              : "provider_subscription_identity_lookup_unavailable",
            subscriptionProfile.tenant_id,
            subscriptionProfile.id,
          );
        }
        const parentSubscription = await parentResponse.json().catch(() =>
          null
        ) as Record<string, unknown> | null;
        const parentReference = String(
          parentSubscription?.externalReference || "",
        ).trim();
        const canonicalReference = parseCanonicalAsaasReference(
          parentReference,
          subscriptionProfile.id,
          "subscription",
        );
        if (
          !providerGeneratedSubscriptionPaymentMatches(
            payment,
            parentSubscription,
            {
              studentId: subscriptionProfile.id,
              customerId: String(subscriptionProfile.asaas_customer_id || "")
                .trim(),
              subscriptionId: providerSubscriptionId,
            },
          ) || !canonicalReference
        ) {
          throw new AsaasTriageError(
            "provider_subscription_identity_mismatch",
            subscriptionProfile.tenant_id,
            subscriptionProfile.id,
          );
        }
        if (canonicalReference.kind === "ENROLLMENT") {
          const { data: enrollmentOffer, error: enrollmentOfferError } =
            await supabase.from("offers")
              .select("id,tenant_id,kind,processing_by,consumed_by")
              .eq("id", canonicalReference.offerId)
              .eq("tenant_id", subscriptionProfile.tenant_id)
              .eq("kind", "ENROLLMENT")
              .maybeSingle();
          if (enrollmentOfferError) throw enrollmentOfferError;
          if (
            !enrollmentOffer ||
            ![enrollmentOffer.processing_by, enrollmentOffer.consumed_by]
              .includes(subscriptionProfile.id)
          ) {
            throw new AsaasTriageError(
              "provider_subscription_enrollment_mismatch",
              subscriptionProfile.tenant_id,
              subscriptionProfile.id,
            );
          }
        }
        studentId = subscriptionProfile.id;
        studentTenantId = subscriptionProfile.tenant_id;
        canonicalPaymentReference = parentReference;
      }

      if (!studentId || !studentTenantId || !canonicalPaymentReference) {
        throw new AsaasTriageError("student_or_tenant_unresolved");
      }

      await resolveAsaasIntegration(
        supabase,
        studentTenantId,
        "payment.event",
      );

      if (
        existingPayment?.student_id &&
        existingPayment.student_id !== studentId
      ) {
        throw new AsaasTriageError(
          "existing_payment_student_mismatch",
          existingPayment.tenant_id || studentTenantId,
          existingPayment.id,
        );
      }
      if (
        existingPayment?.tenant_id &&
        existingPayment.tenant_id !== studentTenantId
      ) {
        throw new AsaasTriageError(
          "existing_payment_tenant_mismatch",
          existingPayment.tenant_id,
          existingPayment.id,
        );
      }
      if (
        existingPayment?.provider_customer_id &&
        !paymentCustomerMatchesCanonicalBinding(
          existingPayment.provider_customer_id,
          payment.customer,
        )
      ) {
        throw new AsaasTriageError(
          "existing_payment_customer_mismatch",
          existingPayment.tenant_id || studentTenantId,
          existingPayment.id,
        );
      }
      if (!shouldApplyProviderEvent(existingPayment, eventAt, eventRank)) {
        console.info("[Webhook] Older provider event ignored", {
          event,
          paymentId: payment.id,
        });
        return;
      }

      creditedAt = actualCreditAt(event, payment);
      estimatedCreditAt = asaasDateToIso(payment.estimatedCreditDate);
      const dueDate = String(payment.dueDate || "").trim();
      const paymentDate = String(payment.paymentDate || "").trim();
      if (
        typeof body.id !== "string" || !body.id.trim() ||
        !Number.isFinite(paymentValue) || paymentValue <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
        (paymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate))
      ) {
        throw new AsaasTriageError(
          "active_payment_event_evidence_incomplete",
          studentTenantId,
          existingPayment?.id || studentId,
        );
      }
      const { data: activePaymentResult, error: activePaymentError } =
        await supabase.rpc("apply_active_student_payment_event", {
          p_provider_payment_id: payment.id,
          p_expected_local_payment_id: existingPayment?.id || null,
          p_expected_student_id: studentId,
          p_expected_tenant_id: studentTenantId,
          p_expected_provider_customer_id: payment.customer.trim(),
          p_expected_provider_subscription_id:
            String(payment.subscription || "").trim() || null,
          p_canonical_reference: canonicalPaymentReference,
          p_event_id: body.id.trim(),
          p_event_name: event,
          p_event_created_at: eventAt,
          p_event_rank: eventRank,
          p_provider_status: providerStatus,
          p_provider_value: paymentValue,
          p_due_date: dueDate,
          p_payment_date: paymentDate || null,
          p_billing_type: String(payment.billingType || "").trim() || null,
          p_invoice_url: String(
            payment.bankSlipUrl || payment.invoiceUrl || "",
          ).trim() || null,
          p_description: String(payment.description || "Mensalidade").trim(),
          p_payment_type: classifyStudentPaymentType(
            payment.description,
            payment.externalReference,
          ),
          p_credited_at: creditedAt,
          p_estimated_credit_at: estimatedCreditAt,
          p_payload: body,
        });
      if (activePaymentError) {
        if (["22023", "23514"].includes(String(activePaymentError.code))) {
          throw new AsaasTriageError(
            "active_payment_event_database_rejected",
            studentTenantId,
            existingPayment?.id || studentId,
          );
        }
        throw activePaymentError;
      }
      if (activePaymentResult?.ok !== true) {
        throw new AsaasTriageError(
          String(
            activePaymentResult?.reason || "active_payment_event_not_applied",
          ),
          studentTenantId,
          existingPayment?.id || studentId,
        );
      }
      if (activePaymentResult.action === "IGNORED") return;
      if (
        typeof activePaymentResult.id !== "string" ||
        !activePaymentResult.id
      ) {
        throw new Error("active_payment_event_result_invalid");
      }
      previousLocalStatus = typeof activePaymentResult.previous_status ===
          "string"
        ? activePaymentResult.previous_status
        : null;
      inactiveSettlementUpdateOnly =
        activePaymentResult.inactive_update_only === true;
      persistedPayment = {
        id: activePaymentResult.id,
        due_date: activePaymentResult.due_date || dueDate,
      };
    }

    if (!studentId || !studentTenantId || !persistedPayment) {
      throw new Error("student_payment_processing_state_invalid");
    }

    if (event === "PAYMENT_RECEIVED" && !creditedAt) {
      await recordAsaasAutomationIssue(supabase, {
        tenantId: studentTenantId,
        kind: "CREDIT_DATE_MISSING",
        severity: payment.billingType === "CREDIT_CARD" ? "HIGH" : "WARNING",
        providerEntityId: payment.id,
        localEntityId: persistedPayment.id,
        fingerprint: `credit-date-missing:${payment.id}`,
        details: {
          billingType: payment.billingType || null,
          paymentDate: payment.paymentDate || null,
          estimatedCreditDate: payment.estimatedCreditDate || null,
        },
      });
    }

    const reviewReason = financialReviewReason(
      event,
      previousLocalStatus,
      refundedAmount,
    );
    if (reviewReason) {
      await recordAsaasAutomationIssue(supabase, {
        tenantId: studentTenantId,
        kind: "NON_FINAL_FINANCIAL_EVENT",
        severity: event === "PAYMENT_DELETED" ? "CRITICAL" : "HIGH",
        providerEntityId: payment.id,
        localEntityId: persistedPayment.id,
        fingerprint: `non-final:${event}:${payment.id}`,
        details: {
          reason: reviewReason,
          providerStatus,
          localStatusPreserved: previousLocalStatus,
          refundedAmount,
        },
      });
      throw new AsaasTriageError(
        reviewReason,
        studentTenantId,
        persistedPayment.id,
      );
    }

    const settledPayment = isSettledPaymentEvent(event);
    const fullyRefunded = event === "PAYMENT_REFUNDED" ||
      (Number.isFinite(paymentValue) &&
        paymentValue > 0 &&
        refundedAmount >= paymentValue);
    const enrollmentPaymentUnsettled = fullyRefunded ||
      event === "PAYMENT_RECEIVED_IN_CASH_UNDONE";

    // A student's access is derived atomically from the newest matured
    // competence. Never let arrival order between different charges decide
    // whether the student is ACTIVE or OVERDUE.
    if (
      settledPayment || event === "PAYMENT_OVERDUE" ||
      enrollmentPaymentUnsettled
    ) {
      const { data: financialStatus, error: financialStatusError } =
        await supabase.rpc("recompute_student_financial_status", {
          p_tenant_id: studentTenantId,
          p_student_id: studentId,
        });
      if (financialStatusError) throw financialStatusError;
      if (financialStatus?.ok !== true) {
        throw new Error("student_financial_status_recompute_failed");
      }
    }

    if (inactiveSettlementUpdateOnly) {
      console.log("[Webhook] Inactive student settlement applied update-only", {
        paymentId: payment.id,
      });
      return;
    }

    if (settledPayment || enrollmentPaymentUnsettled) {
      const profileQuery = supabase
        .from("profiles")
        .select(
          "role,tenant_id,phone,full_name,guardian_id,guardian_name,guardian_cpf,guardian_phone,enrollment_payment_id,subscription_id,is_test_account",
        )
        .eq("id", studentId)
        .eq("tenant_id", studentTenantId)
        .eq("role", "STUDENT");
      const { data: profileData, error: profileFetchErr } = await profileQuery
        .maybeSingle();
      if (profileFetchErr) throw profileFetchErr;
      if (!profileData) {
        // The ledger correction is already complete. Profile-dependent
        // enrollment and communication effects must not be retried/reactivated
        // when offboarding finalized immediately after the financial write.
        await recordAsaasAutomationIssue(supabase, {
          tenantId: studentTenantId,
          kind: isHistoricalReversal
            ? "HISTORICAL_REVERSAL_PROFILE_MISSING"
            : "ENROLLMENT_OBSERVATION_PROFILE_MISSING",
          severity: "HIGH",
          providerEntityId: payment.id,
          localEntityId: persistedPayment.id,
          fingerprint: `enrollment-observation-profile-missing:${payment.id}`,
          details: {
            event,
            ledgerCorrectionApplied: true,
          },
        });
        return;
      }

      const observationOutcome = settledPayment ? "SETTLED" : "UNSETTLED";
      const observationBinding =
        await resolveWebhookEnrollmentObservationBinding(supabase, {
          tenantId: studentTenantId,
          studentId,
          providerPaymentId: payment.id,
          externalReference: canonicalPaymentReference ||
            String(payment.externalReference || "").trim() || null,
          outcome: observationOutcome,
          localPaymentId: persistedPayment.id,
        });
      if (observationBinding) {
        const observation = await applyWebhookEnrollmentObservation(
          supabase,
          buildWebhookEnrollmentObservation({
            tenantId: studentTenantId,
            studentId,
            offerId: observationBinding.offerId,
            payment,
            paymentKind: observationBinding.paymentKind,
            outcome: observationOutcome,
            externalReference: observationBinding.externalReference,
            providerStatus,
            providerValue: paymentValue,
            persistedDueDate: persistedPayment.due_date,
            localPaymentId: persistedPayment.id,
          }),
          persistedPayment.id,
        );
        if (!observation.applied) {
          // A newer financial event or lifecycle transition won. The ledger
          // remains durable, while enrollment and communication are omitted.
          return;
        }
        console.log("[Webhook] Enrollment observation applied", {
          paymentId: payment.id,
          paymentKind: observationBinding.paymentKind,
          action: observation.result.action || null,
        });
      }

      if (settledPayment) {
        console.log(`[Webhook] Processing settled payment: ${event}`);

        const hasFinancialGuardian = Boolean(
          profileData.guardian_id || profileData.guardian_cpf,
        );
        const financialPhone = hasFinancialGuardian
          ? profileData.guardian_phone
          : profileData.phone;
        const financialName = hasFinancialGuardian
          ? profileData.guardian_name
          : profileData.full_name;

        // Confirmation delivery is durable and idempotent. It is enqueued on
        // every inbox retry, but only after provider settlement (never merely
        // PAYMENT_CONFIRMED).
        if (
          profileData.is_test_account !== true &&
          financialPhone
        ) {
          // The durable outbound claim, not the in-memory "already paid"
          // snapshot, is the delivery idempotency key. This also repairs an
          // exact inbox replay after a crash between the financial write and
          // creation of the communication claim.
          await deliverMetaPurchaseOnce({
            admin: supabase,
            tenantId: studentTenantId,
            studentId,
            localPaymentId: persistedPayment.id,
            phone: financialPhone,
            value: Number(payment.value) || undefined,
          });
          const payerName =
            safeCommunicationText(financialName?.split(" ")[0], 80) ||
            "Responsável";
          const valorFormatado = payment.value
            ? `R$ ${Number(payment.value).toFixed(2).replace(".", ",")}`
            : "";
          const confirmationMessage = `✅ *Pagamento confirmado${
            valorFormatado ? `, ${valorFormatado}` : ""
          }!*\nObrigado, ${payerName}. O acesso do aluno segue ativo.`;
          const classDate = String(
            persistedPayment.due_date ||
              payment.dueDate ||
              payment.paymentDate ||
              eventAt.slice(0, 10),
          ).slice(0, 10);
          const { error: queueError } = await supabase
            .from("notification_queue")
            .insert({
              tenant_id: studentTenantId,
              teacher_id: null,
              student_id: studentId,
              student_name: financialName || profileData.full_name,
              student_phone: financialPhone,
              message_body: confirmationMessage,
              scheduled_for: new Date().toISOString(),
              status: "pending",
              attempts: 0,
              source_id: persistedPayment.id,
              source_type: "ASAAS_PAYMENT",
              class_date: classDate,
              notification_kind: "PAYMENT_CONFIRMED",
            });
          if (queueError && queueError.code !== "23505") throw queueError;
        }
      }

      // Ledger movements remain exclusively database-triggered from the
      // persisted student_payment snapshot.
    } else if (event === "PAYMENT_OVERDUE") {
      console.log(
        "[Webhook] Current financial state recomputed after overdue.",
      );
    } else {
      console.log(`[Webhook] Provider snapshot applied: ${event}`);
    }
  } catch (err: unknown) {
    console.error("[Webhook] Durable payment processing failed", {
      type: err instanceof Error ? err.name : "UnknownError",
    });
    throw err;
  }
}

type DurableInboxClaim = {
  provider_event_id: string;
  event_name: string;
  provider_entity_id: string;
  payload: AsaasWebhookBody;
  attempt_count: number;
};

async function dispatchPersistedAsaasEvent(
  body: AsaasWebhookBody,
): Promise<void> {
  const paymentReference = body.payment?.externalReference ?? "";
  if (
    paymentReference.startsWith("wolfie-topup-order:") ||
    paymentReference.startsWith("topup:")
  ) {
    await processWolfieTopupEvent(body);
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("asaas_webhook_database_unavailable");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const saasReference = body.payment?.externalReference ||
    body.subscription?.externalReference ||
    "";
  const saasCheckoutId = await resolveSaasCheckoutId(body);
  if (saasReference.startsWith("saas:") || saasCheckoutId) {
    if (!saasCheckoutId) {
      throw new AsaasTriageError("saas_checkout_unresolved");
    }
    await processSaasCheckoutEvent(supabase, body, saasCheckoutId);
    return;
  }

  const hubCheckoutId = await resolveHubCheckoutId(body);
  if (paymentReference.startsWith("hub:") || hubCheckoutId) {
    if (!hubCheckoutId) {
      throw new AsaasTriageError("hub_checkout_unresolved");
    }
    await processHubPaymentEvent(body, hubCheckoutId);
    return;
  }

  if (!body.payment) {
    throw new AsaasTriageError("unsupported_unrouted_asaas_event");
  }
  await processarPagamento(body);
}

async function drainAsaasWebhookInbox(maxEvents = 25): Promise<{
  processed: number;
  retried: number;
  triaged: number;
}> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("asaas_webhook_database_unavailable");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const workerToken = crypto.randomUUID();
  const stats = { processed: 0, retried: 0, triaged: 0 };

  try {
    for (
      let index = 0;
      index < Math.max(1, Math.min(maxEvents, 100));
      index++
    ) {
      const { data, error } = await supabase.rpc(
        "claim_next_asaas_webhook_event",
        { p_worker_token: workerToken, p_lease_seconds: 240 },
      );
      if (error) throw error;
      const claim = data as DurableInboxClaim | null;
      if (!claim?.provider_event_id) break;

      try {
        await dispatchPersistedAsaasEvent(claim.payload);
        const finished = await supabase.rpc("finish_asaas_webhook_event", {
          p_event_id: claim.provider_event_id,
          p_worker_token: workerToken,
          p_outcome: "PROCESSED",
          p_error: null,
          p_tenant_id: null,
          p_local_entity_id: null,
        });
        if (finished.error) throw finished.error;
        if (finished.data?.ok !== true) {
          throw new Error("asaas_inbox_claim_lost_before_finish");
        }
        stats.processed++;
      } catch (processingError) {
        const triage = processingError instanceof AsaasTriageError;
        const reason = processingError instanceof Error
          ? processingError.message
          : "asaas_event_processing_failed";
        const finished = await supabase.rpc("finish_asaas_webhook_event", {
          p_event_id: claim.provider_event_id,
          p_worker_token: workerToken,
          p_outcome: triage ? "TRIAGE" : "RETRY",
          p_error: reason,
          p_tenant_id: triage ? processingError.tenantId : null,
          p_local_entity_id: triage ? processingError.localEntityId : null,
        });
        if (finished.error) throw finished.error;
        if (finished.data?.ok !== true) {
          throw new Error("asaas_inbox_claim_lost_before_retry");
        }
        if (triage) stats.triaged++;
        else stats.retried++;

        // The claim RPC preserves order inside the same provider entity while
        // skipping that entity during backoff. Keep draining so a transient
        // failure for one payment/tenant cannot stall unrelated ready events.
      }
    }
  } finally {
    const released = await supabase.rpc("release_asaas_webhook_worker", {
      p_worker_token: workerToken,
    });
    if (released.error) {
      console.error("[Webhook] Worker lease release failed", {
        code: released.error.code,
      });
    }
  }

  return stats;
}

function scheduleDurableInboxDrain(): void {
  const drain = drainAsaasWebhookInbox().catch((error) => {
    console.error("[Webhook] Durable drain deferred to cron", {
      type: error instanceof Error ? error.name : "unknown",
    });
  });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(drain);
  }
}

serve(async (req) => {
  // 0. CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, Allow: "POST" },
    });
  }

  // Internal cron/operations route. The service key is compared server-side;
  // this function deliberately has verify_jwt=false because Asaas itself does
  // not send Supabase JWTs.
  const internalBearer = req.headers.get("authorization")?.trim() || "";
  const internalApiKey = req.headers.get("apikey")?.trim() || "";
  const isInternalService = Boolean(
    SUPABASE_SERVICE_ROLE_KEY &&
      (internalBearer === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` ||
        internalApiKey === SUPABASE_SERVICE_ROLE_KEY),
  );
  if (isInternalService) {
    const operation = (await req.json().catch(() => ({}))) as {
      operation?: unknown;
      maxEvents?: unknown;
    };
    if (operation.operation !== "drain") {
      return new Response(JSON.stringify({ error: "Unknown operation" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const maxEvents = Number(operation.maxEvents);
    try {
      const stats = await drainAsaasWebhookInbox(
        Number.isInteger(maxEvents) ? maxEvents : 50,
      );
      return new Response(JSON.stringify({ success: true, ...stats }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("[Webhook] Internal durable drain failed", {
        type: error instanceof Error ? error.name : "unknown",
      });
      return new Response(JSON.stringify({ error: "DRAIN_FAILED" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Provider route: authentication and body validation happen before durable
  // persistence. HTTP 200 is emitted only after the database confirms enqueue.
  const requestToken = req.headers.get("asaas-access-token");
  if (!ASAAS_WEBHOOK_TOKEN || requestToken !== ASAAS_WEBHOOK_TOKEN) {
    console.warn("[Webhook] Token ausente ou inválido.");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  let body: AsaasWebhookBody;
  let reqText = "";
  try {
    reqText = await readWebhookBody(req);
    if (!reqText) {
      return new Response(JSON.stringify({ error: "Empty body" }), {
        headers: corsHeaders,
        status: 400,
      });
    }
    body = JSON.parse(reqText) as AsaasWebhookBody;
  } catch (error) {
    const tooLarge = error instanceof Error &&
      error.message === "PAYLOAD_TOO_LARGE";
    return new Response(
      JSON.stringify({
        error: tooLarge ? "Payload too large" : "Invalid JSON",
      }),
      {
        headers: corsHeaders,
        status: tooLarge ? 413 : 400,
      },
    );
  }

  const eventId = typeof body.id === "string" ? body.id.trim() : "";
  const eventName = typeof body.event === "string" ? body.event.trim() : "";
  const entityId = body.payment?.id?.trim() || body.subscription?.id?.trim() ||
    "";
  if (!eventId || eventId.length > 240 || !eventName || !entityId) {
    return new Response(JSON.stringify({ error: "Invalid webhook event" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "Persistence unavailable" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 503,
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const payloadHash = await sha256ExactHex(canonicalJson(body));
    const { data: enqueueResult, error: enqueueError } = await supabase.rpc(
      "enqueue_asaas_webhook_event",
      {
        p_event_id: eventId,
        p_event_name: eventName,
        p_entity_id: entityId,
        p_event_created_at: asaasDateToIso(body.dateCreated),
        p_payload: body,
        p_payload_hash: payloadHash,
      },
    );
    if (enqueueError) throw enqueueError;

    if (enqueueResult?.processable !== false) scheduleDurableInboxDrain();
    return new Response(
      JSON.stringify({
        received: true,
        duplicate: enqueueResult?.duplicate === true,
        status: enqueueResult?.status || "RECEIVED",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (error) {
    console.error("[Webhook] Durable enqueue failed", {
      type: error instanceof Error ? error.name : "unknown",
    });
    return new Response(
      JSON.stringify({ error: "PERSISTENCE_RETRY_REQUIRED" }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 503,
      },
    );
  }
});
