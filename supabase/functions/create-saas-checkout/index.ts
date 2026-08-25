/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  checkoutPayloadMatches,
  containsCardMaterial,
  normalizeProviderId,
  parseSaasCheckoutBillingType,
  requiresProviderReconciliation,
  resolveProviderCustomer,
  resolveProviderSubscription,
  saasCheckoutProviderReference,
  type SaasCheckoutBillingType,
} from "./provider-safety.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ASAAS_URL = (Deno.env.get("ASAAS_API_URL") || "https://api.asaas.com")
  .replace(/\/+$/, "")
  .replace(/\/v3$/, "");
const ASAAS_TOKEN = (
  Deno.env.get("ASAAS_ACCESS_TOKEN") ||
  Deno.env.get("ASAAS_API_KEY") ||
  ""
).trim();
const CHECKOUT_COLUMNS = "id,idempotency_key,status,school_name,owner_name,owner_email,owner_phone,owner_cpf_cnpj,plan_id,billing_cycle,billing_type,amount,lead_id,asaas_customer_id,asaas_subscription_id,asaas_payment_id,invoice_url,bank_slip_url,pix_payload,pix_encoded_image,due_date,metadata,updated_at";

type BillingCycle = "MONTHLY" | "YEARLY";
type JsonRecord = Record<string, unknown>;

