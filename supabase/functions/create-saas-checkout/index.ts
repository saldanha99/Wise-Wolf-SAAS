/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  AsaasCapabilityFenceError,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import {
  asaasCreationFingerprint,
  asaasCreationHttpOutcome,
  claimAsaasCreation,
  findUniqueAsaasEntity,
  markAsaasCreationSubmitting,
  recordAsaasCreationState,
} from "../_shared/asaas-creation-guard.ts";
import {
  checkoutPayloadMatches,
  containsCardMaterial,
  normalizeProviderId,
  parseSaasCheckoutBillingType,
  resolveProviderCustomer,
  resolveProviderSubscription,
  saasCheckoutNextDueDate,
  saasCheckoutProviderReference,
} from "./provider-safety.ts";
import {
  PLATFORM_ASAAS_TENANT_ID,
  type ResolvedAsaasIntegration,
  resolvePlatformAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CHECKOUT_COLUMNS =
  "id,idempotency_key,status,school_name,owner_name,owner_email,owner_phone,owner_cpf_cnpj,plan_id,billing_cycle,billing_type,amount,lead_id,asaas_customer_id,asaas_subscription_id,asaas_payment_id,invoice_url,bank_slip_url,pix_payload,pix_encoded_image,due_date,metadata,created_at,updated_at";

type BillingCycle = "MONTHLY" | "YEARLY";
type JsonRecord = Record<string, unknown>;

class AsaasRequestError extends Error {
  constructor(
    readonly status: number,
  ) {
    super("asaas_request_failed");
    this.name = "AsaasRequestError";
  }
}

class ProviderStateAmbiguousError extends Error {
  constructor() {
    super("provider_state_ambiguous");
    this.name = "ProviderStateAmbiguousError";
  }
}

class ProviderReviewRequiredError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ProviderReviewRequiredError";
  }
}

class ProviderCreationInProgressError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("provider_creation_in_progress");
    this.name = "ProviderCreationInProgressError";
  }
}

class ProviderCreationRejectedError extends Error {
  constructor(readonly providerStatus: number) {
    super("provider_creation_rejected");
    this.name = "ProviderCreationRejectedError";
  }
}

class ProviderTemporarilyUnavailableError extends Error {
  constructor() {
    super("provider_temporarily_unavailable");
    this.name = "ProviderTemporarilyUnavailableError";
  }
}

