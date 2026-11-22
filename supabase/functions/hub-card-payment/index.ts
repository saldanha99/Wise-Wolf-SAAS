/// <reference lib="deno.ns" />
// Pagamento com cartão no NOSSO formulário (Hub e Wolfie), 22/11/2026.
//
// Única função que recebe dados de cartão. A cobrança já existe: o create-hub-checkout
// criou cliente, assinatura (billingType CREDIT_CARD) e a 1ª cobrança SEM cartão. Aqui:
//   1. confere quem paga (a pessoa logada que abriu a cobrança), a cobrança no Asaas e
//      os tetos de tentativa (hub_card_payment_gate: conta, IP e recusas por cobrança);
//   2. paga a 1ª cobrança (POST /payments/{id}/payWithCreditCard, com remoteIp do comprador);
//   3. mensal aprovado: põe o cartão na assinatura (POST /subscriptions/{id}/updateCreditCard,
//      sem cobrar) para o Asaas cobrar sozinho os próximos meses — conta sem tokenização,
//      quem guarda o cartão é o Asaas. Anual: cobrança única, renovação por aviso;
//   4. grava só o resultado, 4 últimos dígitos e bandeira (devolvidos pelo Asaas).
// O acesso é liberado pelo webhook do Asaas (hub_activate_paid_checkout), como no PIX.
// NUNCA logar o corpo da requisição, o cartão ou a resposta crua do Asaas.
// Fluxo e proteções: docs/PAGAMENTOS-CARTAO.md.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  type AsaasMutationPurpose,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import {
  PLATFORM_ASAAS_TENANT_ID,
  type ResolvedAsaasIntegration,
  resolvePlatformAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";
