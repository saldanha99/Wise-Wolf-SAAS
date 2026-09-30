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

export function normalizeAffiliateCouponInput(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_COUPON", "Cupom inválido");
  }
  const normalized = value.trim().toUpperCase();
  if (normalized.length < 4 || normalized.length > 64) {
    throw new ApiError(400, "INVALID_COUPON", "Cupom inválido");
  }
  return normalized;
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

/**
 * Versao do contrato que a escola da oferta oferece aos contratos novos
 * (public.contract_terms_offered_version, migration 20260927150000). A pagina
 * de matricula e o convite do professor MOSTRAM e GRAVAM esta versao; so a
 * escola que decidiu registrar as aulas oferece a clausula. Resposta estranha
 * nao vira versao nenhuma: sem saber o texto, o contrato nao e mostrado.
 */
export function offeredContractTermsVersion(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  throw new ApiError(
    503,
    "CONTRACT_TERMS_UNAVAILABLE",
    "Contract terms are unavailable",
  );
}

async function loadOfferedContractTermsVersion(
  admin: ReturnType<typeof serviceClient>,
  tenantId: string,
  kind: "STUDENT" | "TEACHER",
): Promise<number> {
  const { data, error } = await admin.rpc("contract_terms_offered_version", {
    p_tenant: tenantId,
    p_contract_kind: kind,
  });
  if (error) {
    throw new ApiError(
      503,
      "CONTRACT_TERMS_UNAVAILABLE",
      "Contract terms are unavailable",
    );
  }
  return offeredContractTermsVersion(data);
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

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const HTTPS_URL = /^https:\/\/[^\s"<>]+$/;

/**
 * Marca pública da escola (cores e logo) para a página do convite de
 * afiliado — as mesmas regras da página de renovação: valor fora do formato
 * vira null e a tela cai no visual padrão. Nada de school_info aqui.
 */
export function publicSchoolBrand(branding: unknown): {
  brandPrimary: string | null;
  brandSecondary: string | null;
  schoolLogoUrl: string | null;
} {
  const record = isRecord(branding) ? branding : {};
  const hex = (value: unknown) =>
    typeof value === "string" && HEX_COLOR.test(value) ? value : null;
  return {
    brandPrimary: hex(record.primaryColor),
    brandSecondary: hex(record.secondaryColor),
    schoolLogoUrl:
      typeof record.logoUrl === "string" && HTTPS_URL.test(record.logoUrl)
        ? record.logoUrl
        : null,
  };
}

/** Falha ao ler a marca nunca derruba o convite: a página usa o padrão. */
async function loadPublicSchoolBrand(
  admin: ReturnType<typeof serviceClient>,
  tenantId: unknown,
): Promise<ReturnType<typeof publicSchoolBrand>> {
  if (typeof tenantId !== "string" || !tenantId) {
    return publicSchoolBrand(null);
  }
  try {
    const { data, error } = await admin
      .from("tenants")
      .select("branding")
      .eq("id", tenantId)
      .maybeSingle();
    return publicSchoolBrand(error ? null : data?.branding);
  } catch {
    return publicSchoolBrand(null);
  }
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
      // Cupom reservado no convite e nome da escola: a página de cadastro
      // explica o programa com os dados reais do afiliado.
      affiliateCode: typeof data.affiliateCode === "string"
        ? data.affiliateCode
        : null,
      linkedStudentId: typeof data.linkedStudentId === "string"
        ? data.linkedStudentId
        : null,
      schoolName: typeof data.schoolName === "string" ? data.schoolName : null,
      tenantId: data.tenantId,
      _offerId: data._offerId,
      // Cor e logo da escola: a página do convite leva a marca de quem convida.
      ...(await loadPublicSchoolBrand(admin, data.tenantId)),
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
  const contractTermsVersion = await loadOfferedContractTermsVersion(
    admin,
    tenantId,
    body.offerType === "teacher" ? "TEACHER" : "STUDENT",
  );
  let googleAccountRequired = false;
  if (body.offerType === "teacher") {
    const { data: required, error: requirementError } = await admin.rpc(
      "teacher_invite_google_required",
      { p_offer_id: offerId },
    );
    if (requirementError) {
      throw new ApiError(
        503,
        "GOOGLE_REQUIREMENT_UNAVAILABLE",
        "Google requirement is unavailable",
      );
    }
    googleAccountRequired = required === true;
  }
  return json({
    ...data,
    [body.offerType === "teacher" ? "schoolInfo" : "_schoolInfo"]: materialized,
    contractTermsVersion,
    ...(body.offerType === "teacher" ? { googleAccountRequired } : {}),
  });
}

async function applyAffiliateCoupon(
  body: Record<string, unknown>,
): Promise<Response> {
  if (!hasOnlyKeys(body, ["action", "offerId", "couponCode"])) {
    throw new ApiError(400, "INVALID_REQUEST", "Unexpected request fields");
  }
  const offerId = uuid(body.offerId, "offerId");
  const couponCode = normalizeAffiliateCouponInput(body.couponCode);
  const admin = serviceClient();
  const { data, error } = await admin.rpc("apply_affiliate_coupon", {
    p_offer_id: offerId,
    p_coupon_code: couponCode,
  });
  if (error) {
    throw new ApiError(503, "COUPON_UNAVAILABLE", "Cupom indisponível");
  }
  if (!isRecord(data) || data.ok !== true) {
    const code = isRecord(data) && typeof data.error === "string"
      ? data.error
      : "INVALID_COUPON";
    // Domain rejections stay HTTP 200 so supabase-js preserves the structured
    // code for the registration UI. Transport/auth failures still use non-2xx.
    return json({ error: code });
  }

  // Return the same materialized offer contract used by the registration page,
  // now with the authoritative fee set to zero.
  return await resolveOffer({
    action: "offer",
    offerId,
    offerType: "enrollment",
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

/**
 * Como o contrato do professor exibe o valor. `rateUnit` e o que o convite
 * (register-teacher) grava e o que a folha le (teacher_student_rate troca a
 * regua de pagamento com rateUnit = PER_LESSON). O aceite pelo app
 * (accept_teacher_contract, migration 20260927150000) NAO grava rateUnit, para
 * nao mudar pagamento, e grava displayRateUnit = PER_LESSON: a tela assinada
 * mostrou o valor por aula, e sem isso a copia mostraria metade dele (a regra
 * do contrato antigo por hora). So PER_LESSON e aceito como exibicao.
 */
export function teacherContractRateUnit(
  commercial: Record<string, unknown>,
): string | undefined {
  if (typeof commercial.rateUnit === "string" && commercial.rateUnit) {
    return commercial.rateUnit;
  }
  return commercial.displayRateUnit === "PER_LESSON" ? "PER_LESSON" : undefined;
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
    const { data: teacher, error: teacherError } = await context.admin
      .from("profiles")
      .select("full_name,contract_accepted")
      .eq("tenant_id", tenant.tenantId)
      .eq("id", userId)
      .eq("role", "TEACHER")
      .maybeSingle();
    if (teacherError) {
      throw new ApiError(
        503,
        "CONTRACT_UNAVAILABLE",
        "Contract is unavailable",
      );
    }
    if (!teacher) {
      throw new ApiError(404, "CONTRACT_NOT_FOUND", "Contract not found");
    }
    return json({
      archiveStatus: "MISSING",
      full_name: teacher.full_name,
      contractAccepted: teacher.contract_accepted === true,
      canSign: context.userId === userId && teacher.contract_accepted !== true,
    });
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
    rateUnit: teacherContractRateUnit(commercial),
    // Versão do texto assinado (register-teacher grava desde 27/09/2026).
    // Ausente = contrato de antes: a tela mostra o texto antigo.
    contractTermsVersion: Number.isInteger(commercial.contractTermsVersion)
      ? commercial.contractTermsVersion
      : null,
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
    if (body.action === "applyAffiliateCoupon") {
      return await applyAffiliateCoupon(body);
    }
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
