import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  authorizeRequest,
  methodNotAllowed,
  type RequestAuthContext,
} from "../_shared/request-auth.ts";
import {
  legalSignatureLocation,
  materializeLegalSchoolInfo,
} from "../_shared/tenant-legal-assets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const providers = ["asaas", "evolution", "openai", "openrouter"] as const;
type Provider = (typeof providers)[number];
const operationalTenantStatuses = new Set(["active", "trial", "trialing"]);

export function isOperationalTenantStatus(value: unknown): boolean {
  return typeof value === "string" &&
    operationalTenantStatuses.has(value.trim().toLowerCase());
}

const MAX_BODY_BYTES = 32_768;
function environmentValue(name: string, fallback: string): string {
  try {
    return Deno.env.get(name)?.trim() || fallback;
  } catch {
    return fallback;
  }
}

const CNAME_TARGET = environmentValue(
  "CUSTOM_DOMAIN_CNAME_TARGET",
  "system.wisewolflanguage.com.br",
).toLowerCase().replace(/\.$/, "");
const BRANDING_PUBLIC_ORIGIN = environmentValue(
  "BRANDING_PUBLIC_ORIGIN",
  "https://api.wisewolflanguage.com.br",
).replace(/\/$/, "");

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
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function rejectInactiveTenantError(
  error: { code?: string } | null | undefined,
): void {
  if (error?.code === "55000") {
    throw new ApiError(
      403,
      "TENANT_INACTIVE",
      "The selected tenant is not active",
    );
  }
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

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
  minLength = 1,
): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_SETTINGS", `${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new ApiError(400, "INVALID_SETTINGS", `${field} is invalid`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new ApiError(400, "INVALID_SETTINGS", `${field} is invalid`);
  }
  return value.trim();
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ApiError(400, "INVALID_SETTINGS", `${field} is invalid`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) || Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new ApiError(400, "INVALID_SETTINGS", `${field} is invalid`);
  }
  return Number(value);
}

function normalizedHostname(value: unknown): string {
  const hostname = requiredString(value, "domain", 253, 4).toLowerCase()
    .replace(/\.$/, "");
  if (
    hostname.includes("://") || hostname.includes("/") ||
    hostname.includes(":") ||
    hostname === "localhost" || hostname.endsWith(".local") ||
    hostname === "wisewolflanguage.com.br" ||
    hostname.endsWith(".wisewolflanguage.com.br") ||
    !/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
      .test(
        hostname,
      )
  ) {
    throw new ApiError(400, "INVALID_DOMAIN", "Use a valid external hostname");
  }
  return hostname;
}

function normalizedSlug(value: unknown): string {
  const slug = requiredString(value, "slug", 40, 3).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(slug)) {
    throw new ApiError(400, "INVALID_SETTINGS", "slug is invalid");
  }
  return slug;
}

function normalizedColor(value: unknown, field: string): string {
  const color = requiredString(value, field, 7, 7);
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new ApiError(400, "INVALID_SETTINGS", `${field} is invalid`);
  }
  return color.toUpperCase();
}

function assetPath(
  value: unknown,
  tenantId: string,
  kind: "logo" | "favicon",
): string {
  if (value === undefined || value === null || value === "") return "";
  const path = requiredString(value, `${kind}Path`, 512);
  const escapedTenant = tenantId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = kind === "favicon" ? "(?:png|ico)" : "(?:png|jpe?g|webp)";
  const pattern = new RegExp(
    `^${escapedTenant}/${kind}/[0-9a-f-]{36}\\.${suffix}$`,
    "i",
  );
  if (!pattern.test(path)) {
    throw new ApiError(
      400,
      "INVALID_BRANDING_ASSET",
      `${kind} path is invalid`,
    );
  }
  return path;
}

function publicBrandingUrl(path: string): string {
  if (!path) return "";
  return `${BRANDING_PUBLIC_ORIGIN}/storage/v1/object/public/tenant-public-branding/${
    path.split("/").map(encodeURIComponent).join("/")
  }`;
}

