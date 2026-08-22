/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const operationalTenantStatuses = new Set(["active", "trial", "trialing"]);

function errorResponse(status: number): Response {
  return new Response("Asset not found", {
    status,
    headers: { ...corsHeaders, "Cache-Control": "public, max-age=60" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isPublicBrandingPath(
  path: unknown,
  tenantId: string,
  kind: "logo" | "favicon",
): path is string {
  if (typeof path !== "string" || !tenantId) return false;
  const suffix = kind === "favicon" ? "(?:png|ico)" : "(?:png|jpe?g|webp)";
  return new RegExp(
    `^${escapedPattern(tenantId)}/${kind}/${UUID_PATTERN}\\.${suffix}$`,
    "i",
  ).test(path);
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") return errorResponse(405);

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant")?.trim() || "";
  const kind = url.searchParams.get("kind");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(tenantId) ||
    (kind !== "logo" && kind !== "favicon")
  ) return errorResponse(404);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ||
    "";
  if (!supabaseUrl || !serviceRoleKey) return errorResponse(503);
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: tenant, error } = await admin
    .from("tenants")
    .select("branding,saas_status")
    .eq("id", tenantId)
    .maybeSingle();
  if (
    error || !tenant ||
    typeof tenant.saas_status !== "string" ||
    !operationalTenantStatuses.has(tenant.saas_status.trim().toLowerCase()) ||
    !isRecord(tenant.branding)
  ) return errorResponse(404);

  const path = tenant.branding[kind === "logo" ? "logoPath" : "faviconPath"];
  if (!isPublicBrandingPath(path, tenantId, kind)) return errorResponse(404);

  const { data: object, error: downloadError } = await admin.storage
    .from("tenant-branding")
    .download(path);
  if (downloadError || !object) return errorResponse(404);
  const extension = path.split(".").pop()?.toLowerCase();
  const contentType = extension === "jpg" || extension === "jpeg"
    ? "image/jpeg"
    : extension === "webp"
    ? "image/webp"
    : extension === "ico"
    ? "image/x-icon"
    : "image/png";

  return new Response(await object.arrayBuffer(), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

if (import.meta.main) serve(handleRequest);
