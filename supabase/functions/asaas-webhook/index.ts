import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  completeEnrollment,
  markEnrollmentStage,
} from "../_shared/enrollment-progress.ts";
import {
  secureInitialPassword,
  sendAccountActivation,
} from "../_shared/account-invite.ts";
import { classifyStudentPaymentType } from "./payment-classification.ts";
import {
  activateThenCancelHubReplacement,
  HUB_CORE_PRODUCT_FAMILY,
  hubActivationAllowsReplacementCancellation,
  type HubBillingBlockCode,
  hubBillingBlockCode,
  hubCheckoutIdFromExternalReference,
  hubRecoveryReason,
  isHubRecoveryEvent,
  providerCancellationIsFinal,
  replacementProviderSubscriptionId,
} from "../_shared/hub-billing-safety.ts";
import {
  loadTenantCentralWhatsAppContext,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";
import {
  billingIdentityMismatch,
  hubPaymentEventRequiresIdentity,
  providerWebhookEventKey,
} from "./billing-safety.ts";

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
  billingType?: string | null;
  subscription?: string | null;
  bankSlipUrl?: string | null;
  invoiceUrl?: string | null;
  refundedValue?: number | null;
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
  payment?: AsaasWebhookPayment;
  subscription?: AsaasWebhookSubscription;
};

const PAID_EVENTS = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"]);
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
    .test(value);
}

// Environment Variables
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ASAAS_ACCESS_TOKEN =
  (Deno.env.get("ASAAS_ACCESS_TOKEN") || Deno.env.get("ASAAS_API_KEY") || "")
    .trim();
const ASAAS_BASE_URL = (Deno.env.get("ASAAS_API_URL") ||
  "https://api.asaas.com").replace(/\/+$/, "");
const ASAAS_V3_URL = ASAAS_BASE_URL.endsWith("/v3")
  ? ASAAS_BASE_URL
  : `${ASAAS_BASE_URL}/v3`;