const schoolInfoKeys = [
  "name",
  "legalName",
  "cnpj",
  "address",
  "email",
  "phone",
  "city",
  "state",
  "directorName",
  "legalRepresentativeName",
  "legalRepresentativeSignaturePath",
  "privacyContactEmail",
] as const;

function isValidCnpj(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;
  const calculateDigit = (length: number): number => {
    let factor = length - 7;
    let total = 0;
    for (let index = 0; index < length; index += 1) {
      total += Number(digits[index]) * factor;
      factor -= 1;
      if (factor === 1) factor = 9;
    }
    const remainder = total % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return calculateDigit(12) === Number(digits[12]) &&
    calculateDigit(13) === Number(digits[13]);
}

function normalizeSchoolInfo(
  value: unknown,
  tenantId: string,
): Record<string, string> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !hasOnlyKeys(value, schoolInfoKeys)) {
    throw new ApiError(400, "INVALID_SETTINGS", "schoolInfo is invalid");
  }

  const normalized: Record<string, string> = {};
  for (const key of schoolInfoKeys) {
    const maxLength = key === "address"
      ? 300
      : key === "legalRepresentativeSignaturePath"
      ? 512
      : 160;
    const fieldValue = optionalString(
      value[key],
      `schoolInfo.${key}`,
      maxLength,
    );
    if (fieldValue) normalized[key] = fieldValue;
  }

  if (normalized.cnpj && !isValidCnpj(normalized.cnpj)) {
    throw new ApiError(400, "INVALID_SETTINGS", "schoolInfo.cnpj is invalid");
  }
  for (const key of ["email", "privacyContactEmail"] as const) {
    if (
      normalized[key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized[key])
    ) {
      throw new ApiError(
        400,
        "INVALID_SETTINGS",
        `schoolInfo.${key} is invalid`,
      );
    }
  }
  if (
    normalized.legalRepresentativeSignaturePath &&
    !legalSignatureLocation(
      normalized.legalRepresentativeSignaturePath,
      tenantId,
    )
  ) {
    throw new ApiError(
      400,
      "INVALID_SETTINGS",
      "schoolInfo.legalRepresentativeSignaturePath is invalid",
    );
  }
  if (normalized.state && !/^[A-Za-z]{2}$/.test(normalized.state)) {
    throw new ApiError(400, "INVALID_SETTINGS", "schoolInfo.state is invalid");
  }
  if (normalized.state) normalized.state = normalized.state.toUpperCase();
  return Object.keys(normalized).length ? normalized : null;
}

export interface NormalizedSettings {
  name: string;
  slug: string;
  branding: {
    primaryColor: string;
    secondaryColor: string;
    logoPath: string;
    faviconPath: string;
    logoUrl: string;
    faviconUrl: string;
  };
  schoolInfo: Record<string, string> | null;
  whatsappEnabled: boolean;
  financialCutoffDay: number;
  locale: string;
  timezone: string;
  currency: string;
  weekStartsOn: number;
  defaultLessonDurationMinutes: number;
  studentNotificationsEnabled: boolean;
  teacherNotificationsEnabled: boolean;
}