function mutationWasAmbiguous(error: unknown): boolean {
  return error instanceof ProviderStateAmbiguousError;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function digits(value: unknown, maxLength = 20): string {
  return typeof value === "string"
    ? value.replace(/\D/g, "").slice(0, maxLength)
    : "";
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function slugBase(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "escola";
}

async function sha256(value: string): Promise<string> {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function withoutProviderLease(metadata: JsonRecord): JsonRecord {
  const next = { ...metadata };
  delete next.providerAttemptToken;
  delete next.providerLeaseUntil;
  delete next.providerReconciliationRequired;
  delete next.providerReviewRequired;
  return next;
}

function clearProviderLease(metadata: JsonRecord): JsonRecord {
  const next = { ...metadata };
  delete next.providerAttemptToken;
  delete next.providerLeaseUntil;
  return next;
}

function publicCheckoutResult(checkout: JsonRecord) {
  return {
    success: true,
    checkout_id: checkout.id,
    status: checkout.status,
    subscription_id: checkout.asaas_subscription_id,
    payment_id: checkout.asaas_payment_id,
    invoice_url: checkout.invoice_url,
    bank_slip_url: checkout.bank_slip_url,
    pix: checkout.pix_payload
      ? {
        qr_code: checkout.pix_encoded_image,
        copy_paste: checkout.pix_payload,
      }
      : null,
    value: Number(checkout.amount),
    cycle: checkout.billing_cycle,
    provisioning: checkout.status === "PROVISIONED"
      ? "PROVISIONED"
      : "AWAITING_PAYMENT",
  };
}

async function asaasRequest(
  integration: ResolvedAsaasIntegration,
  path: string,
  init: RequestInit = {},
): Promise<JsonRecord> {
  const method = String(init.method || "GET").toUpperCase();
  if (method !== "GET") {
    throw new Error("ASAAS_CREATION_REQUIRES_DURABLE_CLAIM");
  }
  let response: Response;
  try {
    response = await fetch(`${integration.baseUrl}${path}`, {
      ...init,
      headers: {
        access_token: integration.apiKey,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: init.signal || AbortSignal.timeout(12_000),
    });
  } catch {
    throw new AsaasRequestError(0);
  }
  if (!response.ok) {
    throw new AsaasRequestError(response.status);
  }
  try {
    return asRecord(await response.json());
  } catch {
    throw new AsaasRequestError(response.status);
  }
}

async function loadProviderEntity(
  integration: ResolvedAsaasIntegration,
  path: string,
): Promise<JsonRecord> {
  try {
    return await asaasRequest(integration, path);
  } catch (error) {
    if (error instanceof AsaasRequestError && error.status === 404) {
      throw new ProviderReviewRequiredError("provider_link_not_found");
    }
    throw new ProviderStateAmbiguousError();
  }
}

function activeProviderIdentity(
  candidate: Record<string, unknown>,
  reference: string,
): boolean {
  return candidate.deleted !== true &&
    cleanText(candidate.externalReference, 240) === reference;
}

async function loadAllSubscriptionPayments(
  integration: ResolvedAsaasIntegration,
  subscriptionId: string,
): Promise<JsonRecord[]> {
  const collected: JsonRecord[] = [];
  let offset = 0;
  let completed = false;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const result = await asaasRequest(
      integration,
      `/subscriptions/${
        encodeURIComponent(subscriptionId)
      }/payments?limit=100&offset=${offset}`,
    );
    if (!Array.isArray(result.data)) throw new ProviderStateAmbiguousError();
    const page = result.data.map(asRecord);
    collected.push(...page);
    if (result.hasMore !== true) {
      completed = true;
      break;
    }
    if (page.length === 0) throw new ProviderStateAmbiguousError();
    offset += page.length;
  }
  if (!completed) throw new ProviderStateAmbiguousError();
  return collected;
}

function sameAsaasIntegration(
  left: ResolvedAsaasIntegration,
  right: ResolvedAsaasIntegration,
): boolean {
  return left.integrationId === right.integrationId &&
    left.tenantId === right.tenantId &&
    left.provider === right.provider &&
    left.version === right.version &&
    left.mode === right.mode &&
    left.environment === right.environment &&
    left.baseUrl === right.baseUrl &&
    left.apiKey === right.apiKey;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Método não permitido" }, 405);
  }

  let checkoutId: string | null = null;
  let checkoutMetadata: JsonRecord = {};
  let providerAttemptToken: string | null = null;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ||
    "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Checkout temporariamente indisponível" }, 503);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let customerReadIntegration: ResolvedAsaasIntegration;
  let subscriptionReadIntegration: ResolvedAsaasIntegration;
  let paymentReadIntegration: ResolvedAsaasIntegration;
  try {
    [
      customerReadIntegration,
      subscriptionReadIntegration,
      paymentReadIntegration,
    ] = await Promise.all([
      resolvePlatformAsaasIntegration(supabase, "customer.read"),
      resolvePlatformAsaasIntegration(supabase, "subscription.read"),
      resolvePlatformAsaasIntegration(supabase, "payment.read"),
    ]);
  } catch {
    return json({ error: "Checkout temporariamente indisponível" }, 503);
  }
  if (
    !sameAsaasIntegration(
      customerReadIntegration,
      subscriptionReadIntegration,
    ) ||
    !sameAsaasIntegration(customerReadIntegration, paymentReadIntegration)
  ) {
    return json({ error: "Checkout temporariamente indisponível" }, 503);
  }

  try {
    const body = asRecord(await req.json());
    if (containsCardMaterial(body)) {
      return json({
        error:
          "Dados de cartão não são aceitos neste checkout. Use PIX ou boleto.",
        code: "CARD_DATA_NOT_ACCEPTED",
      }, 400);
    }

    const schoolName = cleanText(body.school_name, 140);
    const ownerName = cleanText(body.owner_name, 140);
    const ownerEmail = cleanText(body.owner_email, 254).toLowerCase();
    const ownerCpfCnpj = digits(body.owner_cpf_cnpj, 14);
    const ownerPhone = digits(body.owner_phone, 13);
    const planId = cleanText(body.plan_id, 64);
    const billingCycle: BillingCycle = body.billing_cycle === "YEARLY"
      ? "YEARLY"
      : "MONTHLY";
    const billingType = parseSaasCheckoutBillingType(body.billing_type);
    if (!billingType) {
      return json({
        error: "Forma de pagamento indisponível. Use PIX ou boleto.",
        code: "BILLING_TYPE_NOT_ALLOWED",
      }, 400);
    }
    const requestedIdempotencyKey = cleanText(body.idempotency_key, 64);
    if (!validUuid(requestedIdempotencyKey)) {
      return json({
        error: "Identificador da tentativa inválido.",
        code: "INVALID_IDEMPOTENCY_KEY",
      }, 400);
    }
    const idempotencyKey = requestedIdempotencyKey;

    if (
      schoolName.length < 3 ||
      ownerName.length < 3 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) ||
      ownerCpfCnpj.length < 11 ||
      ownerPhone.length < 10 ||
      !validUuid(planId)
    ) {
      return json({ error: "Revise os dados obrigatórios do checkout" }, 400);
    }

    const expectedPayload = {
      schoolName,
      ownerName,
      ownerEmail,
      ownerCpfCnpj,
      ownerPhone,
      planId,
      billingCycle,
      billingType,
    };
    let { data: checkout, error: existingError } = await supabase
      .from("saas_checkout_intents")
      .select(CHECKOUT_COLUMNS)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingError) {
      console.error("SaaS checkout idempotency lookup failed", {
        code: existingError.code,
      });
      return json({ error: "Não foi possível iniciar o checkout" }, 500);
    }
    if (checkout && !checkoutPayloadMatches(checkout, expectedPayload)) {
      return json({
        error: "A chave desta tentativa já foi usada com outros dados.",
        code: "IDEMPOTENCY_KEY_REUSED",
      }, 409);
    }
    if (
      checkout &&
      ["PAYMENT_PENDING", "PAID", "PROVISIONING", "PROVISIONED"].includes(
        checkout.status,
      )
    ) {
      return json(publicCheckoutResult(checkout));
    }
    if (checkout && ["CANCELLED", "OVERDUE"].includes(checkout.status)) {
      return json({
        error: "Esta tentativa foi encerrada. Inicie uma nova contratação.",
        checkout_id: checkout.id,
      }, 409);
    }

    const { data: plan, error: planError } = await supabase
      .from("saas_plans")
      .select(
        "id,name,price,price_yearly,max_students,max_users,max_teachers,plan_type,active",
      )
      .eq("id", planId)
      .maybeSingle();
    if (planError || !plan || (!checkout && plan.active !== true)) {
      return json({ error: "Plano indisponível" }, 400);
    }

    if (!checkout) {
      const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]
        ?.trim();
      const clientAddress = forwardedFor ||
        req.headers.get("cf-connecting-ip")?.trim() ||
        req.headers.get("x-real-ip")?.trim() ||
        "unknown";
      const rateIdentity = clientAddress === "unknown"
        ? ownerEmail
        : clientAddress;
      const rateKey = await sha256(`saas-checkout:${rateIdentity}`);
      const { data: rateAllowed, error: rateError } = await supabase.rpc(
        "consume_saas_checkout_rate_limit",
        { p_rate_key: rateKey, p_max_requests: 5 },
      );
      if (rateError) {
        console.error("SaaS checkout rate limit failed", {
          code: rateError.code,
        });
        return json({ error: "Não foi possível iniciar o checkout" }, 500);
      }
      if (!rateAllowed) {
        return json(
          {
            error:
              "Muitas tentativas. Aguarde um pouco antes de tentar novamente.",
          },
          429,
        );
      }

      const monthlyPrice = Number(plan.price);
      const yearlyPrice = Number(plan.price_yearly || monthlyPrice * 12);
      const price = billingCycle === "YEARLY" ? yearlyPrice : monthlyPrice;
      if (!Number.isFinite(price) || price <= 0) {
        return json({ error: "Preço do plano inválido" }, 400);
      }

      checkoutId = crypto.randomUUID();
      providerAttemptToken = crypto.randomUUID();
      checkoutMetadata = {
        source: "new-saas",
        address: cleanText(body.address, 180),
        addressNumber: cleanText(body.addressNumber, 20),
        province: cleanText(body.province, 100),
        postalCode: digits(body.postalCode, 8),
        providerSubscriptionDescription:
          `Assinatura Wise Wolf - Plano ${plan.name} (${billingCycle})`.slice(
            0,
            500,
          ),
        providerAttemptToken,
        providerLeaseUntil: new Date(Date.now() + 120_000).toISOString(),
      };

      const { data: lead, error: leadError } = await supabase
        .from("saas_leads")
        .insert({
          name: ownerName,
          email: ownerEmail,
          phone: ownerPhone,
          school_name: schoolName,
          owner_name: ownerName,
          owner_email: ownerEmail,
          owner_phone: ownerPhone,
          owner_cpf_cnpj: ownerCpfCnpj,
          source: "public_checkout",
          status: "CHECKOUT",
          plan_interest: plan.name,
          lead_type: plan.plan_type,
          notes: `Plano: ${plan.name} · Ciclo: ${billingCycle}`,
        })
        .select("id")
        .single();
      if (leadError || !lead) {
        console.error("SaaS lead creation failed", { code: leadError?.code });
        return json({ error: "Não foi possível iniciar o checkout" }, 500);
      }

      const { data: insertedCheckout, error: intentError } = await supabase
        .from("saas_checkout_intents")
        .insert({
          id: checkoutId,
          idempotency_key: idempotencyKey,
          school_name: schoolName,
          tenant_slug: `${slugBase(schoolName)}-${checkoutId.slice(0, 8)}`,
          owner_name: ownerName,
          owner_email: ownerEmail,
          owner_phone: ownerPhone,
          owner_cpf_cnpj: ownerCpfCnpj,
          plan_id: plan.id,
          billing_cycle: billingCycle,
          billing_type: billingType,
          amount: price,
          lead_id: lead.id,
          metadata: checkoutMetadata,
        })
        .select(CHECKOUT_COLUMNS)
        .single();
      if (intentError || !insertedCheckout) {
        const { error: leadCleanupError } = await supabase
          .from("saas_leads")
          .delete()
          .eq("id", lead.id);
        if (leadCleanupError) {
          console.error("SaaS duplicate lead compensation failed", {
            code: leadCleanupError.code,
          });
        }
        if (intentError?.code === "23505") {
          const retryLookup = await supabase.from("saas_checkout_intents")
            .select(CHECKOUT_COLUMNS)
            .eq("idempotency_key", idempotencyKey)
            .maybeSingle();
          if (
            retryLookup.data &&
            checkoutPayloadMatches(retryLookup.data, expectedPayload)
          ) {
            return json({
              error: "Esta contratação já está sendo processada.",
              code: "CHECKOUT_IN_PROGRESS",
              checkout_id: retryLookup.data.id,
            }, 409);
          }
        }
        console.error("SaaS checkout intent creation failed", {
          code: intentError?.code,
        });
        return json({ error: "Não foi possível iniciar o checkout" }, 500);
      }
      checkout = insertedCheckout;
    } else {
      checkoutId = checkout.id;
      checkoutMetadata = asRecord(checkout.metadata);
      const currentLease = Date.parse(cleanText(
        checkoutMetadata.providerLeaseUntil,
        64,
      ));
      if (Number.isFinite(currentLease) && currentLease > Date.now()) {
        return json({
          error: "Esta contratação já está sendo processada.",
          code: "CHECKOUT_IN_PROGRESS",
          checkout_id: checkout.id,
        }, 409);
      }
      providerAttemptToken = crypto.randomUUID();
      checkoutMetadata = {
        ...checkoutMetadata,
        providerAttemptToken,
        providerLeaseUntil: new Date(Date.now() + 120_000).toISOString(),
      };
      const { data: claimedCheckout, error: claimError } = await supabase
        .from("saas_checkout_intents")
        .update({
          metadata: checkoutMetadata,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", checkout.id)
        .eq("updated_at", checkout.updated_at)
        .eq("status", "PENDING")
        .select(CHECKOUT_COLUMNS)
        .maybeSingle();
      if (claimError || !claimedCheckout) {
        return json({
          error: "Esta contratação já está sendo processada.",
          code: "CHECKOUT_IN_PROGRESS",
          checkout_id: checkout.id,
        }, 409);
      }
      checkout = claimedCheckout;
    }

    checkoutId = checkout.id;
    checkoutMetadata = asRecord(checkout.metadata);
    const amount = Number(checkout.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("invalid_checkout_amount");
    }
    const reference = saasCheckoutProviderReference(checkout.id);
    const customerPayload: JsonRecord = {
      name: cleanText(checkout.school_name, 140),
      email: cleanText(checkout.owner_email, 254).toLowerCase(),
      cpfCnpj: digits(checkout.owner_cpf_cnpj, 14),
      mobilePhone: digits(checkout.owner_phone, 13),
      address: cleanText(checkoutMetadata.address, 180) || "A definir",
      addressNumber: cleanText(checkoutMetadata.addressNumber, 20) || "SN",
      province: cleanText(checkoutMetadata.province, 100) || "Centro",
      postalCode: digits(checkoutMetadata.postalCode, 8) || "01000000",
      externalReference: reference,
    };
    const customerLogicalKey = `saas-checkout:${checkout.id}:customer`;
    let customerId = normalizeProviderId(checkout.asaas_customer_id);
    if (checkout.asaas_customer_id && !customerId) {
      throw new ProviderReviewRequiredError("invalid_provider_customer_link");
    }
    if (customerId) {
      const linkedCustomer = await loadProviderEntity(
        customerReadIntegration,
        `/customers/${encodeURIComponent(customerId)}`,
      );
      const linkedResolution = resolveProviderCustomer(
        [linkedCustomer],
        reference,
        ownerCpfCnpj,
      );
      if (
        linkedResolution.status !== "MATCH" ||
        linkedResolution.id !== customerId
      ) {
        throw new ProviderReviewRequiredError(
          "provider_customer_local_link_mismatch",
        );
      }
    } else {
      const customerClaim = await claimAsaasCreation(supabase, {
        tenantId: PLATFORM_ASAAS_TENANT_ID,
        operation: "CUSTOMER_CREATE",
        logicalKey: customerLogicalKey,
        externalReference: reference,
        requestFingerprint: await asaasCreationFingerprint({
          tenantId: PLATFORM_ASAAS_TENANT_ID,
          operation: "CUSTOMER_CREATE",
          logicalKey: customerLogicalKey,
          payload: customerPayload,
        }),
      });

      if (customerClaim.action === "IN_PROGRESS") {
        throw new ProviderCreationInProgressError(
          customerClaim.retry_after_seconds || 15,
        );
      }
      if (customerClaim.action === "REVIEW_REQUIRED" || !customerClaim.ok) {
        throw new ProviderReviewRequiredError(
          "provider_customer_creation_requires_review",
        );
      }

      if (customerClaim.action === "ALREADY_SUCCEEDED") {
        customerId = normalizeProviderId(customerClaim.provider_entity_id);
        if (!customerId) {
          throw new ProviderReviewRequiredError(
            "provider_customer_claim_id_invalid",
          );
        }
        const claimedCustomer = await loadProviderEntity(
          customerReadIntegration,
          `/customers/${encodeURIComponent(customerId)}`,
        );
        const claimedResolution = resolveProviderCustomer(
          [claimedCustomer],
          reference,
          ownerCpfCnpj,
        );
        if (
          claimedResolution.status !== "MATCH" ||
          claimedResolution.id !== customerId
        ) {
          throw new ProviderReviewRequiredError(
            "provider_customer_claim_mismatch",
          );
        }
      } else {
        const customerLookup = await findUniqueAsaasEntity<JsonRecord>({
          baseUrl: customerReadIntegration.baseUrl,
          apiKey: customerReadIntegration.apiKey,
          path: "customers",
          query: { externalReference: reference },
          matches: (candidate) =>
            resolveProviderCustomer(
              [candidate],
              reference,
              ownerCpfCnpj,
            ).status === "MATCH",
          conflicts: (candidate) =>
            activeProviderIdentity(candidate, reference),
        });
        if (
          customerLookup.kind === "DUPLICATE" ||
          customerLookup.kind === "CONFLICT"
        ) {
          await recordAsaasCreationState(supabase, customerClaim, {
            status: "BLOCKED",
            error: customerLookup.kind === "DUPLICATE"
              ? "duplicate_saas_provider_customers"
              : "saas_provider_customer_identity_conflict",
          });
          throw new ProviderReviewRequiredError(
            "provider_customer_duplicate_or_conflict",
          );
        }
        if (customerLookup.kind === "UNAVAILABLE") {
          await recordAsaasCreationState(supabase, customerClaim, {
            status: customerClaim.action === "RECONCILE_REQUIRED"
              ? "UNKNOWN"
              : "RETRY",
            httpStatus: customerLookup.httpStatus,
            error: "saas_customer_recovery_lookup_unavailable",
          });
          throw new ProviderStateAmbiguousError();
        }
        if (customerLookup.kind === "FOUND") {
          customerId = normalizeProviderId(customerLookup.entity.id);
          if (!customerId) {
            await recordAsaasCreationState(supabase, customerClaim, {
              status: "BLOCKED",
              error: "saas_provider_customer_id_invalid",
            });
            throw new ProviderReviewRequiredError(
              "provider_customer_id_invalid",
            );
          }
          await recordAsaasCreationState(supabase, customerClaim, {
            status: "SUCCEEDED",
            providerEntityId: customerId,
            providerStatus: cleanText(customerLookup.entity.status, 80),
          });
        } else if (customerClaim.action === "RECONCILE_REQUIRED") {
          await recordAsaasCreationState(supabase, customerClaim, {
            status: "UNKNOWN",
            error: "saas_customer_not_yet_observed",
          });
          throw new ProviderStateAmbiguousError();
        } else {
          const customerMutationState = await supabase
            .from("saas_checkout_intents")
            .select("status,asaas_customer_id")
            .eq("id", checkout.id)
            .maybeSingle();
          if (customerMutationState.error || !customerMutationState.data) {
            throw new ProviderStateAmbiguousError();
          }
          if (
            customerMutationState.data.status !== "PENDING" ||
            customerMutationState.data.asaas_customer_id !== null
          ) {
            throw new ProviderReviewRequiredError(
              "checkout_customer_creation_state_changed",
            );
          }
          let customerCreateIntegration: ResolvedAsaasIntegration;
          try {
            customerCreateIntegration = await resolvePlatformAsaasIntegration(
              supabase,
              "customer.create",
            );
          } catch {
            await recordAsaasCreationState(supabase, customerClaim, {
              status: "RETRY",
              error: "saas_customer_create_capability_unavailable",
            });
            throw new ProviderTemporarilyUnavailableError();
          }
          if (
            !sameAsaasIntegration(
              customerReadIntegration,
              customerCreateIntegration,
            )
          ) {
            await recordAsaasCreationState(supabase, customerClaim, {
              status: "RETRY",
              error: "saas_customer_integration_changed_before_submit",
            });
            throw new ProviderTemporarilyUnavailableError();
          }
          try {
            await markAsaasCreationSubmitting(supabase, customerClaim);
          } catch {
            throw new ProviderCreationInProgressError(15);
          }

          let freshCustomerCreateIntegration: ResolvedAsaasIntegration;
          try {
            freshCustomerCreateIntegration =
              await revalidateAsaasMutationCapability(
                supabase,
                {
                  tenantId: PLATFORM_ASAAS_TENANT_ID,
                  purpose: "customer.create",
                  expected: customerCreateIntegration,
                },
              );
          } catch (error) {
            const unavailable = error instanceof AsaasCapabilityFenceError &&
              error.failure === "UNAVAILABLE";
            await recordAsaasCreationState(supabase, customerClaim, {
              status: "BLOCKED",
              error: unavailable
                ? "saas_customer_capability_unavailable_before_post"
                : "saas_customer_capability_changed_before_post",
            });
            if (unavailable) throw new ProviderTemporarilyUnavailableError();
            throw new ProviderReviewRequiredError(
              "customer_integration_changed_before_post",
            );
          }

          let customerResponse: Response;
          try {
            customerResponse = await fetch(
              `${freshCustomerCreateIntegration.baseUrl}/customers`,
              {
                method: "POST",
                headers: {
                  access_token: freshCustomerCreateIntegration.apiKey,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(customerPayload),
                signal: AbortSignal.timeout(15_000),
              },
            );
          } catch {
            try {
              await recordAsaasCreationState(supabase, customerClaim, {
                status: "UNKNOWN",
                error: "saas_customer_post_outcome_unknown",
              });
            } catch {
              // SUBMITTING still fences every future attempt to GET-only recovery.
            }
            throw new ProviderStateAmbiguousError();
          }

          const rawCustomer = await customerResponse.text();
          let customer: JsonRecord = {};
          try {
            customer = asRecord(JSON.parse(rawCustomer));
          } catch {
            // A malformed success response is an unknown provider outcome.
          }
          const submittedCustomerId = normalizeProviderId(customer.id) || "";
          const outcome = asaasCreationHttpOutcome(
            customerResponse.ok,
            customerResponse.status,
            submittedCustomerId,
          );
          if (
            outcome === "SUCCEEDED" &&
            resolveProviderCustomer(
                [customer],
                reference,
                ownerCpfCnpj,
              ).status !== "MATCH"
          ) {
            try {
              await recordAsaasCreationState(supabase, customerClaim, {
                status: "BLOCKED",
                providerEntityId: submittedCustomerId,
                providerStatus: cleanText(customer.status, 80),
                httpStatus: customerResponse.status,
                error: "saas_customer_response_payload_conflict",
              });
            } catch {
              throw new ProviderStateAmbiguousError();
            }
            throw new ProviderReviewRequiredError(
              "provider_customer_response_mismatch",
            );
          }
          try {
            await recordAsaasCreationState(supabase, customerClaim, {
              status: outcome,
              providerEntityId: submittedCustomerId,
              providerStatus: cleanText(customer.status, 80),
              httpStatus: customerResponse.status,
              error: outcome === "SUCCEEDED"
                ? null
                : outcome === "FAILED"
                ? "saas_customer_creation_rejected"
                : "saas_customer_post_outcome_unknown",
            });
          } catch {
            throw new ProviderStateAmbiguousError();
          }
          if (outcome === "UNKNOWN") {
            throw new ProviderStateAmbiguousError();
          }
          if (outcome === "FAILED") {
            throw new ProviderCreationRejectedError(customerResponse.status);
          }
          customerId = submittedCustomerId;
        }
      }

      if (!customerId) throw new ProviderStateAmbiguousError();
      const { data: linkedCheckout, error: customerLinkError } = await supabase
        .from("saas_checkout_intents")
        .update({
          asaas_customer_id: customerId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", checkout.id)
        .eq("status", "PENDING")
        .is("asaas_customer_id", null)
        .select("asaas_customer_id")
        .maybeSingle();
      if (
        customerLinkError || linkedCheckout?.asaas_customer_id !== customerId
      ) {
        const currentLink = await supabase.from("saas_checkout_intents")
          .select("status,asaas_customer_id")
          .eq("id", checkout.id)
          .maybeSingle();
        if (currentLink.error) throw new ProviderStateAmbiguousError();
        if (currentLink.data?.status !== "PENDING") {
          throw new ProviderCreationInProgressError(5);
        }
        if (
          normalizeProviderId(currentLink.data?.asaas_customer_id) !==
            customerId
        ) {
          throw new ProviderReviewRequiredError(
            "provider_customer_local_link_conflict",
          );
        }
      }
    }

    if (!customerId) throw new ProviderStateAmbiguousError();
    const nextDueDate = saasCheckoutNextDueDate(checkout.created_at);
    if (!nextDueDate) {
      throw new ProviderReviewRequiredError("checkout_created_at_invalid");
    }
    const subscriptionDescription = cleanText(
      checkoutMetadata.providerSubscriptionDescription,
      500,
    ) ||
      `Assinatura Wise Wolf - Plano ${checkout.plan_id} (${checkout.billing_cycle})`
        .slice(0, 500);
    const subscriptionPayload: JsonRecord = {
      customer: customerId,
      billingType,
      value: amount,
      nextDueDate,
      cycle: billingCycle,
      description: subscriptionDescription,
      externalReference: reference,
    };
    const subscriptionExpected = {
      reference,
      customerId,
      billingType,
      billingCycle,
      amount,
      description: subscriptionDescription,
      maxPayments: null,
      splitPolicy: { kind: "NONE" as const },
      nextDueDate,
      status: "ACTIVE" as const,
    };
    const subscriptionLogicalKey = `saas-checkout:${checkout.id}:subscription`;
    let subscriptionId = normalizeProviderId(checkout.asaas_subscription_id);
    if (checkout.asaas_subscription_id && !subscriptionId) {
      throw new ProviderReviewRequiredError(
        "invalid_provider_subscription_link",
      );
    }
    if (subscriptionId) {
      const linkedSubscription = await loadProviderEntity(
        subscriptionReadIntegration,
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );
      const linkedResolution = resolveProviderSubscription(
        [linkedSubscription],
        subscriptionExpected,
      );
      if (
        linkedResolution.status !== "MATCH" ||
        linkedResolution.id !== subscriptionId
      ) {
        throw new ProviderReviewRequiredError(
          "provider_subscription_local_link_mismatch",
        );
      }
    } else {
      const subscriptionClaim = await claimAsaasCreation(supabase, {
        tenantId: PLATFORM_ASAAS_TENANT_ID,
        operation: "SUBSCRIPTION_CREATE",
        logicalKey: subscriptionLogicalKey,
        externalReference: reference,
        requestFingerprint: await asaasCreationFingerprint({
          tenantId: PLATFORM_ASAAS_TENANT_ID,
          operation: "SUBSCRIPTION_CREATE",
          logicalKey: subscriptionLogicalKey,
          payload: subscriptionPayload,
        }),
      });

      if (subscriptionClaim.action === "IN_PROGRESS") {
        throw new ProviderCreationInProgressError(
          subscriptionClaim.retry_after_seconds || 15,
        );
      }
      if (
        subscriptionClaim.action === "REVIEW_REQUIRED" ||
        !subscriptionClaim.ok
      ) {
        throw new ProviderReviewRequiredError(
          "provider_subscription_creation_requires_review",
        );
      }

      if (subscriptionClaim.action === "ALREADY_SUCCEEDED") {
        subscriptionId = normalizeProviderId(
          subscriptionClaim.provider_entity_id,
        );
        if (!subscriptionId) {
          throw new ProviderReviewRequiredError(
            "provider_subscription_claim_id_invalid",
          );
        }
        const claimedSubscription = await loadProviderEntity(
          subscriptionReadIntegration,
          `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        );
        const claimedResolution = resolveProviderSubscription(
          [claimedSubscription],
          subscriptionExpected,
        );
        if (
          claimedResolution.status !== "MATCH" ||
          claimedResolution.id !== subscriptionId
        ) {
          throw new ProviderReviewRequiredError(
            "provider_subscription_claim_mismatch",
          );
        }
      } else {
        const subscriptionLookup = await findUniqueAsaasEntity<JsonRecord>({
          baseUrl: subscriptionReadIntegration.baseUrl,
          apiKey: subscriptionReadIntegration.apiKey,
          path: "subscriptions",
          query: { externalReference: reference },
          matches: (candidate) =>
            resolveProviderSubscription(
              [candidate],
              subscriptionExpected,
            ).status === "MATCH",
          conflicts: (candidate) =>
            activeProviderIdentity(candidate, reference),
        });
        if (
          subscriptionLookup.kind === "DUPLICATE" ||
          subscriptionLookup.kind === "CONFLICT"
        ) {
          await recordAsaasCreationState(supabase, subscriptionClaim, {
            status: "BLOCKED",
            error: subscriptionLookup.kind === "DUPLICATE"
              ? "duplicate_saas_provider_subscriptions"
              : "saas_provider_subscription_payload_conflict",
          });
          throw new ProviderReviewRequiredError(
            "provider_subscription_duplicate_or_conflict",
          );
        }
        if (subscriptionLookup.kind === "UNAVAILABLE") {
          await recordAsaasCreationState(supabase, subscriptionClaim, {
            status: subscriptionClaim.action === "RECONCILE_REQUIRED"
              ? "UNKNOWN"
              : "RETRY",
            httpStatus: subscriptionLookup.httpStatus,
            error: "saas_subscription_recovery_lookup_unavailable",
          });
          throw new ProviderStateAmbiguousError();
        }
        if (subscriptionLookup.kind === "FOUND") {
          subscriptionId = normalizeProviderId(subscriptionLookup.entity.id);
          if (!subscriptionId) {
            await recordAsaasCreationState(supabase, subscriptionClaim, {
              status: "BLOCKED",
              error: "saas_provider_subscription_id_invalid",
            });
            throw new ProviderReviewRequiredError(
              "provider_subscription_id_invalid",
            );
          }
          await recordAsaasCreationState(supabase, subscriptionClaim, {
            status: "SUCCEEDED",
            providerEntityId: subscriptionId,
            providerStatus: cleanText(subscriptionLookup.entity.status, 80),
          });
        } else if (subscriptionClaim.action === "RECONCILE_REQUIRED") {
          await recordAsaasCreationState(supabase, subscriptionClaim, {
            status: "UNKNOWN",
            error: "saas_subscription_not_yet_observed",
          });
          throw new ProviderStateAmbiguousError();
        } else {
          const subscriptionMutationState = await supabase
            .from("saas_checkout_intents")
            .select("status,asaas_customer_id,asaas_subscription_id")
            .eq("id", checkout.id)
            .maybeSingle();
          if (
            subscriptionMutationState.error ||
            !subscriptionMutationState.data
          ) {
            throw new ProviderStateAmbiguousError();
          }
          if (
            subscriptionMutationState.data.status !== "PENDING" ||
            normalizeProviderId(
                subscriptionMutationState.data.asaas_customer_id,
              ) !== customerId ||
            subscriptionMutationState.data.asaas_subscription_id !== null
          ) {
            throw new ProviderReviewRequiredError(
              "checkout_subscription_creation_state_changed",
            );
          }
          let subscriptionCreateIntegration: ResolvedAsaasIntegration;
          try {
            subscriptionCreateIntegration =
              await resolvePlatformAsaasIntegration(
                supabase,
                "subscription.create",
              );
          } catch {
            await recordAsaasCreationState(supabase, subscriptionClaim, {
              status: "RETRY",
              error: "saas_subscription_create_capability_unavailable",
            });
            throw new ProviderTemporarilyUnavailableError();
          }
          if (
            !sameAsaasIntegration(
              subscriptionReadIntegration,
              subscriptionCreateIntegration,
            )
          ) {
            await recordAsaasCreationState(supabase, subscriptionClaim, {
              status: "RETRY",
              error: "saas_subscription_integration_changed_before_submit",
            });
            throw new ProviderTemporarilyUnavailableError();
          }
          try {
            await markAsaasCreationSubmitting(supabase, subscriptionClaim);
          } catch {
            throw new ProviderCreationInProgressError(15);
          }

          let freshSubscriptionCreateIntegration: ResolvedAsaasIntegration;
          try {
            freshSubscriptionCreateIntegration =
              await revalidateAsaasMutationCapability(
                supabase,
                {
                  tenantId: PLATFORM_ASAAS_TENANT_ID,
                  purpose: "subscription.create",
                  expected: subscriptionCreateIntegration,
                },
              );
          } catch (error) {
            const unavailable = error instanceof AsaasCapabilityFenceError &&
              error.failure === "UNAVAILABLE";
            await recordAsaasCreationState(supabase, subscriptionClaim, {
              status: "BLOCKED",
              error: unavailable
                ? "saas_subscription_capability_unavailable_before_post"
                : "saas_subscription_capability_changed_before_post",
            });
            if (unavailable) throw new ProviderTemporarilyUnavailableError();
            throw new ProviderReviewRequiredError(
              "subscription_integration_changed_before_post",
            );
          }

          let subscriptionResponse: Response;
          try {
            subscriptionResponse = await fetch(
              `${freshSubscriptionCreateIntegration.baseUrl}/subscriptions`,
              {
                method: "POST",
                headers: {
                  access_token: freshSubscriptionCreateIntegration.apiKey,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(subscriptionPayload),
                signal: AbortSignal.timeout(15_000),
              },
            );
          } catch {
            try {
              await recordAsaasCreationState(supabase, subscriptionClaim, {
                status: "UNKNOWN",
                error: "saas_subscription_post_outcome_unknown",
              });
            } catch {
              // SUBMITTING still fences every future attempt to GET-only recovery.
            }
            throw new ProviderStateAmbiguousError();
          }

          const rawSubscription = await subscriptionResponse.text();
          let subscription: JsonRecord = {};
          try {
            subscription = asRecord(JSON.parse(rawSubscription));
          } catch {
            // A malformed success response is an unknown provider outcome.
          }
          const submittedSubscriptionId =
            normalizeProviderId(subscription.id) ||
            "";
          const outcome = asaasCreationHttpOutcome(
            subscriptionResponse.ok,
            subscriptionResponse.status,
            submittedSubscriptionId,
          );
          if (
            outcome === "SUCCEEDED" &&
            resolveProviderSubscription(
                [subscription],
                subscriptionExpected,
              ).status !== "MATCH"
          ) {
            try {
              await recordAsaasCreationState(supabase, subscriptionClaim, {
                status: "BLOCKED",
                providerEntityId: submittedSubscriptionId,
                providerStatus: cleanText(subscription.status, 80),
                httpStatus: subscriptionResponse.status,
                error: "saas_subscription_response_payload_conflict",
              });
            } catch {
              throw new ProviderStateAmbiguousError();
            }
            throw new ProviderReviewRequiredError(
              "provider_subscription_response_mismatch",
            );
          }
          try {
            await recordAsaasCreationState(supabase, subscriptionClaim, {
              status: outcome,
              providerEntityId: submittedSubscriptionId,
              providerStatus: cleanText(subscription.status, 80),
              httpStatus: subscriptionResponse.status,
              error: outcome === "SUCCEEDED"
                ? null
                : outcome === "FAILED"
                ? "saas_subscription_creation_rejected"
                : "saas_subscription_post_outcome_unknown",
            });
          } catch {
            throw new ProviderStateAmbiguousError();
          }
          if (outcome === "UNKNOWN") {
            throw new ProviderStateAmbiguousError();
          }
          if (outcome === "FAILED") {
            throw new ProviderCreationRejectedError(
              subscriptionResponse.status,
            );
          }
          subscriptionId = submittedSubscriptionId;
        }
      }

      if (!subscriptionId) throw new ProviderStateAmbiguousError();
      const { data: linkedCheckout, error: subscriptionLinkError } =
        await supabase
          .from("saas_checkout_intents")
          .update({
            asaas_subscription_id: subscriptionId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", checkout.id)
          .eq("status", "PENDING")
          .is("asaas_subscription_id", null)
          .select("asaas_subscription_id")
          .maybeSingle();
      if (
        subscriptionLinkError ||
        normalizeProviderId(linkedCheckout?.asaas_subscription_id) !==
          subscriptionId
      ) {
        const currentLink = await supabase.from("saas_checkout_intents")
          .select("status,asaas_subscription_id")
          .eq("id", checkout.id)
          .maybeSingle();
        if (currentLink.error) throw new ProviderStateAmbiguousError();
        if (currentLink.data?.status !== "PENDING") {
          throw new ProviderCreationInProgressError(5);
        }
        if (
          normalizeProviderId(currentLink.data?.asaas_subscription_id) !==
            subscriptionId
        ) {
          throw new ProviderReviewRequiredError(
            "provider_subscription_local_link_conflict",
          );
        }
      }
    }

    if (!subscriptionId) throw new ProviderStateAmbiguousError();

    const payments = await loadAllSubscriptionPayments(
      subscriptionReadIntegration,
      subscriptionId,
    );
    const matchingPayments = payments.filter((candidate) =>
      candidate.deleted !== true &&
      normalizeProviderId(candidate.id) !== null &&
      cleanText(candidate.subscription, 200) === subscriptionId &&
      cleanText(candidate.customer, 200) === customerId &&
      cleanText(candidate.billingType, 40).toUpperCase() === billingType &&
      Number.isFinite(Number(candidate.value)) &&
      Math.round(Number(candidate.value) * 100) === Math.round(amount * 100) &&
      cleanText(candidate.dueDate, 10) === nextDueDate
    );
    if (matchingPayments.length > 1) {
      throw new ProviderReviewRequiredError(
        "provider_subscription_payment_duplicate",
      );
    }
    if (matchingPayments.length === 0) {
      throw new ProviderStateAmbiguousError();
    }
    const firstPayment = matchingPayments[0];
    const paymentId = normalizeProviderId(firstPayment.id);
    if (!paymentId) throw new ProviderStateAmbiguousError();

    let pixData: JsonRecord = {};
    if (billingType === "PIX") {
      try {
        pixData = await asaasRequest(
          paymentReadIntegration,
          `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
        );
      } catch {
        throw new ProviderStateAmbiguousError();
      }
    }

    const completedMetadata = {
      ...withoutProviderLease(checkoutMetadata),
      providerLinkedAt: new Date().toISOString(),
    };
    let { data: completedCheckout, error: updateError } = await supabase
      .from("saas_checkout_intents")
      .update({
        status: "PAYMENT_PENDING",
        asaas_customer_id: customerId,
        asaas_subscription_id: subscriptionId,
        asaas_payment_id: paymentId,
        invoice_url: cleanText(firstPayment.invoiceUrl, 1000) || null,
        bank_slip_url: cleanText(firstPayment.bankSlipUrl, 1000) || null,
        pix_payload: cleanText(pixData.payload, 10000) || null,
        pix_encoded_image: cleanText(pixData.encodedImage, 200000) || null,
        due_date: cleanText(firstPayment.dueDate, 10) || null,
        metadata: completedMetadata,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", checkout.id)
      .eq("asaas_subscription_id", subscriptionId)
      .eq("status", "PENDING")
      .select(CHECKOUT_COLUMNS)
      .maybeSingle();
    if (!updateError && !completedCheckout) {
      const advancedCheckout = await supabase.from("saas_checkout_intents")
        .select(CHECKOUT_COLUMNS)
        .eq("id", checkout.id)
        .maybeSingle();
      if (
        advancedCheckout.data &&
        ["PAYMENT_PENDING", "PAID", "PROVISIONING", "PROVISIONED"].includes(
          advancedCheckout.data.status,
        )
      ) {
        completedCheckout = advancedCheckout.data;
      } else if (advancedCheckout.error) {
        updateError = advancedCheckout.error;
      }
    }
    if (updateError || !completedCheckout) {
      console.error("SaaS checkout finalization failed", {
        code: updateError?.code,
      });
      throw new Error("checkout_finalization_failed");
    }

    return json({
      ...publicCheckoutResult(completedCheckout),
      lead_id: completedCheckout.lead_id,
      plan_name: plan.name,
      message: "Pagamento criado. O acesso será liberado após a confirmação.",
    });
  } catch (error) {
    const ambiguous = mutationWasAmbiguous(error);
    const reviewRequired = error instanceof ProviderReviewRequiredError;
    const inProgress = error instanceof ProviderCreationInProgressError;
    const rejected = error instanceof ProviderCreationRejectedError;
    const temporarilyUnavailable = error instanceof
      ProviderTemporarilyUnavailableError;
    console.error("SaaS checkout failed", {
      type: error instanceof Error ? error.name : "unknown",
      ambiguous,
      reviewRequired,
    });
    if (checkoutId) {
      const metadata = ambiguous
        ? {
          ...clearProviderLease(checkoutMetadata),
          providerReconciliationRequired: true,
          providerReviewRequired: false,
        }
        : reviewRequired
        ? {
          ...clearProviderLease(checkoutMetadata),
          providerReconciliationRequired: false,
          providerReviewRequired: true,
        }
        : withoutProviderLease(checkoutMetadata);
      const lastError = ambiguous
        ? "provider_reconciliation_required"
        : reviewRequired
        ? "provider_creation_requires_review"
        : inProgress
        ? "provider_creation_in_progress"
        : rejected
        ? `provider_creation_rejected_${error.providerStatus}`
        : temporarilyUnavailable
        ? "provider_temporarily_unavailable"
        : "checkout_attempt_failed";
      let failureUpdate = supabase.from("saas_checkout_intents").update({
        metadata,
        last_error: lastError,
        updated_at: new Date().toISOString(),
      })
        .eq("id", checkoutId)
        .eq("status", "PENDING");
      if (providerAttemptToken) {
        failureUpdate = failureUpdate.eq(
          "metadata->>providerAttemptToken",
          providerAttemptToken,
        );
      }
      const { error: failureUpdateError } = await failureUpdate;
      if (failureUpdateError) {
        console.error("SaaS checkout failure state persistence failed", {
          code: failureUpdateError.code,
        });
      }
    }

    const responseStatus = ambiguous
      ? 503
      : temporarilyUnavailable
      ? 503
      : reviewRequired || inProgress
      ? 409
      : rejected
      ? 422
      : 500;
    const responseCode = ambiguous
      ? "PROVIDER_RECONCILIATION_REQUIRED"
      : temporarilyUnavailable
      ? "PROVIDER_UNAVAILABLE"
      : reviewRequired
      ? "PROVIDER_REVIEW_REQUIRED"
      : inProgress
      ? "CHECKOUT_IN_PROGRESS"
      : rejected
      ? "PROVIDER_REQUEST_REJECTED"
      : "CHECKOUT_FAILED";
    const responseMessage = ambiguous
      ? "O provedor ainda está conciliando esta tentativa. Aguarde antes de tentar novamente."
      : temporarilyUnavailable
      ? "O checkout está temporariamente indisponível. Tente novamente com a mesma tentativa."
      : reviewRequired
      ? "Esta contratação precisa de revisão antes de uma nova tentativa."
      : inProgress
      ? "Esta contratação já está sendo processada."
      : rejected
      ? "O provedor recusou os dados da contratação. Revise as informações."
      : "Não foi possível concluir o checkout. Tente novamente com a mesma tentativa.";
    return json(
      {
        error: responseMessage,
        code: responseCode,
        checkout_id: checkoutId,
        ...(inProgress ? { retry_after_seconds: error.retryAfterSeconds } : {}),
      },
      responseStatus,
    );
  }
});
