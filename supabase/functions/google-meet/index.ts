/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeRequest, hasTenantAccess } from "../_shared/request-auth.ts";
import { parseAiUsage, recordAiUsage } from "../_shared/ai-usage.ts";
import {
  type ArtifactImportStatus,
  type ArtifactToggle,
  artifactToggleAction,
  authorizationUrl,
  decryptSecret,
  documentationSyncOutcome,
  encryptSecret,
  grantedRequiredScopes,
  identityAuthorizationUrl,
  isRecord,
  JOB_DEADLINE_MS,
  nativeNotesDraft,
  normalizeSummary,
  type OAuthFlow,
  oauthResultPage,
  pkceChallenge,
  randomToken,
  runDocumentationTick,
  saoPauloDayWindow,
  sha256,
  type SourceArtifact,
  SUMMARY_PROMPT_VERSION,
  summaryPrompt,
  text,
  uuid,
} from "./core.ts";
import {
  applyRoomArtifacts,
  exchangeToken,
  geminiSummary,
  googleIdentity,
  GoogleMeetProvider,
  GoogleProviderError,
  importArtifacts,
  type MeetArtifact,
  type MeetArtifactKind,
  type MeetConference,
  providerErrorCode,
  roomCreationErrorCode,
} from "./provider.ts";
import {
  type AttendanceSource,
  combineAttendanceReports,
  looksLikeAttendanceReport,
  meetingCodeFromUri,
  namesOtherMeeting,
  pickAttendanceReports,
  summarizeAttendance,
} from "./attendance.ts";