export function normalizeSettings(
  value: unknown,
  tenantId: string,
  currentBranding: Record<string, unknown>,
): NormalizedSettings {
  const keys = [
    "name",
    "slug",
    "branding",
    "schoolInfo",
    "whatsappEnabled",
    "financialCutoffDay",
    "locale",
    "timezone",
    "currency",
    "weekStartsOn",
    "defaultLessonDurationMinutes",
    "studentNotificationsEnabled",
    "teacherNotificationsEnabled",
  ] as const;
  if (
    !isRecord(value) || !hasOnlyKeys(value, keys) || !isRecord(value.branding)
  ) {
    throw new ApiError(400, "INVALID_SETTINGS", "Settings payload is invalid");
  }
  if (
    !hasOnlyKeys(value.branding, [
      "primaryColor",
      "secondaryColor",
      "logoPath",
      "faviconPath",
      "logoUrl",
      "faviconUrl",
    ])
  ) {
    throw new ApiError(400, "INVALID_SETTINGS", "Branding payload is invalid");
  }

  const logoPath = assetPath(value.branding.logoPath, tenantId, "logo");
  const faviconPath = assetPath(
    value.branding.faviconPath,
    tenantId,
    "favicon",
  );
  const existingLogoUrl = optionalString(
    currentBranding.logoUrl,
    "logoUrl",
    2048,
  );
  const existingFaviconUrl = optionalString(
    currentBranding.faviconUrl,
    "faviconUrl",
    2048,
  );

  const locale = requiredString(value.locale, "locale", 5, 2);
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale)) {
    throw new ApiError(400, "INVALID_SETTINGS", "locale is invalid");
  }
  const timezone = requiredString(value.timezone, "timezone", 64, 3);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new ApiError(400, "INVALID_SETTINGS", "timezone is invalid");
  }
  const currency = requiredString(value.currency, "currency", 3, 3)
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiError(400, "INVALID_SETTINGS", "currency is invalid");
  }

  return {
    name: requiredString(value.name, "name", 120, 2),
    slug: normalizedSlug(value.slug),
    branding: {
      primaryColor: normalizedColor(
        value.branding.primaryColor,
        "primaryColor",
      ),
      secondaryColor: normalizedColor(
        value.branding.secondaryColor,
        "secondaryColor",
      ),
      logoPath,
      faviconPath,
      logoUrl: logoPath ? publicBrandingUrl(logoPath) : existingLogoUrl,
      faviconUrl: faviconPath
        ? publicBrandingUrl(faviconPath)
        : existingFaviconUrl,
    },
    schoolInfo: normalizeSchoolInfo(value.schoolInfo, tenantId),
    whatsappEnabled: requiredBoolean(value.whatsappEnabled, "whatsappEnabled"),
    financialCutoffDay: boundedInteger(
      value.financialCutoffDay,
      "financialCutoffDay",
      1,
      28,
    ),
    locale,
    timezone,
    currency,
    weekStartsOn: boundedInteger(value.weekStartsOn, "weekStartsOn", 0, 6),
    defaultLessonDurationMinutes: boundedInteger(
      value.defaultLessonDurationMinutes,
      "defaultLessonDurationMinutes",
      15,
      240,
    ),
    studentNotificationsEnabled: requiredBoolean(
      value.studentNotificationsEnabled,
      "studentNotificationsEnabled",
    ),
    teacherNotificationsEnabled: requiredBoolean(
      value.teacherNotificationsEnabled,
      "teacherNotificationsEnabled",
    ),
  };
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }
  try {
    const parsed = JSON.parse(rawBody || "{}");
    if (!isRecord(parsed)) throw new Error("not_an_object");
    return parsed;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

async function resolveActiveTenant(
  context: RequestAuthContext,
): Promise<string> {
  const role = context.profile?.role;
  if (role === "SCHOOL_ADMIN" && context.profile?.tenant_id) {
    await requireOperationalTenant(context.admin, context.profile.tenant_id);
    return context.profile.tenant_id;
  }
  if (role !== "SUPER_ADMIN" || !context.userId) {
    throw new ApiError(
      403,
      "ROLE_FORBIDDEN",
      "School administrator access required",
    );
  }

  const { data: selectedContext, error: contextError } = await context.admin
    .from("tenant_user_contexts")
    .select("tenant_id")
    .eq("user_id", context.userId)
    .maybeSingle();
  if (contextError || !selectedContext?.tenant_id) {
    throw new ApiError(
      403,
      "ACTIVE_TENANT_REQUIRED",
      "Select an active tenant before managing settings",
    );
  }

  const { data: membership, error: membershipError } = await context.admin
    .from("tenant_memberships")
    .select("tenant_id")
    .eq("user_id", context.userId)
    .eq("tenant_id", selectedContext.tenant_id)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (membershipError || !membership) {
    throw new ApiError(
      403,
      "ACTIVE_TENANT_REQUIRED",
      "The selected tenant membership is not active",
    );
  }
  await requireOperationalTenant(context.admin, selectedContext.tenant_id);
  return selectedContext.tenant_id;
}

async function requireOperationalTenant(
  admin: SupabaseClient,
  tenantId: string,
): Promise<void> {
  const { data, error } = await admin
    .from("tenants")
    .select("saas_status")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) {
    console.error("Tenant status lookup failed", { code: error.code });
    throw new ApiError(
      503,
      "TENANT_STATUS_UNAVAILABLE",
      "Tenant status is temporarily unavailable",
    );
  }
  if (!data || !isOperationalTenantStatus(data.saas_status)) {
    throw new ApiError(
      403,
      "TENANT_INACTIVE",
      "The selected tenant is not active",
    );
  }
}