const ASAAS_WEBHOOK_TOKEN = (Deno.env.get("ASAAS_WEBHOOK_TOKEN") || "").trim();
// Chave via env para permitir rotação sem novo deploy.
const EVOLUTION_API_KEYS = Array.from(
  new Set([
    (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
  ].filter(Boolean)),
);
const EVOLUTION_API_BASE = `${
  (Deno.env.get("EVOLUTION_API_URL") || "https://api.2b.app.br")
    .replace(/\/+$/, "")
}/message/sendText`;
const MAX_WEBHOOK_BYTES = 256 * 1024;

function normalizeBrazilianPhone(value: unknown): string | null {
  let phone = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  return phone.startsWith("55") && (phone.length === 12 || phone.length === 13)
    ? phone
    : null;
}

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
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input.trim().toLowerCase()),
  );
  return Array.from(new Uint8Array(buf)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
async function sendMetaCapiEvent(
  opts: {
    eventName: string;
    phone?: string | null;
    value?: number;
    currency?: string;
  },
): Promise<void> {
  if (!FB_CAPI_TOKEN) return;
  try {
    const userData: Record<string, unknown> = {};
    if (opts.phone) {
      const digits = opts.phone.replace(/\D/g, "");
      userData.ph = [
        await sha256Hex(digits.startsWith("55") ? digits : `55${digits}`),
      ];
    }
    const body = {
      data: [{
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
      }],
    };
    await fetch(
      `https://graph.facebook.com/v20.0/${FB_PIXEL_ID}/events?access_token=${FB_CAPI_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      },
    ).catch(() => {});
  } catch { /* CAPI nunca pode quebrar o fluxo principal */ }
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

async function cancelHubProviderSubscription(
  providerSubscriptionId: string,
): Promise<void> {
  if (!ASAAS_ACCESS_TOKEN) {
    throw new Error("asaas_subscription_cancellation_unavailable");
  }
  const response = await fetchComTimeout(
    `${ASAAS_V3_URL}/subscriptions/${
      encodeURIComponent(providerSubscriptionId)
    }`,
    {
      method: "DELETE",
      headers: {
        access_token: ASAAS_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    },
  );
  if (!providerCancellationIsFinal(response.status)) {
    console.error("[Webhook] Hub provider cancellation failed", {
      status: response.status,
    });
    throw new Error("hub_provider_cancellation_failed");
  }
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
  let { data: existingUserId, error: lookupError } = await supabase.rpc(
    "get_user_id_by_email",
    { email_input: ownerEmail },
  );
  if (lookupError) {
    throw new Error(`owner_lookup_${lookupError.code || "failed"}`);
  }

  let userId = existingUserId as string | null;
  let createdUser = false;
  if (!userId) {
    const { data: created, error: createError } = await supabase.auth.admin
      .createUser({
        email: ownerEmail,
        password: secureInitialPassword(),
        email_confirm: true,
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
      createdUser = true;
    }
  }

  const { data: existingProfile, error: profileLookupError } = await supabase
    .from("profiles")
    .select("id,tenant_id,role")
    .eq("id", userId)
    .maybeSingle();
  if (profileLookupError) {
    throw new Error(
      `owner_profile_lookup_${profileLookupError.code || "failed"}`,
    );
  }

  if (!existingProfile) {
    const { error: createProfileError } = await supabase.from("profiles")
      .insert({
        id: userId,
        full_name: provisioned.owner_name,
        email: ownerEmail,
        role: "SCHOOL_ADMIN",
        tenant_id: provisioned.tenant_id,
        status_financial: "ACTIVE",
        created_at: new Date().toISOString(),
      });
    if (createProfileError && createProfileError.code !== "23505") {
      throw new Error(
        `owner_profile_create_${createProfileError.code || "failed"}`,
      );
    }
  } else {
    if (
      existingProfile.tenant_id === provisioned.tenant_id &&
      existingProfile.role !== "SCHOOL_ADMIN"
    ) {
      const { error: promoteError } = await supabase.from("profiles").update({
        role: "SCHOOL_ADMIN",
      }).eq("id", userId);
      if (promoteError) {
        throw new Error(
          `owner_profile_promote_${promoteError.code || "failed"}`,
        );
      }
    }
  }

  const { error: membershipError } = await supabase
    .from("tenant_memberships")
    .upsert({
      user_id: userId,
      tenant_id: provisioned.tenant_id,
      role: "SCHOOL_ADMIN",
      status: "ACTIVE",
      is_primary: !existingProfile ||
        existingProfile.tenant_id === provisioned.tenant_id,
    }, { onConflict: "user_id,tenant_id" });
  if (membershipError) {
    throw new Error(`owner_membership_${membershipError.code || "failed"}`);
  }

  const { error: completionError } = await supabase
    .from("saas_checkout_intents")
    .update({
      status: "PROVISIONED",
      provisioned_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", provisioned.checkout_id);
  if (completionError) {
    throw new Error(`checkout_completion_${completionError.code || "failed"}`);
  }

  if (createdUser) {
    try {
      await sendAccountActivation(supabase, {
        email: ownerEmail,
        name: provisioned.owner_name,
        accountLabel: "administrador da escola",
      });
    } catch (activationError) {
      // Provisioning is complete and the owner can still use password
      // recovery. Persist the delivery warning for operational follow-up.
      console.error("[Webhook] SaaS owner activation delivery failed", {
        type: activationError instanceof Error
          ? activationError.name
          : "unknown",
      });
      await supabase.from("saas_checkout_intents").update({
        last_error: "activation_email_delivery_failed",
        updated_at: new Date().toISOString(),
      }).eq("id", provisioned.checkout_id);
    }
  }
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
          body.subscription?.externalReference || null,
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
  const { error } = await supabase.from("saas_billing_event_inbox").update({
    status,
    last_error: lastError?.slice(0, 500) || null,
    processed_at: status === "PROCESSED" ? new Date().toISOString() : null,
    lease_expires_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("event_key", eventKey);
  if (error) throw error;
}

async function processSaasCheckoutEvent(
  supabase: SupabaseClient,
  body: AsaasWebhookBody,
  resolvedCheckoutId?: string | null,
): Promise<boolean> {
  const event = body.event || "";
  if (!SAAS_ACCESS_EVENTS.has(event)) return false;

  const checkoutId = resolvedCheckoutId ?? await resolveSaasCheckoutId(body);
  if (!checkoutId || !isUuid(checkoutId)) return false;

  const { data: checkout, error: checkoutError } = await supabase
    .from("saas_checkout_intents")
    .select(
      "id,status,amount,billing_type,billing_cycle,asaas_customer_id,asaas_subscription_id,asaas_payment_id",
    )
    .eq("id", checkoutId)
    .maybeSingle();
  if (checkoutError) throw checkoutError;
  if (!checkout) throw new Error("saas_checkout_not_found");

  const claim = await claimSaasBillingEvent(supabase, body, checkoutId);
  if (claim.duplicate) return true;

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
        await supabase.from("saas_checkout_intents").update({
          status: "PROVISIONING_FAILED",
          last_error: reason,
          updated_at: new Date().toISOString(),
        }).eq("id", checkoutId);
        throw ownerError;
      }
      console.log(`[Webhook] SaaS provisionado: ${checkoutId}`);
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
  if (
    payment.value !== undefined &&
    (!Number.isFinite(amount) || amount < 0)
  ) {
    throw new Error("invalid_wolfie_topup_amount");
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("wolfie_topup_database_unavailable");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const explicitEventId = typeof body.id === "string" &&
      body.id.length >= 1 && body.id.length <= 240
    ? body.id
    : null;
  const eventId = explicitEventId ??
    `synthetic:${await sha256Hex(JSON.stringify([
      event,
      payment.id,
      reference,
      payment.status,
      payment.value ?? null,
      payment.refundedValue ?? null,
      payment.paymentDate ?? null,
    ]))}`;
  const receivedAt = new Date().toISOString();
  const { error: inboxError } = await supabase
    .from("wolfie_topup_webhook_inbox")
    .upsert({
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
    }, { onConflict: "provider_event_id" });
  if (inboxError) throw new Error("wolfie_topup_inbox_unavailable");

  const finishInbox = async (
    status: "APPLIED" | "IGNORED" | "LEGACY_REVIEW" | "FAILED",
    lastError: string | null = null,
  ) => {
    const { error } = await supabase.from("wolfie_topup_webhook_inbox")
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

  let refundedAmount = typeof payment.refundedValue === "number" &&
      Number.isFinite(payment.refundedValue) && payment.refundedValue >= 0
    ? payment.refundedValue
    : Number.NaN;
  if (
    !Number.isFinite(refundedAmount) &&
    (TOPUP_FREEZE_EVENTS.has(event) || TOPUP_REVERSAL_EVENTS.has(event)) &&
    ASAAS_ACCESS_TOKEN
  ) {
    try {
      const refundsResponse = await fetch(
        `${ASAAS_V3_URL}/payments/${encodeURIComponent(payment.id)}/refunds`,
        {
          headers: { "access_token": ASAAS_ACCESS_TOKEN },
          signal: AbortSignal.timeout(8_000),
        },
      );
      const refundsPayload: unknown = await refundsResponse.json().catch(() =>
        null
      );
      if (
        refundsResponse.ok &&
        refundsPayload &&
        typeof refundsPayload === "object" &&
        Array.isArray((refundsPayload as { data?: unknown }).data)
      ) {
        refundedAmount = (refundsPayload as { data: unknown[] }).data.reduce<
          number
        >(
          (sum: number, refund: unknown) => {
            const value = refund && typeof refund === "object"
              ? Number((refund as { value?: unknown }).value)
              : Number.NaN;
            return sum + (Number.isFinite(value) && value > 0 ? value : 0);
          },
          0,
        );
      }
    } catch {
      console.warn("[Webhook] Refund amount lookup unavailable", {
        paymentId: payment.id,
      });
    }
  }
  const { data, error } = await supabase.rpc("apply_wolfie_topup_payment", {
    p_order_id: orderId,
    p_payment_id: payment.id,
    p_event: event,
    p_amount_brl: amount,
    p_refunded_amount_brl: Number.isFinite(refundedAmount)
      ? refundedAmount
      : null,
  });
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
  const { error } = await supabase.from("hub_payment_event_inbox").update({
    status,
    last_error: lastError?.slice(0, 500) || null,
    processed_at: status === "PROCESSED" ? new Date().toISOString() : null,
    lease_expires_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("event_key", eventKey);
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
  ).then((response) => {
    if (!response.ok) {
      console.warn("[Webhook] Hub fulfillment kickoff deferred", {
        status: response.status,
      });
    }
  }).catch((error) => {
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

  return hubBillingBlockCode(
    productFamily,
    account?.status,
    hubEnabled,
  );
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

  await cancelHubProviderSubscription(providerSubscriptionId);
  const blockedAt = new Date().toISOString();
  const checkoutMetadata = checkout.metadata &&
      typeof checkout.metadata === "object" &&
      !Array.isArray(checkout.metadata)
    ? checkout.metadata
    : {};

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

  const { error: checkoutError } = await supabase
    .from("hub_checkout_sessions")
    .update({
      status: "CANCELLED",
      asaas_payment_id: checkout.asaas_payment_id || paymentId,
      metadata: {
        ...checkoutMetadata,
        billingBlockedCode: blockCode,
        billingBlockedPaymentId: paymentId,
        billingBlockedAt: blockedAt,
        providerCancellationId: providerSubscriptionId,
        requiresManualReconciliation: true,
      },
      updated_at: blockedAt,
    })
    .eq("id", checkout.id)
    .neq("status", "REVERSED");
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
    hubCheckoutIdFromExternalReference(payment.externalReference) ?? "";
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
      payment.subscription && checkout.asaas_subscription_id &&
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
      const replacementMetadata = checkout.metadata &&
          typeof checkout.metadata === "object" &&
          !Array.isArray(checkout.metadata)
        ? checkout.metadata
        : {};
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
        cancelHubProviderSubscription,
        async (cancelledProviderSubscriptionId) => {
          const { error: replacementError } = await supabase
            .from("hub_checkout_sessions")
            .update({
              metadata: {
                ...replacementMetadata,
                replacementProviderCancellationCompletedAt: new Date()
                  .toISOString(),
                replacementProviderCancellationId:
                  cancelledProviderSubscriptionId,
              },
              updated_at: new Date().toISOString(),
            })
            .eq("id", checkoutId);
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
      await cancelHubProviderSubscription(providerSubscriptionId);
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
      const { error } = await supabase.from("hub_checkout_sessions").update({
        metadata: {
          ...(checkout.metadata && typeof checkout.metadata === "object" &&
              !Array.isArray(checkout.metadata)
            ? checkout.metadata
            : {}),
          providerRecoveryEvent: event,
          providerRecoveryReason: hubRecoveryReason(event),
          providerRecoveryPaymentId: payment.id,
          providerRecoveryAt: new Date().toISOString(),
          requiresManualReconciliation: true,
        },
        updated_at: new Date().toISOString(),
      }).eq("id", checkoutId);
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
      const { error } = await supabase.from("hub_checkout_sessions").update({
        asaas_payment_id: checkout.asaas_payment_id || payment.id,
        invoice_url: payment.invoiceUrl || null,
        bank_slip_url: payment.bankSlipUrl || null,
        updated_at: new Date().toISOString(),
      }).eq("id", checkoutId).neq("status", "REVERSED");
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

// Processa o evento do ASAAS. Roda em BACKGROUND (EdgeRuntime.waitUntil),
// depois que o webhook já respondeu 200 — então NUNCA lança erro pro ASAAS,
// apenas registra nos logs.
async function processarPagamento(body: AsaasWebhookBody): Promise<void> {
  try {
    const { event, payment } = body;

    if (!event || !payment) {
      console.warn("[Webhook] Ignorado: faltou event ou payment.");
      return;
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

    /*
          STRATEGY:
          1. Try to find the student (Profile) via externalReference (our ID) or customer (Asaas ID).
          2. Update/Insert the Payment in 'student_payments'.
          3. Update the Profile/Subscription status if necessary.
        */

    // 1. Find Student
    let studentId: string | null = null;
    // Basic UUID validation
    const isValidUUID = (id: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      );

    if (payment.externalReference && isValidUUID(payment.externalReference)) {
      studentId = payment.externalReference;
    } else if (payment.externalReference) {
      console.warn(
        "⚠️ externalReference não é UUID; identificação seguirá pelo customer.",
      );
    }

    // If no external ref, lookup by Asaas Customer ID
    if (!studentId) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("asaas_customer_id", payment.customer)
        .eq("role", "STUDENT")
        .single();

      if (profile) {
        studentId = profile.id;
        console.log("[Webhook] Aluno identificado pelo customer canônico.");
      } else {
        console.warn(
          "⚠️ Perfil não encontrado pelo customer; tentando fallback legado.",
        );

        // Fallback: Fetch Customer from Asaas to get Email
        if (ASAAS_ACCESS_TOKEN) {
          try {
            const asaasRes = await fetchComTimeout(
              `https://api.asaas.com/v3/customers/${payment.customer}`,
              {
                headers: { "access_token": ASAAS_ACCESS_TOKEN },
              },
            );

            if (asaasRes.ok) {
              const asaasCustomer = await asaasRes.json();
              if (asaasCustomer.email) {
                // IMPORTANT: 'profiles' must have 'email' column (added via migration)
                const { data: profilesByEmail } = await supabase.from(
                  "profiles",
                )
                  .select("id")
                  .eq("email", String(asaasCustomer.email).trim().toLowerCase())
                  .eq("role", "STUDENT")
                  .limit(2);
                const profileByEmail = profilesByEmail?.length === 1
                  ? profilesByEmail[0]
                  : null;

                if (profileByEmail) {
                  studentId = profileByEmail.id;
                  console.log("✅ Aluno identificado pelo fallback legado.");

                  // Sync ID for future
                  await supabase.from("profiles").update({
                    asaas_customer_id: payment.customer,
                  }).eq("id", studentId);
                } else {
                  console.warn(
                    "❌ Nenhum perfil encontrado pelo fallback legado.",
                  );
                }
              }
            } else {
              console.error("❌ Falha ao consultar customer no Asaas:", {
                status: asaasRes.status,
              });
            }
          } catch (errFallback) {
            console.error("[Webhook] Email fallback failed", {
              type: errFallback instanceof Error
                ? errFallback.name
                : "UnknownError",
            });
          }
        } else {
          console.warn(
            "⚠️ ASAAS_ACCESS_TOKEN not configured. Skipping email fallback.",
          );
        }

        if (!studentId) {
          console.warn(`⚠️ Final: Student could not be identified.`);
        }
      }
    } else {
      console.log("[Webhook] Aluno identificado pela referência canônica.");
    }

    let studentTenantId: string | null = null;
    if (studentId) {
      const { data: studentScope, error: studentScopeError } = await supabase
        .from("profiles")
        .select("tenant_id,role")
        .eq("id", studentId)
        .maybeSingle();
      if (
        studentScopeError || studentScope?.role !== "STUDENT" ||
        typeof studentScope?.tenant_id !== "string" ||
        !studentScope.tenant_id
      ) {
        console.warn(
          "[Webhook] Referência ignorada: perfil não é aluno de tenant.",
        );
        studentId = null;
      } else {
        studentTenantId = studentScope.tenant_id;
      }
    }

    // 2. Process Events

    // Allow 'PAYMENT_UPDATED' to re-process and potentially link the student if missing
    if (
      event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED" ||
      event === "PAYMENT_UPDATED"
    ) {
      console.log(`Processing Payment Event: ${event}`);

      // Check existing payment status to prevent duplicate WhatsApp sends (Idempotency check)
      const { data: existingPayment } = await supabase
        .from("student_payments")
        .select("status")
        .eq("asaas_payment_id", payment.id)
        .maybeSingle();

      const isAlreadyPaid = existingPayment &&
        [
          "CONFIRMED",
          "RECEIVED",
          "PAGO",
          "PAYMENT_RECEIVED",
          "PAYMENT_CONFIRMED",
        ].includes(existingPayment.status);

      // A. Update Payment Record
      // We use upsert to ensure we create it if it was missed during creation
      const paymentType = classifyStudentPaymentType(
        payment.description,
        payment.externalReference,
      );

      const paymentData: Record<string, unknown> = {
        asaas_payment_id: payment.id,
        value: payment.value,
        status: payment.status, // CONFIRMED or RECEIVED
        due_date: payment.dueDate,
        payment_date: payment.paymentDate || new Date().toISOString(), // Critical for Revenue Calc
        billing_type: payment.billingType,
        invoice_url: payment.bankSlipUrl || payment.invoiceUrl,
        description: payment.description || "Mensalidade",
        payment_type: paymentType,
        updated_at: new Date().toISOString(),
      };

      // CRITICAL FIX: Only set student_id if it is defined.
      // DO NOT OVERWRITE EXISTING STUDENT_ID WITH NULL.
      if (studentId && studentTenantId) {
        paymentData.student_id = studentId;
        paymentData.tenant_id = studentTenantId;
      }

      const { error: payError } = await supabase
        .from("student_payments")
        .upsert(paymentData, { onConflict: "asaas_payment_id" });

      if (payError) {
        console.error("[Webhook] student_payments update failed", {
          code: payError.code,
        });
        // Roda em background: apenas registra, não relança (o ASAAS já recebeu 200).
        return;
      } else {
        console.log("[Webhook] Payment record updated.");
      }

      // B. Update Subscription / Profile Status & Check for Welcome Message
      if (studentId) {
        // Fetch Profile Data needed for Welcome Logic & Cash Flow
        const { data: profileData, error: profileFetchErr } = await supabase
          .from("profiles")
          .select(
            "role, tenant_id, contract_accepted, welcome_sent_at, phone, full_name, signed_document_url, class_frequency, enrollment_payment_id, is_test_account",
          )
          .eq("id", studentId)
          .eq("tenant_id", studentTenantId)
          .eq("role", "STUDENT")
          .single();

        if (profileFetchErr) {
          console.error("[Webhook] Student profile lookup failed", {
            code: profileFetchErr.code,
          });
        }

        // Update Status to ACTIVE
        const { error: profileError } = await supabase
          .from("profiles")
          .update({ status_financial: "ACTIVE" })
          .eq("id", studentId);

        if (profileError) {
          console.error("[Webhook] Student financial status update failed", {
            code: profileError.code,
          });
        } else console.log("✅ Profile Financial Status set to ACTIVE");

        // Uma matrícula em processamento só fecha quando o pagamento
        // obrigatório correspondente (taxa ou serviço avulso) é confirmado.
        // O webhook usa service_role e é a fonte autoritativa mesmo se o
        // aluno fechar a página antes de clicar em "já paguei".
        if (
          profileData &&
          (event === "PAYMENT_CONFIRMED" || event === "PAYMENT_RECEIVED")
        ) {
          try {
            const { data: processingOffer } = await supabase
              .from("offers")
              .select("id, metadata, processing_state")
              .eq("kind", "ENROLLMENT")
              .eq("processing_by", studentId)
              .neq("processing_state", "COMPLETED")
              .order("processing_updated_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            if (processingOffer) {
              const enrollmentPaymentId = profileData.enrollment_payment_id ||
                processingOffer.metadata?.enrollment_payment_id;
              const oneTimePaymentId = processingOffer.metadata
                ?.one_time_payment_id;
              const isEnrollmentFee = enrollmentPaymentId === payment.id;
              const isOneTime = oneTimePaymentId === payment.id;

              if (isEnrollmentFee) {
                await supabase.from("profiles").update({
                  enrollment_fee_paid: true,
                }).eq("id", studentId).eq("enrollment_payment_id", payment.id);
              }

              if (isEnrollmentFee || isOneTime) {
                await markEnrollmentStage(
                  supabase,
                  processingOffer.id,
                  studentId,
                  "BILLING_READY",
                  {
                    metadata: isOneTime
                      ? { one_time_paid_at: new Date().toISOString() }
                      : { enrollment_fee_paid_at: new Date().toISOString() },
                  },
                );
                await completeEnrollment(
                  supabase,
                  processingOffer.id,
                  studentId,
                );
                console.log("[Webhook] Enrollment completed by paid event.");
              }
            }
          } catch (completionError) {
            console.error("[Webhook] Enrollment completion failed:", {
              type: completionError instanceof Error
                ? completionError.name
                : "UnknownError",
            });
          }
        }

        // --- CONFIRMAÇÃO DE PAGAMENTO VIA WHATSAPP ---
        // Envia APENAS uma mensagem simples de confirmação, SEM links.
        // A mensagem de Bem-vindo ao Império é disparada SOMENTE no fluxo de matrícula (PublicRegistration), NUNCA aqui.
        if (
          profileData &&
          profileData.is_test_account !== true &&
          profileData.phone &&
          (event === "PAYMENT_CONFIRMED" || event === "PAYMENT_RECEIVED")
        ) {
          if (isAlreadyPaid) {
            console.log(
              "[Webhook] Payment confirmation WhatsApp skipped: already paid.",
            );
          } else {
            // Primeira confirmação real deste pagamento — dispara o evento de conversão.
            sendMetaCapiEvent({
              eventName: "Purchase",
              phone: profileData.phone,
              value: Number(payment.value) || undefined,
            });
            try {
              const communication = profileData.tenant_id
                ? await loadTenantCentralWhatsAppContext(
                  supabase,
                  profileData.tenant_id,
                  "student",
                )
                : null;
              const cleanPhone = normalizeBrazilianPhone(profileData.phone);
              if (!communication || !cleanPhone || !EVOLUTION_API_KEYS.length) {
                console.warn(
                  "[Webhook] Payment confirmation WhatsApp skipped: tenant channel unavailable.",
                );
              } else {
                const studentName = safeCommunicationText(
                  profileData.full_name?.split(" ")[0],
                  80,
                ) || "Aluno";
                const valorFormatado = payment.value
                  ? `R$ ${Number(payment.value).toFixed(2).replace(".", ",")}`
                  : "";
                const confirmationMessage = `✅ *Pagamento confirmado${
                  valorFormatado ? `, ${valorFormatado}` : ""
                }!*\nObrigado, ${studentName}. Seu acesso na ${communication.identity.brandName} segue ativo.`;

                let evoRes: Response | null = null;
                for (const key of EVOLUTION_API_KEYS) {
                  evoRes = await fetchComTimeout(
                    `${EVOLUTION_API_BASE}/${
                      encodeURIComponent(communication.instanceName)
                    }`,
                    {
                      method: "POST",
                      headers: {
                        "apikey": key,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        number: cleanPhone,
                        text: confirmationMessage,
                        delay: 1200,
                        linkPreview: false,
                      }),
                    },
                  );
                  if (evoRes.status !== 401) break;
                }

                if (evoRes?.ok) {
                  console.log("✅ Payment Confirmation WhatsApp Sent!");
                } else {
                  console.error(
                    "❌ Falha ao enviar confirmação de pagamento:",
                    { status: evoRes?.status },
                  );
                }
              }
            } catch (whatsappErr) {
              console.error(
                "❌ Error in Payment Confirmation WhatsApp flow:",
                whatsappErr,
              );
            }
          }
        }
        // -----------------------------

        // LEDGER: a inserção no caixa é responsabilidade EXCLUSIVA do trigger
        // ledger_on_payment_received (fonte única, idempotente por student_payment_id
        // + índice único uq_financial_transactions_student_payment). O bloco de
        // inserção direta que existia aqui foi removido em 03/07/2026 — era a origem
        // do "caixa dobrado" (linha 'student_tuition Ref: pay_...' sem vínculo,
        // duplicando a linha MENSALIDADE do trigger). NÃO reintroduzir.
      }
    } else if (event === "PAYMENT_OVERDUE") {
      console.log("⚠️ PAYMENT OVERDUE! Marking as overdue...");

      const paymentData: Record<string, unknown> = {
        asaas_payment_id: payment.id,
        status: "OVERDUE",
        updated_at: new Date().toISOString(),
      };

      if (studentId) paymentData.student_id = studentId;

      const { error: payError } = await supabase
        .from("student_payments")
        .update(paymentData)
        .eq("asaas_payment_id", payment.id);

      if (payError) {
        console.error("[Webhook] Overdue payment update failed", {
          code: payError.code,
        });
      }

      if (studentId) {
        await supabase
          .from("profiles")
          .update({ status_financial: "OVERDUE" })
          .eq("id", studentId);
        console.log("✅ Profile Financial Status set to OVERDUE");
      }
    } // Handle generic updates (Created, etc)
    else {
      console.log(`ℹ️ Generic Event: ${event}. Upserting info...`);

      const paymentData: Record<string, unknown> = {
        asaas_payment_id: payment.id,
        value: payment.value,
        status: payment.status,
        due_date: payment.dueDate,
        billing_type: payment.billingType,
        invoice_url: payment.bankSlipUrl || payment.invoiceUrl,
        description: payment.description,
        payment_type: classifyStudentPaymentType(
          payment.description,
          payment.externalReference,
        ),
        updated_at: new Date().toISOString(),
      };

      // CRITICAL FIX: Only set student_id if it is defined.
      if (studentId && studentTenantId) {
        paymentData.student_id = studentId;
        paymentData.tenant_id = studentTenantId;
      }

      const { error: upsertError } = await supabase
        .from("student_payments")
        .upsert(paymentData, { onConflict: "asaas_payment_id" });

      if (upsertError) {
        console.error("[Webhook] Generic payment upsert failed", {
          code: upsertError.code,
        });
      }
    }
  } catch (err: unknown) {
    console.error("❌ CRITICAL WEBHOOK ERROR (background):", {
      type: err instanceof Error ? err.name : "UnknownError",
    });
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
      headers: { ...corsHeaders, "Allow": "POST" },
    });
  }

  // 1. Validação rápida (corpo + token) — tudo que precisa retornar erro HTTP
  //    pro ASAAS acontece AQUI, antes do ACK.
  const requestToken = req.headers.get("asaas-access-token");
  if (!ASAAS_WEBHOOK_TOKEN || requestToken !== ASAAS_WEBHOOK_TOKEN) {
    console.warn("[Webhook] Token ausente ou inválido.");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  let body: AsaasWebhookBody;
  try {
    const reqText = await readWebhookBody(req);
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

  // Top-ups are money-like durable credits. Process them synchronously and
  // return 5xx on transient failure so Asaas retries instead of losing a
  // confirmed purchase after an early 200 ACK.
  const topupReference = body.payment?.externalReference ?? "";
  if (
    topupReference.startsWith("wolfie-topup-order:") ||
    topupReference.startsWith("topup:")
  ) {
    try {
      await processWolfieTopupEvent(body);
      return new Response(JSON.stringify({ received: true }), {
        headers: corsHeaders,
        status: 200,
      });
    } catch (error) {
      console.error("[Webhook] Wolfie top-up processing failed", {
        type: error instanceof Error ? error.message : "unknown",
      });
      return new Response(JSON.stringify({ error: "TOPUP_RETRY_REQUIRED" }), {
        headers: corsHeaders,
        status: 503,
      });
    }
  }

  const saasReference = body.payment?.externalReference ||
    body.subscription?.externalReference || "";
  let saasCheckoutId: string | null = null;
  try {
    saasCheckoutId = await resolveSaasCheckoutId(body);
  } catch (error) {
    console.error("[Webhook] SaaS subscription routing failed", {
      type: error instanceof Error ? error.message : "unknown",
    });
    return new Response(JSON.stringify({ error: "SAAS_RETRY_REQUIRED" }), {
      headers: corsHeaders,
      status: 503,
    });
  }

  if (saasReference.startsWith("saas:") || saasCheckoutId) {
    if (!saasCheckoutId) {
      console.warn("[Webhook] Referência de checkout SaaS inválida.");
      const accessEvent = SAAS_ACCESS_EVENTS.has(body.event || "");
      return new Response(
        JSON.stringify(
          accessEvent ? { error: "SAAS_RETRY_REQUIRED" } : { received: true },
        ),
        {
          headers: corsHeaders,
          status: accessEvent ? 503 : 200,
        },
      );
    }
    try {
      const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
      await processSaasCheckoutEvent(supabase, body, saasCheckoutId);
      return new Response(JSON.stringify({ received: true }), {
        headers: corsHeaders,
        status: 200,
      });
    } catch (error) {
      console.error("[Webhook] SaaS subscription processing failed", {
        type: error instanceof Error ? error.message : "unknown",
      });
      return new Response(JSON.stringify({ error: "SAAS_RETRY_REQUIRED" }), {
        headers: corsHeaders,
        status: 503,
      });
    }
  }

  let hubCheckoutId: string | null = null;
  try {
    hubCheckoutId = await resolveHubCheckoutId(body);
  } catch (error) {
    console.error("[Webhook] Hub subscription routing failed", {
      type: error instanceof Error ? error.message : "unknown",
    });
    return new Response(JSON.stringify({ error: "HUB_RETRY_REQUIRED" }), {
      headers: corsHeaders,
      status: 503,
    });
  }

  // Hub/Wolfie subscriptions are access-bearing financial events. Process
  // them synchronously with a durable inbox so a transient database failure
  // returns 5xx and Asaas retries instead of silently losing access state.
  if (topupReference.startsWith("hub:") || hubCheckoutId) {
    try {
      await processHubPaymentEvent(body, hubCheckoutId);
      return new Response(JSON.stringify({ received: true }), {
        headers: corsHeaders,
        status: 200,
      });
    } catch (error) {
      console.error("[Webhook] Hub subscription processing failed", {
        type: error instanceof Error ? error.message : "unknown",
      });
      return new Response(JSON.stringify({ error: "HUB_RETRY_REQUIRED" }), {
        headers: corsHeaders,
        status: 503,
      });
    }
  }

  // 2. Processa os demais eventos em BACKGROUND e responde 200 imediatamente.
  //    Isso evita o "Read timed out" do ASAAS: o banco/WhatsApp continuam
  //    rodando depois da resposta, sem segurar a conexão do webhook.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(processarPagamento(body));
  } else {
    // Fallback: process in background (non-blocking) to prevent timeouts
    processarPagamento(body).catch((err) =>
      console.error("[Webhook] Background processing failed", {
        type: err instanceof Error ? err.name : "UnknownError",
      })
    );
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: corsHeaders,
    status: 200,
  });
});
