/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

type HubRpcClient = ReturnType<typeof createClient<any>>;

interface HubReservation {
  client: HubRpcClient;
  userId: string;
  reservationId: string;
  leaseToken: string;
  requestKey: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNED_URL_TTL_SECONDS = 120;

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const hubAccessStatus = (code: string): number => {
  if (code === "USAGE_LIMIT_REACHED") return 429;
  if (code === "SUBSCRIPTION_REQUIRED") return 402;
  if (
    code === "REQUEST_IN_PROGRESS" ||
    code === "REQUEST_ALREADY_COMPLETED" ||
    code === "IDEMPOTENCY_KEY_REUSED" ||
    code === "HUB_ACCOUNT_AMBIGUOUS"
  ) return 409;
  if (code === "HUB_DISABLED") return 503;
  return 403;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
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

  let hubReservation: HubReservation | null = null;
  let hubReleaseReason = "REQUEST_FAILED";
  try {
    const body = await req.json() as Record<string, unknown>;
    const contentId = typeof body.contentId === "string"
      ? body.contentId.trim()
      : "";
    const requestedAccountId =
      typeof body.accountId === "string" && body.accountId.trim()
        ? body.accountId.trim()
        : null;
    const assetKind = body.asset === "FULL"
      ? "FULL"
      : body.asset === "PREVIEW"
      ? "PREVIEW"
      : "";
    const requestKey =
      typeof body.requestKey === "string" && body.requestKey.trim()
        ? body.requestKey.trim()
        : crypto.randomUUID();
    if (
      !UUID_PATTERN.test(contentId) ||
      !assetKind ||
      (requestedAccountId !== null && !UUID_PATTERN.test(requestedAccountId)) ||
      !UUID_PATTERN.test(requestKey)
    ) {
      return json(400, {
        error: "INVALID_CONTENT_REQUEST",
        code: "INVALID_CONTENT_REQUEST",
      });
    }

    const { data: item, error: itemError } = await auth.context.admin
      .from("hub_content_items")
      .select(
        "id, preview_enabled, published_at, is_active, catalog_scope, rights_basis, rights_verified_at, license_summary",
      )
      .eq("id", contentId)
      .maybeSingle();
    if (itemError) throw itemError;
    if (
      !item ||
      !item.is_active ||
      item.catalog_scope !== "COMMERCIAL_GLOBAL" ||
      !item.published_at ||
      new Date(item.published_at).getTime() > Date.now() ||
      !item.rights_verified_at ||
      !["OWNED", "LICENSED", "PUBLIC_DOMAIN"].includes(item.rights_basis) ||
      typeof item.license_summary !== "string" ||
      !item.license_summary.trim()
    ) {
      return json(404, {
        error: "CONTENT_NOT_FOUND",
        code: "CONTENT_NOT_FOUND",
      });
    }
    if (assetKind === "PREVIEW" && !item.preview_enabled) {
      return json(403, {
        error: "CONTENT_PREVIEW_UNAVAILABLE",
        code: "CONTENT_PREVIEW_UNAVAILABLE",
      });
    }

    const { data: asset, error: assetError } = await auth.context.admin
      .from("hub_content_assets")
      .select("bucket_id, object_path, external_url")
      .eq("content_id", contentId)
      .eq("asset_kind", assetKind)
      .maybeSingle();
    if (assetError) throw assetError;
    if (
      !asset ||
      asset.bucket_id !== "hub-library" ||
      typeof asset.object_path !== "string" ||
      !asset.object_path.trim() ||
      (typeof asset.external_url === "string" && asset.external_url.trim())
    ) {
      return json(404, {
        error: "CONTENT_ASSET_UNAVAILABLE",
        code: "CONTENT_ASSET_UNAVAILABLE",
      });
    }

    const siblingKind = assetKind === "PREVIEW" ? "FULL" : "PREVIEW";
    const { data: siblingAsset, error: siblingError } = await auth.context.admin
      .from("hub_content_assets")
      .select("bucket_id, object_path, external_url")
      .eq("content_id", contentId)
      .eq("asset_kind", siblingKind)
      .maybeSingle();
    if (siblingError) throw siblingError;
    if (
      !siblingAsset ||
      siblingAsset.bucket_id !== "hub-library" ||
      typeof siblingAsset.object_path !== "string" ||
      !siblingAsset.object_path.trim() ||
      (typeof siblingAsset.external_url === "string" &&
        siblingAsset.external_url.trim())
    ) {
      console.error("Hub content sibling asset is missing", {
        contentId,
        assetKind,
      });
      return json(503, {
        error: "CONTENT_ASSET_UNAVAILABLE",
        code: "CONTENT_ASSET_UNAVAILABLE",
      });
    }
    if (
      (
        asset.bucket_id === siblingAsset.bucket_id &&
        asset.object_path === siblingAsset.object_path
      )
    ) {
      console.error("Hub content asset isolation check failed", { contentId });
      return json(503, {
        error: "CONTENT_ASSET_UNAVAILABLE",
        code: "CONTENT_ASSET_UNAVAILABLE",
      });
    }

    const hubClient = auth.context.admin;
    const featureKey = assetKind === "FULL"
      ? "library.full_access"
      : "library.preview";
    const requestFingerprint = await sha256Hex(JSON.stringify({
      feature: featureKey,
      accountId: requestedAccountId,
      contentId,
      assetKind,
    }));
    const { data: usage, error: usageError } = await hubClient.rpc(
      "hub_reserve_feature",
      {
        p_user_id: auth.context.userId,
        p_feature_key: featureKey,
        p_units: 1,
        p_request_key: requestKey,
        p_request_fingerprint: requestFingerprint,
        p_account_id: requestedAccountId,
        p_metadata: { source: "hub-library-access", contentId, assetKind },
      },
    );
    if (usageError) {
      console.error("Hub library usage authorization failed", {
        code: usageError.code,
      });
      return json(503, {
        error: "HUB_ACCESS_UNAVAILABLE",
        code: "HUB_ACCESS_UNAVAILABLE",
      });
    }
    if (!usage?.allowed) {
      const code = typeof usage?.code === "string"
        ? usage.code
        : "CONTENT_ACCESS_DENIED";
      return json(hubAccessStatus(code), { error: code, code });
    }
    if (
      typeof usage.reservationId !== "string" ||
      typeof usage.leaseToken !== "string"
    ) {
      return json(503, {
        error: "HUB_ACCESS_UNAVAILABLE",
        code: "HUB_ACCESS_UNAVAILABLE",
      });
    }
    hubReservation = {
      client: hubClient,
      userId: auth.context.userId!,
      reservationId: usage.reservationId,
      leaseToken: usage.leaseToken,
      requestKey,
    };

    hubReleaseReason = "DELIVERY_FAILED";
    const { data: signed, error: signedError } = await auth.context.admin
      .storage
      .from(asset.bucket_id)
      .createSignedUrl(asset.object_path, SIGNED_URL_TTL_SECONDS);
    if (signedError || !signed?.signedUrl) {
      console.error("Hub library signed URL creation failed", {
        message: signedError?.message,
      });
      return json(503, {
        error: "CONTENT_DELIVERY_UNAVAILABLE",
        code: "CONTENT_DELIVERY_UNAVAILABLE",
      });
    }
    const deliveryUrl = signed.signedUrl;
    const expiresIn = SIGNED_URL_TTL_SECONDS;

    const resolvedAccountId = typeof usage.accountId === "string"
      ? usage.accountId
      : null;
    if (resolvedAccountId) {
      hubReleaseReason = "PERSISTENCE_FAILED";
      const { error: auditError } = await auth.context.admin.from(
        "hub_content_access_events",
      ).insert({
        account_id: resolvedAccountId,
        user_id: auth.context.userId,
        content_id: contentId,
        access_kind: assetKind === "PREVIEW" ? "PREVIEW" : "OPEN",
      });
      if (auditError) {
        console.error("Hub content audit was not recorded", {
          code: auditError.code,
        });
        return json(503, {
          error: "CONTENT_AUDIT_UNAVAILABLE",
          code: "CONTENT_AUDIT_UNAVAILABLE",
        });
      }
    }

    hubReleaseReason = "REQUEST_FAILED";
    const reservation = hubReservation;
    const { data: committed, error: commitError } = await reservation.client
      .rpc("hub_commit_feature", {
        p_user_id: reservation.userId,
        p_reservation_id: reservation.reservationId,
        p_lease_token: reservation.leaseToken,
        p_request_key: reservation.requestKey,
      });
    if (commitError) {
      console.error("Hub library usage commit failed", {
        code: commitError.code,
      });
      return json(503, {
        error: "HUB_ACCESS_UNAVAILABLE",
        code: "HUB_ACCESS_UNAVAILABLE",
      });
    }
    if (!committed?.allowed) {
      const code = typeof committed?.code === "string"
        ? committed.code
        : "HUB_ACCESS_UNAVAILABLE";
      return json(hubAccessStatus(code), { error: code, code });
    }
    hubReservation = null;

    return json(200, {
      signedUrl: deliveryUrl,
      expiresIn,
      remaining: committed.remaining ?? null,
    });
  } catch (error) {
    console.error("Hub library access failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return json(500, {
      error: "HUB_LIBRARY_ACCESS_FAILED",
      code: "HUB_LIBRARY_ACCESS_FAILED",
    });
  } finally {
    if (hubReservation) {
      const reservation = hubReservation;
      const { error: releaseError } = await reservation.client.rpc(
        "hub_release_feature",
        {
          p_user_id: reservation.userId,
          p_reservation_id: reservation.reservationId,
          p_lease_token: reservation.leaseToken,
          p_request_key: reservation.requestKey,
          p_reason: hubReleaseReason,
        },
      );
      if (releaseError) {
        console.warn("Hub library usage release failed", {
          code: releaseError.code,
        });
      }
    }
  }
});
