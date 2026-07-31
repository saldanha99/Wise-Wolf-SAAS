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

let ASAAS_URL = Deno.env.get("ASAAS_API_URL") || "https://api-sandbox.asaas.com";
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
  return ASAAS_URL.includes("api-sandbox") || ASAAS_URL.includes("api.asaas.com")
    ? "/v3"
    : "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!UUID.test(packageId)) return json({ error: "INVALID_PACKAGE" }, 400);

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

  const { data: profile, error: profileError } = await auth.context.admin
    .from("profiles")
    .select("asaas_customer_id")
    .eq("id", studentId)
    .maybeSingle();
  if (profileError || !profile?.asaas_customer_id) {
    return json({ error: "CUSTOMER_NOT_READY" }, 409);
  }

  // O webhook lê este prefixo para saber quantos minutos creditar e a quem.
  const reference = `topup:${studentId}:${pkg.minutes}`;

  try {
    const paymentRes = await fetch(`${ASAAS_URL}${asaasPathPrefix()}/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "access_token": ASAAS_API_KEY,
      },
      body: JSON.stringify({
        customer: profile.asaas_customer_id,
        billingType: "PIX",
        value: Number(pkg.price_brl),
        dueDate: new Date().toISOString().slice(0, 10),
        description: `Wolfie — ${pkg.name}`,
        externalReference: reference,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const payment = await paymentRes.json().catch(() => null);
    if (!paymentRes.ok || !payment?.id) {
      console.error("Topup charge creation failed", {
        status: paymentRes.status,
      });
      return json({ error: "CHARGE_FAILED" }, 502);
    }

    const qrRes = await fetch(
      `${ASAAS_URL}${asaasPathPrefix()}/payments/${
        encodeURIComponent(payment.id)
      }/pixQrCode`,
      {
        headers: { "access_token": ASAAS_API_KEY },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const qr = await qrRes.json().catch(() => null);

    return json({
      success: true,
      paymentId: payment.id,
      minutes: pkg.minutes,
      value: Number(pkg.price_brl),
      invoiceUrl: payment.invoiceUrl ?? null,
      pixPayload: qr?.payload ?? null,
      pixQrCode: qr?.encodedImage ?? null,
    });
  } catch (error) {
    console.error("Topup transport failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return json({ error: "TOPUP_UNAVAILABLE" }, 503);
  }
});
