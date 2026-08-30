/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const asaasBase = (Deno.env.get("ASAAS_BASE_URL") || "https://api.asaas.com/v3")
  .replace(/\/+$/, "");
const asaasToken =
  (Deno.env.get("ASAAS_ACCESS_TOKEN") || Deno.env.get("ASAAS_API_KEY") || "")
    .trim();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;
  if (!asaasToken) return json({ error: "Asaas is unavailable" }, 503);

  try {
    const body = await req.json();
    const tenantId = typeof body.tenantId === "string"
      ? body.tenantId.trim()
      : "";
    const ownerName = typeof body.ownerName === "string"
      ? body.ownerName.trim()
      : "";
    const ownerEmail = typeof body.ownerEmail === "string"
      ? body.ownerEmail.trim().toLowerCase()
      : "";
    const ownerCpfCnpj = typeof body.ownerCpfCnpj === "string"
      ? body.ownerCpfCnpj.replace(/\D/g, "")
      : "";
    const splitPercentage = body.splitPercentage === undefined
      ? 90
      : Number(body.splitPercentage);
    if (
      !tenantId || !ownerName || !ownerEmail.includes("@") ||
      !/^\d{11,14}$/.test(ownerCpfCnpj)
    ) {
      return json({ error: "Incomplete or invalid account data" }, 400);
    }
    if (
      !Number.isFinite(splitPercentage) || splitPercentage < 0 ||
      splitPercentage > 100
    ) {
      return json({ error: "Invalid split percentage" }, 400);
    }

    const admin = auth.context.admin;
    const { data: existing, error: tenantError } = await admin
      .from("tenants")
      .select("id, asaas_subaccount_id")
      .eq("id", tenantId)
      .maybeSingle();
    if (tenantError) return json({ error: "Could not validate tenant" }, 500);
    if (!existing) return json({ error: "Tenant not found" }, 404);
    if (existing.asaas_subaccount_id) {
      return json({
        error: "Subaccount already exists",
        subaccount_id: existing.asaas_subaccount_id,
      }, 409);
    }

    const response = await fetch(`${asaasBase}/accounts`, {
      method: "POST",
      headers: { access_token: asaasToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: ownerName,
        email: ownerEmail,
        cpfCnpj: ownerCpfCnpj,
        mobilePhone: typeof body.ownerPhone === "string"
          ? body.ownerPhone.replace(/\D/g, "")
          : undefined,
        address: typeof body.address === "string" && body.address.trim()
          ? body.address.trim()
          : "A definir",
        addressNumber:
          typeof body.addressNumber === "string" && body.addressNumber.trim()
            ? body.addressNumber.trim()
            : "SN",
        province: typeof body.province === "string" && body.province.trim()
          ? body.province.trim()
          : "Centro",
        postalCode:
          typeof body.postalCode === "string" && body.postalCode.trim()
            ? body.postalCode.replace(/\D/g, "")
            : "01000000",
      }),
    });
    const asaasData = await response.json().catch(() => null);
    if (!response.ok || !asaasData?.id || !asaasData?.walletId) {
      console.error("Asaas subaccount creation failed", {
        status: response.status,
      });
      return json({ error: "Failed to create subaccount" }, 502);
    }

    const { error: updateError } = await admin.from("tenants").update({
      asaas_subaccount_id: asaasData.id,
      asaas_wallet_id: asaasData.walletId,
      // The provider key is deliberately not persisted in the exposed schema.
      asaas_api_key_encrypted: null,
      asaas_subaccount_status: "APPROVED",
      asaas_split_percentage: splitPercentage,
    }).eq("id", tenantId).is("asaas_subaccount_id", null);
    if (updateError) {
      console.error("Asaas subaccount persistence failed", {
        code: updateError.code,
      });
      return json(
        { error: "Subaccount created but tenant update failed" },
        500,
      );
    }

    return json({
      success: true,
      subaccount_id: asaasData.id,
      wallet_id: asaasData.walletId,
    });
  } catch (error) {
    console.error("Create Asaas subaccount failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Invalid request" }, 400);
  }
});