async function consumeRateLimit(
  admin: SupabaseClient,
  tenantId: string,
  action: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const { data, error } = await admin.rpc(
    "consume_tenant_settings_rate_limit",
    {
      p_tenant_id: tenantId,
      p_action_key: action,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    },
  );
  if (error) {
    throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "Try again later");
  }
  if (data !== true) {
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "Too many requests. Try again later",
    );
  }
}

async function loadSettings(admin: SupabaseClient, tenantId: string) {
  const [tenantResult, settingsResult, secretsResult, auditResult] =
    await Promise.all([
      admin.from("tenants").select(
        "id,name,slug,domain,branding,school_info,whatsapp_enabled,financial_cutoff_day,custom_domain,custom_domain_verified,custom_domain_dns_token,custom_domain_verified_at,student_limit,teacher_limit,plan_id,saas_status,current_period_end",
      ).eq("id", tenantId).maybeSingle(),
      admin.from("tenant_admin_settings").select(
        "version,locale,timezone,currency,week_starts_on,default_lesson_duration_minutes,student_notifications_enabled,teacher_notifications_enabled,updated_at",
      ).eq("tenant_id", tenantId).maybeSingle(),
      admin.rpc("get_tenant_secret_status", { p_tenant_id: tenantId }),
      admin.from("tenant_configuration_audit").select(
        "id,actor_role,action,section,changes,created_at",
      ).eq("tenant_id", tenantId).order("created_at", { ascending: false })
        .limit(20),
    ]);

  if (tenantResult.error || !tenantResult.data || settingsResult.error) {
    throw new ApiError(
      404,
      "TENANT_NOT_FOUND",
      "Tenant settings were not found",
    );
  }
  if (!isOperationalTenantStatus(tenantResult.data.saas_status)) {
    throw new ApiError(
      403,
      "TENANT_INACTIVE",
      "The selected tenant is not active",
    );
  }
  if (secretsResult.error || auditResult.error) {
    throw new ApiError(
      503,
      "SETTINGS_UNAVAILABLE",
      "Settings are temporarily unavailable",
    );
  }

  const tenant = tenantResult.data;
  let schoolInfo = tenant.school_info || null;
  try {
    schoolInfo = await materializeLegalSchoolInfo(
      admin,
      tenantId,
      tenant.school_info,
      { includePath: true },
    );
  } catch (error) {
    console.error("Tenant legal signature lookup failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    if (isRecord(tenant.school_info)) {
      schoolInfo = { ...tenant.school_info };
      delete schoolInfo.legalRepresentativeSignatureUrl;
      delete schoolInfo.directorSignatureUrl;
      delete schoolInfo.signatureUrl;
    }
  }
  const settings = settingsResult.data || {
    version: 1,
    locale: "pt-BR",
    timezone: "America/Sao_Paulo",
    currency: "BRL",
    week_starts_on: 1,
    default_lesson_duration_minutes: 60,
    student_notifications_enabled: true,
    teacher_notifications_enabled: true,
    updated_at: null,
  };
  const statuses = new Map(
    ((secretsResult.data || []) as Array<Record<string, unknown>>).map((
      row,
    ) => [
      row.provider,
      row,
    ]),
  );

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug || "",
      domain: tenant.domain || "",
      branding: tenant.branding || {},
      schoolInfo,
      whatsappEnabled: tenant.whatsapp_enabled === true,
      financialCutoffDay: tenant.financial_cutoff_day || 5,
      customDomain: tenant.custom_domain || "",
      customDomainVerified: tenant.custom_domain_verified === true,
      customDomainDnsToken: tenant.custom_domain_dns_token || "",
      customDomainVerifiedAt: tenant.custom_domain_verified_at,
      studentLimit: tenant.student_limit,
      teacherLimit: tenant.teacher_limit,
      planId: tenant.plan_id,
      subscriptionStatus: tenant.saas_status,
      currentPeriodEnd: tenant.current_period_end,
    },
    settings: {
      version: settings.version,
      locale: settings.locale,
      timezone: settings.timezone,
      currency: settings.currency,
      weekStartsOn: settings.week_starts_on,
      defaultLessonDurationMinutes: settings.default_lesson_duration_minutes,
      studentNotificationsEnabled: settings.student_notifications_enabled,
      teacherNotificationsEnabled: settings.teacher_notifications_enabled,
      updatedAt: settings.updated_at,
    },
    integrations: providers.map((provider) => {
      const row = statuses.get(provider) as Record<string, unknown> | undefined;
      return row
        ? {
          provider,
          configured: true,
          environment: row.environment,
          status: row.status,
          secretLastFour: row.secret_last_four,
          accountLabel: row.account_label,
          lastValidatedAt: row.last_validated_at,
          updatedAt: row.updated_at,
        }
        : {
          provider,
          configured: false,
          environment: provider === "asaas" ? "sandbox" : "production",
          status: "not_configured",
          secretLastFour: null,
          accountLabel: null,
          lastValidatedAt: null,
          updatedAt: null,
        };
    }),
    audit: auditResult.data || [],
    dns: {
      verificationRecord: tenant.custom_domain
        ? `_wisewolf-verify.${tenant.custom_domain}`
        : "",
      cnameTarget: CNAME_TARGET,
    },
    security: {
      tenantAuthority: "active_membership_and_operational_subscription",
      tenantDerivedOnServer: true,
      secretStorage: "supabase_vault",
      brandingNamespace: `tenant-public-branding/${tenantId}`,
      legalAssetNamespace: `tenant-legal-assets/${tenantId}`,
    },
  };
}

