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
  parseBookBranding,
  parseSchoolBookSpec,
  schoolBookAudience,
  schoolBookBrandFromTenant,
  type SchoolBookSpec,
} from "./book-spec.ts";
import {
  type BookContentState,
  buildFinalInput,
  buildPreserveInstructions,
  initialContentState,
  parseSourceNotes,
} from "./book-content.ts";
import { advanceContent } from "./content-runner.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-content-bot-token",
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
  "id,tenant_id,created_by,creator_role,status,title,level_tag,niche,audience,book_language,page_count,objective,topics,brand,destination,footer_text,created_via,gamma_url,provider_warnings,provider_credits,collection_id,material_id,error_code,created_at,updated_at,completed_at";
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

const BOT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

const sha256Hex = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ).map((byte) => byte.toString(16).padStart(2, "0")).join("");

// Conta técnica do agente de conteúdo (OpenBot): token próprio, só para esta
// função. O banco guarda só o sha256; a conta é TEACHER sem alunos.
async function authorizeContentBot(token: string) {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim();
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")
    .trim();
  if (!supabaseUrl || !serviceRoleKey || !BOT_TOKEN_PATTERN.test(token)) {
    return null;
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.rpc("content_bot_authenticate", {
    p_token_sha256: await sha256Hex(token),
  });
  const row = Array.isArray(data) ? data[0] : null;
  if (error || !isRecord(row) || typeof row.user_id !== "string") return null;
  const profile: AuthProfile = {
    id: row.user_id,
    role: "TEACHER",
    tenant_id: typeof row.tenant_id === "string" ? row.tenant_id : null,
    lifecycle_status: "active",
  };
  return { admin, userId: row.user_id, profile };
}

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
  isBot: boolean,
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
  const sourceNotes = parseSourceNotes(body.sourceNotes);
  if (sourceNotes === false) {
    return json(400, {
      error: "INVALID_SOURCE_NOTES",
      code: "INVALID_SOURCE_NOTES",
    });
  }
  const brandingParsed = parseBookBranding(body);
  if (!brandingParsed.ok) {
    return json(400, { error: brandingParsed.code, code: brandingParsed.code });
  }
  const branding = brandingParsed.branding;
  let themeId = (Deno.env.get(
    branding.brand === "neutral" ? "GAMMA_THEME_ID_NEUTRAL" : "GAMMA_THEME_ID",
  ) ?? "").trim();
  // Livro neutro sem tema neutro cairia no tema padrão da conta (pode ter a
  // logo da escola): recusa em vez de arriscar a marca.
  if (branding.brand === "neutral" && !themeId) {
    return json(503, {
      error: "GAMMA_NEUTRAL_THEME_NOT_CONFIGURED",
      code: "GAMMA_NEUTRAL_THEME_NOT_CONFIGURED",
    });
  }
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
    .select("id, branding").eq("id", tenantId).maybeSingle();
  if (tenantError || !tenant) {
    return json(404, { error: "TENANT_NOT_FOUND", code: "TENANT_NOT_FOUND" });
  }
  // brand=school: tema, logo e cor de destaque da própria escola (branding).
  const schoolBrand = branding.brand === "school"
    ? schoolBookBrandFromTenant(tenant.branding)
    : { themeId: null, logoUrl: null, accentHex: null };
  if (schoolBrand.themeId) themeId = schoolBrand.themeId;

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
      brand: branding.brand,
      destination: branding.destination,
      footer_text: branding.footerText,
      created_via: isBot ? "CONTENT_BOT" : "APP",
      image_style: branding.imageStyle,
      // Conteúdo escrito e validado por nós antes do Gamma (que só diagrama).
      content: initialContentState(spec, branding.imageStyle, sourceNotes),
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

  // A escrita (blocos validados) avança a cada "status"; o Gamma entra no fim.
  return json(202, { job, idempotent: false });
}

