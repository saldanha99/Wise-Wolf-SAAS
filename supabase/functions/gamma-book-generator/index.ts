/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  authorizeRequest,
  type AuthProfile,
  hasTenantAccess,
  methodNotAllowed,
} from "../_shared/request-auth.ts";
import {
  buildSchoolBookInput,
  buildSchoolBookInstructions,
  parseSchoolBookSpec,
  schoolBookAudience,
  type SchoolBookSpec,
} from "./book-spec.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store, max-age=0",
  "Pragma": "no-cache",
  "Vary": "Authorization",
};

type JsonObject = Record<string, unknown>;
type AdminClient = ReturnType<typeof createClient<any>>;

const GAMMA_BASE_URL = "https://public-api.gamma.app/v1.0";
const MATERIALS_BUCKET = "materials";
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]{1,79}$/i;
const JOB_COLUMNS =
  "id,tenant_id,created_by,creator_role,status,title,level_tag,niche,audience,book_language,page_count,objective,topics,gamma_url,provider_warnings,provider_credits,collection_id,material_id,error_code,created_at,updated_at,completed_at";
const JOB_INTERNAL_COLUMNS =
  `${JOB_COLUMNS},gamma_generation_id,provider_request_id` as const;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const json = (status: number, payload: JsonObject) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const gammaUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !(parsed.hostname === "gamma.app" ||
        parsed.hostname.endsWith(".gamma.app"))
    ) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const gammaErrorCode = (status: number): string => {
  if (status === 401) return "GAMMA_API_KEY_INVALID";
  if (status === 402 || status === 403) return "GAMMA_CREDITS_OR_PLAN_REQUIRED";
  if (status === 429) return "GAMMA_RATE_LIMITED";
  if (status === 400 || status === 422) return "GAMMA_REQUEST_REJECTED";
  return "GAMMA_UNAVAILABLE";
};

const warningsFrom = (payload: JsonObject): string[] => {
  const warnings: string[] = [];
  if (typeof payload.warnings === "string" && payload.warnings.trim()) {
    warnings.push(payload.warnings.trim().slice(0, 2000));
  }
  if (Array.isArray(payload.pageWarnings)) {
    for (const warning of payload.pageWarnings) {
      if (typeof warning === "string" && warning.trim()) {
        warnings.push(warning.trim().slice(0, 2000));
      }
    }
  }
  return warnings.slice(0, 20);
};

const encodeStoragePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

const isStaffManager = (role: string) =>
  ["SCHOOL_ADMIN", "COORDINATOR", "MANAGER", "SUPER_ADMIN"].includes(role);

async function loadJob(admin: AdminClient, jobId: string) {
  const { data, error } = await admin
    .from("school_book_generations")
    .select(JOB_INTERNAL_COLUMNS)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error("BOOK_JOB_LOOKUP_FAILED");
  return data as (JsonObject & { gamma_generation_id?: string }) | null;
}

function canAccessJob(
  profile: AuthProfile,
  userId: string,
  job: JsonObject,
): boolean {
  if (profile.role === "SUPER_ADMIN") return true;
  if (profile.tenant_id !== job.tenant_id) return false;
  return job.created_by === userId || isStaffManager(profile.role);
}