interface ProviderValidation {
  accountLabel: string | null;
  environment: "sandbox" | "production" | "platform";
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  const text = (await response.text()).slice(0, 200_000);
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function validateProviderCredential(
  provider: Provider,
  secret: string,
  requestedEnvironment: unknown,
  fetcher: typeof fetch = fetch,
): Promise<ProviderValidation> {
  let url: string;
  let headers: Record<string, string>;
  let environment: ProviderValidation["environment"];

  if (provider === "asaas") {
    if (
      requestedEnvironment !== "sandbox" &&
      requestedEnvironment !== "production"
    ) {
      throw new ApiError(
        400,
        "INVALID_ENVIRONMENT",
        "Invalid Asaas environment",
      );
    }
    environment = requestedEnvironment;
    url = environment === "production"
      ? "https://api.asaas.com/v3/myAccount"
      : "https://api-sandbox.asaas.com/v3/myAccount";
    headers = { access_token: secret };
  } else if (provider === "evolution") {
    environment = "platform";
    const base = environmentValue("EVOLUTION_API_URL", "https://api.2b.app.br")
      .replace(/\/$/, "");
    const parsedBase = new URL(base);
    if (
      parsedBase.protocol !== "https:" || parsedBase.username ||
      parsedBase.password
    ) {
      throw new ApiError(
        503,
        "PROVIDER_UNAVAILABLE",
        "Provider is unavailable",
      );
    }
    url = `${base}/instance/fetchInstances`;
    headers = { apikey: secret };
  } else if (provider === "openai") {
    environment = "production";
    url = "https://api.openai.com/v1/models";
    headers = { Authorization: `Bearer ${secret}` };
  } else {
    environment = "production";
    url = "https://openrouter.ai/api/v1/key";
    headers = { Authorization: `Bearer ${secret}` };
  }

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { ...headers, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ApiError(
      502,
      "PROVIDER_UNAVAILABLE",
      "Provider validation failed",
    );
  }
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403
      ? 422
      : 502;
    throw new ApiError(
      status,
      "INVALID_CREDENTIAL",
      "The provider rejected this credential",
    );
  }