/** Regras de marca para o Gamma (o resto das instruções é "diagramar sem reescrever"). */
function brandRules(brand: string, accentHex: string | null): string[] {
  if (brand === "neutral") {
    return [
      "This is an unbranded edition: never write any school, company or teacher name, logo, slogan or brand mark anywhere.",
    ];
  }
  return accentHex
    ? [
      `Use the school's brand accent color ${accentHex} for highlights, heading accents and callout borders. Never write a logo or brand mark as text; the logo is placed in the page header.`,
    ]
    : [];
}

/** Envia o texto pronto (conteúdo validado + gabarito montado por código) ao Gamma. */
async function launchGamma(
  admin: AdminClient,
  job: JsonObject,
  spec: SchoolBookSpec,
  state: BookContentState,
) {
  const gammaApiKey = (Deno.env.get("GAMMA_API_KEY") ?? "").trim();
  if (!gammaApiKey) return { ok: false as const, code: "GAMMA_NOT_CONFIGURED" };
  const branding = {
    brand: String(job.brand),
    footerText: typeof job.footer_text === "string" ? job.footer_text : null,
    imageStyle: state.imageStyle,
  };
  let themeId = (Deno.env.get(
    branding.brand === "neutral" ? "GAMMA_THEME_ID_NEUTRAL" : "GAMMA_THEME_ID",
  ) ?? "").trim();
  if (branding.brand === "neutral" && !themeId) {
    return { ok: false as const, code: "GAMMA_NEUTRAL_THEME_NOT_CONFIGURED" };
  }
  const { data: tenant } = await admin.from("tenants").select("id, branding")
    .eq("id", String(job.tenant_id)).maybeSingle();
  const schoolBrand = branding.brand === "school"
    ? schoolBookBrandFromTenant(tenant?.branding)
    : { themeId: null, logoUrl: null, accentHex: null };
  if (schoolBrand.themeId) themeId = schoolBrand.themeId;
  const inputText = buildFinalInput(spec, state);

  const payload: JsonObject = {
    title: spec.title,
    inputText,
    additionalInstructions: buildPreserveInstructions(
      brandRules(branding.brand, schoolBrand.accentHex),
      branding.imageStyle,
    ),
    // O texto já está pronto e validado: o Gamma só diagrama.
    textMode: "preserve",
    format: "document",
    cardSplit: "inputTextBreaks",
    exportAs: "pdf",
    textOptions: {
      language: spec.language === "bilingual" ? "pt-br" : "en",
      audience: schoolBookAudience(spec),
    },
    // Pexels: licença comercial sem marca d'água. A busca "webFreeToUse
    // Commercially" trouxe prévia de banco de imagem com marca d'água (teste de
    // 22/11). Imagem gerada por IA fica fora (regra: imagem gerada só pelo Codex).
    imageOptions: {
      source: "pexels",
    },
    cardOptions: {
      dimensions: "a4",
      headerFooter: {
        topLeft: { type: "text", value: spec.title },
        ...(schoolBrand.logoUrl
          ? {
            topRight: {
              type: "image",
              source: "custom",
              src: schoolBrand.logoUrl,
              size: "md",
            },
          }
          : {}),
        bottomRight: { type: "cardNumber" },
        ...(branding.footerText
          ? { bottomLeft: { type: "text", value: branding.footerText } }
          : {}),
        // Com logo da escola, o cabeçalho também vai na capa (o Gamma reserva o
        // espaço; carimbar o PDF cobria o título).
        hideFromFirstCard: !schoolBrand.logoUrl,
      },
    },
    sharingOptions: {
      workspaceAccess: "noAccess",
      externalAccess: "noAccess",
    },
  };
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
      return { ok: false as const, code };
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
    return { ok: true as const, job: started };
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
    return { ok: false as const, code };
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
  const botCreated = job.created_via === "CONTENT_BOT";
  const objectPath =
    `${job.tenant_id}/${job.created_by}/${crypto.randomUUID()}.pdf`;
  let userClient: AdminClient;
  if (botCreated) {
    // Sem sessão humana: envia como serviço e registra a conta técnica como
    // dona do objeto (procedência igual à de um upload de professor).
    if (!supabaseUrl) throw new Error("STORAGE_AUTH_UNAVAILABLE");
    userClient = admin;
  } else {
    const anonKey = (Deno.env.get("SUPABASE_ANON_KEY") ?? "").trim();
    const authorization = req.headers.get("authorization")?.trim() ?? "";
    if (!supabaseUrl || !anonKey || !authorization) {
      throw new Error("STORAGE_AUTH_UNAVAILABLE");
    }
    userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  const { error: uploadError } = await userClient.storage.from(MATERIALS_BUCKET)
    .upload(objectPath, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadError) throw new Error("BOOK_STORAGE_UPLOAD_FAILED");
  if (botCreated) {
    const { data: claimed, error: claimError } = await admin.rpc(
      "content_bot_claim_material_object",
      { p_user: job.created_by, p_object: objectPath },
    );
    if (claimError || claimed !== true) {
      await admin.storage.from(MATERIALS_BUCKET).remove([objectPath]);
      throw new Error("BOOK_STORAGE_OWNER_FAILED");
    }
  }

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

    // Nasce pendente e privado: professor, agente de conteúdo e todo livro
    // para o Hub. Só livro da escola criado por admin no app nasce aprovado.
    const mustReview = job.creator_role === "TEACHER" || botCreated ||
      job.destination === "HUB";
    const category = job.destination === "HUB"
      ? "Livro neutro para o Hub (IA)"
      : job.brand === "neutral"
      ? "Livro gerado por IA (sem marca)"
      : "Livro gerado por IA";
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
        category,
        uploaded_by: job.created_by,
        scope: mustReview ? "PRIVATE" : "TENANT",
        approval_status: mustReview ? "PENDING" : "APPROVED",
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

const WRITE_LEASE_SECONDS = 150;

function progressOf(state: BookContentState | null) {
  if (!state) return null;
  const done = state.chunks.filter((c) => c.state === "done").length;
  return { stage: "WRITING", done, total: state.chunks.length };
}

function specOfJob(job: JsonObject): SchoolBookSpec {
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
  return parsed.spec;
}

/**
 * Livro em STARTING com conteúdo estruturado: avança UM passo (escrever ou verificar um
 * bloco) sob uma trava curta, para duas chamadas de "status" não escreverem o mesmo bloco.
 * Quando todos os blocos passam, monta o texto final e chama o Gamma (status GENERATING).
 */
async function advanceWriting(admin: AdminClient, job: JsonObject) {
  const jobId = String(job.id);
  const now = new Date();
  const { data: claimed, error: claimError } = await admin
    .from("school_book_generations")
    .update({
      content_lease_until: new Date(now.getTime() + WRITE_LEASE_SECONDS * 1000)
        .toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "STARTING")
    .not("content", "is", null)
    .or(
      `content_lease_until.is.null,content_lease_until.lt."${now.toISOString()}"`,
    )
    .select(`${JOB_COLUMNS},content`)
    .maybeSingle();
  if (claimError) {
    return json(503, {
      error: "BOOK_JOB_UNAVAILABLE",
      code: "BOOK_JOB_UNAVAILABLE",
    });
  }
  if (!claimed) {
    // Livro antigo (sem conteúdo) ou outro "status" já está trabalhando: só devolve.
    const { data: current } = await admin.from("school_book_generations")
      .select(`${JOB_COLUMNS},content`).eq("id", jobId).maybeSingle();
    const { content, ...publicJob } = (current ?? job) as JsonObject;
    return json(200, {
      job: publicJob,
      progress: progressOf(content as BookContentState | null),
    });
  }
  const { content: rawState, ...publicJob } = claimed as JsonObject;
  let state = rawState as BookContentState;
  const release = (extra: JsonObject = {}) =>
    admin.from("school_book_generations").update({
      content: state,
      content_lease_until: null,
      updated_at: new Date().toISOString(),
      ...extra,
    }).eq("id", jobId).select(JOB_COLUMNS).maybeSingle();

  try {
    const spec = specOfJob(publicJob);
    const step = await advanceContent(spec, state, {
      db: admin,
      tenantId: String(publicJob.tenant_id),
      userId: String(publicJob.created_by),
    });
    state = step.state;
    if (step.outcome === "failed") {
      const { data } = await release({
        status: "FAILED",
        error_code: step.errorCode ?? "BOOK_CONTENT_INVALID",
      });
      return json(200, { job: data ?? publicJob, progress: progressOf(state) });
    }
    if (step.outcome !== "ready") {
      const { data } = await release();
      return json(200, { job: data ?? publicJob, progress: progressOf(state) });
    }
    await release({
      content_lease_until: new Date(Date.now() + WRITE_LEASE_SECONDS * 1000)
        .toISOString(),
    });
    const launched = await launchGamma(admin, publicJob, spec, state);
    if (!launched.ok) {
      const { data } = await release({
        status: "FAILED",
        error_code: launched.code,
      });
      return json(200, { job: data ?? publicJob, progress: progressOf(state) });
    }
    await admin.from("school_book_generations").update({
      content_lease_until: null,
    }).eq("id", jobId);
    return json(200, {
      job: launched.job,
      progress: {
        stage: "LAYOUT",
        done: state.chunks.length,
        total: state.chunks.length,
      },
    });
  } catch (error) {
    const code = error instanceof Error && /^(BOOK|GAMMA)_/.test(error.message)
      ? error.message
      : "BOOK_CONTENT_FAILED";
    console.error("Book content step failed", { code });
    const { data } = await release({ status: "FAILED", error_code: code });
    return json(200, { job: data ?? publicJob, progress: progressOf(state) });
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
  if (String(job.status) === "STARTING") {
    return await advanceWriting(admin, job);
  }
  if (["COMPLETED", "FAILED", "FINALIZING"].includes(String(job.status))) {
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

async function readCredits(profile: AuthProfile, isBot: boolean) {
  if (!isBot && !["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(profile.role)) {
    return json(403, {
      error: "CREDITS_ACCESS_DENIED",
      code: "CREDITS_ACCESS_DENIED",
    });
  }
  const gammaApiKey = (Deno.env.get("GAMMA_API_KEY") ?? "").trim();
  if (!gammaApiKey) {
    return json(503, {
      error: "GAMMA_NOT_CONFIGURED",
      code: "GAMMA_NOT_CONFIGURED",
    });
  }
  try {
    const response = await fetchWithTimeout(`${GAMMA_BASE_URL}/me`, {
      headers: { "X-API-KEY": gammaApiKey, "Accept": "application/json" },
    }, 10_000);
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok || !isRecord(payload)) {
      const code = gammaErrorCode(response.status);
      return json(response.status >= 500 ? 503 : 422, { error: code, code });
    }
    return json(200, {
      creditsRemaining: typeof payload.creditsRemaining === "number"
        ? payload.creditsRemaining
        : null,
      neutralThemeConfigured: Boolean(
        (Deno.env.get("GAMMA_THEME_ID_NEUTRAL") ?? "").trim(),
      ),
    });
  } catch {
    return json(503, { error: "GAMMA_UNAVAILABLE", code: "GAMMA_UNAVAILABLE" });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const botToken = req.headers.get("x-content-bot-token")?.trim() ?? "";
  let context: { admin: AdminClient; userId: string; profile: AuthProfile };
  let isBot = false;
  if (botToken) {
    const bot = await authorizeContentBot(botToken);
    if (!bot) {
      return json(401, {
        error: "CONTENT_BOT_DENIED",
        code: "CONTENT_BOT_DENIED",
      });
    }
    context = bot;
    isBot = true;
  } else {
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
    context = {
      admin: auth.context.admin,
      userId: auth.context.userId,
      profile: auth.context.profile,
    };
  }

  let body: JsonObject;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 32_000) {
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
      context.admin,
      context.userId,
      context.profile,
      body,
      isBot,
    );
  }
  if (action === "status") {
    return await refreshGeneration(
      req,
      context.admin,
      context.userId,
      context.profile,
      body,
    );
  }
  if (action === "credits") {
    return await readCredits(context.profile, isBot);
  }
  return json(400, { error: "INVALID_ACTION", code: "INVALID_ACTION" });
});
