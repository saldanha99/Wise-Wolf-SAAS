/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  authorizeRequest,
  methodNotAllowed,
  type RequestAuthContext,
} from "../_shared/request-auth.ts";
import { materializeLegalSchoolInfo } from "../_shared/tenant-legal-assets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BODY_BYTES = 2_048;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operationalTenantStatuses = new Set(["active", "trial", "trialing"]);

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "application/json",
      Pragma: "no-cache",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request is too large");
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request is too large");
  }
  try {
    const body = JSON.parse(raw || "{}");
    if (!isRecord(body)) throw new Error();
    return body;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value.trim();
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ||
    "";
  if (!url || !serviceRoleKey) {
    throw new ApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "Legal assets are unavailable",
    );
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function isOperationalStatus(value: unknown): boolean {
  return typeof value === "string" &&
    operationalTenantStatuses.has(value.trim().toLowerCase());
}

export function offerKindMatches(
  offerType: unknown,
  persistedKind: unknown,
): boolean {
  if (offerType === "enrollment") return true;
  return offerType === "teacher"
    ? persistedKind === "TEACHER_INVITE"
    : offerType === "vendor" && persistedKind === "VENDOR_INVITE";
}

async function activeTenantId(context: RequestAuthContext): Promise<string> {
  if (context.profile?.role !== "SUPER_ADMIN" && context.profile?.tenant_id) {
    return context.profile.tenant_id;
  }
  if (!context.userId) {
    throw new ApiError(403, "ACTIVE_TENANT_REQUIRED", "Active tenant required");
  }
  const { data, error } = await context.admin
    .from("tenant_user_contexts")
    .select("tenant_id")
    .eq("user_id", context.userId)
    .maybeSingle();
  if (error || !data?.tenant_id) {
    throw new ApiError(403, "ACTIVE_TENANT_REQUIRED", "Active tenant required");
  }
  const { data: membership, error: membershipError } = await context.admin
    .from("tenant_memberships")
    .select("tenant_id")
    .eq("tenant_id", data.tenant_id)
    .eq("user_id", context.userId)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (membershipError || !membership) {
    throw new ApiError(403, "ACTIVE_TENANT_REQUIRED", "Active tenant required");
  }
  return data.tenant_id;
}

async function operationalTenant(
  context: RequestAuthContext,
): Promise<{ tenantId: string; schoolInfo: unknown }> {
  const tenantId = await activeTenantId(context);
  const { data, error } = await context.admin
    .from("tenants")
    .select("school_info,saas_status")
    .eq("id", tenantId)
    .maybeSingle();
  if (error || !data || !isOperationalStatus(data.saas_status)) {
    throw new ApiError(403, "TENANT_UNAVAILABLE", "Tenant is unavailable");
  }
  return { tenantId, schoolInfo: data.school_info };
}

async function resolveOffer(body: Record<string, unknown>): Promise<Response> {
  if (!hasOnlyKeys(body, ["action", "offerId", "offerType"])) {
    throw new ApiError(400, "INVALID_REQUEST", "Unexpected request fields");
  }
  const offerId = uuid(body.offerId, "offerId");
  if (
    body.offerType !== "teacher" && body.offerType !== "vendor" &&
    body.offerType !== "enrollment"
  ) {
    throw new ApiError(400, "INVALID_REQUEST", "offerType is invalid");
  }
  const admin = serviceClient();
  const rpc = body.offerType === "teacher" || body.offerType === "vendor"
    ? "get_invite_offer_public"
    : "get_offer_public";
  const { data, error } = await admin.rpc(rpc, { p_offer_id: offerId });
  if (error) {
    throw new ApiError(503, "OFFER_UNAVAILABLE", "Offer is unavailable");
  }
  if (!isRecord(data) || typeof data.error === "string") {
    return json(
      isRecord(data) ? data : { error: "OFFER_NOT_FOUND" },
      404,
    );
  }
  if (!offerKindMatches(body.offerType, data.kind)) {
    throw new ApiError(404, "OFFER_NOT_FOUND", "Offer is unavailable");
  }

  if (body.offerType === "vendor") {
    return json({
      kind: data.kind,
      commissionRate: data.commissionRate,
      suggestedName: data.suggestedName,
      tenantId: data.tenantId,
      _offerId: data._offerId,
    });
  }

  const tenantId = body.offerType === "teacher" ? data.tenantId : data.unitId;
  const schoolInfo = body.offerType === "teacher"
    ? data.schoolInfo
    : data._schoolInfo;
  if (typeof tenantId !== "string" || !tenantId || !isRecord(schoolInfo)) {
    throw new ApiError(
      409,
      "LEGAL_SNAPSHOT_MISSING",
      "Legal snapshot is missing",
    );
  }
  const materialized = await materializeLegalSchoolInfo(
    admin,
    tenantId,
    schoolInfo,
    { publicBaseUrl: Deno.env.get("SUPABASE_PUBLIC_URL") },
  );
  if (!materialized?.legalRepresentativeSignatureUrl) {
    throw new ApiError(
      409,
      "LEGAL_SIGNATURE_MISSING",
      "Legal signature is missing",
    );
  }
  return json({
    ...data,
    [body.offerType === "teacher" ? "schoolInfo" : "_schoolInfo"]: materialized,
  });
}

async function resolveCurrent(
  body: Record<string, unknown>,
  context: RequestAuthContext,
): Promise<Response> {
  if (!hasOnlyKeys(body, ["action"])) {
    throw new ApiError(400, "INVALID_REQUEST", "Unexpected request fields");
  }
  const tenant = await operationalTenant(context);
  const schoolInfo = await materializeLegalSchoolInfo(
    context.admin,
    tenant.tenantId,
    tenant.schoolInfo,
    { publicBaseUrl: Deno.env.get("SUPABASE_PUBLIC_URL") },
  );
  return json({ tenantId: tenant.tenantId, schoolInfo });
}

async function resolveContract(
  body: Record<string, unknown>,
  context: RequestAuthContext,
): Promise<Response> {
  if (!hasOnlyKeys(body, ["action", "userId"])) {
    throw new ApiError(400, "INVALID_REQUEST", "Unexpected request fields");
  }
  const userId = uuid(body.userId, "userId");
  const tenant = await operationalTenant(context);
  if (
    context.userId !== userId &&
    !["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(context.profile?.role || "")
  ) {
    throw new ApiError(403, "CONTRACT_FORBIDDEN", "Contract access denied");
  }
  const { data, error } = await context.admin
    .from("tenant_contract_records")
    .select(
      "party_snapshot,legal_snapshot,commercial_snapshot,accepted_at,accepted_ip",
    )
    .eq("tenant_id", tenant.tenantId)
    .eq("user_id", userId)
    .eq("contract_kind", "TEACHER")
    .maybeSingle();
  if (error) {
    throw new ApiError(503, "CONTRACT_UNAVAILABLE", "Contract is unavailable");
  }
  if (!data) {
    throw new ApiError(404, "CONTRACT_NOT_FOUND", "Contract not found");
  }

  const party = isRecord(data.party_snapshot) ? data.party_snapshot : {};
  const commercial = isRecord(data.commercial_snapshot)
    ? data.commercial_snapshot
    : {};
  const schoolInfo = await materializeLegalSchoolInfo(
    context.admin,
    tenant.tenantId,
    data.legal_snapshot,
    { publicBaseUrl: Deno.env.get("SUPABASE_PUBLIC_URL") },
  );
  return json({
    full_name: party.fullName,
    rg: party.rg,
    cpf: party.cpf,
    address: party.address,
    birth_date: party.birthDate,
    hourly_rate: commercial.hourlyRate,
    contract_accepted: true,
    accepted_at: data.accepted_at,
    user_ip: data.accepted_ip,
    schoolInfo,
  });
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);
  try {
    const body = await requestBody(req);
    if (body.action === "offer") return await resolveOffer(body);
    if (body.action !== "current" && body.action !== "contract") {
      throw new ApiError(400, "INVALID_ACTION", "Unsupported action");
    }

    const auth = await authorizeRequest(req, {
      corsHeaders,
      allowedRoles: [
        "STUDENT",
        "TEACHER",
        "SCHOOL_ADMIN",
        "SUPER_ADMIN",
        "COORDINATOR",
      ],
    });
    if (auth.ok === false) return auth.response;
    return body.action === "current"
      ? await resolveCurrent(body, auth.context)
      : await resolveContract(body, auth.context);
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    console.error("Tenant legal asset request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json(
      { error: "Legal assets are unavailable", code: "INTERNAL_ERROR" },
      500,
    );
  }
}

if (import.meta.main) serve(handleRequest);
