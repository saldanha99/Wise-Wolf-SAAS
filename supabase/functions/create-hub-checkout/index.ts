/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ASAAS_URL = (Deno.env.get("ASAAS_API_URL") || "https://api.asaas.com")
  .replace(/\/+$/, "")
  .replace(/\/v3$/, "");
const ASAAS_TOKEN = (Deno.env.get("ASAAS_ACCESS_TOKEN") || Deno.env.get("ASAAS_API_KEY") || "").trim();

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const digits = (value: unknown) => typeof value === "string" ? value.replace(/\D/g, "") : "";
const text = (value: unknown, max = 180) => typeof value === "string" ? value.trim().slice(0, max) : "";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isValidCpf = (value: string) => {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const digit = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(value[index]) * (length + 1 - index);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(value[9]) && digit(10) === Number(value[10]);
};

const isValidCnpj = (value: string) => {
  if (!/^\d{14}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const calculate = (length: 12 | 13) => {
    const weights = length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return calculate(12) === Number(value[12]) && calculate(13) === Number(value[13]);
};

const isValidCpfCnpj = (value: string) => isValidCpf(value) || isValidCnpj(value);

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
    console.error("Hub Asaas request failed", { path, status: response.status });
    throw new Error("ASAAS_REQUEST_FAILED");
  }
  return payload;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["NON_STUDENT", "STUDENT", "TEACHER", "COORDINATOR", "SCHOOL_ADMIN", "SUPER_ADMIN", "SALESPERSON"],
  });
  if (auth.ok === false) return auth.response;
  if (!ASAAS_TOKEN) return json(503, { error: "PAYMENT_PROVIDER_UNAVAILABLE", code: "PAYMENT_PROVIDER_UNAVAILABLE" });

  let checkoutId: string | null = null;
  try {
    const body = await req.json() as Record<string, unknown>;
    const planCode = text(body.planCode, 40).toUpperCase();
    const billingCycle = body.billingCycle === "YEARLY" ? "YEARLY" : "MONTHLY";
    const billingType = ["PIX", "BOLETO", "CREDIT_CARD"].includes(String(body.billingType))
      ? String(body.billingType)
      : "PIX";
    const customerName = text(body.name);
    const customerEmail = text(auth.context.user?.email || body.email).toLowerCase();
    const cpfCnpj = digits(body.cpfCnpj);
    const phone = digits(body.phone);
    const requestKey = text(body.requestKey, 40);
    const testMode = body.testMode === true;
    if (!planCode || customerName.length < 3 || !customerEmail.includes("@") || !isValidCpfCnpj(cpfCnpj) || phone.length < 10 || phone.length > 13 || !UUID_PATTERN.test(requestKey)) {
      return json(400, { error: "INVALID_CHECKOUT_DATA", code: "INVALID_CHECKOUT_DATA" });
    }
    if (testMode) {
      const fixtureAllowed = auth.context.user?.app_metadata?.test_fixture === true;
      const sandboxProvider = ASAAS_URL.toLowerCase().includes("sandbox");
      if (!fixtureAllowed || !sandboxProvider) return json(409, { error: "TEST_MODE_REQUIRES_SANDBOX", code: "TEST_MODE_REQUIRES_SANDBOX" });
    }

    const { data: membership, error: membershipError } = await auth.context.admin
      .from("hub_memberships")
      .select("account_id, membership_role, hub_accounts(id, name, asaas_customer_id)")
      .eq("user_id", auth.context.userId)
      .eq("status", "ACTIVE")
      .in("membership_role", ["OWNER", "ADMIN"])
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership) return json(403, { error: "HUB_MANAGER_REQUIRED", code: "HUB_MANAGER_REQUIRED" });
    const account = Array.isArray(membership.hub_accounts) ? membership.hub_accounts[0] : membership.hub_accounts;
    if (!account) return json(404, { error: "HUB_ACCOUNT_REQUIRED", code: "HUB_ACCOUNT_REQUIRED" });

    const { data: existingCheckout, error: existingCheckoutError } = await auth.context.admin
      .from("hub_checkout_sessions")
      .select("id, status, amount, invoice_url, bank_slip_url, asaas_payment_id")
      .eq("requested_by", auth.context.userId)
      .eq("request_key", requestKey)
      .maybeSingle();
    if (existingCheckoutError) throw existingCheckoutError;
    if (existingCheckout) {
      if (existingCheckout.status === "CREATED") return json(409, { error: "CHECKOUT_IN_PROGRESS", code: "CHECKOUT_IN_PROGRESS", checkoutId: existingCheckout.id });
      let existingPix = null;
      if (existingCheckout.asaas_payment_id && billingType === "PIX") {
        existingPix = await asaasRequest(`/payments/${encodeURIComponent(existingCheckout.asaas_payment_id)}/pixQrCode`);
      }
      return json(200, {
        success: true,
        idempotent: true,
        checkoutId: existingCheckout.id,
        status: existingCheckout.status,
        amount: Number(existingCheckout.amount),
        invoiceUrl: existingCheckout.invoice_url,
        bankSlipUrl: existingCheckout.bank_slip_url,
        pix: existingPix ? { copyPaste: existingPix.payload, qrCode: existingPix.encodedImage } : null,
      });
    }

    const { data: plan, error: planError } = await auth.context.admin
      .from("hub_plans")
      .select("id, code, name, price_monthly, price_yearly, metadata")
      .eq("code", planCode)
      .eq("is_active", true)
      .eq("is_public", true)
      .maybeSingle();
    if (planError) throw planError;
    if (!plan || plan.code === "DISCOVERY") return json(400, { error: "INVALID_PLAN", code: "INVALID_PLAN" });
    if (plan.metadata?.sales_assisted === true) return json(409, { error: "SALES_ASSISTED_PLAN", code: "SALES_ASSISTED_PLAN" });
    const amount = Number(billingCycle === "YEARLY" ? plan.price_yearly : plan.price_monthly);
    if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: "PLAN_PRICE_UNAVAILABLE", code: "PLAN_PRICE_UNAVAILABLE" });

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
        metadata: testMode ? { test_fixture: true, testMode: true } : {},
      })
      .select("id")
      .single();
    if (checkoutError || !checkout) throw checkoutError || new Error("CHECKOUT_CREATE_FAILED");
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
      await auth.context.admin.from("hub_accounts").update({ asaas_customer_id: customerId }).eq("id", membership.account_id);
    }

    const subscriptionPayload: Record<string, unknown> = {
      customer: customerId,
      billingType,
      value: amount,
      nextDueDate: new Date().toISOString().slice(0, 10),
      cycle: billingCycle,
      description: `Wise Wolf Hub - ${plan.name} (${billingCycle})`,
      externalReference: `hub:${checkout.id}`,
    };
    if (billingType === "CREDIT_CARD") {
      const creditCard = body.creditCard as Record<string, unknown> | undefined;
      if (!creditCard) return json(400, { error: "CREDIT_CARD_REQUIRED", code: "CREDIT_CARD_REQUIRED" });
      subscriptionPayload.creditCard = creditCard;
      subscriptionPayload.creditCardHolderInfo = {
        name: customerName,
        email: customerEmail,
        cpfCnpj,
        postalCode: digits(body.postalCode) || "01000000",
        addressNumber: text(body.addressNumber, 20) || "SN",
        phone,
      };
    }

    const subscription = await asaasRequest("/subscriptions", {
      method: "POST",
      body: JSON.stringify(subscriptionPayload),
    });
    const payments = await asaasRequest(`/subscriptions/${encodeURIComponent(subscription.id)}/payments`);
    const firstPayment = Array.isArray(payments?.data) ? payments.data[0] : null;
    let pix = null;
    if (firstPayment?.id && billingType === "PIX") {
      pix = await asaasRequest(`/payments/${encodeURIComponent(firstPayment.id)}/pixQrCode`);
    }

    const { error: updateError } = await auth.context.admin.from("hub_checkout_sessions").update({
      status: "PENDING",
      asaas_subscription_id: subscription.id,
      asaas_payment_id: firstPayment?.id || null,
      invoice_url: firstPayment?.invoiceUrl || null,
      bank_slip_url: firstPayment?.bankSlipUrl || null,
      metadata: { dueDate: firstPayment?.dueDate || null },
    }).eq("id", checkout.id);
    if (updateError) throw updateError;

    return json(200, {
      success: true,
      checkoutId: checkout.id,
      status: "PENDING",
      planName: plan.name,
      amount,
      billingCycle,
      invoiceUrl: firstPayment?.invoiceUrl || null,
      bankSlipUrl: firstPayment?.bankSlipUrl || null,
      pix: pix ? { copyPaste: pix.payload, qrCode: pix.encodedImage } : null,
    });
  } catch (error) {
    if (checkoutId) {
      await auth.context.admin.from("hub_checkout_sessions").update({ status: "FAILED" }).eq("id", checkoutId);
    }
    console.error("Hub checkout failed", { type: error instanceof Error ? error.name : "UnknownError" });
    return json(500, { error: "HUB_CHECKOUT_FAILED", code: "HUB_CHECKOUT_FAILED" });
  }
});