import {
  asaasCardPayload,
  buyerIp,
  cardInputError,
  type CardInput,
  declineMessage,
  hasCardOutside,
  type HolderInput,
  paymentApproved,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function ipHash(ip: string): Promise<string> {
  // HMAC com a chave do servidor: o IP cru não fica no banco e não dá para refazer o hash fora daqui.
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`hub-card-ip:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function asaas(
  integration: ResolvedAsaasIntegration,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(`${integration.baseUrl}${path}`, {
    ...init,
    headers: { access_token: integration.apiKey, "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    allowInactiveTenant: true,
    corsHeaders,
    allowWolfieDirect: true,
    allowedRoles: ["NON_STUDENT", "STUDENT", "TEACHER", "COORDINATOR", "SCHOOL_ADMIN", "SUPER_ADMIN", "SALESPERSON"],
  });
  if (auth.ok === false) return auth.response;
  const user = auth.context.user;
  if (!user?.id || !user.email) return json(401, { code: "LOGIN_REQUIRED" });

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return json(400, { code: "INVALID_BODY" });
  }
  if (!body || typeof body !== "object" || hasCardOutside(body)) return json(400, { code: "INVALID_BODY" });

  const checkoutId = String(body.checkoutId ?? "");
  if (!UUID.test(checkoutId)) return json(400, { code: "CHECKOUT_INVALID" });
  const card = (body.card ?? null) as CardInput | null;
  const holder = (body.holder ?? null) as HolderInput | null;
  const fieldError = cardInputError(card, holder);
  if (fieldError) return json(400, { code: fieldError });
  const ip = buyerIp(req.headers);
  if (!ip) return json(400, { code: "BUYER_IP_UNAVAILABLE" });

  const admin = auth.context.admin;
  const { data: checkout, error: checkoutError } = await admin
    .from("hub_checkout_sessions")
    .select("id, requested_by, status, billing_type, billing_cycle, amount, asaas_payment_id, asaas_subscription_id")
    .eq("id", checkoutId)
    .maybeSingle();
  if (checkoutError) return json(503, { code: "CHECKOUT_UNAVAILABLE" });
  if (!checkout || checkout.requested_by !== user.id) return json(404, { code: "CHECKOUT_NOT_FOUND" });
  if (checkout.status === "PAID") return json(409, { code: "ALREADY_PAID" });
  if (checkout.billing_type !== "CREDIT_CARD" || checkout.status !== "PENDING" || !checkout.asaas_payment_id) {
    return json(409, { code: "CHECKOUT_NOT_PAYABLE_BY_CARD" });
  }

  const { data: gate, error: gateError } = await admin.rpc("hub_card_payment_gate", {
    p_checkout: checkout.id,
    p_user: user.id,
    p_ip_hash: await ipHash(ip),
  });
  if (gateError) return json(503, { code: "CARD_UNAVAILABLE" });
  const gateResult = gate as { allowed?: boolean; reason?: string; attempt_id?: string } | null;
  if (!gateResult?.allowed || !gateResult.attempt_id) {
    return json(429, { code: "CARD_ATTEMPTS_LIMIT", reason: gateResult?.reason ?? "blocked" });
  }
  const attemptId = gateResult.attempt_id;
  const finish = async (outcome: string, reason: string | null, last4?: string | null, brand?: string | null) => {
    await admin.rpc("hub_card_payment_finish", {
      p_attempt: attemptId,
      p_outcome: outcome,
      p_reason: reason,
      p_last4: last4 ?? null,
      p_brand: brand ?? null,
    });
  };

  let integration: ResolvedAsaasIntegration;
  const fenced = async (purpose: AsaasMutationPurpose) =>
    await revalidateAsaasMutationCapability(admin, { tenantId: PLATFORM_ASAAS_TENANT_ID, purpose, expected: integration });
  try {
    integration = await resolvePlatformAsaasIntegration(admin, "payment.read");
  } catch {
    await finish("ERROR", "integration_unavailable");
    return json(503, { code: "CARD_UNAVAILABLE" });
  }

  // A cobrança no Asaas tem de ser exatamente a desta sessão, ainda aberta, no cartão.
  const paymentId = encodeURIComponent(String(checkout.asaas_payment_id));
  const current = await asaas(integration, `/payments/${paymentId}`).catch(() => null);
  const currentBody = (current?.body ?? {}) as Record<string, unknown>;
  if (
    !current?.ok ||
    String(currentBody.externalReference ?? "") !== `hub:${checkout.id}` ||
    String(currentBody.billingType ?? "").toUpperCase() !== "CREDIT_CARD" ||
    Math.abs(Number(currentBody.value) - Number(checkout.amount)) > 0.005
  ) {
    await finish("BLOCKED", "provider_payment_mismatch");
    return json(409, { code: "CHECKOUT_NOT_PAYABLE_BY_CARD" });
  }
  if (paymentApproved(currentBody)) {
    await finish("BLOCKED", "already_paid");
    return json(409, { code: "ALREADY_PAID" });
  }
  if (String(currentBody.status ?? "").toUpperCase() !== "PENDING") {
    await finish("BLOCKED", "provider_payment_not_pending");
    return json(409, { code: "CHECKOUT_NOT_PAYABLE_BY_CARD" });
  }

  const payload = asaasCardPayload(card!, holder!, user.email);
  let paid: { ok: boolean; status: number; body: unknown };
  try {
    const writer = await fenced("payment.update");
    paid = await asaas(writer, `/payments/${paymentId}/payWithCreditCard`, {
      method: "POST",
      body: JSON.stringify({ ...payload, remoteIp: ip }),
      timeoutMs: 45_000,
    });
  } catch (error) {
    // Rede caiu ou o Asaas demorou: não sabemos se passou. O webhook decide; a tela acompanha a sessão.
    console.error("[hub-card-payment] tentativa sem resposta", { checkout: checkout.id, error: (error as Error)?.name });
    await finish("ERROR", "provider_no_response");
    return json(202, { status: "UNKNOWN", code: "CARD_RESULT_PENDING" });
  }

  const paidBody = (paid.body ?? {}) as { creditCard?: { creditCardNumber?: unknown; creditCardBrand?: unknown } };
  const last4 = String(paidBody.creditCard?.creditCardNumber ?? "").replace(/\D/g, "").slice(-4) || null;
  const brand = String(paidBody.creditCard?.creditCardBrand ?? "") || null;
  if (!paid.ok || !paymentApproved(paid.body)) {
    await finish("DECLINED", `asaas_${paid.status}`, last4, brand);
    console.warn("[hub-card-payment] cartão recusado", { checkout: checkout.id, status: paid.status });
    return json(402, { status: "DECLINED", code: "CARD_DECLINED", message: declineMessage(paid.body) });
  }

  // Mensal: o Asaas guarda o cartão na assinatura e cobra os próximos meses (sem cobrar agora).
  let recurring = false;
  if (checkout.billing_cycle === "MONTHLY" && checkout.asaas_subscription_id) {
    try {
      const writer = await fenced("subscription.update");
      const updated = await asaas(
        writer,
        `/subscriptions/${encodeURIComponent(String(checkout.asaas_subscription_id))}/updateCreditCard`,
        { method: "POST", body: JSON.stringify({ ...payload, remoteIp: ip }), timeoutMs: 30_000 },
      );
      recurring = updated.ok;
      if (!updated.ok) {
        console.warn("[hub-card-payment] cartão não ficou na assinatura", { checkout: checkout.id, status: updated.status });
      }
    } catch (error) {
      console.warn("[hub-card-payment] cartão não ficou na assinatura", { checkout: checkout.id, error: (error as Error)?.name });
    }
  }
  await finish("APPROVED", recurring || checkout.billing_cycle !== "MONTHLY" ? null : "recurring_card_not_saved", last4, brand);
  return json(200, { status: "APPROVED", last4, brand, recurring });
});
