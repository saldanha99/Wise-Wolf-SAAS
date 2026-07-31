/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

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

type BillingCycle = "MONTHLY" | "YEARLY";
type BillingType = "PIX" | "BOLETO" | "CREDIT_CARD";

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

function publicCheckoutResult(checkout: Record<string, unknown>) {
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  let checkoutId: string | null = null;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
  if (!ASAAS_TOKEN || !supabaseUrl || !serviceRoleKey) {
    return json({ error: "Checkout temporariamente indisponível" }, 503);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const body = await req.json();
    const schoolName = cleanText(body.school_name, 140);
    const ownerName = cleanText(body.owner_name, 140);
    const ownerEmail = cleanText(body.owner_email, 254).toLowerCase();
    const ownerCpfCnpj = digits(body.owner_cpf_cnpj, 14);
    const ownerPhone = digits(body.owner_phone, 13);
    const planId = cleanText(body.plan_id, 64);
    const billingCycle: BillingCycle = body.billing_cycle === "YEARLY"
      ? "YEARLY"
      : "MONTHLY";
    const billingType: BillingType = ["PIX", "BOLETO", "CREDIT_CARD"].includes(
        body.billing_type,
      )
      ? body.billing_type
      : "PIX";
    const requestedIdempotencyKey = cleanText(body.idempotency_key, 64);
    const idempotencyKey = validUuid(requestedIdempotencyKey)
      ? requestedIdempotencyKey
      : crypto.randomUUID();
    let normalizedCreditCard: Record<string, string> | null = null;
    if (billingType === "CREDIT_CARD") {
      const creditCard = body.creditCard;
      const holderName = cleanText(creditCard?.holderName, 140);
      const cardNumber = digits(creditCard?.number, 19);
      const expiryMonth = digits(creditCard?.expiryMonth, 2);
      const expiryYear = digits(creditCard?.expiryYear, 4);
      const ccv = digits(creditCard?.ccv, 4);
      if (
        holderName.length < 3 ||
        cardNumber.length < 13 ||
        expiryMonth.length !== 2 ||
        expiryYear.length !== 4 ||
        ccv.length < 3
      ) {
        return json({ error: "Dados do cartão inválidos" }, 400);
      }
      normalizedCreditCard = {
        holderName,
        number: cardNumber,
        expiryMonth,
        expiryYear,
        ccv,
      };
    }

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

    const { data: existingCheckout, error: existingError } = await supabase
      .from("saas_checkout_intents")
      .select(
        "id,status,asaas_subscription_id,asaas_payment_id,invoice_url,bank_slip_url,pix_payload,pix_encoded_image,amount,billing_cycle",
      )
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingError) {
      console.error("SaaS checkout idempotency lookup failed", {
        code: existingError.code,
      });
      return json({ error: "Não foi possível iniciar o checkout" }, 500);
    }
    if (existingCheckout) {
      if (!existingCheckout.asaas_subscription_id) {
        return json({
          error:
            "Esta tentativa não gerou uma cobrança. Feche o checkout e inicie novamente.",
          checkout_id: existingCheckout.id,
        }, 409);
      }
      return json(publicCheckoutResult(existingCheckout));
    }

    const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
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

    const { data: plan, error: planError } = await supabase
      .from("saas_plans")
      .select(
        "id,name,price,price_yearly,max_students,max_users,max_teachers,plan_type,active",
      )
      .eq("id", planId)
      .eq("active", true)
      .maybeSingle();
    if (planError || !plan) return json({ error: "Plano indisponível" }, 400);

    const monthlyPrice = Number(plan.price);
    const yearlyPrice = Number(plan.price_yearly || monthlyPrice * 12);
    const price = billingCycle === "YEARLY" ? yearlyPrice : monthlyPrice;
    if (!Number.isFinite(price) || price <= 0) {
      return json({ error: "Preço do plano inválido" }, 400);
    }

    checkoutId = crypto.randomUUID();
    const tenantSlug = `${slugBase(schoolName)}-${checkoutId.slice(0, 8)}`;

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

    const { error: intentError } = await supabase
      .from("saas_checkout_intents")
      .insert({
        id: checkoutId,
        idempotency_key: idempotencyKey,
        school_name: schoolName,
        tenant_slug: tenantSlug,
        owner_name: ownerName,
        owner_email: ownerEmail,
        owner_phone: ownerPhone,
        owner_cpf_cnpj: ownerCpfCnpj,
        plan_id: plan.id,
        billing_cycle: billingCycle,
        billing_type: billingType,
        amount: price,
        lead_id: lead.id,
        metadata: {
          source: "new-saas",
          address: cleanText(body.address, 180),
          addressNumber: cleanText(body.addressNumber, 20),
          province: cleanText(body.province, 100),
          postalCode: digits(body.postalCode, 8),
        },
      });
    if (intentError) {
      console.error("SaaS checkout intent creation failed", {
        code: intentError.code,
      });
      return json({ error: "Não foi possível iniciar o checkout" }, 500);
    }

    const customerResponse = await fetch(`${ASAAS_URL}/v3/customers`, {
      method: "POST",
      headers: {
        access_token: ASAAS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: schoolName,
        email: ownerEmail,
        cpfCnpj: ownerCpfCnpj,
        mobilePhone: ownerPhone,
        address: cleanText(body.address, 180) || "A definir",
        addressNumber: cleanText(body.addressNumber, 20) || "SN",
        province: cleanText(body.province, 100) || "Centro",
        postalCode: digits(body.postalCode, 8) || "01000000",
        externalReference: `saas:${checkoutId}`,
      }),
    });
    if (!customerResponse.ok) {
      console.error("Asaas SaaS customer creation failed", {
        status: customerResponse.status,
      });
      await supabase.from("saas_checkout_intents").update({
        status: "CANCELLED",
        last_error: `asaas_customer_${customerResponse.status}`,
        updated_at: new Date().toISOString(),
      }).eq("id", checkoutId);
      return json(
        { error: "Não foi possível validar os dados de cobrança no Asaas" },
        502,
      );
    }
    const customer = await customerResponse.json();
    await supabase.from("saas_checkout_intents").update({
      asaas_customer_id: customer.id,
      updated_at: new Date().toISOString(),
    }).eq("id", checkoutId);

    const nextDueDate = new Date();
    nextDueDate.setDate(nextDueDate.getDate() + 1);
    const subscriptionPayload: Record<string, unknown> = {
      customer: customer.id,
      billingType,
      value: price,
      nextDueDate: nextDueDate.toISOString().split("T")[0],
      cycle: billingCycle,
      description: `Assinatura Wise Wolf - Plano ${plan.name} (${billingCycle})`,
      externalReference: `saas:${checkoutId}`,
    };

    if (billingType === "CREDIT_CARD") {
      subscriptionPayload.creditCard = normalizedCreditCard;
      subscriptionPayload.creditCardHolderInfo = {
        name: ownerName,
        email: ownerEmail,
        cpfCnpj: ownerCpfCnpj,
        postalCode: digits(body.postalCode, 8) || "01000000",
        addressNumber: cleanText(body.addressNumber, 20) || "SN",
        phone: ownerPhone,
      };
    }

    const subscriptionResponse = await fetch(`${ASAAS_URL}/v3/subscriptions`, {
      method: "POST",
      headers: {
        access_token: ASAAS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(subscriptionPayload),
    });
    if (!subscriptionResponse.ok) {
      console.error("Asaas SaaS subscription creation failed", {
        status: subscriptionResponse.status,
      });
      await supabase.from("saas_checkout_intents").update({
        status: "CANCELLED",
        last_error: `asaas_subscription_${subscriptionResponse.status}`,
        updated_at: new Date().toISOString(),
      }).eq("id", checkoutId);
      return json({ error: "Não foi possível criar a assinatura" }, 502);
    }
    const subscription = await subscriptionResponse.json();

    const paymentsResponse = await fetch(
      `${ASAAS_URL}/v3/subscriptions/${subscription.id}/payments`,
      { headers: { access_token: ASAAS_TOKEN } },
    );
    const paymentsData = paymentsResponse.ok
      ? await paymentsResponse.json()
      : { data: [] };
    const firstPayment = paymentsData.data?.[0] || null;

    let pixData: Record<string, string> | null = null;
    if (firstPayment && billingType === "PIX") {
      const pixResponse = await fetch(
        `${ASAAS_URL}/v3/payments/${firstPayment.id}/pixQrCode`,
        { headers: { access_token: ASAAS_TOKEN } },
      );
      if (pixResponse.ok) pixData = await pixResponse.json();
    }

    const { data: completedCheckout, error: updateError } = await supabase
      .from("saas_checkout_intents")
      .update({
        status: "PAYMENT_PENDING",
        asaas_subscription_id: subscription.id,
        asaas_payment_id: firstPayment?.id || null,
        invoice_url: firstPayment?.invoiceUrl || null,
        bank_slip_url: firstPayment?.bankSlipUrl || null,
        pix_payload: pixData?.payload || null,
        pix_encoded_image: pixData?.encodedImage || null,
        due_date: firstPayment?.dueDate || nextDueDate.toISOString().split("T")[0],
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", checkoutId)
      .select(
        "id,status,asaas_subscription_id,asaas_payment_id,invoice_url,bank_slip_url,pix_payload,pix_encoded_image,amount,billing_cycle",
      )
      .single();
    if (updateError || !completedCheckout) {
      console.error("SaaS checkout finalization failed", {
        code: updateError?.code,
      });
      return json(
        {
          error:
            "A cobrança foi criada, mas não conseguimos finalizar a tela. Contate o suporte antes de tentar novamente.",
          checkout_id: checkoutId,
        },
        500,
      );
    }

    return json({
      ...publicCheckoutResult(completedCheckout),
      lead_id: lead.id,
      plan_name: plan.name,
      message: "Pagamento criado. O acesso será liberado após a confirmação.",
    });
  } catch (error) {
    console.error("SaaS checkout failed", {
      type: error instanceof Error ? error.name : "unknown",
    });
    if (checkoutId) {
      await supabase.from("saas_checkout_intents").update({
        last_error: "unexpected_checkout_error",
        updated_at: new Date().toISOString(),
      }).eq("id", checkoutId);
    }
    return json({ error: "Não foi possível concluir o checkout" }, 500);
  }
});