async function startGeneration(
  req: Request,
  admin: AdminClient,
  userId: string,
  profile: AuthProfile,
  body: JsonObject,
) {
  const gammaApiKey = (Deno.env.get("GAMMA_API_KEY") ?? "").trim();
  if (!gammaApiKey) {
    return json(503, {
      error: "GAMMA_NOT_CONFIGURED",
      code: "GAMMA_NOT_CONFIGURED",
    });
  }

  const parsed = parseSchoolBookSpec(body);
  if (!parsed.ok) return json(400, { error: parsed.code, code: parsed.code });
  const spec = parsed.spec;
  const tenantId = typeof body.tenantId === "string"
    ? body.tenantId.trim()
    : profile.tenant_id ?? "";
  if (
    !TENANT_PATTERN.test(tenantId) || !hasTenantAccess({
      admin,
      isService: false,
      profile,
      user: null,
      userId,
    }, tenantId)
  ) {
    return json(403, {
      error: "TENANT_ACCESS_DENIED",
      code: "TENANT_ACCESS_DENIED",
    });
  }
  const requestKey = typeof body.requestKey === "string"
    ? body.requestKey.trim()
    : "";
  if (!UUID_PATTERN.test(requestKey)) {
    return json(400, {
      error: "INVALID_REQUEST_KEY",
      code: "INVALID_REQUEST_KEY",
    });
  }

  const { data: tenant, error: tenantError } = await admin.from("tenants")
    .select("id").eq("id", tenantId).maybeSingle();
  if (tenantError || !tenant) {
    return json(404, { error: "TENANT_NOT_FOUND", code: "TENANT_NOT_FOUND" });
  }

  const { data: existing, error: existingError } = await admin
    .from("school_book_generations")
    .select(JOB_COLUMNS)
    .eq("created_by", userId)
    .eq("request_key", requestKey)
    .maybeSingle();
  if (existingError) {
    return json(503, {
      error: "BOOK_JOB_UNAVAILABLE",
      code: "BOOK_JOB_UNAVAILABLE",
    });
  }
  if (existing) return json(200, { job: existing, idempotent: true });

  const { data: job, error: insertError } = await admin
    .from("school_book_generations")
    .insert({
      tenant_id: tenantId,
      created_by: userId,
      creator_role: profile.role,
      request_key: requestKey,
      status: "STARTING",
      title: spec.title,
      level_tag: spec.level,
      niche: spec.niche,
      audience: spec.audience,
      book_language: spec.language,
      page_count: spec.pageCount,
      objective: spec.objective,
      topics: spec.topics,
    })
    .select(JOB_COLUMNS)
    .single();
  if (insertError || !job) {
    const { data: replay } = await admin.from("school_book_generations")
      .select(JOB_COLUMNS).eq("created_by", userId).eq(
        "request_key",
        requestKey,
      )
      .maybeSingle();
    if (replay) return json(200, { job: replay, idempotent: true });
    return json(503, {
      error: "BOOK_JOB_UNAVAILABLE",
      code: "BOOK_JOB_UNAVAILABLE",
    });
  }

  const payload: JsonObject = {
    title: spec.title,
    inputText: buildSchoolBookInput(spec),
    additionalInstructions: buildSchoolBookInstructions(spec),
    textMode: "generate",
    format: "document",
    cardSplit: "inputTextBreaks",
    exportAs: "pdf",
    textOptions: {
      amount: "detailed",
      language: spec.language === "bilingual" ? "pt-br" : "en",
      tone: "clear, warm, rigorous, practical, motivating",
      audience: schoolBookAudience(spec),
    },
    imageOptions: {
      source: "webFreeToUseCommercially",
    },
    cardOptions: {
      dimensions: "a4",
      headerFooter: {
        topLeft: { type: "text", value: spec.title },
        bottomRight: { type: "cardNumber" },
        hideFromFirstCard: true,
      },
    },
    sharingOptions: {
      workspaceAccess: "noAccess",
      externalAccess: "noAccess",
    },
  };
  const themeId = (Deno.env.get("GAMMA_THEME_ID") ?? "").trim();
  const folderId = (Deno.env.get("GAMMA_FOLDER_ID") ?? "").trim();
  if (themeId) payload.themeId = themeId;
  if (folderId) payload.folderIds = [folderId];

  try {
    const response = await fetchWithTimeout(
      `${GAMMA_BASE_URL}/generations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": gammaApiKey,
        },
        body: JSON.stringify(payload),
      },
      25_000,
    );
    const responsePayload: unknown = await response.json().catch(() => ({}));
    const providerRequestId =
      response.headers.get("x-request-id")?.slice(0, 200) || null;
    if (
      !response.ok || !isRecord(responsePayload) ||
      typeof responsePayload.generationId !== "string"
    ) {
      const code = gammaErrorCode(response.status);
      await admin.from("school_book_generations").update({
        status: "FAILED",
        error_code: code,
        provider_request_id: providerRequestId,
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      return json(response.status >= 500 ? 503 : 422, { error: code, code });
    }
    const generationId = responsePayload.generationId.trim();
    if (!generationId || generationId.length > 300) {
      throw new Error("GAMMA_INVALID_RESPONSE");
    }
    const { data: started, error: updateError } = await admin
      .from("school_book_generations")
      .update({
        status: "GENERATING",
        gamma_generation_id: generationId,
        provider_request_id: providerRequestId,
        provider_warnings: warningsFrom(responsePayload),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .select(JOB_COLUMNS)
      .single();
    if (updateError || !started) throw new Error("BOOK_JOB_UPDATE_FAILED");
    return json(202, { job: started, idempotent: false });
  } catch (error) {
    const code = error instanceof Error && error.name === "AbortError"
      ? "GAMMA_TIMEOUT"
      : "GAMMA_UNAVAILABLE";
    console.error("Gamma book start failed", {
      code,
      type: error instanceof Error ? error.name : "UnknownError",
    });
    await admin.from("school_book_generations").update({
      status: "FAILED",
      error_code: code,
      updated_at: new Date().toISOString(),
    }).eq("id", job.id);
    return json(503, { error: code, code });
  }
}

async function finalizeBook(
  req: Request,
  admin: AdminClient,
  job: JsonObject,
  spec: SchoolBookSpec,
  provider: JsonObject,
) {
  const exportUrl = gammaUrl(provider.exportUrl);
  const publicGammaUrl = gammaUrl(provider.gammaUrl);
  if (!exportUrl) throw new Error("GAMMA_EXPORT_UNAVAILABLE");

  const download = await fetchWithTimeout(exportUrl, { method: "GET" }, 45_000);
  if (!download.ok) throw new Error("GAMMA_EXPORT_DOWNLOAD_FAILED");
  const declaredLength = Number(download.headers.get("content-length") || 0);
  if (declaredLength > MAX_PDF_BYTES) throw new Error("GAMMA_EXPORT_TOO_LARGE");
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.byteLength < 5 || bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error("GAMMA_EXPORT_INVALID_SIZE");
  }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("GAMMA_EXPORT_NOT_PDF");
  }

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  const anonKey = (Deno.env.get("SUPABASE_ANON_KEY") ?? "").trim();
  const authorization = req.headers.get("authorization")?.trim() ?? "";
  if (!supabaseUrl || !anonKey || !authorization) {
    throw new Error("STORAGE_AUTH_UNAVAILABLE");
  }
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const objectPath =
    `${job.tenant_id}/${job.created_by}/${crypto.randomUUID()}.pdf`;
  const { error: uploadError } = await userClient.storage.from(MATERIALS_BUCKET)
    .upload(objectPath, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadError) throw new Error("BOOK_STORAGE_UPLOAD_FAILED");

  let collectionId: string | null = null;
  let materialId: string | null = null;
  try {
    const { data: collection, error: collectionError } = await admin
      .from("pedagogical_collections")
      .insert({
        tenant_id: job.tenant_id,
        title: spec.title,
        niche: spec.niche,
        level_tag: spec.level,
        created_by: job.created_by,
      })
      .select("id")
      .single();
    if (collectionError || !collection) {
      throw new Error("BOOK_COLLECTION_SAVE_FAILED");
    }
    collectionId = collection.id;

    const teacherCreated = job.creator_role === "TEACHER";
    const fileUrl =
      `${supabaseUrl}/storage/v1/object/authenticated/${MATERIALS_BUCKET}/${
        encodeStoragePath(objectPath)
      }`;
    const { data: material, error: materialError } = await admin
      .from("pedagogical_materials")
      .insert({
        tenant_id: job.tenant_id,
        title: spec.title,
        file_url: fileUrl,
        type: "PDF",
        level_tag: spec.level,
        category: "Livro gerado por IA",
        uploaded_by: job.created_by,
        scope: teacherCreated ? "PRIVATE" : "TENANT",
        approval_status: teacherCreated ? "PENDING" : "APPROVED",
        niche: spec.niche,
        collection_id: collectionId,
        part_number: 1,
        storage_object_path: objectPath,
        hub_catalog_opt_in: false,
        hub_commercial_approved: false,
      })
      .select("id")
      .single();
    if (materialError || !material) throw new Error("BOOK_LIBRARY_SAVE_FAILED");
    materialId = material.id;

    const { data: completed, error: completeError } = await admin
      .from("school_book_generations")
      .update({
        status: "COMPLETED",
        gamma_url: publicGammaUrl,
        provider_request_id: typeof provider.requestId === "string"
          ? provider.requestId.slice(0, 200)
          : job.provider_request_id,
        provider_credits: isRecord(provider.credits) ? provider.credits : {},
        collection_id: collectionId,
        material_id: materialId,
        error_code: null,
        updated_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .select(JOB_COLUMNS)
      .single();
    if (completeError || !completed) {
      throw new Error("BOOK_JOB_COMPLETE_FAILED");
    }
    return completed;
  } catch (error) {
    if (materialId) {
      await admin.from("pedagogical_materials").delete().eq("id", materialId);
    }
    if (collectionId) {
      await admin.from("pedagogical_collections").delete().eq(
        "id",
        collectionId,
      );
    }
    await userClient.storage.from(MATERIALS_BUCKET).remove([objectPath]);
    throw error;
  }
}

async function refreshGeneration(
  req: Request,
  admin: AdminClient,
  userId: string,
  profile: AuthProfile,
  body: JsonObject,
) {
  const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
  if (!UUID_PATTERN.test(jobId)) {
    return json(400, { error: "INVALID_JOB_ID", code: "INVALID_JOB_ID" });
  }
  let job = await loadJob(admin, jobId);
  if (!job) {
    return json(404, {
      error: "BOOK_JOB_NOT_FOUND",
      code: "BOOK_JOB_NOT_FOUND",
    });
  }
  if (!canAccessJob(profile, userId, job)) {
    return json(403, {
      error: "BOOK_JOB_ACCESS_DENIED",
      code: "BOOK_JOB_ACCESS_DENIED",
    });
  }
  if (
    ["COMPLETED", "FAILED", "FINALIZING", "STARTING"].includes(
      String(job.status),
    )
  ) {
    return json(200, { job });
  }

  const gammaApiKey = (Deno.env.get("GAMMA_API_KEY") ?? "").trim();
  if (!gammaApiKey) {
    return json(503, {
      error: "GAMMA_NOT_CONFIGURED",
      code: "GAMMA_NOT_CONFIGURED",
    });
  }
  const generationId = typeof job.gamma_generation_id === "string"
    ? job.gamma_generation_id
    : "";
  if (!generationId) {
    return json(503, { error: "GAMMA_JOB_INVALID", code: "GAMMA_JOB_INVALID" });
  }

  try {
    const response = await fetchWithTimeout(
      `${GAMMA_BASE_URL}/generations/${encodeURIComponent(generationId)}`,
      { headers: { "X-API-KEY": gammaApiKey, "Accept": "application/json" } },
      15_000,
    );
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok || !isRecord(payload)) {
      const code = gammaErrorCode(response.status);
      return json(response.status >= 500 ? 503 : 422, { error: code, code });
    }
    payload.requestId = response.headers.get("x-request-id") || undefined;
    const providerStatus = typeof payload.status === "string"
      ? payload.status.toLowerCase()
      : "pending";
    if (providerStatus === "failed") {
      const code = "GAMMA_GENERATION_FAILED";
      const { data: failed } = await admin.from("school_book_generations")
        .update({
          status: "FAILED",
          error_code: code,
          provider_request_id: payload.requestId,
          provider_credits: isRecord(payload.credits) ? payload.credits : {},
          updated_at: new Date().toISOString(),
        }).eq("id", jobId).select(JOB_COLUMNS).single();
      return json(200, { job: failed || job });
    }
    if (providerStatus !== "completed") {
      await admin.from("school_book_generations").update({
        provider_request_id: payload.requestId,
        updated_at: new Date().toISOString(),
      }).eq("id", jobId);
      job = await loadJob(admin, jobId);
      return json(200, { job });
    }

    const { data: claimed, error: claimError } = await admin
      .from("school_book_generations")
      .update({ status: "FINALIZING", updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("status", "GENERATING")
      .select(JOB_INTERNAL_COLUMNS)
      .maybeSingle();
    if (claimError) throw new Error("BOOK_FINALIZE_CLAIM_FAILED");
    if (!claimed) {
      job = await loadJob(admin, jobId);
      return json(200, { job });
    }
    job = claimed;
    const parsed = parseSchoolBookSpec({
      title: job.title,
      level: job.level_tag,
      niche: job.niche,
      audience: job.audience,
      language: job.book_language,
      pageCount: job.page_count,
      objective: job.objective,
      topics: job.topics,
    });
    if (!parsed.ok) throw new Error("BOOK_JOB_SPEC_INVALID");
    const completed = await finalizeBook(req, admin, job, parsed.spec, payload);
    return json(200, { job: completed });
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith("GAMMA_")
      ? error.message
      : error instanceof Error && error.message.startsWith("BOOK_")
      ? error.message
      : "BOOK_FINALIZATION_FAILED";
    console.error("Gamma book refresh failed", {
      code,
      type: error instanceof Error ? error.name : "UnknownError",
    });
    const { data: failed } = await admin.from("school_book_generations")
      .update({
        status: "FAILED",
        error_code: code,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .select(JOB_COLUMNS)
      .maybeSingle();
    return json(503, { error: code, code, job: failed || job });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["TEACHER", "SCHOOL_ADMIN", "SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;
  if (!auth.context.userId || !auth.context.profile) {
    return json(403, {
      error: "AUTHORIZATION_REQUIRED",
      code: "AUTHORIZATION_REQUIRED",
    });
  }

  let body: JsonObject;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 12_000) {
      return json(413, {
        error: "REQUEST_TOO_LARGE",
        code: "REQUEST_TOO_LARGE",
      });
    }
    const parsed = JSON.parse(raw || "{}");
    if (!isRecord(parsed)) throw new Error("INVALID_JSON");
    body = parsed;
  } catch {
    return json(400, { error: "INVALID_JSON", code: "INVALID_JSON" });
  }

  const action = typeof body.action === "string" ? body.action : "create";
  if (action === "create") {
    return await startGeneration(
      req,
      auth.context.admin,
      auth.context.userId,
      auth.context.profile,
      body,
    );
  }
  if (action === "status") {
    return await refreshGeneration(
      req,
      auth.context.admin,
      auth.context.userId,
      auth.context.profile,
      body,
    );
  }
  return json(400, { error: "INVALID_ACTION", code: "INVALID_ACTION" });
});
