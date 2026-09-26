/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeRequest, hasTenantAccess } from "../_shared/request-auth.ts";
import { parseAiUsage, recordAiUsage } from "../_shared/ai-usage.ts";
import {
  authorizationUrl,
  decryptSecret,
  encryptSecret,
  googleEmail,
  grantedRequiredScopes,
  isRecord,
  nativeNotesDraft,
  normalizeSummary,
  pkceChallenge,
  randomToken,
  runDocumentationTick,
  sha256,
  type SourceArtifact,
  SUMMARY_PROMPT_VERSION,
  summaryPrompt,
  text,
  uuid,
} from "./core.ts";
import {
  exchangeToken,
  geminiSummary,
  googleIdentity,
  GoogleMeetProvider,
  GoogleProviderError,
} from "./provider.ts";
import {
  looksLikeAttendanceReport,
  meetingCodeFromUri,
  namesOtherMeeting,
  parseAttendanceReport,
  pickAttendanceReport,
  summarizeAttendance,
} from "./attendance.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
type Config = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  key: string;
  enabled: boolean;
  attendanceEnabled: boolean;
  aiEnabled: boolean;
  aiKey: string;
  aiModel: string;
  retentionDays: number;
  missing: string[];
};
function config(): Config {
  const env = (key: string) => Deno.env.get(key)?.trim() || "";
  const names = [
    "GOOGLE_MEET_OAUTH_CLIENT_ID",
    "GOOGLE_MEET_OAUTH_CLIENT_SECRET",
    "GOOGLE_MEET_OAUTH_REDIRECT_URI",
    "GOOGLE_MEET_TOKEN_ENCRYPTION_KEY",
  ];
  const missing = names.filter((name) => !env(name));
  const redirectUri = env(names[2]);
  if (
    redirectUri &&
    !/^https:\/\/[^\s?#]+\/functions\/v1\/google-meet$/.test(redirectUri)
  ) missing.push("GOOGLE_MEET_OAUTH_REDIRECT_URI_INVALID");
  const key = env(names[3]);
  try {
    if (key && atob(key).length !== 32) {
      missing.push("GOOGLE_MEET_TOKEN_ENCRYPTION_KEY_INVALID");
    }
  } catch {
    missing.push("GOOGLE_MEET_TOKEN_ENCRYPTION_KEY_INVALID");
  }
  const aiKey = env("GEMINI_API_KEY"),
    aiModel = env("GOOGLE_MEET_SUMMARY_MODEL");
  return {
    clientId: env(names[0]),
    clientSecret: env(names[1]),
    redirectUri,
    key,
    enabled: env("GOOGLE_MEET_PEDAGOGY_ENABLED") === "true",
    // Relatório de presença nativo do Google (Business Plus). Sem a flag, a
    // sala nasce sem relatório e nada de presença é lido.
    attendanceEnabled: env("GOOGLE_MEET_ATTENDANCE_REPORT_ENABLED") === "true",
    aiEnabled: env("GOOGLE_MEET_SUMMARY_AI_ENABLED") === "true" && !!aiKey &&
      /^[a-zA-Z0-9._-]+$/.test(aiModel),
    aiKey,
    aiModel,
    retentionDays: Math.max(
      7,
      Math.min(365, Number(env("GOOGLE_MEET_RAW_RETENTION_DAYS")) || 90),
    ),
    missing,
  };
}
async function storage(
  db: SupabaseClient,
  action: string,
  tenantId: string | null,
  actorId: string | null,
  sessionId: string | null = null,
  payload: unknown = {},
): Promise<any> {
  const { data, error } = await db.rpc("google_meet_backend", {
    p_action: action,
    p_tenant_id: tenantId,
    p_actor_id: actorId,
    p_session_id: sessionId,
    p_payload: payload,
  });
  if (error) {
    const known = /^[a-z_]+$/.test(error.message || "")
      ? error.message
      : "google_meet_storage_unavailable";
    throw new Error(known);
  }
  return data;
}
async function summaryPricing(
  db: SupabaseClient,
  cfg: Config,
  artifacts: SourceArtifact[] = [],
) {
  if (!cfg.aiEnabled) return null;
  const { data, error } = await db.from("ai_model_pricing").select(
    "input_usd_per_1m,output_usd_per_1m,updated_at",
  ).eq("model", cfg.aiModel).maybeSingle();
  if (error || !data) return null;
  const input = Math.ceil(summaryPrompt(artifacts.slice(0, 6)).length / 3);
  return {
    ...data,
    estimated_input_tokens: input,
    max_output_tokens: 6000,
    estimated_usd: (input * Number(data.input_usd_per_1m) +
      6000 * Number(data.output_usd_per_1m)) / 1000000,
  };
}
async function tokenFor(
  db: SupabaseClient,
  cfg: Config,
  tenantId: string,
  actorId: string,
) {
  const connection = await storage(db, "connection_get", tenantId, actorId);
  if (
    !connection?.refresh_token_ciphertext || connection.status !== "CONNECTED"
  ) throw new Error("google_connection_required");
  const refreshToken = await decryptSecret(
    connection.refresh_token_ciphertext,
    cfg.key,
    `refresh:${tenantId}`,
  );
  try {
    const token = await exchangeToken({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return { token: text(token.access_token, 8000), connection };
  } catch (error) {
    if (
      error instanceof GoogleProviderError &&
      error.code === "google_reconnect_required"
    ) {
      await storage(db, "connection_error", tenantId, actorId, null, {
        error_code: error.code,
      });
    }
    throw error;
  }
}
async function callback(req: Request, cfg: Config): Promise<Response> {
  const url = new URL(req.url), state = url.searchParams.get("state") || "";
  const html = (ok: boolean, code: string) =>
    new Response(
      `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Conexão Google Meet</title><body><main><h1>${
        ok ? "Conta Google conectada" : "Conexão não concluída"
      }</h1><p>${
        ok
          ? "Volte à plataforma e atualize o status da integração."
          : "Volte à plataforma e tente conectar novamente. Código: " + code
      }</p></main></body></html>`,
      {
        status: ok ? 200 : 400,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; frame-ancestors 'none'",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  try {
    if (cfg.missing.length || !/^[a-zA-Z0-9_-]{43}$/.test(state)) {
      throw new Error("oauth_configuration_or_state_invalid");
    }
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const nonce = await storage(db, "nonce_consume", null, null, null, {
      state_hash: await sha256(state),
    });
    if (url.searchParams.has("error")) throw new Error("oauth_cancelled");
    const code = text(url.searchParams.get("code"), 6000);
    if (!code) throw new Error("oauth_code_missing");
    // Revalidate the originating administrator before exchanging a token.
    await storage(db, "status", nonce.tenant_id, nonce.actor_id);
    const verifier = await decryptSecret(
      nonce.verifier_ciphertext,
      cfg.key,
      `oauth:${nonce.tenant_id}:${nonce.actor_id}`,
    );
    const token = await exchangeToken({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    });
    if (!grantedRequiredScopes(token.scope)) {
      throw new Error("google_required_scopes_missing");
    }
    if (!text(token.refresh_token, 8000)) {
      throw new Error("google_offline_access_required");
    }
    const identity = await googleIdentity(text(token.access_token, 8000));
    await storage(
      db,
      "connection_save",
      nonce.tenant_id,
      nonce.actor_id,
      null,
      {
        organizer_sub: identity.sub,
        organizer_email: identity.email,
        refresh_token_ciphertext: await encryptSecret(
          text(token.refresh_token, 8000),
          cfg.key,
          `refresh:${nonce.tenant_id}`,
        ),
        granted_scopes: text(token.scope, 4000).split(/\s+/),
      },
    );
    return html(true, "connected");
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "oauth_failed";
    return html(false, code);
  }
}

async function syncSession(
  db: SupabaseClient,
  cfg: Config,
  tenantId: string,
  actorId: string,
  sessionId: string,
) {
  const detail = await storage(
    db,
    "session_detail",
    tenantId,
    actorId,
    sessionId,
  );
  if (!detail.session.documentation_consent) {
    throw new Error("documentation_consent_required");
  }
  if (!detail.room?.space_name || detail.room.state !== "READY") {
    throw new Error("google_room_not_ready");
  }
  const { token, connection } = await tokenFor(db, cfg, tenantId, actorId);
  if (connection.organizer_sub !== detail.room.organizer_sub) {
    throw new Error("google_organizer_changed");
  }
  const provider = new GoogleMeetProvider(token);
  let imported = 0, pending = 0;
  try {
    const metadata = await provider.artifactMetadata(detail.room.space_name, {
      start: detail.session.scheduled_start_at,
      end: detail.session.scheduled_end_at,
    });
    for (const item of metadata) {
      if (item.state !== "FILE_GENERATED") {
        pending++;
        continue;
      }
      if (!isRecord(item.docsDestination) || !item.docsDestination.document) {
        pending++;
        continue;
      }
      const sourceText = await provider.documentText(
        String(item.docsDestination.document),
      );
      const result = await storage(
        db,
        "artifact_save",
        tenantId,
        actorId,
        sessionId,
        {
          provider_name: item.name,
          kind: item.kind,
          document_id: item.docsDestination.document,
          source_text: sourceText,
          content_sha256: await sha256(sourceText),
          retention_days: cfg.retentionDays,
        },
      );
      if (result.inserted) imported++;
      if (
        item.kind === "SMART_NOTES" &&
        !detail.summaries.some((summary: any) =>
          summary.origin === "GOOGLE_SMART_NOTES" &&
          summary.source_artifact_ids.includes(result.id)
        )
      ) {
        const source = {
          id: result.id,
          kind: "SMART_NOTES",
          source_text: sourceText,
        };
        await storage(db, "summary_save", tenantId, actorId, sessionId, {
          status: "PROPOSED",
          origin: "GOOGLE_SMART_NOTES",
          content: nativeNotesDraft(source),
          source_artifact_ids: [source.id],
          prompt_version: "native-google-notes",
        });
      }
    }
    let attendance: unknown = null;
    if (cfg.attendanceEnabled) {
      try {
        attendance = await syncAttendance(
          db,
          provider,
          cfg,
          tenantId,
          sessionId,
          detail,
          connection,
        );
      } catch (error) {
        // Presença falhando não derruba a documentação pedagógica; fica no log.
        const code = error instanceof Error && /^[a-z_]+$/.test(error.message)
          ? error.message
          : "google_attendance_failed";
        console.error("[google-meet] relatório de presença", {
          sessionId,
          code,
        });
        attendance = { error: code };
      }
    }
    const state = metadata.length === 0
      ? "ARTIFACTS_NOT_AVAILABLE"
      : pending
      ? "ARTIFACTS_PENDING"
      : null;
    await storage(db, "sync_complete", tenantId, actorId, sessionId, {
      error_code: state,
    });
    return {
      ok: true,
      imported,
      pending,
      attendance,
      status: state || "SYNCED",
    };
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "google_sync_failed";
    await storage(db, "sync_complete", tenantId, actorId, sessionId, {
      error_code: code,
    });
    throw error;
  }
}

async function attendanceStorage(
  db: SupabaseClient,
  action: "attendance_save" | "attendance_evaluate",
  tenantId: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<any> {
  const { data, error } = await db.rpc("google_meet_attendance_backend", {
    p_action: action,
    p_tenant_id: tenantId,
    p_session_id: sessionId,
    p_payload: payload,
  });
  if (error) {
    throw new Error(
      /^[a-z_]+$/.test(error.message || "")
        ? error.message
        : "google_meet_storage_unavailable",
    );
  }
  return data;
}

// Presença pelo relatório nativo do Google: a planilha que o Meet cria no
// Drive da conta da escola depois da reunião. O banco compara com o lançamento
// e só abre caso na Central de Qualidade — pagamento não muda.
async function syncAttendance(
  db: SupabaseClient,
  provider: GoogleMeetProvider,
  cfg: Config,
  tenantId: string,
  sessionId: string,
  detail: any,
  connection: any,
) {
  const conferences = await provider.conferences(detail.room.space_name, {
    start: detail.session.scheduled_start_at,
    end: detail.session.scheduled_end_at,
  });
  let reportFound = false;
  // Conferência ainda aberta: o relatório dela não existe; o que estiver no Drive
  // é de outra aula. Espera o próximo ciclo (a avaliação só abre caso sem
  // conferência nenhuma, então "sem relatório ainda" não acusa ninguém).
  const stillOpen = conferences.some((c) => !c.endTime);
  if (conferences.length && !stillOpen) {
    const starts = conferences.map((c) => c.startTime).filter(Boolean).sort();
    const ends = conferences.map((c) => c.endTime || c.startTime).filter(
      Boolean,
    ).sort();
    const first = starts[0] || detail.session.scheduled_start_at;
    const last = ends[ends.length - 1] || detail.session.scheduled_end_at;
    // O Google gera a planilha depois que a reunião acaba (medido: 2 s depois):
    // janela do fim da última conferência desta sala até 3 h depois, com 2 min
    // de folga para relógio. Planilha criada antes disso é de outra aula.
    const candidates = await provider.attendanceReportCandidates(
      new Date(Date.parse(last) - 2 * 60000).toISOString(),
      new Date(Date.parse(last) + 3 * 3600000).toISOString(),
    );
    const code = meetingCodeFromUri(detail.room.meeting_uri);
    let picked = pickAttendanceReport(candidates, code, null) as
      | (typeof candidates[number] & { csv?: string })
      | null;
    if (picked) {
      picked = { ...picked, csv: await provider.spreadsheetCsv(picked.id) };
    } else if (candidates.length) {
      const withCsv = [];
      for (
        const candidate of candidates.filter((c) =>
          looksLikeAttendanceReport(c.name) && !namesOtherMeeting(c.name, code)
        ).slice(0, 10)
      ) {
        withCsv.push({
          ...candidate,
          csv: await provider.spreadsheetCsv(candidate.id),
        });
      }
      picked = pickAttendanceReport(withCsv, code, detail.room.cohost_email);
    }
    if (picked?.csv) {
      const { data: teacher } = await db.from("profiles").select("full_name")
        .eq("id", detail.session.teacher_id).eq("tenant_id", tenantId)
        .maybeSingle();
      const parsed = parseAttendanceReport(picked.csv, first);
      const summary = "error" in parsed ? null : summarizeAttendance(
        parsed.rows,
        {
          teacherEmail: detail.room.cohost_email || null,
          teacherName: teacher?.full_name || null,
          organizerEmail: connection.organizer_email || null,
        },
      );
      await attendanceStorage(db, "attendance_save", tenantId, sessionId, {
        conference_name: conferences[0].name,
        document_id: picked.id,
        document_name: picked.name,
        source_csv: picked.csv,
        content_sha256: await sha256(picked.csv),
        parse_error: "error" in parsed ? parsed.error : null,
        participants: summary?.participants || [],
        teacher_first_join_at: summary?.teacherFirstJoinAt || null,
        teacher_seconds: summary ? summary.teacherSeconds : null,
        student_first_join_at: summary?.studentFirstJoinAt || null,
        student_seconds: summary ? summary.studentSeconds : null,
        retention_days: cfg.retentionDays,
      });
      reportFound = true;
    }
  }
  return await attendanceStorage(
    db,
    "attendance_evaluate",
    tenantId,
    sessionId,
    { conference_count: conferences.length, report_found: reportFound },
  );
}

async function createSessionRoom(
  db: SupabaseClient,
  cfg: Config,
  tenantId: string,
  actorId: string,
  sessionId: string,
) {
  if (!cfg.enabled || cfg.missing.length) {
    throw new Error("google_pedagogy_disabled");
  }
  const detail = await storage(
    db,
    "session_detail",
    tenantId,
    actorId,
    sessionId,
  );
  if (!detail.session.documentation_consent) {
    throw new Error("documentation_consent_required");
  }
  if (detail.session.status === "SUPERSEDED") {
    throw new Error("lesson_session_superseded");
  }
  const { data: teacher, error } = await db.from("profiles").select("email")
    .eq("id", detail.session.teacher_id).eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !teacher) throw new Error("session_teacher_not_found");
  const cohostEmail = googleEmail(teacher.email);
  const { token, connection } = await tokenFor(db, cfg, tenantId, actorId);
  const claim = await storage(db, "room_claim", tenantId, actorId, sessionId, {
    organizer_sub: connection.organizer_sub,
    cohost_email: cohostEmail,
  });
  if (claim.room.organizer_sub !== connection.organizer_sub) {
    throw new Error("google_organizer_changed");
  }
  if (claim.room.state === "READY") return { ok: true, room: claim.room };
  if (!claim.claimed && !claim.room.space_name) {
    throw new Error("google_room_reconciliation_required");
  }
  const provider = new GoogleMeetProvider(token);
  let room = claim.room;
  if (claim.claimed) {
    try {
      const space = await provider.createSpace({
        attendanceReport: cfg.attendanceEnabled,
      });
      room = await storage(db, "room_save", tenantId, actorId, sessionId, {
        ...space,
        state: "COHOST_PENDING",
      });
    } catch (error) {
      await storage(db, "room_save", tenantId, actorId, sessionId, {
        state: "NEEDS_RECONCILIATION",
        error_code: "google_room_creation_uncertain",
      });
      throw error;
    }
  }
  try {
    await provider.ensureCohost(room.space_name, room.cohost_email);
    room = await storage(db, "room_save", tenantId, actorId, sessionId, {
      state: "READY",
    });
  } catch (error) {
    await storage(db, "room_save", tenantId, actorId, sessionId, {
      state: "COHOST_PENDING",
      error_code: "google_cohost_setup_failed",
    });
    throw error;
  }
  return { ok: true, room };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const cfg = config();
  if (req.method === "GET") return callback(req, cfg);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const authorization = await authorizeRequest(req, {
    allowedRoles: ["SCHOOL_ADMIN", "SUPER_ADMIN", "COORDINATOR", "TEACHER"],
    allowService: true,
    corsHeaders: cors,
  });
  if (authorization.ok === false) return authorization.response;
  const auth = authorization.context, db = auth.admin;
  try {
    const bodyText = await req.text();
    if (bodyText.length > 160000) {
      return json({ error: "request_too_large" }, 413);
    }
    const body: unknown = JSON.parse(bodyText);
    if (!isRecord(body)) throw new Error("invalid_request");
    const action = text(body.action, 40),
      tenantId = text(body.tenantId, 100) || auth.profile?.tenant_id || "";
    if (auth.isService && action === "sync_due" && !tenantId) {
      const result = await runDocumentationTick<any>(
        cfg.enabled,
        cfg.missing.length === 0,
        async () => {
          const { data: jobs, error } = await db.rpc(
            "get_pending_google_meet_sync_sessions",
          );
          if (error) throw new Error("google_meet_storage_unavailable");
          return jobs || [];
        },
        async (job) => {
          try {
            return {
              session_id: job.lesson_session_id,
              ...(job.operation === "PREPARE_ROOM"
                ? await createSessionRoom(
                  db,
                  cfg,
                  job.tenant_id,
                  job.actor_id,
                  job.lesson_session_id,
                )
                : await syncSession(
                  db,
                  cfg,
                  job.tenant_id,
                  job.actor_id,
                  job.lesson_session_id,
                )),
            };
          } catch (error) {
            return {
              session_id: job.lesson_session_id,
              ok: false,
              error: error instanceof Error && /^[a-z_]+$/.test(error.message)
                ? error.message
                : "google_sync_failed",
            };
          }
        },
      );
      return json(result);
    }
    if (!tenantId || !hasTenantAccess(auth, tenantId)) {
      return json({ error: "tenant_scope_required" }, 403);
    }
    if (auth.isService && action !== "sync_due") {
      return json({ error: "service_action_forbidden" }, 403);
    }
    const actorId = auth.isService ? uuid(body.actorId) : auth.userId!;
    const isAdmin = auth.isService ||
      ["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(auth.profile?.role || "");
    if (["connect", "disconnect"].includes(action) && !isAdmin) {
      return json({ error: "google_meet_admin_required" }, 403);
    }

    if (action === "status") {
      const status = await storage(db, "status", tenantId, actorId);
      // Conexão feita antes da troca de escopo: salas funcionam, mas transcrição,
      // anotações e presença não são lidas até reconectar.
      const connection = status.connection
        ? await storage(db, "connection_get", tenantId, actorId)
        : null;
      return json({
        ...status,
        scopes_outdated: !!connection?.tenant_id &&
          !grantedRequiredScopes(
            (Array.isArray(connection.granted_scopes)
              ? connection.granted_scopes
              : []).join(" "),
          ),
        configured: cfg.missing.length === 0,
        missing_configuration: cfg.missing,
        enabled: cfg.enabled,
        summary_ai_enabled: cfg.aiEnabled,
        summary_ai_model: cfg.aiEnabled ? cfg.aiModel : null,
        summary_ai_separate_billing: true,
        summary_ai_pricing: await summaryPricing(db, cfg),
        can_manage: isAdmin,
        performance_collection_enabled: false,
        raw_retention_days: cfg.retentionDays,
      });
    }
    if (action === "session_detail") {
      const detail = await storage(
        db,
        "session_detail",
        tenantId,
        actorId,
        uuid(body.sessionId),
      );
      return json({
        ...detail,
        enabled: cfg.enabled && cfg.missing.length === 0,
        summary_ai_enabled: cfg.aiEnabled,
        summary_ai_model: cfg.aiModel,
        summary_ai_pricing: await summaryPricing(db, cfg, detail.artifacts),
      });
    }
    if (action === "review_summary") {
      const sessionId = uuid(body.sessionId),
        detail = await storage(
          db,
          "session_detail",
          tenantId,
          actorId,
          sessionId,
        );
      const parentId = uuid(body.parentVersionId),
        parent = detail.summaries.find((row: any) => row.id === parentId);
      if (!parent) throw new Error("summary_not_found");
      if (!["VERIFIED", "REJECTED"].includes(String(body.status))) {
        throw new Error("invalid_review_status");
      }
      const summary = normalizeSummary(
        body.content,
        detail.artifacts,
        body.status === "VERIFIED",
      );
      return json(
        await storage(db, "summary_save", tenantId, actorId, sessionId, {
          status: body.status,
          origin: "HUMAN_REVIEW",
          parent_version_id: parent.id,
          content: summary,
          source_artifact_ids: parent.source_artifact_ids,
          review_reason: text(body.reason, 2000),
        }),
      );
    }
    if (cfg.missing.length) {
      return json({
        error: "google_integration_not_configured",
        missing_configuration: cfg.missing,
      }, 503);
    }
    if (action === "connect") {
      const state = randomToken(), verifier = randomToken();
      await storage(db, "nonce_create", tenantId, actorId, null, {
        state_hash: await sha256(state),
        verifier_ciphertext: await encryptSecret(
          verifier,
          cfg.key,
          `oauth:${tenantId}:${actorId}`,
        ),
      });
      return json({
        authorization_url: authorizationUrl(
          cfg,
          state,
          await pkceChallenge(verifier),
        ),
      });
    }
    if (action === "disconnect") {
      const connection = await storage(db, "connection_get", tenantId, actorId);
      let revoked = false;
      if (connection?.refresh_token_ciphertext) {
        try {
          const token = await decryptSecret(
            connection.refresh_token_ciphertext,
            cfg.key,
            `refresh:${tenantId}`,
          );
          const result = await fetch("https://oauth2.googleapis.com/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token }),
            signal: AbortSignal.timeout(20000),
          });
          revoked = result.ok || result.status === 400;
        } catch { /* Local disconnect must still disable future access. */ }
      }
      await storage(db, "disconnect", tenantId, actorId);
      return json({
        ok: true,
        provider_revoked: revoked,
        message: revoked
          ? "Conta desconectada."
          : "Acesso local removido. Confira também as conexões de terceiros na conta Google.",
      });
    }
    if (!cfg.enabled) return json({ error: "google_pedagogy_disabled" }, 409);
    if (action === "create_session_room") {
      return json(
        await createSessionRoom(
          db,
          cfg,
          tenantId,
          actorId,
          uuid(body.sessionId),
        ),
      );
    }
    if (action === "sync_artifacts") {
      return json(
        await syncSession(db, cfg, tenantId, actorId, uuid(body.sessionId)),
      );
    }
    if (action === "sync_due") {
      if (!isAdmin) return json({ error: "google_meet_admin_required" }, 403);
      const due = await storage(db, "sync_due", tenantId, actorId),
        results = [];
      for (const item of due) {
        try {
          results.push({
            session_id: item.lesson_session_id,
            ...await syncSession(
              db,
              cfg,
              tenantId,
              actorId,
              item.lesson_session_id,
            ),
          });
        } catch (error) {
          results.push({
            session_id: item.lesson_session_id,
            ok: false,
            error: error instanceof Error && /^[a-z_]+$/.test(error.message)
              ? error.message
              : "google_sync_failed",
          });
        }
      }
      return json({ ok: results.every((row) => row.ok), results });
    }
    if (action === "generate_summary") {
      if (!cfg.aiEnabled) {
        return json({ error: "google_summary_ai_not_configured" }, 409);
      }
      if (body.acceptApiUsage !== true) {
        return json({ error: "google_summary_api_usage_ack_required" }, 409);
      }
      const sessionId = uuid(body.sessionId),
        detail = await storage(
          db,
          "session_detail",
          tenantId,
          actorId,
          sessionId,
        );
      if (!detail.session.documentation_consent) {
        throw new Error("documentation_consent_required");
      }
      const artifacts: SourceArtifact[] = detail.artifacts.slice(0, 6);
      if (!artifacts.length) throw new Error("google_artifacts_required");
      if (!await summaryPricing(db, cfg, artifacts)) {
        throw new Error("google_summary_pricing_required");
      }
      const recentAi = detail.summaries.find((row: any) =>
        row.origin === "GEMINI_API" &&
        Date.parse(row.created_at) > Date.now() - 60000
      );
      if (recentAi) {
        return json({ error: "google_summary_generation_rate_limited" }, 429);
      }
      await storage(db, "summary_claim", tenantId, actorId, sessionId);
      const result = await geminiSummary(
        summaryPrompt(artifacts),
        cfg.aiKey,
        cfg.aiModel,
      );
      await recordAiUsage(db, {
        tenantId,
        userId: actorId,
        feature: "meet_pedagogical_summary",
        provider: "google",
        model: cfg.aiModel,
        usage: parseAiUsage(result),
      });
      const candidates = Array.isArray(result.candidates)
        ? result.candidates
        : [];
      const candidate = candidates[0];
      if (
        !isRecord(candidate) || !isRecord(candidate.content) ||
        !Array.isArray(candidate.content.parts)
      ) throw new Error("google_summary_response_invalid");
      const generated = candidate.content.parts.filter(isRecord).map((part) =>
        text(part.text, 80000)
      ).join("");
      const summary = normalizeSummary(JSON.parse(generated), artifacts);
      if (!summary.evidence.length) {
        throw new Error("google_summary_evidence_required");
      }
      return json(
        await storage(db, "summary_save", tenantId, actorId, sessionId, {
          status: "PROPOSED",
          origin: "GEMINI_API",
          content: summary,
          source_artifact_ids: artifacts.map((artifact) => artifact.id),
          model_id: cfg.aiModel,
          prompt_version: SUMMARY_PROMPT_VERSION,
        }),
      );
    }
    return json({ error: "unknown_action" }, 400);
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "google_meet_request_failed";
    const forbidden = /forbidden|required|scope/.test(code);
    return json(
      { error: code },
      error instanceof GoogleProviderError
        ? (error.status >= 500 ? 503 : 422)
        : forbidden
        ? 403
        : 422,
    );
  }
});
