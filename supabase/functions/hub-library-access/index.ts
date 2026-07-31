/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNED_URL_TTL_SECONDS = 120;

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: [
      "NON_STUDENT",
      "STUDENT",
      "TEACHER",
      "COORDINATOR",
      "SCHOOL_ADMIN",
      "SUPER_ADMIN",
      "SALESPERSON",
    ],
  });
  if (auth.ok === false) return auth.response;

  try {
    const body = await req.json() as Record<string, unknown>;
    const contentId = typeof body.contentId === "string" ? body.contentId.trim() : "";
    const assetKind = body.asset === "FULL" ? "FULL" : body.asset === "PREVIEW" ? "PREVIEW" : "";
    if (!UUID_PATTERN.test(contentId) || !assetKind) {
      return json(400, { error: "INVALID_CONTENT_REQUEST", code: "INVALID_CONTENT_REQUEST" });
    }

    const { data: item, error: itemError } = await auth.context.admin
      .from("hub_content_items")
      .select("id, preview_enabled, published_at, is_active")
      .eq("id", contentId)
      .maybeSingle();
    if (itemError) throw itemError;
    if (!item || !item.is_active || !item.published_at || new Date(item.published_at).getTime() > Date.now()) {
      return json(404, { error: "CONTENT_NOT_FOUND", code: "CONTENT_NOT_FOUND" });
    }
    if (assetKind === "PREVIEW" && !item.preview_enabled) {
      return json(403, { error: "CONTENT_PREVIEW_UNAVAILABLE", code: "CONTENT_PREVIEW_UNAVAILABLE" });
    }

    const { data: asset, error: assetError } = await auth.context.admin
      .from("hub_content_assets")
      .select("bucket_id, object_path, external_url")
      .eq("content_id", contentId)
      .eq("asset_kind", assetKind)
      .maybeSingle();
    if (assetError) throw assetError;
    if (!asset) {
      return json(404, { error: "CONTENT_ASSET_UNAVAILABLE", code: "CONTENT_ASSET_UNAVAILABLE" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() ?? "";
    const authorization = req.headers.get("Authorization") ?? "";
    if (!supabaseUrl || !anonKey || !authorization) {
      return json(503, { error: "HUB_ACCESS_UNAVAILABLE", code: "HUB_ACCESS_UNAVAILABLE" });
    }
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const requestKey = crypto.randomUUID();
    const featureKey = assetKind === "FULL" ? "library.full_access" : "library.preview";
    const { data: usage, error: usageError } = await userClient.rpc("hub_consume_feature", {
      p_feature_key: featureKey,
      p_units: 1,
      p_request_key: requestKey,
      p_metadata: { contentId, assetKind },
    });
    if (usageError) {
      console.error("Hub library usage authorization failed", { code: usageError.code });
      return json(503, { error: "HUB_ACCESS_UNAVAILABLE", code: "HUB_ACCESS_UNAVAILABLE" });
    }
    if (!usage?.allowed) {
      const code = typeof usage?.code === "string" ? usage.code : "CONTENT_ACCESS_DENIED";
      const status = code === "USAGE_LIMIT_REACHED" ? 429 : code === "SUBSCRIPTION_REQUIRED" ? 402 : 403;
      return json(status, { error: code, code });
    }

    let deliveryUrl = typeof asset.external_url === "string" ? asset.external_url : null;
    let expiresIn = 0;
    if (!deliveryUrl) {
      const { data: signed, error: signedError } = await auth.context.admin.storage
        .from(asset.bucket_id)
        .createSignedUrl(asset.object_path, SIGNED_URL_TTL_SECONDS);
      if (signedError || !signed?.signedUrl) {
        console.error("Hub library signed URL creation failed", { message: signedError?.message });
        return json(503, { error: "CONTENT_DELIVERY_UNAVAILABLE", code: "CONTENT_DELIVERY_UNAVAILABLE" });
      }
      deliveryUrl = signed.signedUrl;
      expiresIn = SIGNED_URL_TTL_SECONDS;
    }

    const accountId = typeof usage.accountId === "string" ? usage.accountId : null;
    if (accountId) {
      const { error: auditError } = await auth.context.admin.from("hub_content_access_events").insert({
        account_id: accountId,
        user_id: auth.context.userId,
        content_id: contentId,
        access_kind: assetKind === "PREVIEW" ? "PREVIEW" : "OPEN",
      });
      if (auditError) console.warn("Hub content audit was not recorded", { code: auditError.code });
    }

    return json(200, {
      signedUrl: deliveryUrl,
      expiresIn,
      remaining: usage.remaining ?? null,
    });
  } catch (error) {
    console.error("Hub library access failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return json(500, { error: "HUB_LIBRARY_ACCESS_FAILED", code: "HUB_LIBRARY_ACCESS_FAILED" });
  }
});