type ConnectionRow = {
  tenant_id?: string;
  organizer_sub: string;
  organizer_email: string | null;
  refresh_token_ciphertext: string | null;
  status: string;
};
type TokenGrant = { token: string; connection: ConnectionRow };
// Um token de acesso por escola e por rodada: o lote processa vários trabalhos
// e não precisa trocar o refresh token a cada sala.
type TokenCache = Map<string, Promise<TokenGrant>>;
type RoomRow = {
  lesson_session_id: string;
  space_name: string | null;
  meeting_uri: string | null;
  state: string;
  organizer_sub: string;
  cohost_email: string;
  claim_id?: string | null;
  // Transcrição e anotações ligadas no Google (a revogação desliga).
  artifacts_state?: "ENABLED" | "DISABLED";
};
type ImportRow = {
  provider_name: string;
  status: ArtifactImportStatus;
};
// session_state: o que a edge precisa para a fila, sem texto bruto. A tela usa
// session_detail, que aplica quem pode ver a transcrição.
type SessionDetailData = {
  session: {
    teacher_id: string;
    class_date: string;
    scheduled_start_at: string;
    scheduled_end_at: string;
    documentation_consent: boolean;
    status: string;
  };
  room: RoomRow | null;
  summaries: { origin: string; source_artifact_ids: string[] }[];
  imports?: ImportRow[];
  attendance_saved_reports?: number;
  // Conta Google confirmada pelo professor da aula (login Google).
  teacher_google_email?: string | null;
};
type PendingJob = {
  tenant_id: string;
  actor_id: string;
  lesson_session_id: string;
  operation:
    | "PREPARE_ROOM"
    | "SYNC_ARTIFACTS"
    | "DISABLE_ARTIFACTS"
    | "ENABLE_ARTIFACTS";
};
// claim_id é a reserva interna da criação; não vai para o navegador.
const publicRoom = (room: RoomRow | null) => {
  if (!room) return room;
  const { claim_id: _claim, ...rest } = room;
  return rest;
};
const ARTIFACT_KINDS: MeetArtifactKind[] = ["TRANSCRIPT", "SMART_NOTES"];

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
function tokenFor(
  db: SupabaseClient,
  cfg: Config,
  tenantId: string,
  actorId: string,
  cache?: TokenCache,
): Promise<TokenGrant> {
  const key = `${tenantId}:${actorId}`;
  const cached = cache?.get(key);
  if (cached) return cached;
  const pending = issueToken(db, cfg, tenantId, actorId);
  // Falha também fica no cache da rodada: com o Google fora, os outros
  // trabalhos da mesma escola falham na hora em vez de esperar 20 s cada.
  pending.catch(() => {});
  cache?.set(key, pending);
  return pending;
}
async function issueToken(
  db: SupabaseClient,
  cfg: Config,
  tenantId: string,
  actorId: string,
): Promise<TokenGrant> {
  const connection: ConnectionRow | null = await storage(
    db,
    "connection_get",
    tenantId,
    actorId,
  );
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
  // O fluxo (conta central ou conta do professor) vem do nonce gravado no banco,
  // nunca da URL de retorno — é o mesmo endereço para os dois.
  let flow: OAuthFlow | null = null;
  const page = (ok: boolean, code: string, email: string | null = null) => {
    const result = oauthResultPage({ flow, ok, code, email });
    return new Response(result.html, {
      status: result.status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
      },
    });
  };
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
    flow = nonce.flow === "teacher_identity" ? "teacher_identity" : "organizer";
    if (url.searchParams.has("error")) throw new Error("oauth_cancelled");
    const code = text(url.searchParams.get("code"), 6000);
    if (!code) throw new Error("oauth_code_missing");

    if (flow === "teacher_identity") {
      // Professor confirmando a própria conta Google: só o e-mail verificado
      // importa. O token (openid + email) não é guardado.
      const verifier = await decryptSecret(
        nonce.verifier_ciphertext,
        cfg.key,
        `identity:${nonce.tenant_id}:${nonce.actor_id}`,
      );
      const token = await exchangeToken({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.redirectUri,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
      });
      const identity = await googleIdentity(text(token.access_token, 8000));
      // O banco confere de novo que o dono do nonce é professor ativo da escola.
      const saved = await storage(
        db,
        "identity_save",
        nonce.tenant_id,
        nonce.actor_id,
        null,
        {
          google_sub: identity.sub,
          google_email: identity.email,
          email_verified: true,
        },
      );
      return page(
        true,
        "teacher_identity_verified",
        text(saved?.email, 254) || identity.email,
      );
    }

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
    // Outra conta Google com salas criadas pela atual: o banco recusa
    // (google_organizer_change_requires_confirmation), a menos que a direção
    // tenha pedido a troca ao gerar o link (allow_replace no nonce).
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
        allow_replace: nonce.allow_replace === true,
      },
    );
    return page(true, "connected");
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "oauth_failed";
    return page(false, code);
  }
}

type SyncOptions = {
  // Releitura manual ("Importar transcrição e notas"): relê o que já foi
  // importado para pegar edição do documento. Vazio continua final.
  force?: boolean;
  // Prazo absoluto (ms) da rodada: passado dele, não abre mais documento.
  deadline?: number;
  tokens?: TokenCache;
};