class AsaasRequestError extends Error {
  constructor(
    readonly status: number,
    readonly ambiguous: boolean,
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

function mutationWasAmbiguous(error: unknown): boolean {
  return error instanceof ProviderStateAmbiguousError ||
    (error instanceof AsaasRequestError && error.ambiguous);
}

async function reconcileAfterMutation(
  mutationError: unknown,
  lookup: () => Promise<ReturnType<typeof resolveProviderCustomer>>,
): Promise<ReturnType<typeof resolveProviderCustomer>> {
  try {
    return await lookup();
  } catch (lookupError) {
    if (requiresProviderReconciliation(mutationWasAmbiguous(mutationError), false)) {
      throw new ProviderStateAmbiguousError();
    }
    throw lookupError;
  }
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
  path: string,
  init: RequestInit = {},
): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await fetch(`${ASAAS_URL}/v3${path}`, {
      ...init,
      headers: {
        access_token: ASAAS_TOKEN,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new AsaasRequestError(0, init.method === "POST");
  }
  if (!response.ok) {
    throw new AsaasRequestError(
      response.status,
      init.method === "POST" && response.status >= 500,
    );
  }
  try {
    return asRecord(await response.json());
  } catch {
    throw new AsaasRequestError(response.status, init.method === "POST");
  }
}

async function removeProviderObject(path: string): Promise<void> {
  await asaasRequest(path, { method: "DELETE" });
}

async function lookupProviderCustomer(
  reference: string,
  cpfCnpj: string,
): Promise<ReturnType<typeof resolveProviderCustomer>> {
  const result = await asaasRequest(
    `/customers?externalReference=${encodeURIComponent(reference)}&limit=100`,
  );
  return resolveProviderCustomer(result.data, reference, cpfCnpj);
}

async function lookupProviderSubscription(
  reference: string,
  expected: {
    customerId: string;
    billingType: SaasCheckoutBillingType;
    billingCycle: BillingCycle;
    amount: number;
  },
): Promise<ReturnType<typeof resolveProviderSubscription>> {
  const result = await asaasRequest(
    `/subscriptions?externalReference=${encodeURIComponent(reference)}&limit=100`,
  );
  return resolveProviderSubscription(result.data, {
    reference,
    ...expected,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  let checkoutId: string | null = null;
  let checkoutMetadata: JsonRecord = {};
  let providerAttemptToken: string | null = null;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
  if (!ASAAS_TOKEN || !supabaseUrl || !serviceRoleKey) {
    return json({ error: "Checkout temporariamente indisponível" }, 503);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const body = asRecord(await req.json());
    if (containsCardMaterial(body)) {
      return json({
        error: "Dados de cartão não são aceitos neste checkout. Use PIX ou boleto.",
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
      const rateIdentity = clientAddress === "unknown" ? ownerEmail : clientAddress;
      const rateKey = await sha256(`saas-checkout:${rateIdentity}`);
      const { data: rateAllowed, error: rateError } = await supabase.rpc(
        "consume_saas_checkout_rate_limit",
        { p_rate_key: rateKey, p_max_requests: 5 },
      );
      if (rateError) {
        console.error("SaaS checkout rate limit failed", { code: rateError.code });
        return json({ error: "Não foi possível iniciar o checkout" }, 500);
      }
      if (!rateAllowed) {
        return json(
          { error: "Muitas tentativas. Aguarde um pouco antes de tentar novamente." },
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
    let customerId = normalizeProviderId(checkout.asaas_customer_id);
    if (checkout.asaas_customer_id && !customerId) {
      throw new Error("invalid_provider_customer_link");
    }
    if (!customerId) {
      let customerResolution = await lookupProviderCustomer(
        reference,
        ownerCpfCnpj,
      );
      let createdCustomerId: string | null = null;
      if (customerResolution.status === "CONFLICT") {
        throw new Error("provider_customer_identity_conflict");
      }
      if (customerResolution.status === "NONE") {
        try {
          const customer = await asaasRequest("/customers", {
            method: "POST",
            body: JSON.stringify({
              name: schoolName,
              email: ownerEmail,
              cpfCnpj: ownerCpfCnpj,
              mobilePhone: ownerPhone,
              address: cleanText(checkoutMetadata.address, 180) || "A definir",
              addressNumber: cleanText(checkoutMetadata.addressNumber, 20) || "SN",
              province: cleanText(checkoutMetadata.province, 100) || "Centro",
              postalCode: digits(checkoutMetadata.postalCode, 8) || "01000000",
              externalReference: reference,
            }),
          });
          createdCustomerId = normalizeProviderId(customer.id);
          if (!createdCustomerId) throw new ProviderStateAmbiguousError();
          customerResolution = { status: "MATCH", id: createdCustomerId };
        } catch (error) {
          const recovered = await reconcileAfterMutation(
            error,
            () => lookupProviderCustomer(reference, ownerCpfCnpj),
          );
          if (recovered.status === "MATCH") {
            customerResolution = recovered;
          } else if (
            error instanceof AsaasRequestError && !error.ambiguous &&
            recovered.status === "NONE"
          ) {
            throw error;
          } else {
            throw new ProviderStateAmbiguousError();
          }
        }
      }
      if (customerResolution.status !== "MATCH") {
        throw new ProviderStateAmbiguousError();
      }
      customerId = customerResolution.id;
      const { data: linkedCheckout, error: customerLinkError } = await supabase
        .from("saas_checkout_intents")
        .update({
          asaas_customer_id: customerId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", checkout.id)
        .is("asaas_customer_id", null)
        .select("asaas_customer_id")
        .maybeSingle();
      if (customerLinkError || linkedCheckout?.asaas_customer_id !== customerId) {
        const currentLink = await supabase.from("saas_checkout_intents")
          .select("asaas_customer_id")
          .eq("id", checkout.id)
          .maybeSingle();
        if (currentLink.data?.asaas_customer_id !== customerId) {
          if (createdCustomerId) {
            try {
              await removeProviderObject(
                `/customers/${encodeURIComponent(createdCustomerId)}`,
              );
            } catch {
              throw new ProviderStateAmbiguousError();
            }
          }
          throw customerLinkError || new Error("provider_customer_link_rejected");
        }
      }
    }

    let subscriptionId = normalizeProviderId(checkout.asaas_subscription_id);
    if (checkout.asaas_subscription_id && !subscriptionId) {
      throw new Error("invalid_provider_subscription_link");
    }
    if (!subscriptionId) {
      const subscriptionExpected = {
        customerId,
        billingType,
        billingCycle,
        amount,
      };
      let subscriptionResolution = await lookupProviderSubscription(
        reference,
        subscriptionExpected,
      );
      let createdSubscriptionId: string | null = null;
      if (subscriptionResolution.status === "CONFLICT") {
        throw new Error("provider_subscription_conflict");
      }
      if (subscriptionResolution.status === "NONE") {
        const nextDueDate = new Date();
        nextDueDate.setDate(nextDueDate.getDate() + 1);
        try {
          const subscription = await asaasRequest("/subscriptions", {
            method: "POST",
            body: JSON.stringify({
              customer: customerId,
              billingType,
              value: amount,
              nextDueDate: nextDueDate.toISOString().slice(0, 10),
              cycle: billingCycle,
              description: `Assinatura Wise Wolf - Plano ${plan.name} (${billingCycle})`,
              externalReference: reference,
            }),
          });
          createdSubscriptionId = normalizeProviderId(subscription.id);
          if (!createdSubscriptionId) throw new ProviderStateAmbiguousError();
          subscriptionResolution = {
            status: "MATCH",
            id: createdSubscriptionId,
          };
        } catch (error) {
          const recovered = await reconcileAfterMutation(
            error,
            () => lookupProviderSubscription(
              reference,
              subscriptionExpected,
            ),
          );
          if (recovered.status === "MATCH") {
            subscriptionResolution = recovered;
          } else if (
            error instanceof AsaasRequestError && !error.ambiguous &&
            recovered.status === "NONE"
          ) {
            throw error;
          } else {
            throw new ProviderStateAmbiguousError();
          }
        }
      }
      if (subscriptionResolution.status !== "MATCH") {
        throw new ProviderStateAmbiguousError();
      }
      subscriptionId = subscriptionResolution.id;
      const { data: linkedCheckout, error: subscriptionLinkError } = await supabase
        .from("saas_checkout_intents")
        .update({
          asaas_subscription_id: subscriptionId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", checkout.id)
        .is("asaas_subscription_id", null)
        .select("asaas_subscription_id")
        .maybeSingle();
      if (
        subscriptionLinkError ||
        linkedCheckout?.asaas_subscription_id !== subscriptionId
      ) {
        const currentLink = await supabase.from("saas_checkout_intents")
          .select("asaas_subscription_id")
          .eq("id", checkout.id)
          .maybeSingle();
        if (currentLink.data?.asaas_subscription_id !== subscriptionId) {
          if (createdSubscriptionId) {
            try {
              await removeProviderObject(
                `/subscriptions/${encodeURIComponent(createdSubscriptionId)}`,
              );
            } catch {
              throw new ProviderStateAmbiguousError();
            }
          }
          throw subscriptionLinkError ||
            new Error("provider_subscription_link_rejected");
        }
      }
    }

    const payments = await asaasRequest(
      `/subscriptions/${encodeURIComponent(subscriptionId)}/payments`,
    );
    const firstPayment = Array.isArray(payments.data)
      ? asRecord(payments.data[0])
      : {};
    const paymentId = normalizeProviderId(firstPayment.id);
    if (!paymentId) throw new Error("provider_payment_not_ready");

    let pixData: JsonRecord = {};
    if (billingType === "PIX") {
      try {
        pixData = await asaasRequest(
          `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
        );
      } catch {
        pixData = {};
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
    console.error("SaaS checkout failed", {
      type: error instanceof Error ? error.name : "unknown",
      ambiguous,
    });
    if (checkoutId && providerAttemptToken) {
      const metadata = ambiguous
        ? {
          ...checkoutMetadata,
          providerAttemptToken,
          providerLeaseUntil: new Date(Date.now() + 600_000).toISOString(),
          providerReconciliationRequired: true,
        }
        : withoutProviderLease(checkoutMetadata);
      await supabase.from("saas_checkout_intents").update({
        metadata,
        last_error: ambiguous
          ? "provider_reconciliation_required"
          : "checkout_attempt_failed",
        updated_at: new Date().toISOString(),
      }).eq("id", checkoutId);
    }
    return json(
      {
        error: ambiguous
          ? "O provedor ainda está conciliando esta tentativa. Aguarde antes de tentar novamente."
          : "Não foi possível concluir o checkout. Tente novamente com a mesma tentativa.",
        code: ambiguous
          ? "PROVIDER_RECONCILIATION_REQUIRED"
          : "CHECKOUT_FAILED",
        checkout_id: checkoutId,
      },
      ambiguous ? 503 : 500,
    );
  }
});