  const data = await safeJson(response);
  const labelCandidate = provider === "asaas"
    ? data.name || data.email || data.id
    : provider === "openrouter"
    ? data.label || data.name
    : null;
  const accountLabel = typeof labelCandidate === "string"
    ? labelCandidate.trim().slice(0, 120) || null
    : null;
  return { accountLabel, environment };
}

async function dnsAnswers(
  hostname: string,
  type: "TXT" | "CNAME",
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const endpoint = new URL("https://cloudflare-dns.com/dns-query");
  endpoint.searchParams.set("name", hostname);
  endpoint.searchParams.set("type", type);
  const response = await fetcher(endpoint, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new ApiError(
      502,
      "DNS_UNAVAILABLE",
      "DNS verification is unavailable",
    );
  }
  const payload = await safeJson(response);
  const answers = Array.isArray(payload.Answer) ? payload.Answer : [];
  return answers.flatMap((answer) => {
    if (!isRecord(answer) || typeof answer.data !== "string") return [];
    return [answer.data.replace(/^"|"$/g, "").replace(/"\s+"/g, "")];
  });
}

export async function verifyDnsOwnership(
  domain: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<{ txtVerified: boolean; cnameVerified: boolean }> {
  const [txt, cname] = await Promise.all([
    dnsAnswers(`_wisewolf-verify.${domain}`, "TXT", fetcher),
    dnsAnswers(domain, "CNAME", fetcher),
  ]);
  return {
    txtVerified: txt.some((answer) => answer === token),
    cnameVerified: cname.some((answer) =>
      answer.toLowerCase().replace(/\.$/, "") === CNAME_TARGET
    ),
  };
}

function providerFrom(value: unknown): Provider {
  if (typeof value !== "string" || !providers.includes(value as Provider)) {
    throw new ApiError(400, "INVALID_PROVIDER", "Unsupported provider");
  }
  return value as Provider;
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  try {
    const body = await requestBody(req);
    const auth = await authorizeRequest(req, {
      corsHeaders,
      allowedRoles: ["SCHOOL_ADMIN", "SUPER_ADMIN"],
    });
    if (auth.ok === false) return auth.response;

    const tenantId = await resolveActiveTenant(auth.context);
    const actorId = auth.context.userId;
    if (!actorId) {
      throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
    }
    const action = body.action;
    if (typeof action !== "string") {
      throw new ApiError(400, "INVALID_ACTION", "Action is required");
    }
    if ("tenantId" in body || "tenant_id" in body || "role" in body) {
      throw new ApiError(
        400,
        "SERVER_DERIVED_TENANT",
        "Tenant and role are derived from the authenticated session",
      );
    }

    if (action === "get") {
      if (!hasOnlyKeys(body, ["action"])) {
        throw new ApiError(400, "INVALID_ACTION", "Unexpected request fields");
      }
      await consumeRateLimit(auth.context.admin, tenantId, "get", 120, 60);
      return json(await loadSettings(auth.context.admin, tenantId));
    }

    if (action === "save") {
      if (!hasOnlyKeys(body, ["action", "version", "settings"])) {
        throw new ApiError(400, "INVALID_ACTION", "Unexpected request fields");
      }
      await consumeRateLimit(auth.context.admin, tenantId, "save", 20, 300);
      const version = boundedInteger(
        body.version,
        "version",
        1,
        Number.MAX_SAFE_INTEGER,
      );
      const { data: tenant, error: tenantError } = await auth.context.admin
        .from("tenants")
        .select("branding")
        .eq("id", tenantId)
        .maybeSingle();
      if (tenantError || !tenant) {
        throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant was not found");
      }
      const settings = normalizeSettings(
        body.settings,
        tenantId,
        isRecord(tenant.branding) ? tenant.branding : {},
      );
      if (settings.schoolInfo?.legalRepresentativeSignaturePath) {
        try {
          const verifiedSchoolInfo = await materializeLegalSchoolInfo(
            auth.context.admin,
            tenantId,
            settings.schoolInfo,
            { includePath: true },
          );
          if (!verifiedSchoolInfo?.legalRepresentativeSignatureUrl) {
            throw new Error("signature_missing");
          }
        } catch {
          throw new ApiError(
            400,
            "INVALID_LEGAL_SIGNATURE",
            "Legal signature object is unavailable",
          );
        }
      }
      const { data, error } = await auth.context.admin.rpc(
        "apply_tenant_admin_settings",
        {
          p_tenant_id: tenantId,
          p_actor_id: actorId,
          p_expected_version: version,
          p_settings: settings,
        },
      );
      if (error) {
        rejectInactiveTenantError(error);
        if (error.code === "40001") {
          throw new ApiError(
            409,
            "SETTINGS_CONFLICT",
            "Reload before saving again",
          );
        }
        if (error.code === "23505") {
          throw new ApiError(
            409,
            "SLUG_IN_USE",
            "This school address is already in use",
          );
        }
        throw new ApiError(400, "SETTINGS_REJECTED", "Settings were not saved");
      }
      return json({ ok: true, version: data?.version });
    }

    if (action === "secret:set") {
      if (!hasOnlyKeys(body, ["action", "provider", "secret", "environment"])) {
        throw new ApiError(400, "INVALID_ACTION", "Unexpected request fields");
      }
      const provider = providerFrom(body.provider);
      const secret = requiredString(body.secret, "secret", 4096, 8);
      await consumeRateLimit(
        auth.context.admin,
        tenantId,
        `secret:${provider}`,
        5,
        900,
      );
      const validation = await validateProviderCredential(
        provider,
        secret,
        body.environment,
      );
      const { data, error } = await auth.context.admin.rpc(
        "upsert_tenant_integration_secret",
        {
          p_tenant_id: tenantId,
          p_provider: provider,
          p_secret: secret,
          p_environment: validation.environment,
          p_actor_id: actorId,
          p_account_label: validation.accountLabel,
        },
      );
      if (error) {
        rejectInactiveTenantError(error);
        throw new ApiError(
          503,
          "SECRET_STORAGE_FAILED",
          "Credential was not stored",
        );
      }
      return json({ ok: true, integration: data });
    }

    if (action === "secret:delete") {
      if (!hasOnlyKeys(body, ["action", "provider"])) {
        throw new ApiError(400, "INVALID_ACTION", "Unexpected request fields");
      }
      const provider = providerFrom(body.provider);
      await consumeRateLimit(
        auth.context.admin,
        tenantId,
        `secret-delete:${provider}`,
        5,
        900,
      );
      const { data, error } = await auth.context.admin.rpc(
        "delete_tenant_integration_secret",
        { p_tenant_id: tenantId, p_provider: provider, p_actor_id: actorId },
      );
      if (error) {
        rejectInactiveTenantError(error);
        throw new ApiError(
          503,
          "SECRET_DELETE_FAILED",
          "Credential was not removed",
        );
      }
      return json({ ok: true, removed: data === true });
    }

    if (action === "domain:request") {
      if (!hasOnlyKeys(body, ["action", "domain"])) {
        throw new ApiError(400, "INVALID_ACTION", "Unexpected request fields");
      }
      await consumeRateLimit(
        auth.context.admin,
        tenantId,
        "domain-request",
        10,
        900,
      );
      const domain = normalizedHostname(body.domain);
      const { data: conflict, error: conflictError } = await auth.context.admin
        .from("tenants")
        .select("id")
        .ilike("custom_domain", domain)
        .neq("id", tenantId)
        .limit(1)
        .maybeSingle();
      if (conflictError) {
        throw new ApiError(
          503,
          "DOMAIN_CHECK_FAILED",
          "Domain could not be checked",
        );
      }
      if (conflict) {
        throw new ApiError(409, "DOMAIN_IN_USE", "Domain is already in use");
      }

      const token = `wwv-${crypto.randomUUID().replaceAll("-", "")}`;
      const { error } = await auth.context.admin.rpc(
        "request_tenant_custom_domain_server",
        {
          p_tenant_id: tenantId,
          p_actor_id: actorId,
          p_domain: domain,
          p_dns_token: token,
        },
      );
      if (error?.code === "23505") {
        throw new ApiError(409, "DOMAIN_IN_USE", "Domain is already in use");
      }
      rejectInactiveTenantError(error);
      if (error) {
        throw new ApiError(400, "DOMAIN_REJECTED", "Domain was not saved");
      }
      return json({
        ok: true,
        domain,
        dns: {
          txtName: `_wisewolf-verify.${domain}`,
          txtValue: token,
          cnameName: domain,
          cnameValue: CNAME_TARGET,
        },
      });
    }

    if (action === "domain:verify") {
      if (!hasOnlyKeys(body, ["action"])) {
        throw new ApiError(400, "INVALID_ACTION", "Unexpected request fields");
      }
      await consumeRateLimit(
        auth.context.admin,
        tenantId,
        "domain-verify",
        12,
        900,
      );
      const { data: tenant, error: tenantError } = await auth.context.admin
        .from("tenants")
        .select("custom_domain,custom_domain_dns_token")
        .eq("id", tenantId)
        .maybeSingle();
      if (
        tenantError || !tenant?.custom_domain || !tenant.custom_domain_dns_token
      ) {
        throw new ApiError(
          400,
          "DOMAIN_NOT_REQUESTED",
          "Request a domain first",
        );
      }
      const verification = await verifyDnsOwnership(
        tenant.custom_domain,
        tenant.custom_domain_dns_token,
      );
      if (!verification.txtVerified || !verification.cnameVerified) {
        return json({
          ok: false,
          code: "DNS_NOT_READY",
          verification,
          message: "TXT ownership and CNAME routing must both be valid",
        }, 409);
      }
      const { data: verifiedAt, error } = await auth.context.admin.rpc(
        "verify_tenant_custom_domain_server",
        {
          p_tenant_id: tenantId,
          p_actor_id: actorId,
          p_expected_dns_token: tenant.custom_domain_dns_token,
        },
      );
      if (error?.code === "40001") {
        throw new ApiError(
          409,
          "DOMAIN_STATE_CHANGED",
          "Reload and verify again",
        );
      }
      rejectInactiveTenantError(error);
      if (error) {
        throw new ApiError(
          503,
          "DOMAIN_UPDATE_FAILED",
          "Domain was not activated",
        );
      }
      return json({ ok: true, verifiedAt, verification });
    }

    throw new ApiError(400, "INVALID_ACTION", "Unsupported action");
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    console.error("Tenant settings request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json(
      { error: "Unexpected server error", code: "INTERNAL_ERROR" },
      500,
    );
  }
}

if (import.meta.main) serve(handleRequest);