async function syncSession(
  db: SupabaseClient,
  cfg: Config,
  tenantId: string,
  actorId: string,
  sessionId: string,
  options: SyncOptions = {},
) {
  const deadline = options.deadline ?? Date.now() + JOB_DEADLINE_MS;
  const detail: SessionDetailData = await storage(
    db,
    "session_state",
    tenantId,
    actorId,
    sessionId,
  );
  if (!detail.session.documentation_consent) {
    throw new Error("documentation_consent_required");
  }
  const room = detail.room;
  if (!room?.space_name || room.state !== "READY") {
    throw new Error("google_room_not_ready");
  }
  const { token, connection } = await tokenFor(
    db,
    cfg,
    tenantId,
    actorId,
    options.tokens,
  );
  if (connection.organizer_sub !== room.organizer_sub) {
    throw new Error("google_organizer_changed");
  }
  const provider = new GoogleMeetProvider(token);
  const known = new Map(
    (detail.imports || []).map((row) => [row.provider_name, row]),
  );

  // A sala é exclusiva da sessão: toda conferência dela no DIA da aula é a
  // aula (remarcada por fora no mesmo dia inclusive).
  let conferences: MeetConference[];
  try {
    conferences = await provider.conferences(
      room.space_name,
      saoPauloDayWindow(detail.session.class_date),
    );
  } catch (error) {
    await storage(db, "sync_complete", tenantId, actorId, sessionId, {
      error_code: providerErrorCode(error, "google_sync_failed"),
      complete: false,
    });
    throw error;
  }

  // Cada lista (tipo × conferência) no seu try/catch: anotação que não lista
  // não esconde a transcrição nem a presença.
  const artifacts: MeetArtifact[] = [];
  let listingError: string | null = null;
  for (const conference of conferences) {
    for (const kind of ARTIFACT_KINDS) {
      try {
        artifacts.push(...await provider.artifactsOf(conference, kind));
      } catch (error) {
        listingError = listingError ||
          providerErrorCode(error, "google_artifact_listing_failed");
        console.error("[google-meet] lista de documentos", {
          sessionId,
          kind,
          code: providerErrorCode(error, "google_artifact_listing_failed"),
        });
      }
    }
  }

  // Um documento por vez, cada um com o próprio erro registrado; o laço segue.
  let imported = 0;
  const { statuses, deferred: docsDeferred } = await importArtifacts(
    provider,
    artifacts,
    {
      known,
      force: options.force,
      deadline,
      persist: async (item, reading) => {
        let revisionId: string | null = null;
        if (reading.status === "IMPORTED") {
          const result = await storage(
            db,
            "artifact_save",
            tenantId,
            actorId,
            sessionId,
            {
              provider_name: item.name,
              kind: item.kind,
              document_id: item.document || item.name.split("/").pop(),
              source: reading.source,
              source_text: reading.sourceText,
              content_sha256: await sha256(reading.sourceText),
              retention_days: cfg.retentionDays,
            },
          );
          revisionId = result.id;
          if (result.inserted) imported++;
          if (
            item.kind === "SMART_NOTES" &&
            !detail.summaries.some((summary) =>
              summary.origin === "GOOGLE_SMART_NOTES" &&
              summary.source_artifact_ids.includes(result.id)
            )
          ) {
            const source = {
              id: result.id,
              kind: "SMART_NOTES",
              source_text: reading.sourceText,
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
        await storage(db, "artifact_status", tenantId, actorId, sessionId, {
          provider_name: item.name,
          kind: item.kind,
          provider_state: item.state,
          status: reading.status,
          source: reading.source,
          error_code: reading.errorCode,
          revision_id: revisionId,
        });
      },
      recordFailure: async (item, code) => {
        console.error("[google-meet] documento", {
          sessionId,
          kind: item.kind,
          code,
        });
        await storage(db, "artifact_status", tenantId, actorId, sessionId, {
          provider_name: item.name,
          kind: item.kind,
          provider_state: item.state,
          status: "FAILED",
          error_code: code,
        });
      },
    },
  );
  let deferred = docsDeferred;

  // A presença roda mesmo com documento falhando: é outra fonte, outro arquivo.
  let attendance: Record<string, unknown> | null = null;
  let attendanceDone = false;
  if (cfg.attendanceEnabled) {
    if (Date.now() > deadline) {
      deferred = true;
    } else {
      try {
        attendance = await syncAttendance(
          db,
          provider,
          cfg,
          tenantId,
          sessionId,
          detail,
          connection,
          conferences,
        );
        // Só conclui com relatório lido E aula lançada: lançamento que chega
        // depois ainda precisa ser comparado com a sala.
        attendanceDone = attendance.report_found === true &&
          typeof attendance.presence === "string" && !!attendance.presence;
      } catch (error) {
        const code = providerErrorCode(error, "google_attendance_failed");
        console.error("[google-meet] relatório de presença", {
          sessionId,
          code,
        });
        attendance = { error: code };
      }
    }
  }

  const outcome = documentationSyncOutcome({
    statuses,
    listingFailed: !!listingError,
    deferred,
    attendanceRequired: cfg.attendanceEnabled,
    attendanceDone,
  });
  const state = outcome.complete ? null : listingError ||
    (artifacts.length === 0
      ? "ARTIFACTS_NOT_AVAILABLE"
      : outcome.failed
      ? "ARTIFACTS_FAILED"
      : outcome.pending
      ? "ARTIFACTS_PENDING"
      : cfg.attendanceEnabled && !attendanceDone
      ? "ATTENDANCE_PENDING"
      : null);
  await storage(db, "sync_complete", tenantId, actorId, sessionId, {
    error_code: state,
    complete: outcome.complete,
  });
  return {
    ok: true,
    imported,
    pending: outcome.pending,
    failed: outcome.failed,
    deferred,
    complete: outcome.complete,
    attendance,
    status: outcome.complete ? "COMPLETE" : state || "SYNCED",
  };
}

async function attendanceStorage(
  db: SupabaseClient,
  action: "attendance_save" | "attendance_evaluate",
  tenantId: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
  return isRecord(data) ? data : {};
}

// Presença pelo relatório nativo do Google: a planilha que o Meet cria no
// Drive da conta da escola depois de cada conferência. O banco compara com o
// lançamento e só abre caso na Central de Qualidade — pagamento não muda.
async function syncAttendance(
  db: SupabaseClient,
  provider: GoogleMeetProvider,
  cfg: Config,
  tenantId: string,
  sessionId: string,
  detail: SessionDetailData,
  connection: ConnectionRow,
  conferences: MeetConference[],
): Promise<Record<string, unknown>> {
  const room = detail.room!;
  // O professor é a conta Google que ele confirmou por login (e a coanfitriã
  // gravada na sala, que nasce dela). O nome nunca identifica o professor.
  const teacherEmails = [detail.teacher_google_email || "", room.cohost_email]
    .filter(Boolean);
  let reportFound = false;
  // Conferência ainda aberta: o relatório dela não existe; o que estiver no Drive
  // é de outra aula. Espera o próximo ciclo (a avaliação só abre caso sem
  // conferência nenhuma, então "sem relatório ainda" não acusa ninguém).
  const stillOpen = conferences.some((c) => !c.endTime);
  if (conferences.length && !stillOpen) {
    if ((detail.attendance_saved_reports || 0) >= conferences.length) {
      // Já guardado com todas as conferências do dia: só reavalia contra o
      // lançamento (que pode ter chegado depois), sem baixar a planilha de novo.
      reportFound = true;
    } else {
      const starts = conferences.map((c) => c.startTime).filter(Boolean)
        .sort();
      const ends = conferences.map((c) => c.endTime || c.startTime).filter(
        Boolean,
      ).sort();
      const first = starts[0] || detail.session.scheduled_start_at;
      const last = ends[ends.length - 1] || detail.session.scheduled_end_at;
      // O Google gera a planilha logo depois que cada conferência acaba
      // (medido: 2 s). Janela do início da primeira conferência do dia até 3 h
      // depois do fim da última, com 2 min de folga para relógio.
      const candidates = await provider.attendanceReportCandidates(
        new Date(Date.parse(first) - 2 * 60000).toISOString(),
        new Date(Date.parse(last) + 3 * 3600000).toISOString(),
      );
      const code = meetingCodeFromUri(room.meeting_uri);
      let sources: AttendanceSource[] = [];
      // Queda e reentrada = mais de uma planilha com o código da sala: todas.
      for (const candidate of pickAttendanceReports(candidates, code, null)) {
        if (sources.length >= 10) break;
        sources.push({
          ...candidate,
          csv: await provider.spreadsheetCsv(candidate.id),
        });
      }
      if (!sources.length && candidates.length) {
        const withCsv: AttendanceSource[] = [];
        for (
          const candidate of candidates.filter((c) =>
            looksLikeAttendanceReport(c.name) &&
            !namesOtherMeeting(c.name, code)
          ).slice(0, 10)
        ) {
          withCsv.push({
            ...candidate,
            csv: await provider.spreadsheetCsv(candidate.id),
          });
        }
        sources = pickAttendanceReports(withCsv, code, teacherEmails);
      }
      if (sources.length) {
        const combined = combineAttendanceReports(sources, first);
        if (combined.sourceCsv.length > 200000) {
          throw new GoogleProviderError("google_document_too_large", 422);
        }
        const summary = combined.parseError
          ? null
          : summarizeAttendance(combined.rows, {
            teacherEmails,
            organizerEmail: connection.organizer_email || null,
          });
        await attendanceStorage(db, "attendance_save", tenantId, sessionId, {
          conference_name: conferences[0].name,
          document_id: combined.documentId,
          document_name: combined.documentName,
          source_document_ids: combined.documentIds,
          source_csv: combined.sourceCsv,
          content_sha256: await sha256(combined.sourceCsv),
          parse_error: combined.parseError,
          participants: summary?.participants || [],
          teacher_first_join_at: summary?.teacherFirstJoinAt || null,
          teacher_seconds: summary ? summary.teacherSeconds : null,
          student_first_join_at: summary?.studentFirstJoinAt || null,
          student_seconds: summary ? summary.studentSeconds : null,
          retention_days: cfg.retentionDays,
        });
        reportFound = !combined.parseError;
      }
    }
  }
  const evaluation = await attendanceStorage(
    db,
    "attendance_evaluate",
    tenantId,
    sessionId,
    { conference_count: conferences.length, report_found: reportFound },
  );
  return { ...evaluation, report_found: reportFound };
}

type RoomOptions = {
  // Rodada do cron: FAILED só é tentado de novo quando a espera venceu.
  automatic?: boolean;
  tokens?: TokenCache;
};

async function createSessionRoom(
  db: SupabaseClient,
  cfg: Config,
  tenantId: string,
  actorId: string,
  sessionId: string,
  options: RoomOptions = {},
) {
  if (!cfg.enabled || cfg.missing.length) {
    throw new Error("google_pedagogy_disabled");
  }
  const detail: SessionDetailData = await storage(
    db,
    "session_state",
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
  // Coanfitrião = conta Google que o professor confirmou por login. O e-mail
  // do cadastro não prova de quem é a conta (decisão da direção, 26/09/2026).
  // O banco confere de novo e grava o e-mail confirmado na sala.
  if (!detail.teacher_google_email && !detail.room?.space_name) {
    throw new Error("google_teacher_identity_required");
  }
  const { token, connection } = await tokenFor(
    db,
    cfg,
    tenantId,
    actorId,
    options.tokens,
  );
  const claim: { claimed: boolean; room: RoomRow } = await storage(
    db,
    "room_claim",
    tenantId,
    actorId,
    sessionId,
    {
      organizer_sub: connection.organizer_sub,
      automatic: !!options.automatic,
    },
  );
  if (claim.room.organizer_sub !== connection.organizer_sub) {
    throw new Error("google_organizer_changed");
  }
  if (claim.room.state === "READY") {
    return { ok: true, room: publicRoom(claim.room) };
  }
  if (claim.room.state === "NEEDS_RECONCILIATION") {
    throw new Error("google_room_reconciliation_required");
  }
  if (!claim.claimed && !claim.room.space_name) {
    throw new Error(
      claim.room.state === "FAILED"
        ? "google_room_retry_scheduled"
        : "google_room_creation_in_progress",
    );
  }
  const provider = new GoogleMeetProvider(token);
  let room = claim.room;
  if (claim.claimed) {
    let space: { space_name: string; meeting_uri: string };
    try {
      space = await provider.createSpace({
        attendanceReport: cfg.attendanceEnabled,
      });
    } catch (creationError) {
      // Recusa do Google OU falha incerta: nos dois casos nenhum link foi
      // salvo, e só o link salvo chega ao aluno e ao professor. Um space que o
      // Google tenha criado sem responder fica órfão na conta da escola, sem
      // ninguém com o link — por isso a sala vai para FAILED e é tentada de
      // novo sozinha (30 min, 2 h, 6 h; até 5 tentativas), em vez de travar em
      // NEEDS_RECONCILIATION esperando a direção.
      try {
        await storage(db, "room_save", tenantId, actorId, sessionId, {
          state: "FAILED",
          claim_id: claim.room.claim_id,
          error_code: roomCreationErrorCode(creationError),
        });
      } catch (saveError) {
        // Sem gravar FAILED a linha fica em CREATING e volta à fila em 15 min.
        console.error("[google-meet] falha ao registrar criação", {
          sessionId,
          code: providerErrorCode(saveError, "google_meet_storage_unavailable"),
        });
      }
      throw creationError;
    }
    // Se outra rodada tomou a reserva (sala presa em CREATING por 15 min), o
    // banco recusa (google_room_claim_lost) e este space nunca é distribuído.
    room = await storage(db, "room_save", tenantId, actorId, sessionId, {
      ...space,
      state: "COHOST_PENDING",
      claim_id: claim.room.claim_id,
    });
    if (room.state === "NEEDS_RECONCILIATION") {
      throw new Error("google_room_reconciliation_required");
    }
  }
  try {
    await provider.ensureCohost(room.space_name!, room.cohost_email);
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
  return { ok: true, room: publicRoom(room) };
}

/**
 * A documentação da sala JÁ criada acompanha o aceite: revogou → transcrição e
 * anotações OFF no Google (spaces.patch); o aceite voltou antes da aula → ON.
 * Decide com o estado relido agora (artifactToggleAction) e grava o que ficou
 * no Google (room_artifacts_save), inclusive a falha, para a fila tentar de novo.
 */
async function setRoomArtifacts(
  db: SupabaseClient,
  cfg: Config,
  tenantId: string,
  actorId: string,
  sessionId: string,
  operation: ArtifactToggle,
  options: { tokens?: TokenCache } = {},
): Promise<Record<string, unknown>> {
  if (!cfg.enabled || cfg.missing.length) {
    throw new Error("google_pedagogy_disabled");
  }
  const detail: SessionDetailData = await storage(
    db,
    "session_state",
    tenantId,
    actorId,
    sessionId,
  );
  const room = detail.room;
  const decision = artifactToggleAction({
    operation,
    consent: detail.session.documentation_consent,
    artifactsState: room?.artifacts_state,
    roomState: room?.state,
    hasSpace: !!room?.space_name,
    scheduledStartMs: Date.parse(detail.session.scheduled_start_at),
    nowMs: Date.now(),
  });
  if (decision !== "PATCH" || !room?.space_name) {
    return { ok: true, skipped: decision };
  }
  const { token, connection } = await tokenFor(
    db,
    cfg,
    tenantId,
    actorId,
    options.tokens,
  );
  if (connection.organizer_sub !== room.organizer_sub) {
    // Só a conta que criou a sala consegue alterá-la.
    await storage(db, "room_artifacts_save", tenantId, actorId, sessionId, {
      result: "FAILED",
      error_code: "google_organizer_changed",
    });
    throw new Error("google_organizer_changed");
  }
  const outcome = await applyRoomArtifacts(
    new GoogleMeetProvider(token),
    room.space_name,
    operation === "ENABLE_ARTIFACTS",
  );
  const saved: RoomRow = await storage(
    db,
    "room_artifacts_save",
    tenantId,
    actorId,
    sessionId,
    { result: outcome.result, error_code: outcome.errorCode },
  );
  if (outcome.result === "FAILED") {
    console.error("[google-meet] documentação da sala", {
      sessionId,
      operation,
      code: outcome.errorCode,
    });
    throw new Error(outcome.errorCode || "google_room_update_failed");
  }
  return { ok: true, artifacts_state: saved.artifacts_state };
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
      const tokens: TokenCache = new Map();
      const result = await runDocumentationTick<PendingJob>(
        cfg.enabled,
        cfg.missing.length === 0,
        async () => {
          const { data: jobs, error } = await db.rpc(
            "get_pending_google_meet_sync_sessions",
          );
          if (error) throw new Error("google_meet_storage_unavailable");
          return Array.isArray(jobs) ? jobs : [];
        },
        async (job, deadline) => {
          try {
            let result: Record<string, unknown>;
            if (job.operation === "PREPARE_ROOM") {
              result = await createSessionRoom(
                db,
                cfg,
                job.tenant_id,
                job.actor_id,
                job.lesson_session_id,
                { automatic: true, tokens },
              );
            } else if (job.operation === "SYNC_ARTIFACTS") {
              result = await syncSession(
                db,
                cfg,
                job.tenant_id,
                job.actor_id,
                job.lesson_session_id,
                { deadline, tokens },
              );
            } else if (
              job.operation === "DISABLE_ARTIFACTS" ||
              job.operation === "ENABLE_ARTIFACTS"
            ) {
              result = await setRoomArtifacts(
                db,
                cfg,
                job.tenant_id,
                job.actor_id,
                job.lesson_session_id,
                job.operation,
                { tokens },
              );
            } else {
              throw new Error("unknown_google_meet_operation");
            }
            return {
              session_id: job.lesson_session_id,
              operation: job.operation,
              ...result,
            };
          } catch (error) {
            return {
              session_id: job.lesson_session_id,
              operation: job.operation,
              ok: false,
              error: providerErrorCode(error, "google_sync_failed"),
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
    if (action === "teacher_identity_connect") {
      // O professor confirma a PRÓPRIA conta Google (openid + email). É ela que
      // vira coanfitriã das salas e que o relatório de presença reconhece.
      if (auth.isService || auth.profile?.role !== "TEACHER") {
        return json({ error: "google_meet_teacher_required" }, 403);
      }
      const state = randomToken(), verifier = randomToken();
      await storage(db, "identity_nonce_create", tenantId, actorId, null, {
        state_hash: await sha256(state),
        verifier_ciphertext: await encryptSecret(
          verifier,
          cfg.key,
          `identity:${tenantId}:${actorId}`,
        ),
      });
      return json({
        authorization_url: identityAuthorizationUrl(
          cfg,
          state,
          await pkceChallenge(verifier),
        ),
      });
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
        // Pedido explícito de TROCAR a conta central (confirmado na tela). Sem
        // ele, o retorno recusa outra conta Google quando já há salas criadas.
        allow_replace: body.allow_replace === true,
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
        await syncSession(db, cfg, tenantId, actorId, uuid(body.sessionId), {
          force: true,
        }),
      );
    }
    if (action === "sync_due") {
      if (!isAdmin) return json({ error: "google_meet_admin_required" }, 403);
      const due: { lesson_session_id: string }[] = await storage(
        db,
        "sync_due",
        tenantId,
        actorId,
      );
      const tokens: TokenCache = new Map();
      const tick = await runDocumentationTick(
        true,
        true,
        () => Promise.resolve(Array.isArray(due) ? due : []),
        async (item, deadline) => {
          try {
            return {
              session_id: item.lesson_session_id,
              ...await syncSession(
                db,
                cfg,
                tenantId,
                actorId,
                item.lesson_session_id,
                { deadline, tokens },
              ),
            };
          } catch (error) {
            return {
              session_id: item.lesson_session_id,
              ok: false,
              error: providerErrorCode(error, "google_sync_failed"),
            };
          }
        },
      );
      return json({
        ok: tick.results.every((row) => isRecord(row) && row.ok === true),
        results: tick.results,
        deferred: tick.deferred,
      });
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
