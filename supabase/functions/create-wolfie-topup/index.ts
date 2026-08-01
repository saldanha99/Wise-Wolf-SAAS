/// <reference lib="deno.ns" />

// Cobrança PIX de minutos adicionais do Wolfie ao vivo.
//
// Segurança do dinheiro: o VALOR e a QUANTIDADE de minutos vêm SEMPRE da
// tabela `wolfie_topup_packages`, nunca do corpo da requisição. O cliente só
// escolhe qual pacote — se ele mandasse o preço, poderia comprar 180 minutos
// por R$ 0,01.
//
// Os minutos só são creditados pelo webhook, quando o Asaas confirmar o
// pagamento. Esta função apenas gera a cobrança.

// deno-lint-ignore no-import-prefix
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

let ASAAS_URL = Deno.env.get("ASAAS_API_URL") ||
  "https://api-sandbox.asaas.com";
ASAAS_URL = ASAAS_URL.replace(/\/+$/, "");
const ASAAS_API_KEY =
  (Deno.env.get("ASAAS_API_KEY") || Deno.env.get("ASAAS_ACCESS_TOKEN") || "")
    .trim();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });

function asaasPathPrefix() {
  return ASAAS_URL.includes("api-sandbox") ||
      ASAAS_URL.includes("api.asaas.com")
    ? "/v3"
    : "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sameMoney = (left: unknown, right: unknown) => {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) &&
    Math.round(a * 100) === Math.round(b * 100);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["STUDENT"],
  });
  if (auth.ok === false) return auth.response;

  const tenantId = auth.context.profile?.tenant_id;
  const studentId = auth.context.userId;
  if (!tenantId || !studentId) {
    return json({ error: "STUDENT_PROFILE_REQUIRED" }, 403);
  }
  if (!ASAAS_API_KEY) return json({ error: "ASAAS_NOT_CONFIGURED" }, 503);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "INVALID_BODY" }, 400);
  }

  const packageId = typeof body.packageId === "string" ? body.packageId : "";
  const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
  if (!UUID.test(packageId)) return json({ error: "INVALID_PACKAGE" }, 400);
  if (!UUID.test(requestKey)) {
    return json({ error: "INVALID_REQUEST_KEY" }, 400);
  }

  const { data: profile, error: profileError } = await auth.context.admin
    .from("profiles")
    .select("asaas_customer_id")
    .eq("id", studentId)
    .maybeSingle();
  if (profileError || !profile?.asaas_customer_id) {
    return json({ error: "CUSTOMER_NOT_READY" }, 409);
  }

  const orderColumns =
    "id,tenant_id,student_id,request_key,package_id,package_name,minutes,amount_brl,status,provider_payment_id,creation_lease_expires_at";
  const loadOrder = async () =>
    await auth.context.admin.from("wolfie_topup_orders")
      .select(orderColumns)
      .eq("tenant_id", tenantId)
      .eq("student_id", studentId)
      .eq("request_key", requestKey)
      .maybeSingle();

  let { data: order, error: orderError } = await loadOrder();
  if (orderError) {
    console.error("Topup order lookup failed", { code: orderError.code });
    return json({ error: "TOPUP_UNAVAILABLE" }, 503);
  }
  if (order && order.package_id !== packageId) {
    return json({ error: "IDEMPOTENCY_KEY_CONFLICT" }, 409);
  }

  if (!order) {
    // Preço e minutos SÓ do banco — nunca do cliente.
    const { data: pkg, error: pkgError } = await auth.context.admin
      .from("wolfie_topup_packages")
      .select("id,name,minutes,price_brl")
      .eq("id", packageId)
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .maybeSingle();
    if (pkgError) {
      console.error("Topup package lookup failed", { code: pkgError.code });
      return json({ error: "TOPUP_UNAVAILABLE" }, 503);
    }
    if (!pkg) return json({ error: "PACKAGE_NOT_FOUND" }, 404);

    const inserted = await auth.context.admin.from("wolfie_topup_orders")
      .insert({
        tenant_id: tenantId,
        student_id: studentId,
        request_key: requestKey,
        package_id: pkg.id,
        package_name: String(pkg.name).slice(0, 160),
        minutes: Number(pkg.minutes),
        amount_brl: Number(pkg.price_brl),
        status: "PENDING",
      })
      .select(orderColumns)
      .single();
    order = inserted.data;
    orderError = inserted.error;
    if (orderError?.code === "23505") {
      const raced = await loadOrder();
      order = raced.data;
      orderError = raced.error;
    }
    if (orderError || !order) {
      console.error("Topup order creation failed", {
        code: orderError?.code ?? "missing_order",
      });
      return json({ error: "TOPUP_UNAVAILABLE" }, 503);
    }
    if (order.package_id !== packageId) {
      return json({ error: "IDEMPOTENCY_KEY_CONFLICT" }, 409);
    }
  }

  // Asaas receives only a server-authored order UUID. Tenant, learner,
  // quantity and price remain immutable snapshots in Postgres.
  const reference = `wolfie-topup-order:${order.id}`;
  const paymentMatchesOrder = (
    payment: unknown,
  ): payment is Record<string, unknown> =>
    isRecord(payment) &&
    typeof payment.id === "string" &&
    payment.id.length >= 1 && payment.id.length <= 200 &&
    payment.externalReference === reference &&
    payment.customer === profile.asaas_customer_id &&
    payment.billingType === "PIX" &&
    sameMoney(payment.value, order.amount_brl);

  const respondWithPayment = async (payment: Record<string, unknown>) => {
    const paymentId = String(payment.id);
    const { error: paymentLinkError } = await auth.context.admin
      .from("wolfie_topup_orders")
      .update({
        status: "AWAITING_PAYMENT",
        provider_payment_id: paymentId,
        creation_lease_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("tenant_id", tenantId)
      .eq("student_id", studentId)
      .in("status", ["PENDING", "CREATING", "AWAITING_PAYMENT"]);
    if (paymentLinkError) {
      console.error("Topup payment link persistence failed", {
        code: paymentLinkError.code,
      });
      return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
    }

    let qr: Record<string, unknown> | null = null;
    try {
      const qrRes = await fetch(
        `${ASAAS_URL}${asaasPathPrefix()}/payments/${
          encodeURIComponent(paymentId)
        }/pixQrCode`,
        {
          headers: { "access_token": ASAAS_API_KEY },
          signal: AbortSignal.timeout(15_000),
        },
      );
      const qrPayload: unknown = await qrRes.json().catch(() => null);
      if (qrRes.ok && isRecord(qrPayload)) qr = qrPayload;
    } catch {
      // The charge already exists. Never create another just because its
      // optional QR lookup failed.
      console.warn("Topup QR lookup failed after charge creation");
    }

    return json({
      success: true,
      orderId: order.id,
      requestKey,
      paymentId,
      minutes: order.minutes,
      value: Number(order.amount_brl),
      invoiceUrl: typeof payment.invoiceUrl === "string"
        ? payment.invoiceUrl
        : null,
      pixPayload: typeof qr?.payload === "string" ? qr.payload : null,
      pixQrCode: typeof qr?.encodedImage === "string" ? qr.encodedImage : null,
    });
  };

  try {
    if (
      [
        "PAID",
        "SUSPENDED",
        "REVERSED",
        "FAILED",
        "RECONCILIATION_REQUIRED",
      ].includes(String(order.status))
    ) {
      return json({ error: "TOPUP_ORDER_NOT_PAYABLE" }, 409);
    }

    if (typeof order.provider_payment_id === "string") {
      const existingRes = await fetch(
        `${ASAAS_URL}${asaasPathPrefix()}/payments/${
          encodeURIComponent(order.provider_payment_id)
        }`,
        {
          headers: { "access_token": ASAAS_API_KEY },
          signal: AbortSignal.timeout(15_000),
        },
      );
      const existing: unknown = await existingRes.json().catch(() => null);
      if (!existingRes.ok || !paymentMatchesOrder(existing)) {
        return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
      }
      return await respondWithPayment(existing);
    }

    // A lost POST response is reconciled by the immutable external reference
    // before any retry is allowed to create a new provider charge.
    const lookupUrl = new URL(
      `${ASAAS_URL}${asaasPathPrefix()}/payments`,
    );
    lookupUrl.searchParams.set("externalReference", reference);
    lookupUrl.searchParams.set("customer", profile.asaas_customer_id);
    lookupUrl.searchParams.set("limit", "10");
    const lookupRes = await fetch(lookupUrl, {
      headers: { "access_token": ASAAS_API_KEY },
      signal: AbortSignal.timeout(15_000),
    });
    const lookupPayload: unknown = await lookupRes.json().catch(() => null);
    if (!lookupRes.ok || !isRecord(lookupPayload)) {
      return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
    }
    const matches = Array.isArray(lookupPayload.data)
      ? lookupPayload.data.filter(paymentMatchesOrder)
      : [];
    if (matches.length > 1) {
      await auth.context.admin.from("wolfie_topup_orders").update({
        status: "RECONCILIATION_REQUIRED",
        reconciliation_required: true,
        updated_at: new Date().toISOString(),
      }).eq("id", order.id);
      return json({ error: "DUPLICATE_PROVIDER_CHARGE" }, 409);
    }
    if (matches.length === 1 && isRecord(matches[0])) {
      return await respondWithPayment(matches[0]);
    }

    const { data: claim, error: claimError } = await auth.context.admin.rpc(
      "claim_wolfie_topup_order_creation",
      {
        p_tenant_id: tenantId,
        p_student_id: studentId,
        p_order_id: order.id,
      },
    );
    if (claimError || !isRecord(claim)) {
      console.error("Topup creation claim failed", {
        code: claimError?.code ?? "invalid_result",
      });
      return json({ error: "TOPUP_UNAVAILABLE" }, 503);
    }
    if (claim.claimed !== true) {
      return json({
        error: claim.reason === "creation_in_progress"
          ? "TOPUP_CREATION_IN_PROGRESS"
          : "TOPUP_ORDER_NOT_PAYABLE",
        retryAfter: claim.retryAfter ?? null,
        requestKey,
      }, claim.reason === "creation_in_progress" ? 202 : 409);
    }

    const paymentRes = await fetch(
      `${ASAAS_URL}${asaasPathPrefix()}/payments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "access_token": ASAAS_API_KEY,
        },
        body: JSON.stringify({
          customer: profile.asaas_customer_id,
          billingType: "PIX",
          value: Number(order.amount_brl),
          dueDate: new Date().toISOString().slice(0, 10),
          description: `Wolfie — ${order.package_name}`,
          externalReference: reference,
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    const payment: unknown = await paymentRes.json().catch(() => null);
    if (!paymentRes.ok || !paymentMatchesOrder(payment)) {
      console.error("Topup charge creation failed", {
        status: paymentRes.status,
      });
      if (paymentRes.status >= 400 && paymentRes.status < 500) {
        await auth.context.admin.from("wolfie_topup_orders").update({
          status: "FAILED",
          creation_lease_expires_at: null,
          updated_at: new Date().toISOString(),
        }).eq("id", order.id).eq("status", "CREATING");
      }
      return json({ error: "CHARGE_STATUS_UNCERTAIN", requestKey }, 503);
    }
    return await respondWithPayment(payment);
  } catch (error) {
    console.error("Topup transport failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
    // Network timeout is an uncertain result: keep CREATING and reconcile by
    // externalReference on the same requestKey. Marking FAILED here would make
    // a retry create a second PIX.
    return json({ error: "CHARGE_STATUS_UNCERTAIN", requestKey }, 503);
  }
});
